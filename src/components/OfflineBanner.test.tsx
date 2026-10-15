import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";

import { OfflineBanner } from "@/components/OfflineBanner";

// Match docs/PWA.md: browser state is read after mount, connectivity events
// update the polite live region, and the server renders no connectivity cue.
describe("OfflineBanner", () => {
  let isOnline: boolean;

  beforeEach(() => {
    isOnline = true;
    vi.spyOn(navigator, "onLine", "get").mockImplementation(() => isOnline);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function dispatchConnectivity(online: boolean) {
    isOnline = online;
    act(() => {
      window.dispatchEvent(new Event(online ? "online" : "offline"));
    });
  }

  it("renders nothing while the browser is online", () => {
    const { container } = render(<OfflineBanner />);

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows the banner after an offline event", () => {
    render(<OfflineBanner />);
    expect(screen.queryByTestId("offline-banner")).not.toBeInTheDocument();

    dispatchConnectivity(false);

    expect(screen.getByTestId("offline-banner")).toBeVisible();
  });

  it("automatically dismisses the banner after an online event", () => {
    isOnline = false;
    render(<OfflineBanner />);
    expect(screen.getByRole("status")).toBeVisible();

    dispatchConnectivity(true);

    expect(screen.queryByTestId("offline-banner")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("detects an initially offline browser without waiting for an event", () => {
    isOnline = false;

    render(<OfflineBanner />);

    expect(screen.getByTestId("offline-banner")).toBeVisible();
  });

  it("announces the connectivity message through a polite status region", () => {
    render(<OfflineBanner />);

    dispatchConnectivity(false);

    const banner = screen.getByRole("status");
    expect(banner).toBe(screen.getByTestId("offline-banner"));
    expect(banner).toHaveAttribute("aria-live", "polite");
    expect(banner).toHaveTextContent(
      "You're offline. Live Horizon data and Stellar checks are unavailable until your connection is restored.",
    );
    expect(banner.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("removes the same connectivity listeners on unmount", () => {
    const addListener = vi.spyOn(window, "addEventListener");
    const removeListener = vi.spyOn(window, "removeEventListener");
    const { unmount } = render(<OfflineBanner />);

    const onlineCalls = addListener.mock.calls.filter(([event]) => event === "online");
    const offlineCalls = addListener.mock.calls.filter(([event]) => event === "offline");
    expect(onlineCalls).toHaveLength(1);
    expect(offlineCalls).toHaveLength(1);

    unmount();

    expect(removeListener).toHaveBeenCalledWith("online", onlineCalls[0][1]);
    expect(removeListener).toHaveBeenCalledWith("offline", offlineCalls[0][1]);
  });

  it("follows rapid connectivity changes and repeated events", () => {
    render(<OfflineBanner />);

    act(() => {
      for (const online of [false, true, false, false, true, false]) {
        isOnline = online;
        window.dispatchEvent(new Event(online ? "online" : "offline"));
      }
    });
    expect(screen.getAllByRole("status")).toHaveLength(1);

    dispatchConnectivity(true);
    dispatchConnectivity(true);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("renders safely on the server without window or navigator", () => {
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("navigator", undefined);

    try {
      expect(renderToString(<OfflineBanner />)).toBe("");
    } finally {
      // Restore jsdom before Testing Library's cleanup runs.
      vi.unstubAllGlobals();
    }
  });
});
