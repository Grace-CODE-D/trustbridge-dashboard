-- CreateTable
CREATE TABLE "SorobanOutbox" (
    "id" TEXT NOT NULL,
    "maintainerOrgId" TEXT NOT NULL DEFAULT 'default',
    "action" TEXT NOT NULL DEFAULT 'register',
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SorobanOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SorobanOutbox_idempotencyKey_key" ON "SorobanOutbox"("idempotencyKey");

-- CreateIndex
CREATE INDEX "SorobanOutbox_status_createdAt_idx" ON "SorobanOutbox"("status", "createdAt");

-- CreateIndex
CREATE INDEX "SorobanOutbox_status_nextAttemptAt_idx" ON "SorobanOutbox"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "SorobanOutbox_maintainerOrgId_idx" ON "SorobanOutbox"("maintainerOrgId");
