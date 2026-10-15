import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_EXPORT_PAGE_SIZE,
  MAX_EXPORT_PAGE_SIZE,
  parseExportPagination,
  streamJsonExport,
  getConfiguredPageSizes,
} from "@/lib/treasury-export";

describe("treasury-export pagination", () => {
  it("uses default page size and zero offset when params are omitted", () => {
    const res = parseExportPagination();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.offset).toBe(0);
      expect(res.limit).toBe(DEFAULT_EXPORT_PAGE_SIZE);
    }
  });

  it("parses valid offset and limit from URLSearchParams", () => {
    const params = new URLSearchParams("offset=10&limit=25");
    const res = parseExportPagination(params);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.offset).toBe(10);
      expect(res.limit).toBe(25);
    }
  });

  it("parses valid offset and limit from object getter", () => {
    const body = { offset: 20, limit: 100 };
    const res = parseExportPagination({
      get: (k) => (body[k as keyof typeof body] !== undefined ? String(body[k as keyof typeof body]) : null),
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.offset).toBe(20);
      expect(res.limit).toBe(100);
    }
  });

  it("rejects zero page size", () => {
    const res = parseExportPagination(new URLSearchParams("limit=0"));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("Limit must be between 1 and");
    }
  });

  it("rejects negative page size", () => {
    const res = parseExportPagination(new URLSearchParams("limit=-10"));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("Limit must be between 1 and");
    }
  });

  it("rejects page size exceeding max limit", () => {
    const res = parseExportPagination(new URLSearchParams(`limit=${MAX_EXPORT_PAGE_SIZE + 1}`));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain(`Limit cannot exceed ${MAX_EXPORT_PAGE_SIZE}`);
    }
  });

  it("rejects negative offset", () => {
    const res = parseExportPagination(new URLSearchParams("offset=-1"));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("Offset must be greater than or equal to 0");
    }
  });

  it("rejects non-integer limits and offsets", () => {
    expect(parseExportPagination(new URLSearchParams("limit=abc")).ok).toBe(false);
    expect(parseExportPagination(new URLSearchParams("offset=xyz")).ok).toBe(false);
  });

  it("does not share mutable state across concurrent invocations", () => {
    const res1 = parseExportPagination(new URLSearchParams("offset=5&limit=10"));
    const res2 = parseExportPagination(new URLSearchParams("offset=15&limit=20"));

    expect(res1).not.toBe(res2);
    if (res1.ok && res2.ok) {
      expect(res1.offset).toBe(5);
      expect(res2.offset).toBe(15);
    }
  });

  it("respects env knobs for default and max page sizes", () => {
    vi.stubEnv("TREASURY_EXPORT_MAX_PAGE_SIZE", "200");
    vi.stubEnv("TREASURY_EXPORT_DEFAULT_PAGE_SIZE", "25");

    const sizes = getConfiguredPageSizes();
    expect(sizes.maxLimit).toBe(200);
    expect(sizes.defaultLimit).toBe(25);

    const res = parseExportPagination();
    if (res.ok) {
      expect(res.limit).toBe(25);
    }

    vi.unstubAllEnvs();
  });
});

describe("streamJsonExport", () => {
  it("streams empty contributor roster as valid JSON with empty array", async () => {
    const payload = {
      exportedAt: "2026-10-15T00:00:00Z",
      totalContributors: 0,
      contributors: [],
    };

    const response = streamJsonExport(payload);
    expect(response.headers.get("Content-Type")).toBe("application/json");

    const json = await response.json();
    expect(json.exportedAt).toBe("2026-10-15T00:00:00Z");
    expect(json.totalContributors).toBe(0);
    expect(json.contributors).toEqual([]);
  });

  it("streams populated array of contributors as valid JSON", async () => {
    const items = [
      { id: "1", username: "alice" },
      { id: "2", username: "bob" },
    ];
    const payload = {
      exportedAt: "2026-10-15T00:00:00Z",
      totalContributors: 2,
      contributors: items,
    };

    const response = streamJsonExport(payload);
    const json = await response.json();

    expect(json.totalContributors).toBe(2);
    expect(json.contributors).toHaveLength(2);
    expect(json.contributors[0].username).toBe("alice");
    expect(json.contributors[1].username).toBe("bob");
  });

  it("streams async iterable of contributors with chunking", async () => {
    async function* makeAsyncContributors() {
      yield [{ id: "1" }, { id: "2" }];
      yield [{ id: "3" }];
    }

    const payload = {
      total: 3,
      contributors: makeAsyncContributors(),
    };

    const response = streamJsonExport(payload);
    const json = await response.json();

    expect(json.total).toBe(3);
    expect(json.contributors).toHaveLength(3);
    expect(json.contributors[2].id).toBe("3");
  });
});
