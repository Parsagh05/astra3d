import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/dynamic", () => ({
  default: () =>
    function DynamicTourStub({
      initialHotspotId,
      initialSceneId,
      onClose,
    }: {
      initialHotspotId?: string;
      initialSceneId?: string;
      onClose?: () => void;
    }) {
      return (
        <section
          aria-label="Loaded tour"
          data-hotspot-id={initialHotspotId}
          data-scene-id={initialSceneId}
        >
          <button type="button" onClick={onClose}>
            Close loaded tour
          </button>
        </section>
      );
    },
}));

import { TourTrigger } from "@/components/tour";
import { TourProvider, useTour } from "@/components/tour/tour-provider";

function ProviderHarness({ children }: { children: ReactNode }) {
  return (
    <TourProvider>
      <div className="site-frame">Page content</div>
      {children}
    </TourProvider>
  );
}

function HookConsumer() {
  const { openTour } = useTour();

  return (
    <button
      type="button"
      onClick={() =>
        openTour({ sceneId: "collection", hotspotId: "collection-bag" })
      }
    >
      Open exact point
    </button>
  );
}

describe("TourProvider", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("opens from a trigger, exposes the active state, and closes cleanly", async () => {
    const user = userEvent.setup();
    const stateEvent = vi.fn();
    window.addEventListener("astra3d:tour-state", stateEvent);

    render(
      <ProviderHarness>
        <TourTrigger sceneId="lounge">Enter lounge</TourTrigger>
      </ProviderHarness>,
    );

    expect(document.body).toHaveAttribute("data-tour-open", "false");
    await user.click(screen.getByRole("button", { name: "Enter lounge" }));

    const loadedTour = await screen.findByRole("region", {
      name: "Loaded tour",
    });
    expect(loadedTour).toHaveAttribute("data-scene-id", "lounge");
    expect(document.body).toHaveAttribute("data-tour-open", "true");

    await user.click(
      screen.getByRole("button", { name: "Close loaded tour" }),
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Loaded tour" }),
      ).not.toBeInTheDocument(),
    );
    expect(document.body).toHaveAttribute("data-tour-open", "false");
    expect(stateEvent).toHaveBeenCalled();

    window.removeEventListener("astra3d:tour-state", stateEvent);
  });

  it("passes a precise scene and hotspot through the context API", async () => {
    const user = userEvent.setup();
    render(
      <ProviderHarness>
        <HookConsumer />
      </ProviderHarness>,
    );

    await user.click(screen.getByRole("button", { name: "Open exact point" }));

    const loadedTour = await screen.findByRole("region", {
      name: "Loaded tour",
    });
    expect(loadedTour).toHaveAttribute("data-scene-id", "collection");
    expect(loadedTour).toHaveAttribute("data-hotspot-id", "collection-bag");
  });

  it("opens deep links and removes only tour parameters when closed", async () => {
    const user = userEvent.setup();
    window.history.replaceState(
      {},
      "",
      "/?campaign=launch&tour=flagship&room=collection&point=collection-bag#platform",
    );

    render(
      <ProviderHarness>
        <span>Deep-linked page</span>
      </ProviderHarness>,
    );

    const loadedTour = await screen.findByRole("region", {
      name: "Loaded tour",
    });
    expect(loadedTour).toHaveAttribute("data-scene-id", "collection");
    expect(loadedTour).toHaveAttribute("data-hotspot-id", "collection-bag");

    await user.click(
      screen.getByRole("button", { name: "Close loaded tour" }),
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Loaded tour" }),
      ).not.toBeInTheDocument(),
    );
    expect(window.location.search).toBe("?campaign=launch");
    expect(window.location.hash).toBe("#platform");
  });
});
