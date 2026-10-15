import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/webhooks/github-org-membership/replay/route";
import {
  processGithubOrgMembershipEvent,
  type GitHubMembershipEvent,
} from "@/app/api/webhooks/github-org-membership/route";
import { requireAdmin } from "@/lib/api-auth";
import { recordAuditLog } from "@/lib/audit";
import { prisma } from "@/lib/prisma";

vi.mock("@/lib/api-auth", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { user: { findUnique: vi.fn() } } }));
vi.mock("@/lib/audit", () => ({ recordAuditLog: vi.fn() }));
vi.mock("@/lib/sentry", () => ({ captureException: vi.fn() }));
vi.mock("@/app/api/webhooks/github-org-membership/route", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/api/webhooks/github-org-membership/route")>();
  // Keep the signature helper and Node crypto real; isolate only processing.
  return { ...actual, processGithubOrgMembershipEvent: vi.fn() };
});

const SECRET = "test-secret-123";
// Same membership payload used by the main webhook suite.
const membershipEvent: GitHubMembershipEvent = {
  action: "added",
  member: { login: "testuser", id: 123 },
  organization: { login: "test-org" },
  sender: { login: "admin" },
};
const processedEvent = {
  webhook: "github.organization.member",
  action: "added",
  member: "testuser",
  actor: "admin",
  org: "test-org",
  timestamp: "2026-10-15T00:00:00.000Z",
};

function signature(body: string, secret = SECRET) {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

function request(body = JSON.stringify(membershipEvent), sig: string | null = signature(body)) {
  const headers = new Headers({
    "Content-Type": "application/json",
    "X-GitHub-Delivery": "replay-delivery-123",
    "X-GitHub-Event": "membership",
  });
  if (sig !== null) headers.set("X-Hub-Signature-256", sig);
  return new NextRequest("http://localhost:3000/api/webhooks/github-org-membership/replay", {
    method: "POST",
    headers,
    body,
  });
}

describe("POST /api/webhooks/github-org-membership/replay", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", SECRET);
    vi.stubEnv("GITHUB_MAINTAINER_ORG", "test-org");
    vi.mocked(requireAdmin).mockResolvedValue({
      user: { id: "admin-1", role: "admin", isMaintainer: true },
      expires: "2026-10-16T00:00:00.000Z",
    });
    vi.mocked(processGithubOrgMembershipEvent).mockResolvedValue({
      status: "accepted",
      event: processedEvent,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("returns 403 when requireAdmin denies a non-admin session", async () => {
    vi.mocked(requireAdmin).mockResolvedValue(null);
    const response = await POST(request());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden" });
    expect(requireAdmin).toHaveBeenCalledWith("webhook.github_org_membership_replay");
    expect(processGithubOrgMembershipEvent).not.toHaveBeenCalled();
    expect(recordAuditLog).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", null],
    ["malformed", "sha256=invalid"],
    ["wrong secret", signature(JSON.stringify(membershipEvent), "wrong-secret")],
  ])("returns 401 for a %s signature", async (_label, sig) => {
    const response = await POST(request(JSON.stringify(membershipEvent), sig));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(processGithubOrgMembershipEvent).not.toHaveBeenCalled();
    expect(recordAuditLog).not.toHaveBeenCalled();
  });

  it("rejects a payload changed after signing", async () => {
    const body = JSON.stringify(membershipEvent);
    const alteredBody = JSON.stringify({ ...membershipEvent, action: "deleted" });
    const response = await POST(request(alteredBody, signature(body)));

    expect(response.status).toBe(401);
    expect(processGithubOrgMembershipEvent).not.toHaveBeenCalled();
  });

  it("returns 200 with the processing result and forwards delivery headers", async () => {
    const req = request();
    const response = await POST(req);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "accepted", event: processedEvent });
    expect(processGithubOrgMembershipEvent).toHaveBeenCalledTimes(1);
    expect(processGithubOrgMembershipEvent).toHaveBeenCalledWith(membershipEvent, req.headers);
    expect(req.headers.get("X-GitHub-Delivery")).toBe("replay-delivery-123");
  });

  it("returns 400 for signed malformed JSON without processing it", async () => {
    const response = await POST(request('{"action":'));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: expect.any(String) });
    expect(processGithubOrgMembershipEvent).not.toHaveBeenCalled();
  });

  it.each([undefined, "   "])("allows admin-only unsigned replay when the secret is %s", async (secret) => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", secret);
    const response = await POST(request(JSON.stringify(membershipEvent), null));

    expect(response.status).toBe(200);
    expect(requireAdmin).toHaveBeenCalledOnce();
    expect(processGithubOrgMembershipEvent).toHaveBeenCalledOnce();
  });

  it("still denies non-admin replay when no webhook secret is configured", async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", undefined);
    vi.mocked(requireAdmin).mockResolvedValue(null);
    const response = await POST(request(JSON.stringify(membershipEvent), null));

    expect(response.status).toBe(403);
    expect(processGithubOrgMembershipEvent).not.toHaveBeenCalled();
  });

  it("records the membership audit trail through the real processor", async () => {
    const actual = await vi.importActual<typeof import("@/app/api/webhooks/github-org-membership/route")>(
      "@/app/api/webhooks/github-org-membership/route",
    );
    vi.mocked(processGithubOrgMembershipEvent).mockImplementation(actual.processGithubOrgMembershipEvent);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: "user-1",
      maintainerOrgId: "default",
      githubId: "123",
      githubUsername: "testuser",
      name: "Test User",
      email: "test@example.com",
      image: null,
      accessToken: null,
      banned: false,
      bannedAt: null,
      banReason: null,
      bannedById: null,
      createdAt: new Date("2026-10-01T00:00:00.000Z"),
      updatedAt: new Date("2026-10-01T00:00:00.000Z"),
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "accepted",
      event: { ...processedEvent, timestamp: expect.any(String) },
    });
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { githubUsername: "testuser" } });
    expect(recordAuditLog).toHaveBeenCalledTimes(1);
    expect(recordAuditLog).toHaveBeenCalledWith({
      action: "webhook.org_membership_changed",
      actorId: null,
      actorLogin: "admin",
      targetId: "user-1",
      targetLabel: "testuser",
      metadata: {
        membershipAction: "added",
        org: "test-org",
        webhookId: "replay-delivery-123",
      },
    });
  });
});
