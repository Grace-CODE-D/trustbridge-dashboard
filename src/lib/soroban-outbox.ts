import { randomUUID } from "crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  processSorobanOutbox as workerProcessSorobanOutbox,
  type OutboxProcessOptions,
} from "@/lib/soroban-outbox-worker";

export type SorobanOutboxStatus =
  | "PENDING"
  | "PROCESSING"
  | "COMPLETED"
  | "FAILED"
  | "pending"
  | "processing"
  | "sent"
  | "failed";

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
  /** Action type (default: "register") */
  action?: string;
  /** Maintainer organization ID (default: "default") */
  maintainerOrgId?: string;
  /** Optional transaction or Prisma client */
  db?: Prisma.TransactionClient;
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
 * In production runtime, routes through Prisma `prisma.sorobanOutbox.create()`.
 * In unit tests or local dev with a configured sink, routes through the test sink.
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

  const activeSink = sinkOverride ?? globalSink;
  const now = new Date();
  const id = idempotencyKey ?? randomUUID();

  // Test sink path: execute in-memory via registered sink
  if (activeSink) {
    const existing = inMemoryOutbox.get(id);
    if (
      existing &&
      existing.status !== "FAILED" &&
      existing.status !== "failed"
    ) {
      return existing;
    }

    const entry: SorobanOutboxEntry = {
      id,
      maintainerOrgId,
      action,
      payload,
      status: "PENDING",
      attempts: existing?.attempts ?? 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    inMemoryOutbox.set(id, entry);

    try {
      await activeSink(entry);
      entry.status = "COMPLETED";
      entry.updatedAt = new Date();
      inMemoryOutbox.set(id, entry);
      return entry;
    } catch (error) {
      entry.status = "FAILED";
      entry.attempts += 1;
      entry.lastError =
        error instanceof Error ? error.message : String(error);
      entry.updatedAt = new Date();
      inMemoryOutbox.set(id, entry);
      throw error;
    }
  }

  // Production runtime path: route through Prisma create
  const client: any = db ?? prisma;
  if (client?.sorobanOutbox?.create) {
    return client.sorobanOutbox.create({
      data: {
        id: idempotencyKey ?? undefined,
        maintainerOrgId,
        action,
        payload,
        status: "PENDING",
      },
    });
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
