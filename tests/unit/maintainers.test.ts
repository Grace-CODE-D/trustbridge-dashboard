import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    registration: {
      findFirst: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
    },
    registrationConflict: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn(),
}));

import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/lib/audit";
import {
  isMaintainer,
  getMaintainerContext,
  appendRegistrationNote,
  recordRegistrationConflict,
  listRegistrationConflicts,
  listDeletedRegistrations,
} from "@/lib/maintainers";

describe("Maintainers Helpers (src/lib/maintainers.ts)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("isMaintainer", () => {
    it("returns true for maintainer user", async () => {
      expect(await isMaintainer({ isMaintainer: true })).toBe(true);
    });

    it("returns false for non-maintainer or missing user", async () => {
      expect(await isMaintainer({ isMaintainer: false })).toBe(false);
      expect(await isMaintainer(null)).toBe(false);
      expect(await isMaintainer(undefined)).toBe(false);
    });
  });

  describe("getMaintainerContext", () => {
    it("resolves context from NextAuth session with maintainerOrgId", () => {
      const session = {
        user: {
          id: "m-1",
          isMaintainer: true,
          maintainerOrgId: "org-custom",
          role: "admin",
        },
      };
      const ctx = getMaintainerContext(session);
      expect(ctx.userId).toBe("m-1");
      expect(ctx.maintainerOrgId).toBe("org-custom");
      expect(ctx.isMaintainer).toBe(true);
      expect(ctx.role).toBe("admin");
    });

    it("resolves context from API key auth mapping to same org scope", () => {
      const apiKeyCtx = {
        id: "key-1",
        maintainerOrgId: "org-custom",
        role: "operator",
      };
      const ctx = getMaintainerContext(apiKeyCtx);
      expect(ctx.maintainerOrgId).toBe("org-custom");
      expect(ctx.isMaintainer).toBe(true);
      expect(ctx.role).toBe("operator");
    });

    it("defaults maintainerOrgId to 'default' when omitted", () => {
      const session = {
        user: {
          id: "m-1",
          isMaintainer: true,
        },
      };
      const ctx = getMaintainerContext(session);
      expect(ctx.maintainerOrgId).toBe("default");
    });

    it("returns non-maintainer context for unauthenticated requests", () => {
      const ctx = getMaintainerContext(null);
      expect(ctx.isMaintainer).toBe(false);
      expect(ctx.maintainerOrgId).toBe("default");
    });
  });

  describe("appendRegistrationNote", () => {
    it("appends note to active registration and records audit log", async () => {
      vi.mocked(prisma.registration.findFirst).mockResolvedValue({
        id: "reg-1",
        maintainerOrgId: "org-1",
        stellarAddress: "GABC123",
        deletedAt: null,
        notes: "Previous note",
      } as any);

      vi.mocked(prisma.registration.update).mockResolvedValue({
        id: "reg-1",
        notes: "Previous note\nNew note",
      } as any);

      const res = await appendRegistrationNote({
        registrationId: "reg-1",
        note: "New note",
        maintainerOrgId: "org-1",
        authorId: "m-1",
        authorLogin: "maintainer",
      });

      expect(prisma.registration.findFirst).toHaveBeenCalledWith({
        where: { id: "reg-1", maintainerOrgId: "org-1" },
      });
      expect(prisma.registration.update).toHaveBeenCalledWith({
        where: { id: "reg-1" },
        data: { notes: "Previous note\nNew note" },
      });
      expect(recordAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "registration.note_update",
          actorId: "m-1",
          actorLogin: "maintainer",
          targetId: "reg-1",
        })
      );
      expect(res).toBeDefined();
    });

    it("rejects notes on soft-deleted registrations", async () => {
      vi.mocked(prisma.registration.findFirst).mockResolvedValue({
        id: "reg-1",
        maintainerOrgId: "org-1",
        deletedAt: new Date(),
        notes: null,
      } as any);

      await expect(
        appendRegistrationNote({
          registrationId: "reg-1",
          note: "Note on deleted",
          maintainerOrgId: "org-1",
        })
      ).rejects.toThrow("Cannot append note to a soft-deleted registration");

      expect(prisma.registration.update).not.toHaveBeenCalled();
      expect(recordAuditLog).not.toHaveBeenCalled();
    });

    it("does not overwrite existing notes with empty or whitespace-only note", async () => {
      const res = await appendRegistrationNote({
        registrationId: "reg-1",
        note: "   ",
        maintainerOrgId: "org-1",
      });

      expect(res).toBeNull();
      expect(prisma.registration.findFirst).not.toHaveBeenCalled();
      expect(prisma.registration.update).not.toHaveBeenCalled();
    });

    it("returns null if registration not found", async () => {
      vi.mocked(prisma.registration.findFirst).mockResolvedValue(null);

      const res = await appendRegistrationNote({
        registrationId: "reg-nonexistent",
        note: "Hello",
        maintainerOrgId: "org-1",
      });

      expect(res).toBeNull();
      expect(prisma.registration.update).not.toHaveBeenCalled();
    });
  });

  describe("recordRegistrationConflict", () => {
    it("creates conflict row with maintainerOrgId and logs audit event", async () => {
      vi.mocked(prisma.registrationConflict.create).mockResolvedValue({
        id: "conflict-1",
        attemptedAddress: "GABC...",
        attemptedUserId: "user-2",
        existingUserId: "user-1",
        maintainerOrgId: "org-1",
      } as any);

      const result = await recordRegistrationConflict({
        attemptedAddress: "GABC...",
        attemptedUserId: "user-2",
        existingUserId: "user-1",
        maintainerOrgId: "org-1",
        actorLogin: "user2",
        existingRegistrationId: "reg-1",
      });

      expect(prisma.registrationConflict.create).toHaveBeenCalledWith({
        data: {
          attemptedAddress: "GABC...",
          attemptedUserId: "user-2",
          existingUserId: "user-1",
          maintainerOrgId: "org-1",
        },
      });
      expect(recordAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "registration.conflict",
          actorId: "user-2",
          actorLogin: "user2",
          targetId: "reg-1",
        })
      );
      expect(result).toBeDefined();
    });
  });

  describe("listRegistrationConflicts", () => {
    it("filters conflicts by maintainerOrgId", async () => {
      vi.mocked(prisma.registrationConflict.findMany).mockResolvedValue([
        {
          id: "c-1",
          attemptedAddress: "G1",
          attemptedUserId: "u2",
          existingUserId: "u1",
          createdAt: new Date(),
          maintainerOrgId: "org-1",
        },
      ] as any);

      const res = await listRegistrationConflicts({ maintainerOrgId: "org-1" });
      expect(prisma.registrationConflict.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { maintainerOrgId: "org-1" },
          orderBy: { createdAt: "desc" },
        })
      );
      expect(res).toHaveLength(1);
    });
  });

  describe("listDeletedRegistrations", () => {
    it("enforces maintainerOrgId and deletedAt: not null", async () => {
      vi.mocked(prisma.registration.findMany).mockResolvedValue([]);

      await listDeletedRegistrations({ maintainerOrgId: "org-1", limit: 10 });

      expect(prisma.registration.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { deletedAt: { not: null }, maintainerOrgId: "org-1" },
          take: 11,
        })
      );
    });
  });
});
