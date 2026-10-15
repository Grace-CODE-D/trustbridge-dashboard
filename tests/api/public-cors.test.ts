import { describe, expect, it } from "vitest";

import { OPTIONS as checkOptions } from "@/app/api/check/route";
import { OPTIONS as lookupOptions } from "@/app/api/actions/lookup/route";
import { OPTIONS as contractSyncOptions } from "@/app/api/contract-sync/route";
import { OPTIONS as healthOptions } from "@/app/api/health/route";
import { OPTIONS as openapiOptions } from "@/app/api/openapi.json/route";
import { OPTIONS as statsOptions } from "@/app/api/stats/route";

describe("public API CORS preflight", () => {
  it.each([
    ["/api/check", checkOptions, "POST, OPTIONS"],
    ["/api/actions/lookup", lookupOptions, "GET, OPTIONS"],
    ["/api/contract-sync", contractSyncOptions, "GET, OPTIONS"],
    ["/api/health", healthOptions, "GET, OPTIONS"],
    ["/api/openapi.json", openapiOptions, "GET, OPTIONS"],
    ["/api/stats", statsOptions, "GET, OPTIONS"],
  ])("handles OPTIONS for %s", async (_path, options, methods) => {
    const response = await options();

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-methods")).toBe(methods);
    expect(response.headers.get("allow")).toBe(methods);
  });

  it("allows JSON and the public check cache-bypass header", async () => {
    const response = await checkOptions();

    expect(response.headers.get("access-control-allow-headers")).toBe(
      "Content-Type, X-Cache-Bypass"
    );
  });
});