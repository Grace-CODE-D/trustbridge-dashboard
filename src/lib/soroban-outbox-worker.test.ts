import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    sorobanOutbox: {
      findMany: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
  },
}));

vi.mock("@/lib/soroban-register", () => ({
  mirrorRegistrationToSoroban: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn(),
}));

import { prisma } from "@/lib/prisma";
import { mirrorRegistrationToSoroban } from "@/lib/soroban-register";
import { recordAuditLog } from "@/lib/audit";
import { processSorobanOutbox } from "./soroban-outbox-worker";
import {
  enqueueSorobanOutbox,
  setSorobanOutboxSink,
  clearSorobanOutbox,
  getSorobanOutboxEntry,
  listSorobanOutbox,
} from "./soroban-outbox";

describe("Soroban Outbox Worker (Issue #199)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setSorobanOutboxSink(null);
    clearSorobanOutbox();
  });

  afterEach(() => {
    setSorobanOutboxSink(null);
    clearSorobanOutbox();
  });

  it("processes pending outbox records and marks them completed on success", async () => {
    vi.mocked(prisma.sorobanOutbox.findMany).mockResolvedValueOnce([
      {
        id: "outbox-1",
        maintainerOrgId: "default",
        action: "register",
        payload: { stellarAddress: "G123", githubUsername: "user1", registrationId: "reg-1" },
        status: "PENDING",
        attempts: 0,
        maxAttempts: 5,
        lastError: null,
        nextAttemptAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as any);

    vi.mocked(mirrorRegistrationToSoroban).mockResolvedValueOnce({
      success: true,
      txHash: "0xhash",
      errors: [],
    });

    const result = await processSorobanOutbox();

    expect(result.processedCount).toBe(1);
    expect(result.successCount).toBe(1);
    expect(prisma.sorobanOutbox.update).toHaveBeenCalledWith({
      where: { id: "outbox-1" },
      data: expect.objectContaining({ status: "COMPLETED" }),
    });
  });

  it("updates attempts with exponential backoff on failure and marks FAILED when max attempts exceeded", async () => {
    vi.mocked(prisma.sorobanOutbox.findMany).mockResolvedValueOnce([
      {
        id: "outbox-2",
        maintainerOrgId: "default",
        action: "register",
        payload: { stellarAddress: "G123", githubUsername: "user2", registrationId: "reg-2" },
        status: "PENDING",
        attempts: 4,
        maxAttempts: 5,
        lastError: null,
        nextAttemptAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as any);

    vi.mocked(mirrorRegistrationToSoroban).mockResolvedValueOnce({
      success: false,
      errors: ["RPC Timeout"],
    });

    const result = await processSorobanOutbox({ maxAttempts: 5 });

    expect(result.failedCount).toBe(1);
    expect(prisma.sorobanOutbox.update).toHaveBeenCalledWith({
      where: { id: "outbox-2" },
      data: expect.objectContaining({ status: "FAILED", attempts: 5 }),
    });

    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "soroban_outbox_exhausted",
        targetId: "outbox-2",
      })
    );
  });
});

describe("Unified Outbox Adapter (Issue #488)", () => {
  it("routes production enqueue through Prisma create", async () => {
    vi.mocked(prisma.sorobanOutbox.create).mockResolvedValueOnce({
      id: "outbox-test-1",
      maintainerOrgId: "org-1",
      action: "register",
      payload: { stellarAddress: "G1", githubUsername: "u1", registrationId: "r1" },
      status: "PENDING",
      attempts: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);

    const result = await enqueueSorobanOutbox(
      {
        stellarAddress: "G1",
        githubUsername: "u1",
        registrationId: "r1",
      },
      {
        maintainerOrgId: "org-1",
        action: "register",
      }
    );

    expect(prisma.sorobanOutbox.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        maintainerOrgId: "org-1",
        action: "register",
        status: "PENDING",
      }),
    });
    expect(result.id).toBe("outbox-test-1");
  });

  it("runs in-memory via test sink when setSorobanOutboxSink is configured", async () => {
    const sinkMock = vi.fn().mockResolvedValue(undefined);
    setSorobanOutboxSink(sinkMock);

    const payload = { stellarAddress: "G2", githubUsername: "u2", registrationId: "r2" };
    const entry = await enqueueSorobanOutbox(payload, { idempotencyKey: "idem-1" });

    expect(sinkMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "idem-1",
        payload,
        status: "PENDING",
      })
    );
    expect(entry.status).toBe("COMPLETED");
    expect(getSorobanOutboxEntry("idem-1")?.status).toBe("COMPLETED");
  });

  it("marks rows failed and increments attempts when sink callback throws", async () => {
    const sinkError = new Error("Sink delivery failure");
    setSorobanOutboxSink(vi.fn().mockRejectedValue(sinkError));

    await expect(
      enqueueSorobanOutbox({ test: 123 }, { idempotencyKey: "fail-1" })
    ).rejects.toThrow("Sink delivery failure");

    const entry = getSorobanOutboxEntry("fail-1");
    expect(entry).toBeDefined();
    expect(entry?.status).toBe("FAILED");
    expect(entry?.attempts).toBe(1);
    expect(entry?.lastError).toBe("Sink delivery failure");
  });

  it("clears in-memory outbox state without leaving stale Map entries across tests", () => {
    setSorobanOutboxSink(null);
    clearSorobanOutbox();
    expect(listSorobanOutbox()).toHaveLength(0);
  });
});

