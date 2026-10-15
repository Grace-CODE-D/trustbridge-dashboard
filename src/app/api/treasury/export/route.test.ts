import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

/**
 * Tests for GET and POST /api/treasury/export
 *
 * Authorization matrix:
 *   - Unauthenticated (requireOperator returns null)  → 403
 *   - Viewer / non-operator (requireOperator returns null) → 403
 *   - Operator or higher (requireOperator returns session)  → 200
 *
 * Functional coverage:
 *   - GET: returns export payload with correct counts and audit log
 *   - POST json: returns JSON export payload
 *   - POST csv:  returns CSV attachment with correct headers/rows
 *   - POST bad format: returns 400
 *   - POST CSRF failure: returns early before auth
 */

// ─────────────────────────────────────────────────────────────────────────────
// Mocks
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("@/lib/api-auth", () => ({
  requireOperator: vi.fn(),
}));

vi.mock("@/lib/readiness", () => ({
  computeReadiness: vi.fn(),
}));

vi.mock("@/lib/csrf", () => ({
  assertSameOrigin: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    registration: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn(),
}));

import { GET, POST } from "@/app/api/treasury/export/route";
import { requireOperator } from "@/lib/api-auth";
import { assertSameOrigin } from "@/lib/csrf";
import { prisma } from "@/lib/prisma";
import { computeReadiness } from "@/lib/readiness";
import { computeReadiness } from "@/lib/readiness";
import { recordAuditLog } from "@/lib/audit";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const operatorSession = {
  user: {
    id: "operator-1",
    isMaintainer: true,
    role: "operator",
    email: "operator@test.com",
    githubUsername: "op-user",
  },
  expires: "2099-01-01T00:00:00.000Z",
};

const twoRegistrations = [
  {
    id: "reg-1",
    userId: "user-2",
    stellarAddress: "GBXYZ123",
    funded: true,
    trustlineReady: true,
    trustlineAuthorized: true,
    xlmBalance: "100",
    spendableXlmBalance: "50",
    lastCheckedAt: new Date("2026-07-26"),
    lastCheckedAt: new Date("2026-07-26"),
    deletedAt: null,
    user: { githubUsername: "contributor1" },
  },
  {
    id: "reg-2",
    userId: "user-3",
    stellarAddress: "GABC456",
    funded: false,
    trustlineReady: false,
    trustlineAuthorized: false,
    xlmBalance: "0",
    spendableXlmBalance: "0",
    lastCheckedAt: new Date("2026-07-26"),
    lastCheckedAt: new Date("2026-07-26"),
    deletedAt: null,
    user: { githubUsername: "contributor2" },
  },
];

function makePostRequest(body: unknown, origin = "http://localhost:3000"): NextRequest {
  return new NextRequest("http://localhost:3000/api/treasury/export", {
    method: "POST",
    headers: {
    headers: {
      host: "localhost:3000",
      origin,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/treasury/export
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/treasury/export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(assertSameOrigin).mockReturnValue(null);
    vi.mocked(assertSameOrigin).mockReturnValue(null);
  });

  // ── Authorization ────────────────────────────────────────────────────────

  describe("Authorization", () => {
    it("returns 403 when unauthenticated (requireOperator returns null)", async () => {
      vi.mocked(requireOperator).mockResolvedValue(null);

      const res = await GET();

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toBe("Forbidden");
      expect(prisma.registration.findMany).not.toHaveBeenCalled();
    });

    it("returns 403 when caller is a viewer (requireOperator returns null)", async () => {
      // requireOperator already enforces role — returning null models a viewer denial
      vi.mocked(requireOperator).mockResolvedValue(null);

      const res = await GET();

      expect(res.status).toBe(403);
    });

    it("allows an operator to export", async () => {
      vi.mocked(requireOperator).mockResolvedValue(operatorSession as never);
      vi.mocked(prisma.registration.findMany).mockResolvedValue([]);
      vi.mocked(computeReadiness).mockReturnValue("ready");

      const res = await GET();

      expect(res.status).toBe(200);
      expect(requireOperator).toHaveBeenCalledWith("treasury.export");
    });
  });

  // ── Functional ───────────────────────────────────────────────────────────

  describe("Response", () => {
    beforeEach(() => {
      vi.mocked(requireOperator).mockResolvedValue(operatorSession as never);
    });

    it("returns correct counts and contributor list", async () => {
      vi.mocked(prisma.registration.findMany).mockResolvedValue(twoRegistrations as never);
      vi.mocked(computeReadiness).mockImplementation((funded) =>
        funded ? "ready" : "not_ready"
      );

      const res = await GET();
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.totalContributors).toBe(2);
      expect(json.readyCount).toBe(1);
      expect(json.notReadyCount).toBe(1);
      expect(json.contributors).toHaveLength(2);
      expect(json.contributors[0].githubUsername).toBe("contributor1");
      expect(json.contributors[1].githubUsername).toBe("contributor2");
    });

    it("records an audit log on success", async () => {
      vi.mocked(prisma.registration.findMany).mockResolvedValue(twoRegistrations as never);
      vi.mocked(computeReadiness).mockReturnValue("ready");

      await GET();

      expect(recordAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "treasury.export",
          actorId: "operator-1",
        })
      );
    });

    it("sets exportedBy from session email", async () => {
      vi.mocked(prisma.registration.findMany).mockResolvedValue([]);
      vi.mocked(computeReadiness).mockReturnValue("ready");

      const res = await GET();
      const json = await res.json();

      expect(json.exportedBy).toBe("operator@test.com");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/treasury/export
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/treasury/export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(assertSameOrigin).mockReturnValue(null);
    vi.mocked(assertSameOrigin).mockReturnValue(null);
  });

  // ── Authorization ────────────────────────────────────────────────────────

  describe("Authorization", () => {
    it("returns 403 when unauthenticated (requireOperator returns null)", async () => {
      vi.mocked(requireOperator).mockResolvedValue(null);

      const res = await POST(makePostRequest({ format: "json" }));

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toBe("Forbidden");
      expect(prisma.registration.findMany).not.toHaveBeenCalled();
    });

    it("returns 403 when caller is a viewer (requireOperator returns null)", async () => {
      vi.mocked(requireOperator).mockResolvedValue(null);

      const res = await POST(makePostRequest({ format: "json" }));

      expect(res.status).toBe(403);
    });

    it("allows an operator to export", async () => {
      vi.mocked(requireOperator).mockResolvedValue(operatorSession as never);
      vi.mocked(prisma.registration.findMany).mockResolvedValue([]);
      vi.mocked(computeReadiness).mockReturnValue("ready");

      const res = await POST(makePostRequest({ format: "json" }));

      expect(res.status).toBe(200);
      expect(requireOperator).toHaveBeenCalledWith("treasury.export");
    });
  });

  // ── CSRF ─────────────────────────────────────────────────────────────────

  describe("CSRF", () => {
    it("rejects cross-origin requests before reaching auth", async () => {
      const csrfError = NextResponse.json({ error: "CSRF check failed" }, { status: 403 });
      // assertSameOrigin returning a Response triggers the early return
      vi.mocked(assertSameOrigin).mockReturnValue(csrfError as never);

      const res = await POST(makePostRequest({ format: "json" }, "http://evil.example.com"));

      expect(res.status).toBe(403);
      // Auth should never have been called
      expect(requireOperator).not.toHaveBeenCalled();
    });
  });

  // ── JSON export ──────────────────────────────────────────────────────────

  describe("JSON export", () => {
    beforeEach(() => {
      vi.mocked(requireOperator).mockResolvedValue(operatorSession as never);
    });

    it("returns JSON export payload by default (no format field)", async () => {
      vi.mocked(prisma.registration.findMany).mockResolvedValue([twoRegistrations[0]] as never);
      vi.mocked(computeReadiness).mockReturnValue("ready");

      const res = await POST(makePostRequest({}));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.totalContributors).toBe(1);
      expect(json.contributors).toHaveLength(1);
      expect(json.exportedAt).toBeDefined();
    });

    it("returns JSON export payload when format is 'json'", async () => {
      vi.mocked(prisma.registration.findMany).mockResolvedValue(twoRegistrations as never);
      vi.mocked(computeReadiness).mockImplementation((funded) =>
        funded ? "ready" : "not_ready"
      );

      const res = await POST(makePostRequest({ format: "json" }));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.readyCount).toBe(1);
      expect(json.notReadyCount).toBe(1);
    });

    it("records an audit log with format metadata", async () => {
      vi.mocked(prisma.registration.findMany).mockResolvedValue([]);
      vi.mocked(computeReadiness).mockReturnValue("ready");

      await POST(makePostRequest({ format: "json" }));

      expect(recordAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "treasury.export",
          actorId: "operator-1",
          metadata: expect.objectContaining({ format: "json" }),
        })
      );
    });
  });

  // ── CSV export ───────────────────────────────────────────────────────────

  describe("CSV export", () => {
    beforeEach(() => {
      vi.mocked(requireOperator).mockResolvedValue(operatorSession as never);
      vi.mocked(prisma.registration.findMany).mockResolvedValue([twoRegistrations[0]] as never);
      vi.mocked(computeReadiness).mockReturnValue("ready");
    });

    it("returns CSV content-type and attachment disposition", async () => {
      const res = await POST(makePostRequest({ format: "csv" }));

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/csv");
      expect(res.headers.get("Content-Disposition")).toMatch(
        /^attachment; filename="treasury-export-.+\.csv"$/
      );
    });

    it("includes CSV header row", async () => {
      const res = await POST(makePostRequest({ format: "csv" }));
      const text = await res.text();

      expect(text).toContain("github_username");
      expect(text).toContain("stellar_address");
      expect(text).toContain("spendable_xlm_balance");
    });

    it("includes contributor data rows", async () => {
      const res = await POST(makePostRequest({ format: "csv" }));
      const text = await res.text();

      expect(text).toContain("contributor1");
      expect(text).toContain("GBXYZ123");
    });
  });

  // ── Validation ───────────────────────────────────────────────────────────

  describe("Validation", () => {
    beforeEach(() => {
      vi.mocked(requireOperator).mockResolvedValue(operatorSession as never);
    });

    it("returns 400 for an unsupported format", async () => {
      const res = await POST(makePostRequest({ format: "xml" }));

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain("Unsupported");
    });

    it("returns 400 when page size is zero or negative", async () => {
      const res = await POST(makePostRequest({ limit: 0 }));
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain("Limit must be between");
    });

    it("returns 400 when page size exceeds max limit", async () => {
      const res = await POST(makePostRequest({ limit: 1000 }));
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain("Limit cannot exceed");
    });

    it("returns 400 when offset is negative", async () => {
      const res = await POST(makePostRequest({ offset: -5 }));
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain("Offset must be greater than or equal to 0");
    });
  });
});

