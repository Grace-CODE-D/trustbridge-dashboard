import { describe, it, expect, vi } from "vitest";
import {
  isExportStale,
  getStaleContributors,
  buildStalenessSummary,
  filterContributorsByDateRange,
  evaluateStaleExportGuard,
  assertFreshExport,
} from "@/lib/stale-export";
import type { ContributorRow } from "@/types";

function makeRow(lastCheckedAt: string | null): ContributorRow {
  return {
    id: "1",
    githubUsername: "test",
    stellarAddress: "GBSX",
    trustlineReady: true,
    trustlineAuthorized: true,
    verified: true,
    funded: true,
    xlmBalance: "2",
    spendableXlmBalance: "1.5",
    lastCheckedAt,
    readiness: "ready",
  };
}

describe("stale-export", () => {
  it("returns false when all contributors are fresh", () => {
    const now = new Date().toISOString();
    const contributors = [makeRow(now)];
    expect(isExportStale(contributors, 3600000)).toBe(false);
  });

  it("returns true when a contributor is stale", () => {
    const old = new Date(Date.now() - 7200000).toISOString(); // 2 hours ago
    const contributors = [makeRow(old)];
    expect(isExportStale(contributors, 3600000)).toBe(true);
  });

  it("returns true when any contributor is stale (mixed)", () => {
    const fresh = new Date().toISOString();
    const stale = new Date(Date.now() - 7200000).toISOString();
    const contributors = [makeRow(fresh), makeRow(stale)];
    expect(isExportStale(contributors, 3600000)).toBe(true);
  });

  it("returns true when lastCheckedAt is null", () => {
    const contributors = [makeRow(null)];
    expect(isExportStale(contributors, 3600000)).toBe(true);
  });

  it("returns false for empty contributors", () => {
    expect(isExportStale([], 3600000)).toBe(false);
  });

  it("uses env default (24h) when no maxAgeMs provided", () => {
    const now = new Date().toISOString();
    const contributors = [makeRow(now)];
    expect(isExportStale(contributors)).toBe(false);
  });

  it("respects custom env value", () => {
    vi.stubEnv("STALE_CSV_MAX_AGE_MS", "1000"); // 1 second
    const old = new Date(Date.now() - 2000).toISOString();
    const contributors = [makeRow(old)];
    expect(isExportStale(contributors)).toBe(true);
    vi.unstubAllEnvs();
  });

  it("ignores malformed env and uses default", () => {
    vi.stubEnv("STALE_CSV_MAX_AGE_MS", "not-a-number");
    const now = new Date().toISOString();
    const contributors = [makeRow(now)];
    expect(isExportStale(contributors)).toBe(false);
    vi.unstubAllEnvs();
  });
});

describe("getStaleContributors", () => {
  it("returns only stale contributors", () => {
    const fresh = makeRow(new Date().toISOString());
    const stale = makeRow(new Date(Date.now() - 7200000).toISOString());
    const result = getStaleContributors([fresh, stale], 3600000);
    expect(result).toHaveLength(1);
    expect(result[0].githubUsername).toBe("test");
  });
});

describe("buildStalenessSummary", () => {
  it("reports no stale data when all fresh", () => {
    const fresh = makeRow(new Date().toISOString());
    const summary = buildStalenessSummary([fresh], 3600000);
    expect(summary.stale).toBe(false);
    expect(summary.staleCount).toBe(0);
    expect(summary.allowExport).toBe(true);
    expect(summary.warning).toBe("");
  });

  it("reports stale data with percentage", () => {
    const fresh = makeRow(new Date().toISOString());
    const stale = makeRow(new Date(Date.now() - 7200000).toISOString());
    const summary = buildStalenessSummary([fresh, stale], 3600000);
    expect(summary.stale).toBe(true);
    expect(summary.staleCount).toBe(1);
    expect(summary.totalCount).toBe(2);
    expect(summary.stalePercent).toBe(50);
    expect(summary.allowExport).toBe(false);
    expect(summary.warning).toContain("1 of 2 contributors (50%)");
  });
});

describe("filterContributorsByDateRange", () => {
  it("returns only contributors checked after threshold", () => {
    const twoHoursAgo = Date.now() - 7200000;
    const oneHourAgo = Date.now() - 3600000;
    const fresh = makeRow(new Date(oneHourAgo).toISOString());
    const old = makeRow(new Date(twoHoursAgo).toISOString());

    const result = filterContributorsByDateRange([fresh, old], oneHourAgo - 1000);
    expect(result).toHaveLength(1);
    expect(result[0].githubUsername).toBe("test");
  });

  it("excludes contributors with null lastCheckedAt", () => {
    const fresh = makeRow(new Date().toISOString());
    const unchecked = makeRow(null);
    const result = filterContributorsByDateRange([fresh, unchecked], Date.now() - 86400000);
    expect(result).toHaveLength(1);
  });

  it("returns empty when no contributors match date range", () => {
    const old = makeRow(new Date(Date.now() - 7200000).toISOString());
    const result = filterContributorsByDateRange([old], Date.now());
    expect(result).toHaveLength(0);
  });
});

describe("evaluateStaleExportGuard", () => {
  it("allows export when all contributors are fresh and blockWhenStale is true", () => {
    const fresh = makeRow(new Date().toISOString());
    const result = evaluateStaleExportGuard([fresh], { blockWhenStale: true });

    expect(result.stale).toBe(false);
    expect(result.blocked).toBe(false);
    expect(result.allowExport).toBe(true);
    expect(result.staleCount).toBe(0);
  });

  it("blocks export when a contributor is stale and blockWhenStale is true", () => {
    const stale = makeRow(new Date(Date.now() - 7200000).toISOString());
    const result = evaluateStaleExportGuard([stale], {
      maxAgeMs: 3600000,
      blockWhenStale: true,
    });

    expect(result.stale).toBe(true);
    expect(result.blocked).toBe(true);
    expect(result.allowExport).toBe(false);
    expect(result.staleCount).toBe(1);
    expect(result.reason).toBe("stale_contributors");
    expect(result.error).toBeDefined();
  });

  it("allows export when a contributor is stale but blockWhenStale is false (override path)", () => {
    const stale = makeRow(new Date(Date.now() - 7200000).toISOString());
    const result = evaluateStaleExportGuard([stale], {
      maxAgeMs: 3600000,
      blockWhenStale: false,
    });

    expect(result.stale).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.allowExport).toBe(true);
    expect(result.staleCount).toBe(1);
    expect(result.warning).toContain("1 of 1 contributors (100%)");
  });

  it("falls back to row-level rules when snapshotAt is missing", () => {
    const fresh = makeRow(new Date().toISOString());
    const result = evaluateStaleExportGuard([fresh], {
      snapshotAt: undefined,
      maxAgeMs: 3600000,
    });

    expect(result.stale).toBe(false);
    expect(result.blocked).toBe(false);
  });

  it("counts all contributors as stale when none have been checked (null lastCheckedAt)", () => {
    const unchecked1 = makeRow(null);
    const unchecked2 = makeRow(null);
    const result = evaluateStaleExportGuard([unchecked1, unchecked2], {
      maxAgeMs: 3600000,
      blockWhenStale: true,
    });

    expect(result.stale).toBe(true);
    expect(result.blocked).toBe(true);
    expect(result.staleCount).toBe(2);
    expect(result.stalePercent).toBe(100);
  });

  it("handles timezone-skewed ISO timestamps without crashing", () => {
    const now = new Date();
    // ISO string with explicit timezone offset
    const timezoneSkewed = `${now.toISOString().slice(0, 19)}+05:30`;
    const result = evaluateStaleExportGuard([], {
      snapshotAt: timezoneSkewed,
      maxAgeMs: 86400000,
    });

    expect(result.stale).toBe(false);
    expect(result.blocked).toBe(false);
  });

  it("marks invalid snapshot timestamps as stale with reason", () => {
    const result = evaluateStaleExportGuard([], {
      snapshotAt: "not-a-valid-date",
      blockWhenStale: true,
    });

    expect(result.stale).toBe(true);
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("invalid_snapshot_timestamp");
  });
});

describe("assertFreshExport", () => {
  it("returns null when export is fresh", () => {
    const fresh = makeRow(new Date().toISOString());
    const result = assertFreshExport(undefined, [fresh], { maxAgeMs: 3600000 });
    expect(result).toBeNull();
  });

  it("returns error and reason when export is blocked", () => {
    const stale = makeRow(new Date(Date.now() - 7200000).toISOString());
    const result = assertFreshExport(undefined, [stale], {
      maxAgeMs: 3600000,
      blockWhenStale: true,
    });

    expect(result).not.toBeNull();
    expect(result?.error).toBeDefined();
    expect(result?.reason).toBe("stale_contributors");
  });

  it("evaluates snapshotAt directly when passed as first parameter", () => {
    const oldSnapshot = new Date(Date.now() - 7200000).toISOString();
    const result = assertFreshExport(oldSnapshot, [], {
      maxAgeMs: 3600000,
      blockWhenStale: true,
    });

    expect(result).not.toBeNull();
    expect(result?.reason).toBe("stale_snapshot");
  });
});
