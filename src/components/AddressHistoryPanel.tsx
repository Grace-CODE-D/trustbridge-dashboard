"use client";

import { useQuery } from "@tanstack/react-query";
import { Clock3, History, Loader2 } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn, formatRelativeTime, shortenAddress } from "@/lib/utils";

interface AddressHistoryEntry {
  stellarAddress: string;
  changeType: string;
  recordedAt: string;
}

interface AddressHistoryResponse {
  history: AddressHistoryEntry[];
}

const CHANGE_TYPE_LABEL: Record<string, string> = {
  initial: "Initial registration",
  updated: "Address updated",
};

export interface AddressHistoryPanelProps {
  className?: string;
  csrfToken?: string;
}

export async function fetchAddressHistory(
  csrfToken?: string
): Promise<AddressHistoryResponse> {
  const headers: Record<string, string> = {};
  if (csrfToken) {
    headers["x-csrf-token"] = csrfToken;
  }
  const response = await fetch("/api/address-history", { headers });
  if (!response.ok) throw new Error("Failed to load address history");
  return (await response.json()) as AddressHistoryResponse;
}

export function AddressHistoryPanel({
  className,
  csrfToken,
}: AddressHistoryPanelProps) {
  const historyQuery = useQuery({
    queryKey: ["address-history", csrfToken],
    queryFn: () => fetchAddressHistory(csrfToken),
  });

  const entries = historyQuery.data?.history ?? [];

  return (
    <Card className={cn("border-stellar-purple/20", className)} data-testid="address-history-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <History className="h-5 w-5 text-stellar-purple" />
          Address history
        </CardTitle>
        <CardDescription>
          A timeline of every Stellar address you have registered, newest
          first.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {historyQuery.isLoading && (
          <div
            className="flex items-center justify-center py-10 text-muted-foreground"
            role="status"
            data-testid="address-history-loading"
          >
            <Loader2 className="mr-2 h-5 w-5 animate-spin" aria-hidden="true" />
            Loading address history...
          </div>
        )}

        {historyQuery.isError && (
          <p
            className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive"
            role="alert"
            data-testid="address-history-error"
          >
            Could not load your address history. Try refreshing the page.
          </p>
        )}

        {!historyQuery.isLoading && !historyQuery.isError && entries.length === 0 && (
          <div
            role="status"
            aria-live="polite"
            data-testid="address-history-empty"
            className="rounded-xl border border-dashed bg-muted/20 px-6 py-10 text-center"
          >
            <Clock3
              className="mx-auto h-8 w-8 text-muted-foreground"
              aria-hidden="true"
            />
            <h3 className="mt-3 text-base font-semibold">No address history yet</h3>
            <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
              Once you register a Stellar address, changes will show up here so
              you can track what was on file and when.
            </p>
          </div>
        )}

        {!historyQuery.isLoading && !historyQuery.isError && entries.length > 0 && (
          <ul className="space-y-3" data-testid="address-history-list">
            {entries.map((entry, index) => (
              <li
                key={`${entry.recordedAt}-${index}`}
                className="rounded-lg border bg-card/50 px-3 py-2"
                data-testid="address-history-entry"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">
                    {CHANGE_TYPE_LABEL[entry.changeType] ?? entry.changeType}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatRelativeTime(entry.recordedAt)}
                  </span>
                </div>
                <p
                  className="mt-1 font-mono text-xs text-muted-foreground break-all"
                  title={entry.stellarAddress}
                >
                  {shortenAddress(entry.stellarAddress)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
