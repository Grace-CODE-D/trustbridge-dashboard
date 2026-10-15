/**
 * API tests — GET /api/address-history (#137)
 *
 * Self-only access to a contributor's own AddressHistoryRecord timeline.
 * Maintainers may pass ?userId= to look up another user's history; the
 * critical case is that non-maintainers passing that param NEVER leak
 * another user's history (IDOR).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/address-history/route";

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("@/lib/address-history", () => ({ getAddressHistory: vi.fn() }));

import { getServerSession } from "next-auth";
import { getAddressHistory } from "@/lib/address-history";
import { generateCsrfToken } from "@/lib/csrf";

let currentUserId = "user-1";

function getRequest(query = "", customHeaders?: Record<string, string>) {
  const headers: Record<string, string> =
    customHeaders !== undefined
      ? customHeaders
      : { "x-csrf-token": generateCsrfToken(currentUserId) };
  return new NextRequest(`http://localhost:3000/api/address-history${query}`, {
    headers,
  });
}

function mockSession(opts: { id?: string; isMaintainer?: boolean } = {}) {
  currentUserId = opts.id ?? "user-1";
  vi.mocked(getServerSession).mockResolvedValue({
    user: { id: currentUserId, isMaintainer: opts.isMaintainer ?? false },
  } as never);
}

const SAMPLE_HISTORY = [
  {
    stellarAddress: "GBSX" + "X".repeat(52),
    changeType: "updated",
    recordedAt: new Date("2026-08-01T00:00:00.000Z"),
  },
  {
    stellarAddress: "GAAA" + "A".repeat(52),
    changeType: "initial",
    recordedAt: new Date("2026-07-01T00:00:00.000Z"),
  },
];

afterEach(() => {
  currentUserId = "user-1";
  vi.clearAllMocks();
});

describe("GET /api/address-history — authentication", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);
    const res = await GET(getRequest());
    expect(res.status).toBe(401);
    expect(getAddressHistory).not.toHaveBeenCalled();
  });
});

describe("GET /api/address-history — CSRF protection", () => {
  it("returns 403 with stable error JSON when CSRF token is missing", async () => {
    mockSession({ id: "user-1", isMaintainer: false });
    const res = await GET(getRequest("", {}));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json).toEqual({ error: "Invalid CSRF token" });
    expect(getAddressHistory).not.toHaveBeenCalled();
  });

  it("returns 403 when CSRF token is invalid", async () => {
    mockSession({ id: "user-1", isMaintainer: false });
    const res = await GET(getRequest("", { "x-csrf-token": "invalid-token" }));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json).toEqual({ error: "Invalid CSRF token" });
    expect(getAddressHistory).not.toHaveBeenCalled();
  });

  it("returns 403 when CSRF token was issued for another user", async () => {
    mockSession({ id: "user-1", isMaintainer: false });
    const otherUserToken = generateCsrfToken("user-2");
    const res = await GET(getRequest("", { "x-csrf-token": otherUserToken }));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json).toEqual({ error: "Invalid CSRF token" });
    expect(getAddressHistory).not.toHaveBeenCalled();
  });

  it("returns 403 when CSRF token is expired", async () => {
    mockSession({ id: "user-1", isMaintainer: false });
    const expiredTimestamp = Date.now() - 25 * 60 * 60 * 1000;
    const salt = "0123456789abcdef";
    const crypto = await import("crypto");
    const secret =
      process.env.NEXTAUTH_SECRET ||
      process.env.CSRF_SECRET ||
      "trustbridge-csrf-default-secret-key-32";
    const hmac = crypto
      .createHmac("sha256", secret)
      .update(`user-1:${expiredTimestamp}:${salt}`)
      .digest("hex");
    const expiredToken = `${expiredTimestamp}.${salt}.${hmac}`;

    const res = await GET(getRequest("", { "x-csrf-token": expiredToken }));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json).toEqual({ error: "Invalid CSRF token" });
    expect(getAddressHistory).not.toHaveBeenCalled();
  });

  it("accepts valid CSRF token in csrfToken query parameter", async () => {
    mockSession({ id: "user-1", isMaintainer: false });
    vi.mocked(getAddressHistory).mockResolvedValue(SAMPLE_HISTORY as never);
    const token = generateCsrfToken("user-1");
    const res = await GET(
      getRequest(`?csrfToken=${encodeURIComponent(token)}`, {})
    );
    expect(res.status).toBe(200);
    expect(getAddressHistory).toHaveBeenCalledWith("user-1");
  });

  it("rejects maintainer ?userId= lookup when CSRF token is missing", async () => {
    mockSession({ id: "maintainer-1", isMaintainer: true });
    const res = await GET(getRequest("?userId=other-user", {}));
    expect(res.status).toBe(403);
    expect(getAddressHistory).not.toHaveBeenCalled();
  });
});

describe("GET /api/address-history — self access", () => {
  it("a signed-in contributor gets their own history back", async () => {
    mockSession({ id: "user-1", isMaintainer: false });
    vi.mocked(getAddressHistory).mockResolvedValue(SAMPLE_HISTORY as never);

    const res = await GET(getRequest());
    expect(res.status).toBe(200);
    expect(getAddressHistory).toHaveBeenCalledWith("user-1");
    const json = await res.json();
    expect(json.history).toHaveLength(2);
  });

  it("returns an empty array when the user has no history yet", async () => {
    mockSession({ id: "user-1", isMaintainer: false });
    vi.mocked(getAddressHistory).mockResolvedValue([]);

    const res = await GET(getRequest());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.history).toEqual([]);
  });
});

describe("GET /api/address-history — maintainer lookup", () => {
  it("a maintainer passing ?userId= gets that other user's history", async () => {
    mockSession({ id: "maintainer-1", isMaintainer: true });
    vi.mocked(getAddressHistory).mockResolvedValue(SAMPLE_HISTORY as never);

    const res = await GET(getRequest("?userId=other-user"));
    expect(res.status).toBe(200);
    expect(getAddressHistory).toHaveBeenCalledWith("other-user");
  });

  it("a maintainer with no ?userId= still gets their own history", async () => {
    mockSession({ id: "maintainer-1", isMaintainer: true });
    vi.mocked(getAddressHistory).mockResolvedValue([]);

    const res = await GET(getRequest());
    expect(res.status).toBe(200);
    expect(getAddressHistory).toHaveBeenCalledWith("maintainer-1");
  });
});

describe("GET /api/address-history — IDOR prevention", () => {
  it("a non-maintainer passing ?userId=<other-user-id> only gets their OWN history back", async () => {
    mockSession({ id: "user-1", isMaintainer: false });
    vi.mocked(getAddressHistory).mockResolvedValue(SAMPLE_HISTORY as never);

    const res = await GET(getRequest("?userId=attacker-target-user"));

    expect(res.status).toBe(200);
    // Never called with the attacker-supplied userId.
    expect(getAddressHistory).not.toHaveBeenCalledWith("attacker-target-user");
    // Always called with the session user's own id.
    expect(getAddressHistory).toHaveBeenCalledWith("user-1");
    expect(getAddressHistory).toHaveBeenCalledTimes(1);
  });
});
