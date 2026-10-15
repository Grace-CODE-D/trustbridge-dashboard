import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AddressHistoryPanel } from "@/components/AddressHistoryPanel";

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
  );
}

function mockFetchOnce(body: unknown, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok,
      json: async () => body,
    })
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AddressHistoryPanel", () => {
  it("shows a loading state before the fetch resolves", () => {
    let resolveFetch: (value: unknown) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValue(
        new Promise((resolve) => {
          resolveFetch = resolve;
        })
      )
    );

    renderWithClient(<AddressHistoryPanel />);

    expect(screen.getByTestId("address-history-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("address-history-empty")).not.toBeInTheDocument();

    // Avoid an unhandled promise dangling after the test ends.
    resolveFetch({ ok: true, json: async () => ({ history: [] }) });
  });

  it("shows an explicit empty state when there is no history", async () => {
    mockFetchOnce({ history: [] });

    renderWithClient(<AddressHistoryPanel />);

    const emptyState = await screen.findByTestId("address-history-empty");
    expect(emptyState).toHaveTextContent(/No address history yet/i);
    expect(screen.queryByTestId("address-history-list")).not.toBeInTheDocument();
  });

  it("renders history entries newest-first as returned by the API", async () => {
    mockFetchOnce({
      history: [
        {
          stellarAddress: "GBSX" + "X".repeat(52),
          changeType: "updated",
          recordedAt: "2026-08-01T00:00:00.000Z",
        },
        {
          stellarAddress: "GAAA" + "A".repeat(52),
          changeType: "initial",
          recordedAt: "2026-07-01T00:00:00.000Z",
        },
      ],
    });

    renderWithClient(<AddressHistoryPanel />);

    const entries = await screen.findAllByTestId("address-history-entry");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toHaveTextContent(/Address updated/i);
    expect(entries[1]).toHaveTextContent(/Initial registration/i);
  });

  it("shows an error state when the fetch fails", async () => {
    mockFetchOnce({ error: "boom" }, false);

    renderWithClient(<AddressHistoryPanel />);

    await waitFor(() =>
      expect(screen.getByTestId("address-history-error")).toBeInTheDocument()
    );
    expect(screen.queryByTestId("address-history-empty")).not.toBeInTheDocument();
  });

  it("attaches x-csrf-token header when csrfToken is provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ history: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithClient(<AddressHistoryPanel csrfToken="test-csrf-token-123" />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/address-history",
        expect.objectContaining({
          headers: expect.objectContaining({
            "x-csrf-token": "test-csrf-token-123",
          }),
        })
      );
    });
  });
});

