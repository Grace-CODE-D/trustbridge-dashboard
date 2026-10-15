-- CreateTable
CREATE TABLE "SorobanEventCursor" (
    "id" TEXT NOT NULL,
    "maintainerOrgId" TEXT NOT NULL DEFAULT 'default',
    "eventType" TEXT NOT NULL DEFAULT 'contract',
    "cursor" TEXT NOT NULL,
    "lastPagingToken" TEXT,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SorobanEventCursor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SorobanEventCursor_maintainerOrgId_eventType_key" ON "SorobanEventCursor"("maintainerOrgId", "eventType");

-- CreateIndex
CREATE INDEX "SorobanEventCursor_maintainerOrgId_idx" ON "SorobanEventCursor"("maintainerOrgId");
