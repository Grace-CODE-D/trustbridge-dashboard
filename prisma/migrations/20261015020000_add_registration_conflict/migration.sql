-- CreateTable
CREATE TABLE "RegistrationConflict" (
    "id" TEXT NOT NULL,
    "maintainerOrgId" TEXT NOT NULL DEFAULT 'default',
    "attemptedAddress" TEXT NOT NULL,
    "attemptedUserId" TEXT NOT NULL,
    "existingUserId" TEXT NOT NULL,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegistrationConflict_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RegistrationConflict_attemptedAddress_idx" ON "RegistrationConflict"("attemptedAddress");

-- CreateIndex
CREATE INDEX "RegistrationConflict_attemptedUserId_idx" ON "RegistrationConflict"("attemptedUserId");

-- CreateIndex
CREATE INDEX "RegistrationConflict_existingUserId_idx" ON "RegistrationConflict"("existingUserId");

-- CreateIndex
CREATE INDEX "RegistrationConflict_maintainerOrgId_idx" ON "RegistrationConflict"("maintainerOrgId");

-- CreateIndex
CREATE INDEX "RegistrationConflict_createdAt_idx" ON "RegistrationConflict"("createdAt");

-- AddForeignKey
ALTER TABLE "RegistrationConflict" ADD CONSTRAINT "RegistrationConflict_attemptedUserId_fkey" FOREIGN KEY ("attemptedUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistrationConflict" ADD CONSTRAINT "RegistrationConflict_existingUserId_fkey" FOREIGN KEY ("existingUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
