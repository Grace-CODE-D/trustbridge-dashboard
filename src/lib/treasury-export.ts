import "server-only";

/**
 * Environment knobs for treasury exports:
 * - `TREASURY_EXPORT_DEFAULT_PAGE_SIZE`: Default page size if limit is omitted (default: 50).
 * - `TREASURY_EXPORT_MAX_PAGE_SIZE`: Maximum allowable limit per page (default: 500).
 */
export const DEFAULT_EXPORT_PAGE_SIZE = 50;
export const MAX_EXPORT_PAGE_SIZE = 500;

function parsePositiveInt(val: string | undefined | null, fallback: number): number {
  if (!val) return fallback;
  const parsed = Number.parseInt(val, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getConfiguredPageSizes(): { defaultLimit: number; maxLimit: number } {
  const maxLimit = parsePositiveInt(
    process.env.TREASURY_EXPORT_MAX_PAGE_SIZE,
    MAX_EXPORT_PAGE_SIZE
  );
  const defaultLimit = Math.min(
    parsePositiveInt(
      process.env.TREASURY_EXPORT_DEFAULT_PAGE_SIZE,
      DEFAULT_EXPORT_PAGE_SIZE
    ),
    maxLimit
  );
  return { defaultLimit, maxLimit };
}

export type ExportPaginationResult =
  | { ok: true; offset: number; limit: number }
  | { ok: false; error: string };

export type PaginationParamSource =
  | URLSearchParams
  | { get(key: string): string | null | undefined }
  | { offset?: unknown; limit?: unknown; [key: string]: unknown }
  | null
  | undefined;

/**
 * Parse and validate export pagination parameters (offset and limit).
 * Enforces bounded limits and returns an immutable result object.
 */
export function parseExportPagination(source?: PaginationParamSource): ExportPaginationResult {
  const { defaultLimit, maxLimit } = getConfiguredPageSizes();

  if (!source) {
    return { ok: true, offset: 0, limit: defaultLimit };
  }

  let rawOffset: unknown;
  let rawLimit: unknown;

  if (typeof (source as { get?: unknown }).get === "function") {
    const getter = source as { get(key: string): string | null | undefined };
    rawOffset = getter.get("offset") ?? getter.get("skip");
    rawLimit = getter.get("limit") ?? getter.get("pageSize") ?? getter.get("page_size");
  } else if (typeof source === "object") {
    const obj = source as Record<string, unknown>;
    rawOffset = obj.offset ?? obj.skip;
    rawLimit = obj.limit ?? obj.pageSize ?? obj.page_size;
  }

  // Parse offset
  let offset = 0;
  if (rawOffset !== undefined && rawOffset !== null && rawOffset !== "") {
    const parsedOffset =
      typeof rawOffset === "number"
        ? rawOffset
        : Number.parseInt(String(rawOffset), 10);
    if (!Number.isFinite(parsedOffset) || Number.isNaN(parsedOffset)) {
      return { ok: false, error: "Invalid offset: must be an integer" };
    }
    if (parsedOffset < 0) {
      return { ok: false, error: "Offset must be greater than or equal to 0" };
    }
    offset = parsedOffset;
  }

  // Parse limit
  let limit = defaultLimit;
  if (rawLimit !== undefined && rawLimit !== null && rawLimit !== "") {
    const parsedLimit =
      typeof rawLimit === "number"
        ? rawLimit
        : Number.parseInt(String(rawLimit), 10);
    if (!Number.isFinite(parsedLimit) || Number.isNaN(parsedLimit)) {
      return { ok: false, error: "Invalid limit: must be an integer" };
    }
    if (parsedLimit <= 0) {
      return { ok: false, error: `Limit must be between 1 and ${maxLimit}` };
    }
    if (parsedLimit > maxLimit) {
      return { ok: false, error: `Limit cannot exceed ${maxLimit}` };
    }
    limit = parsedLimit;
  }

  return { ok: true, offset, limit };
}

/**
 * Streams a JSON export response with backpressure-friendly chunking.
 *
 * Supports both pre-buffered arrays and async iterables for `contributors`.
 * Renders an empty roster as `[]` with a valid closing terminator `]}`.
 */
export function streamJsonExport<T = unknown>(
  payload: Record<string, unknown> & {
    contributors?: T[] | AsyncIterable<T> | AsyncIterable<T[]> | null;
  },
  init?: ResponseInit
): Response {
  const encoder = new TextEncoder();
  const { contributors, ...metadata } = payload;
  const metaJson = JSON.stringify(metadata);

  const prefix =
    metaJson.length > 2
      ? `${metaJson.slice(0, -1)},"contributors":[`
      : `{"contributors":[`;
  const suffix = `]}`;

  const stream = new ReadableStream({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(prefix));

        if (contributors) {
          let isFirst = true;

          const emitItem = (item: T) => {
            const itemStr = (isFirst ? "" : ",") + JSON.stringify(item);
            isFirst = false;
            controller.enqueue(encoder.encode(itemStr));
          };

          if (Symbol.asyncIterator in Object(contributors)) {
            for await (const chunk of contributors as AsyncIterable<T | T[]>) {
              if (Array.isArray(chunk)) {
                for (const item of chunk) {
                  emitItem(item);
                }
              } else {
                emitItem(chunk);
              }
            }
          } else if (Array.isArray(contributors)) {
            const CHUNK_SIZE = 50;
            for (let i = 0; i < contributors.length; i += CHUNK_SIZE) {
              const slice = contributors.slice(i, i + CHUNK_SIZE);
              let chunkStr = "";
              for (const item of slice) {
                chunkStr += (isFirst ? "" : ",") + JSON.stringify(item);
                isFirst = false;
              }
              if (chunkStr) {
                controller.enqueue(encoder.encode(chunkStr));
              }
            }
          }
        }

        controller.enqueue(encoder.encode(suffix));
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });

  const responseHeaders = new Headers(init?.headers);
  if (!responseHeaders.has("Content-Type")) {
    responseHeaders.set("Content-Type", "application/json");
  }

  return new Response(stream, {
    ...init,
    status: init?.status ?? 200,
    headers: responseHeaders,
  });
}
