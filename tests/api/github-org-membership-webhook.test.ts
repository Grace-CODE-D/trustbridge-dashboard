import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import { NextRequest } from "next/server";
import { POST, verifyWebhookSignature } from "@/app/api/webhooks/github-org-membership/route";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn(),
}));

import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/lib/audit";
import { captureException } from "@/lib/sentry";

vi.mock("@/lib/sentry", () => ({
  captureException: vi.fn(),
}));

const WEBHOOK_SECRET = "test-secret-123";

function createSignature(payload: Buffer): string {
  const hmac = crypto.createHmac("sha256", WEBHOOK_SECRET);
  hmac.update(payload);
  return `sha256=${hmac.digest("hex")}`;
}

function createWebhookRequest(
  event: Record<string, unknown>,
  signature: string | null = null
) {
  const payload = Buffer.from(JSON.stringify(event));
  const sig = signature ?? createSignature(payload);

  return new NextRequest("http://localhost:3000/api/webhooks/github-org-membership", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Hub-Signature-256": sig,
      "X-GitHub-Delivery": "delivery-id-123",
    },
    body: payload,
  });
}

describe("POST /api/webhooks/github-org-membership", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", WEBHOOK_SECRET);
    vi.stubEnv("GITHUB_MAINTAINER_ORG", "test-org");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe("verifyWebhookSignature", () => {
    it("logs error and returns false when GITHUB_WEBHOOK_SECRET is not configured", () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      delete process.env.GITHUB_WEBHOOK_SECRET;

      const payload = Buffer.from(JSON.stringify({ test: true }));
      const result = verifyWebhookSignature(payload, "sha256=abcdef");

      expect(result).toBe(false);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "GITHUB_WEBHOOK_SECRET not configured — rejecting webhook (fail closed)"
      );

      consoleErrorSpy.mockRestore();
    });

    it("logs error and returns false when GITHUB_WEBHOOK_SECRET is whitespace only", () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      process.env.GITHUB_WEBHOOK_SECRET = "   ";

      const payload = Buffer.from(JSON.stringify({ test: true }));
      const result = verifyWebhookSignature(payload, "sha256=abcdef");

      expect(result).toBe(false);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "GITHUB_WEBHOOK_SECRET not configured — rejecting webhook (fail closed)"
      );

      consoleErrorSpy.mockRestore();
    });

    it("logs warning and returns false when X-Hub-Signature-256 is missing", () => {
      const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.stubEnv("GITHUB_WEBHOOK_SECRET", WEBHOOK_SECRET);

      const payload = Buffer.from(JSON.stringify({ test: true }));
      const result = verifyWebhookSignature(payload, undefined);

      expect(result).toBe(false);
      expect(consoleWarnSpy).toHaveBeenCalledWith("Missing X-Hub-Signature-256 header");

      consoleWarnSpy.mockRestore();
    });
  });

  it("rejects invalid signature", async () => {
    const event = {
      action: "added",
      member: { login: "user1", id: 123 },
      organization: { login: "test-org" },
      sender: { login: "admin" },
    };

    const req = createWebhookRequest(event, "sha256=invalid");
    const res = await POST(req);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("Unauthorized");
  });

  it("rejects request and logs error when webhook secret not configured", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    delete process.env.GITHUB_WEBHOOK_SECRET;

    const event = {
      action: "added",
      member: { login: "user1", id: 123 },
      organization: { login: "test-org" },
      sender: { login: "admin" },
    };

    const payload = Buffer.from(JSON.stringify(event));
    const req = new NextRequest(
      "http://localhost:3000/api/webhooks/github-org-membership",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Hub-Signature-256": "sha256=ignored",
        },
        body: payload,
      }
    );

    const res = await POST(req);
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toBe("Webhook secret not configured");

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "GITHUB_WEBHOOK_SECRET not configured — rejecting webhook (fail closed)"
    );
    expect(recordAuditLog).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it("ignores events from different org", async () => {
    const event = {
      action: "added",
      member: { login: "user1", id: 123 },
      organization: { login: "other-org" },
      sender: { login: "admin" },
    };

    const req = createWebhookRequest(event);
    const res = await POST(req);
    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.status).toBe("ignored");
    expect(recordAuditLog).not.toHaveBeenCalled();
  });

  it("handles member added event", async () => {
    const event = {
      action: "added",
      member: { login: "testuser", id: 123 },
      organization: { login: "test-org" },
      sender: { login: "admin" },
    };

    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: "user-1",
      maintainerOrgId: "default",
      banned: false,
      bannedAt: null,
      banReason: null,
      bannedById: null,
      githubId: "123",
      githubUsername: "testuser",
      name: "Test User",
      email: "test@example.com",
      image: null,
      accessToken: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const req = createWebhookRequest(event);
    const res = await POST(req);
    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.status).toBe("accepted");

    // Verify audit log was recorded
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "webhook.org_membership_changed",
        targetId: "user-1",
        targetLabel: "testuser",
        metadata: expect.objectContaining({
          membershipAction: "added",
          org: "test-org",
        }),
      })
    );
  });

  it("handles member removed event", async () => {
    const event = {
      action: "deleted",
      member: { login: "testuser", id: 123 },
      organization: { login: "test-org" },
      sender: { login: "admin" },
    };

    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: "user-1",
      maintainerOrgId: "default",
      banned: false,
      bannedAt: null,
      banReason: null,
      bannedById: null,
      githubId: "123",
      githubUsername: "testuser",
      name: "Test User",
      email: "test@example.com",
      image: null,
      accessToken: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const req = createWebhookRequest(event);
    const res = await POST(req);
    expect(res.status).toBe(202);

    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "webhook.org_membership_changed",
        metadata: expect.objectContaining({
          membershipAction: "deleted",
        }),
      })
    );
  });

  it("handles member not found gracefully", async () => {
    const event = {
      action: "added",
      member: { login: "newuser", id: 123 },
      organization: { login: "test-org" },
      sender: { login: "admin" },
    };

    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

    const req = createWebhookRequest(event);
    const res = await POST(req);
    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.status).toBe("accepted");
    expect(recordAuditLog).not.toHaveBeenCalled();
  });

  it("handles processing errors gracefully", async () => {
    const event = {
      action: "added",
      member: { login: "testuser", id: 123 },
      organization: { login: "test-org" },
      sender: { login: "admin" },
    };

    vi.mocked(prisma.user.findUnique).mockRejectedValue(
      new Error("Database error")
    );

    const req = createWebhookRequest(event);
    const res = await POST(req);
    // Should still return 202 to prevent retry storm
    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.status).toBe("error");
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        route: "/api/webhooks/github-org-membership",
        method: "POST",
      })
    );
  });

  it("valid webhook with correct signature", async () => {
    const event = {
      action: "added",
      member: { login: "testuser", id: 123 },
      organization: { login: "test-org" },
      sender: { login: "admin" },
    };

    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: "user-1",
      maintainerOrgId: "default",
      banned: false,
      bannedAt: null,
      banReason: null,
      bannedById: null,
      githubId: "123",
      githubUsername: "testuser",
      name: "Test User",
      email: "test@example.com",
      image: null,
      accessToken: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const req = createWebhookRequest(event);
    const res = await POST(req);
    expect(res.status).toBe(202);
  });

});
