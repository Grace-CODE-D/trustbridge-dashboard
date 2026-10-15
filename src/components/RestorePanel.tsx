"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RotateCcw } from "lucide-react";
import { useState } from "react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { formatRelativeTime } from "@/lib/utils";

interface DeletedRegistration {
  id: string;
  stellarAddress: string;
  deletedAt: string;
  user: {
    githubUsername: string | null;
    githubAvatarUrl: string | null;
  };
}

interface DeletedResponse {
  registrations: DeletedRegistration[];
}

interface RestoreResponse {
  success: boolean;
  registration: DeletedRegistration;
}

/**
 * RestorePanel — lists recently soft-deleted registrations and lets maintainers
 * restore them after confirmation. (#310)
 *
 * Calls:
 *   GET  /api/registrations/deleted            — list up to 50 recent deletes
 *   POST /api/registrations/:id/restore        — restore one by id (CSRF + RBAC)
 *
 * An audit log entry is written server-side on every successful restore.
 */
export function RestorePanel() {
  const queryClient = useQueryClient();
  const [selectedRegistration, setSelectedRegistration] =
    useState<DeletedRegistration | null>(null);

  const deletedQuery = useQuery<DeletedResponse>({
    queryKey: ["registrations", "deleted"],
    queryFn: async () => {
      const res = await fetch("/api/registrations/deleted");
      if (!res.ok) throw new Error("Failed to load deleted registrations");
      return (await res.json()) as DeletedResponse;
    },
  });

  const restoreMutation = useMutation<RestoreResponse, Error, string>({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/registrations/${id}/restore`, {
        method: "POST",
        // Body required so the browser sends a Content-Type that satisfies the
        // same-origin CSRF check in assertSameOrigin.
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(json?.error ?? "Restore failed");
      }
      return (await res.json()) as RestoreResponse;
    },
    onSuccess: async () => {
      // Refresh both the deleted list and the main contributor table.
      await queryClient.invalidateQueries({ queryKey: ["registrations", "deleted"] });
      await queryClient.invalidateQueries({ queryKey: ["contributors"] });
      await queryClient.invalidateQueries({ queryKey: ["audit-log"] });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Restore deleted registrations</CardTitle>
        <CardDescription>
          Recently soft-deleted registrations. Restoring a row makes it active
          again and records an audit log entry.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {deletedQuery.isLoading && (
          <div className="flex items-center gap-2 py-6 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Loading deleted registrations…
          </div>
        )}

        {deletedQuery.isError && (
          <p role="alert" className="text-sm text-destructive">
            Failed to load deleted registrations.
          </p>
        )}

        {!deletedQuery.isLoading &&
          !deletedQuery.isError &&
          (deletedQuery.data?.registrations.length ?? 0) === 0 && (
            <p className="py-4 text-sm text-muted-foreground">
              No recently deleted registrations.
            </p>
          )}

        {/* Live region announces restore results */}
        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {restoreMutation.isPending
            ? "Restoring registration…"
            : restoreMutation.isSuccess
              ? "Registration restored successfully."
              : restoreMutation.isError
                ? `Restore failed: ${restoreMutation.error?.message}`
                : ""}
        </p>

        {restoreMutation.isError && (
          <div
            role="alert"
            className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {restoreMutation.error?.message}
          </div>
        )}

        {(deletedQuery.data?.registrations.length ?? 0) > 0 && (
          <ul className="divide-y divide-border" aria-label="Deleted registrations">
            {deletedQuery.data!.registrations.map((reg) => (
              <li
                key={reg.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate font-mono text-sm">{reg.stellarAddress}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {reg.user.githubUsername
                      ? `@${reg.user.githubUsername} · `
                      : ""}
                    deleted {formatRelativeTime(reg.deletedAt)}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSelectedRegistration(reg)}
                  disabled={restoreMutation.isPending}
                  aria-label={`Restore registration for ${reg.stellarAddress}`}
                >
                  {restoreMutation.isPending &&
                  restoreMutation.variables === reg.id ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
                  ) : (
                    <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                  )}
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <ConfirmDialog
        open={selectedRegistration !== null}
        title="Restore registration?"
        description={`Restore ${selectedRegistration?.stellarAddress ?? "this registration"}? This makes it active again and records an audit log entry.`}
        confirmLabel="Restore registration"
        pending={restoreMutation.isPending}
        onCancel={() => setSelectedRegistration(null)}
        onConfirm={() => {
          if (!selectedRegistration || restoreMutation.isPending) return;
          restoreMutation.mutate(selectedRegistration.id);
          setSelectedRegistration(null);
        }}
      />
    </Card>
  );
}
