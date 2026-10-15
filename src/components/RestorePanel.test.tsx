import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RestorePanel } from "./RestorePanel";

// Match the deleted-registrations API fixtures; authorization lives on the API
// and the settings page, so component tests model its responses rather than
// inventing a session prop on RestorePanel.
const registrations = [
  {
    id: "reg-1",
    stellarAddress: "GADDRESS1",
    deletedAt: "2026-08-28T00:00:00.000Z",
    user: { githubUsername: "contributor1", githubAvatarUrl: null },
  },
  {
    id: "reg-2",
    stellarAddress: "GADDRESS2",
    deletedAt: "2026-08-27T00:00:00.000Z",
    user: { githubUsername: "contributor2", githubAvatarUrl: null },
  },
];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

const fetchMock = vi.fn<typeof fetch>();
const clients: QueryClient[] = [];

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <RestorePanel />
    </QueryClientProvider>,
  );
  return client;
}

async function openConfirmation() {
  await userEvent.click(await screen.findByRole("button", {
    name: "Restore registration for GADDRESS1",
  }));
  return screen.getByRole("alertdialog", { name: "Restore registration?" });
}

describe("RestorePanel deleted registrations", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-29T00:00:00Z"));
  });

  afterEach(() => {
    cleanup();
    clients.splice(0).forEach((client) => client.clear());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows loading until the maintainer's deleted list arrives", async () => {
    const response = deferredResponse();
    fetchMock.mockReturnValueOnce(response.promise);
    renderPanel();

    expect(screen.getByText("Loading deleted registrations…")).toBeInTheDocument();
    expect(screen.queryByText("No recently deleted registrations.")).not.toBeInTheDocument();
    await act(async () => { response.resolve(json({ registrations: [] })); });
    expect(await screen.findByText("No recently deleted registrations.")).toBeInTheDocument();
    expect(screen.queryByText("Loading deleted registrations…")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/registrations/deleted");
  });

  it("shows a helpful empty state without restore controls", async () => {
    fetchMock.mockResolvedValueOnce(json({ registrations: [], hasMore: false }));
    renderPanel();

    expect(await screen.findByText("No recently deleted registrations.")).toBeVisible();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /restore/i })).not.toBeInTheDocument();
  });

  it("renders each maintainer-visible row with its username and deletion time", async () => {
    fetchMock.mockResolvedValueOnce(json({ registrations, hasMore: false }));
    renderPanel();

    const list = await screen.findByRole("list", { name: "Deleted registrations" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("GADDRESS1");
    expect(rows[0]).toHaveTextContent("@contributor1 · deleted 1d ago");
    expect(rows[1]).toHaveTextContent("GADDRESS2");
    expect(rows[1]).toHaveTextContent("@contributor2 · deleted 2d ago");
  });

  it.each([
    ["forbidden", () => Promise.resolve(json({ error: "Forbidden" }, 403))],
    ["server error", () => Promise.resolve(json({ error: "Unavailable" }, 500))],
    ["network timeout", () => Promise.reject(new TypeError("Network timeout"))],
  ])("shows an error without exposing rows on %s", async (_label, response) => {
    fetchMock.mockImplementationOnce(response);
    renderPanel();

    expect(await screen.findByRole("alert")).toHaveTextContent("Failed to load deleted registrations.");
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.queryByText("No recently deleted registrations.")).not.toBeInTheDocument();
  });

  it("requires confirmation and lets the maintainer cancel without posting", async () => {
    fetchMock.mockResolvedValueOnce(json({ registrations }));
    renderPanel();

    const dialog = await openConfirmation();
    expect(dialog).toHaveTextContent("Restore GADDRESS1?");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("posts only the confirmed row with CSRF-compatible JSON and refreshes related queries", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ registrations }))
      .mockResolvedValueOnce(json({ success: true, registration: registrations[0] }))
      .mockResolvedValueOnce(json({ registrations: [registrations[1]] }));
    const client = renderPanel();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const dialog = await openConfirmation();
    await userEvent.click(within(dialog).getByRole("button", { name: "Restore registration" }));

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("Registration restored successfully.");
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/registrations/reg-1/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["registrations", "deleted"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["contributors"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["audit-log"] });
    expect(screen.queryByText("GADDRESS1")).not.toBeInTheDocument();
    expect(screen.getByText("GADDRESS2")).toBeInTheDocument();
  });

  it("prevents duplicate POSTs on double confirmation and disables rows while pending", async () => {
    const response = deferredResponse();
    fetchMock
      .mockResolvedValueOnce(json({ registrations }))
      .mockReturnValueOnce(response.promise)
      .mockResolvedValueOnce(json({ registrations: [registrations[1]] }));
    renderPanel();
    const dialog = await openConfirmation();
    const confirm = within(dialog).getByRole("button", { name: "Restore registration" });
    // Fire in the same batch to exercise the dialog's synchronous guard.
    act(() => { fireEvent.click(confirm); fireEvent.click(confirm); });

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Restoring registration…"));
    screen.getAllByRole("button", { name: /Restore registration for/ }).forEach((button) => {
      expect(button).toBeDisabled();
      fireEvent.click(button);
    });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    await act(async () => {
      response.resolve(json({ success: true, registration: registrations[0] }));
    });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Registration restored successfully."));
  });

  it("surfaces a forbidden restore and keeps the row available for another attempt", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ registrations }))
      .mockResolvedValueOnce(json({ error: "Forbidden" }, 403));
    renderPanel();
    const dialog = await openConfirmation();
    await userEvent.click(within(dialog).getByRole("button", { name: "Restore registration" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Forbidden");
    expect(screen.getByRole("status")).toHaveTextContent("Restore failed: Forbidden");
    expect(screen.getByRole("button", { name: "Restore registration for GADDRESS1" })).toBeEnabled();
    expect(screen.getByText("GADDRESS1")).toBeInTheDocument();
  });

  it("uses the fallback error when a restore failure has no JSON body", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ registrations }))
      .mockResolvedValueOnce(new Response("Unavailable", { status: 503 }));
    renderPanel();
    const dialog = await openConfirmation();
    await userEvent.click(within(dialog).getByRole("button", { name: "Restore registration" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Restore failed");
  });
});
