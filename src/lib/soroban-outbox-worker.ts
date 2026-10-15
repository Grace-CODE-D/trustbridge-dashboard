import "server-only";

import { prisma } from "@/lib/prisma";
import { mirrorRegistrationToSoroban } from "@/lib/soroban-register";
import { recordAuditLog } from "@/lib/audit";

export interface OutboxProcessOptions {
  batchSize?: number;
  maxAttempts?: number;
  maintainerOrgId?: string;
}

export interface SorobanOutboxMetrics {
  total: number;
  pending: number;
  processing: number;
  completed: number;
  failed: number;
}

export async function getSorobanOutboxMetrics(
  maintainerOrgId?: string
): Promise<SorobanOutboxMetrics> {
  const whereScope = maintainerOrgId ? { maintainerOrgId } : {};
  const [total, pending, processing, completed, failed] = await Promise.all([
    prisma.sorobanOutbox.count({ where: whereScope }),
    prisma.sorobanOutbox.count({ where: { ...whereScope, status: "PENDING" } }),
    prisma.sorobanOutbox.count({ where: { ...whereScope, status: "PROCESSING" } }),
    prisma.sorobanOutbox.count({ where: { ...whereScope, status: "COMPLETED" } }),
    prisma.sorobanOutbox.count({ where: { ...whereScope, status: "FAILED" } }),
  ]);

  return { total, pending, processing, completed, failed };
}

export async function processSorobanOutbox(options: OutboxProcessOptions = {}) {
  const batchSize = options.batchSize ?? 10;
  const maxAttempts = options.maxAttempts ?? 5;

  const where: any = {
    status: "PENDING",
    nextAttemptAt: { lte: new Date() },
  };
  if (options.maintainerOrgId) {
    where.maintainerOrgId = options.maintainerOrgId;
  }

  const pending = await prisma.sorobanOutbox.findMany({
    where,
    take: batchSize,
    orderBy: { createdAt: "asc" },
  });

  let processedCount = 0;
  let successCount = 0;
  let failedCount = 0;

  for (const item of pending) {
    processedCount++;

    await prisma.sorobanOutbox.update({
      where: { id: item.id },
      data: { status: "PROCESSING" },
    });

    const payload = item.payload as { stellarAddress: string; githubUsername: string; registrationId: string };

    const result = await mirrorRegistrationToSoroban(
      {
        id: payload.registrationId,
        stellarAddress: payload.stellarAddress,
        userId: payload.githubUsername,
      } as any,
      payload.githubUsername
    );

    if (result.success) {
      successCount++;
      await prisma.sorobanOutbox.update({
        where: { id: item.id },
        data: {
          status: "COMPLETED",
          updatedAt: new Date(),
        },
      });
    } else {
      const nextAttempts = item.attempts + 1;
      const isFinalFailure = nextAttempts >= maxAttempts;
      const lastError = result.errors.join("; ");

      if (isFinalFailure) {
        failedCount++;
        await prisma.sorobanOutbox.update({
          where: { id: item.id },
          data: {
            status: "FAILED",
            attempts: nextAttempts,
            lastError,
            updatedAt: new Date(),
          },
        });

        await recordAuditLog({
          action: "soroban_outbox_exhausted",
          actorId: item.maintainerOrgId,
          targetId: item.id,
          metadata: { action: item.action, attempts: nextAttempts, error: lastError },
        });
      } else {
        // Exponential backoff retry: 5s, 25s, 125s...
        const backoffMs = Math.pow(5, nextAttempts) * 1000;
        const nextAttemptAt = new Date(Date.now() + backoffMs);

        await prisma.sorobanOutbox.update({
          where: { id: item.id },
          data: {
            status: "PENDING",
            attempts: nextAttempts,
            lastError,
            nextAttemptAt,
            updatedAt: new Date(),
          },
        });
      }
    }
  }

  return {
    processedCount,
    successCount,
    failedCount,
  };
}
