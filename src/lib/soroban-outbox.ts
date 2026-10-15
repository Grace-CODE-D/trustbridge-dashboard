import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";

export type SorobanOutboxStatus = "pending" | "processing" | "sent" | "completed" | "failed";

export interface SorobanOutboxEntry {
  id: string;
  maintainerOrgId?: string;
  action?: string;
  payload: unknown;
  status: string;
  attempts: number;
  maxAttempts?: number;
  lastError?: string | null;
  nextAttemptAt?: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export type SorobanOutboxSink = (
  entry: SorobanOutboxEntry
) => Promise<void> | void;

export interface EnqueueSorobanOutboxOptions {
  /** Optional idempotency key so retries do not duplicate the mirror. */
  idempotencyKey?: string;
  /** Optional maintainer org ID. */
  maintainerOrgId?: string;
  /** Optional action name. */
  action?: string;
  /** Optional sink override, primarily for tests. */
  sink?: SorobanOutboxSink;
}

const inMemoryOutbox = new Map<string, SorobanOutboxEntry>();
let globalSink: SorobanOutboxSink | null = null;

/**
 * Register the process-wide sink used to deliver outbox entries to Soroban in unit tests.
 */
export function setSorobanOutboxSink(sink?: SorobanOutboxSink | null): void {
  globalSink = sink ?? null;
}

/**
 * Resets the in-memory outbox Map between test runs to avoid stale singleton state.
 */
export function clearSorobanOutbox(): void {
  inMemoryOutbox.clear();
}

export function getSorobanOutboxEntry(
  id: string
): SorobanOutboxEntry | undefined {
  return inMemoryOutbox.get(id);
}

export function listSorobanOutbox(): SorobanOutboxEntry[] {
  return Array.from(inMemoryOutbox.values());
}

/**
 * Enqueue a registration write-through task into the Soroban outbox.
 *
 * Persists durable records to PostgreSQL via Prisma with an in-memory fallback.
 * Failures are surfaced (thrown) rather than swallowed so callers such as the
 * register route can report a real error instead of a silent no-op.
 */
export async function enqueueSorobanOutbox(
  arg1: any,
  arg2?: any,
  arg3?: any,
  arg4?: any
): Promise<SorobanOutboxEntry | any> {
  let db: Prisma.TransactionClient | undefined;
  let action = "register";
  let payload: any;
  let maintainerOrgId = "default";
  let idempotencyKey: string | undefined;
  let sinkOverride: SorobanOutboxSink | undefined;

  // Support both (db, action, payload, maintainerOrgId) and (payload, options)
  if (
    arg1 &&
    (arg1.sorobanOutbox ||
      typeof arg1.$executeRaw === "function" ||
      typeof arg2 === "string")
  ) {
    db = arg1;
    action = arg2 ?? "register";
    payload = arg3;
    maintainerOrgId = arg4 ?? "default";
  } else {
    payload = arg1;
    const options: EnqueueSorobanOutboxOptions = arg2 ?? {};
    idempotencyKey = options.idempotencyKey;
    action = options.action ?? "register";
    maintainerOrgId = options.maintainerOrgId ?? "default";
    db = options.db;
    sinkOverride = options.sink;
  }

  if (payload === undefined || payload === null) {
    throw new Error("enqueueSorobanOutbox: payload is required");
  }

  const now = new Date().toISOString();
  const idempotencyKey = options.idempotencyKey;
  const maintainerOrgId = options.maintainerOrgId ?? "default";
  const action = options.action ?? "register";

  let entry: SorobanOutboxEntry;

  try {
    if (idempotencyKey) {
      const existing = await prisma.sorobanOutbox.findFirst({
        where: { idempotencyKey },
      });
      if (existing && existing.status !== "FAILED") {
        const existingEntry: SorobanOutboxEntry = {
          id: existing.id,
          payload: existing.payload,
          status: existing.status.toLowerCase() as SorobanOutboxStatus,
          attempts: existing.attempts,
          lastError: existing.lastError ?? undefined,
          createdAt: existing.createdAt.toISOString(),
          updatedAt: existing.updatedAt.toISOString(),
        };
        outbox.set(existing.id, existingEntry);
        return existingEntry;
      }
    }

    const created = await prisma.sorobanOutbox.create({
      data: {
        maintainerOrgId,
        action,
        payload: payload as any,
        idempotencyKey: idempotencyKey ?? undefined,
        status: "PENDING",
      },
    });

    entry = {
      id: created.id,
      payload: created.payload,
      status: "pending",
      attempts: created.attempts,
      createdAt: created.createdAt.toISOString(),
      updatedAt: created.updatedAt.toISOString(),
    };
  } catch {
    // In-memory fallback if Prisma is unavailable
    const id = idempotencyKey ?? randomUUID();
    const existing = outbox.get(id);
    if (existing && existing.status !== "failed") {
      return existing;
    }

    entry = {
      id,
      payload,
      status: "pending",
      attempts: existing?.attempts ?? 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
  }

  outbox.set(entry.id, entry);

    try {
      await activeSink(entry);
      entry.status = "sent";
      entry.updatedAt = new Date().toISOString();
      outbox.set(entry.id, entry);
      try {
        await prisma.sorobanOutbox.update({
          where: { id: entry.id },
          data: { status: "COMPLETED" },
        });
      } catch {
        // Ignored
      }
    } catch (error) {
      entry.status = "FAILED";
      entry.attempts += 1;
      entry.lastError = error instanceof Error ? error.message : String(error);
      entry.updatedAt = new Date().toISOString();
      outbox.set(entry.id, entry);
      try {
        await prisma.sorobanOutbox.update({
          where: { id: entry.id },
          data: {
            status: "FAILED",
            attempts: entry.attempts,
            lastError: entry.lastError,
          },
        });
      } catch {
        // Ignored
      }
      throw error;
    }
  }

  return entry;
}

export async function getSorobanOutboxEntry(id: string): Promise<SorobanOutboxEntry | undefined> {
  try {
    const record = await prisma.sorobanOutbox.findUnique({
      where: { id },
    });
    if (record) {
      const entry: SorobanOutboxEntry = {
        id: record.id,
        payload: record.payload,
        status: record.status.toLowerCase() as SorobanOutboxStatus,
        attempts: record.attempts,
        lastError: record.lastError ?? undefined,
        createdAt: record.createdAt.toISOString(),
        updatedAt: record.updatedAt.toISOString(),
      };
      outbox.set(record.id, entry);
      return entry;
    }
  } catch {
    // Ignored
  }
  return outbox.get(id);
}

  // In-memory fallback if Prisma is not available and no sink is set
  const entry: SorobanOutboxEntry = {
    id,
    maintainerOrgId,
    action,
    payload,
    status: "PENDING",
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };
  inMemoryOutbox.set(id, entry);
  return entry;
}

export const processSorobanOutbox = workerProcessSorobanOutbox;
export type { OutboxProcessOptions };
