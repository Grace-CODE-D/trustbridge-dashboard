import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authOptions: {},
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    featureFlag: {
      findMany: vi.fn(),
    },
  },
}));

import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { clearFeatureFlagCache } from "@/lib/feature-flags";
import { GET } from "@/app/api/settings/feature-flags/route";

const findMany = vi.mocked(prisma.featureFlag.findMany);
const ORIGINAL_ENV = process.env;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.FEATURE_FLAGS_DB_ENABLED;
  delete process.env.FEATURE_FLAG_BATCH_RECHECK;
  delete process.env.FEATURE_FLAG_OTEL_TRACES;
  clearFeatureFlagCache();
  vi.clearAllMocks();
  findMany.mockResolvedValue([]);
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

describe("GET /api/settings/feature-flags", () => {
  it("returns 401 for unauthenticated requests", async () => {
    vi.mocked(getServerSession).mockResolvedValueOnce(null);

    const res = await GET();
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: "Unauthorized" });
  });

  it("returns 403 for non-maintainers", async () => {
    vi.mocked(getServerSession).mockResolvedValueOnce({
      user: { id: "user-1", isMaintainer: false },
    } as any);

    const res = await GET();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: "Forbidden" });
  });

  it("returns full list of flags with descriptions for maintainers", async () => {
    vi.mocked(getServerSession).mockResolvedValueOnce({
      user: { id: "maintainer-1", isMaintainer: true },
    } as any);

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.flags).toBeDefined();
    expect(Array.isArray(body.flags)).toBe(true);
    expect(body.flags.length).toBeGreaterThan(0);

    const batchFlag = body.flags.find((f: any) => f.key === "batch_recheck");
    expect(batchFlag).toBeDefined();
    expect(batchFlag.description).toBeTruthy();
    expect(typeof batchFlag.enabled).toBe("boolean");
    expect(batchFlag.source).toBe("Built-in default");
  });

  it("env overrides win over DB values per module rules", async () => {
    process.env.FEATURE_FLAGS_DB_ENABLED = "1";
    process.env.FEATURE_FLAG_BATCH_RECHECK = "false";

    findMany.mockResolvedValueOnce([
      { key: "batch_recheck", enabled: true } as any,
    ]);

    vi.mocked(getServerSession).mockResolvedValueOnce({
      user: { id: "maintainer-1", isMaintainer: true },
    } as any);

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    const batchFlag = body.flags.find((f: any) => f.key === "batch_recheck");
    expect(batchFlag.enabled).toBe(false);
    expect(batchFlag.source).toBe("Environment override");
  });

  it("returns DB values when DB source is enabled and no env override exists", async () => {
    process.env.FEATURE_FLAGS_DB_ENABLED = "1";

    findMany.mockResolvedValueOnce([
      { key: "otel_traces", enabled: true } as any,
    ]);

    vi.mocked(getServerSession).mockResolvedValueOnce({
      user: { id: "maintainer-1", isMaintainer: true },
    } as any);

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    const otelFlag = body.flags.find((f: any) => f.key === "otel_traces");
    expect(otelFlag.enabled).toBe(true);
    expect(otelFlag.source).toBe("Database");
  });

  it("unknown flag keys in DB do not crash the listing", async () => {
    process.env.FEATURE_FLAGS_DB_ENABLED = "1";

    findMany.mockResolvedValueOnce([
      { key: "completely_unknown_flag", enabled: true } as any,
    ]);

    vi.mocked(getServerSession).mockResolvedValueOnce({
      user: { id: "maintainer-1", isMaintainer: true },
    } as any);

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.flags).toBeDefined();
    expect(
      body.flags.some((f: any) => f.key === "completely_unknown_flag")
    ).toBe(false);
  });
});
