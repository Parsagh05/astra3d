import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const panoramaMock = vi.hoisted(() => ({ fallback: false }));

vi.mock("@/components/tour/panorama-canvas", async () => {
  const React = await import("react");

  type MockPanoramaProps = {
    onFallbackChange?: (fallback: boolean) => void;
    onReady?: () => void;
    src: string;
  };

  return {
    PanoramaCanvas: function MockPanoramaCanvas({
      onFallbackChange,
      onReady,
      src,
    }: MockPanoramaProps) {
      React.useEffect(() => {
        onFallbackChange?.(panoramaMock.fallback);
        if (!panoramaMock.fallback) onReady?.();
      }, [onFallbackChange, onReady, src]);

      return React.createElement("div", {
        "data-fallback": panoramaMock.fallback,
        "data-src": src,
        "data-testid": "panorama-renderer",
      });
    },
  };
});

import { ImmersiveTour } from "@/components/tour/immersive-tour";

function TourHarness({
  initialHotspotId,
  initialSceneId = "arrival",
}: {
  initialHotspotId?: string;
  initialSceneId?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className="site-frame">
        <button type="button" onClick={() => setOpen(true)}>
          Open visitor tour
        </button>
      </div>
      {open ? (
        <ImmersiveTour
          initialHotspotId={initialHotspotId}
          initialSceneId={initialSceneId}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function renderTour(
  initialSceneId = "arrival",
  initialHotspotId?: string,
  onClose = vi.fn(),
) {
  window.localStorage.setItem("astra3d-tour-tips", "seen");
  const result = render(
    <ImmersiveTour
      initialHotspotId={initialHotspotId}
      initialSceneId={initialSceneId}
      onClose={onClose}
    />,
  );

  return { ...result, onClose };
}

describe("ImmersiveTour", () => {
  beforeEach(() => {
    panoramaMock.fallback = false;
    window.localStorage.clear();
    window.history.replaceState({}, "", "/");

    Object.defineProperties(HTMLElement.prototype, {
      hasPointerCapture: {
        configurable: true,
        value: vi.fn(() => true),
      },
      releasePointerCapture: {
        configurable: true,
        value: vi.fn(),
      },
      setPointerCapture: {
        configurable: true,
        value: vi.fn(),
      },
      offsetParent: {
        configurable: true,
        get() {
          return this.parentElement;
        },
      },
    });
  });

  it("opens as a modal, introduces its controls, and restores the page on exit", async () => {
    const user = userEvent.setup();
    render(<TourHarness />);

    const trigger = screen.getByRole("button", { name: "Open visitor tour" });
    const pageFrame = trigger.closest(".site-frame") as HTMLElement;
    await user.click(trigger);

    expect(
      screen.getByRole("dialog", { name: "Astra Atelier" }),
    ).toHaveAttribute("aria-modal", "true");
    expect(pageFrame).toHaveAttribute("aria-hidden", "true");
    expect(pageFrame.inert).toBe(true);
    expect(document.body).toHaveStyle({ overflow: "hidden" });
    expect(
      screen.getByRole("heading", {
        name: "Look around. Move deeper. Discover more.",
      }),
    ).toBeInTheDocument();

    const startButton = screen.getByRole("button", {
      name: /Start exploring/,
    });
    await waitFor(() => expect(startButton).toHaveFocus());
    await user.click(startButton);

    const viewport = screen.getByRole("group", {
      name: "Interactive 360 tour: Arrival",
    });
    await waitFor(() => expect(viewport).toHaveFocus());
    expect(window.localStorage.getItem("astra3d-tour-tips")).toBe("seen");

    await user.keyboard("{Escape}");

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
    expect(pageFrame).not.toHaveAttribute("aria-hidden");
    expect(pageFrame.inert).toBe(false);
    expect(document.body).not.toHaveStyle({ overflow: "hidden" });
  });

  it("skips remembered tips and focuses the panorama when the tour reopens", async () => {
    const user = userEvent.setup();
    render(<TourHarness />);

    const trigger = screen.getByRole("button", { name: "Open visitor tour" });
    await user.click(trigger);
    await user.click(
      screen.getByRole("button", { name: /Start exploring/ }),
    );

    const firstViewport = screen.getByRole("group", {
      name: "Interactive 360 tour: Arrival",
    });
    await waitFor(() => expect(firstViewport).toHaveFocus());
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());

    await user.click(trigger);

    expect(
      screen.queryByRole("heading", {
        name: "Look around. Move deeper. Discover more.",
      }),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("group", {
          name: "Interactive 360 tour: Arrival",
        }),
      ).toHaveFocus(),
    );
  });

  it("traps focus inside onboarding and nested tour overlays", async () => {
    const user = userEvent.setup();
    render(<TourHarness />);

    await user.click(
      screen.getByRole("button", { name: "Open visitor tour" }),
    );
    const startButton = screen.getByRole("button", {
      name: /Start exploring/,
    });
    await waitFor(() => expect(startButton).toHaveFocus());

    await user.tab();
    expect(startButton).toHaveFocus();
    await user.tab({ shift: true });
    expect(startButton).toHaveFocus();

    await user.click(startButton);
    const shareTrigger = within(
      screen.getByRole("navigation", { name: "Tour controls" }),
    ).getByRole("button", { name: "Share tour" });
    await user.click(shareTrigger);

    const shareDialog = screen.getByRole("dialog", { name: "Share tour" });
    const closeShare = within(shareDialog).getByRole("button", {
      name: "Close share",
    });
    const copyEmbed = within(shareDialog).getByRole("button", {
      name: "Copy embed code",
    });
    await waitFor(() => expect(closeShare).toHaveFocus());

    await user.tab({ shift: true });
    expect(copyEmbed).toHaveFocus();
    await user.tab();
    expect(closeShare).toHaveFocus();
  });

  it("closes Share over a product first and restores the Share trigger", async () => {
    const user = userEvent.setup();
    renderTour("collection");

    const productPoint = screen.getByRole("button", {
      name: /Orbit mini bag/,
    });
    await user.click(productPoint);
    expect(
      screen.getByRole("heading", { name: "Orbit mini bag" }),
    ).toBeInTheDocument();

    const shareTrigger = within(
      screen.getByRole("navigation", { name: "Tour controls" }),
    ).getByRole("button", { name: "Share tour" });
    await user.click(shareTrigger);
    await waitFor(() =>
      expect(
        within(screen.getByRole("dialog", { name: "Share tour" })).getByRole(
          "button",
          { name: "Close share" },
        ),
      ).toHaveFocus(),
    );

    await user.keyboard("{Escape}");

    expect(
      screen.queryByRole("dialog", { name: "Share tour" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Orbit mini bag" }),
    ).toBeInTheDocument();
    await waitFor(() => expect(shareTrigger).toHaveFocus());

    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("heading", { name: "Orbit mini bag" }),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Orbit mini bag/ }),
      ).toHaveFocus(),
    );
  });

  it("looks around by keyboard, pointer drag, wheel, and reset controls", async () => {
    const user = userEvent.setup();
    renderTour();

    const viewport = screen.getByRole("group", {
      name: "Interactive 360 tour: Arrival",
    });
    await waitFor(() =>
      expect(viewport).toHaveAttribute("data-panorama-ready", "true"),
    );
    expect(viewport).toHaveAttribute("data-view-yaw", "0.00");
    expect(viewport).toHaveAttribute("data-view-pitch", "-2.00");
    expect(viewport).toHaveAttribute("data-view-fov", "76.00");

    viewport.focus();
    await user.keyboard("{ArrowRight}");
    expect(viewport).toHaveAttribute("data-view-yaw", "7.00");

    await user.keyboard("{Shift>}{ArrowUp}{/Shift}");
    expect(viewport).toHaveAttribute("data-view-pitch", "8.40");

    fireEvent.keyDown(viewport, { key: "+" });
    expect(viewport).toHaveAttribute("data-view-fov", "71.00");
    fireEvent.wheel(viewport, { deltaY: 1000 });
    expect(viewport).toHaveAttribute("data-view-fov", "90.00");

    await user.click(screen.getByRole("button", { name: "Reset view" }));
    expect(viewport).toHaveAttribute("data-view-yaw", "0.00");
    expect(viewport).toHaveAttribute("data-view-pitch", "-2.00");
    expect(viewport).toHaveAttribute("data-view-fov", "76.00");

    fireEvent.pointerDown(viewport, {
      clientX: 100,
      clientY: 100,
      pointerId: 1,
    });
    expect(viewport).toHaveAttribute("data-dragging", "true");
    fireEvent.pointerMove(viewport, {
      clientX: 180,
      clientY: 50,
      pointerId: 1,
    });
    expect(viewport).toHaveAttribute("data-view-yaw", "8.40");
    expect(viewport).toHaveAttribute("data-view-pitch", "2.50");
    fireEvent.pointerUp(viewport, { pointerId: 1 });
    expect(viewport).toHaveAttribute("data-dragging", "false");
  });

  it("moves through room hotspots and the keyboard-operable floor plan", async () => {
    const user = userEvent.setup();
    renderTour();

    await user.click(
      screen.getByRole("button", { name: /Enter Collection/ }),
    );

    const dialog = screen.getByRole("dialog", { name: "Astra Atelier" });
    expect(dialog).toHaveAttribute("data-scene-id", "collection");
    expect(
      screen.getByRole("group", {
        name: "Interactive 360 tour: Collection",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("Collection, scene 2 of 3")).toHaveAttribute(
      "role",
      "status",
    );

    const tourControls = screen.getByRole("navigation", {
      name: "Tour controls",
    });
    await user.click(
      within(tourControls).getByRole("button", {
        name: "Open floor plan",
      }),
    );
    expect(
      screen.getByRole("heading", { name: "Tour floor plan" }),
    ).toBeInTheDocument();
    await user.click(
      screen.getAllByRole("button", { name: "Jump to Private Lounge" })[0],
    );

    expect(dialog).toHaveAttribute("data-scene-id", "lounge");
    expect(
      screen.queryByRole("heading", { name: "Tour floor plan" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("button", {
        name: "Private Lounge, current location",
      })[0],
    ).toHaveAttribute("aria-current", "location");
  });

  it("opens story and product hotspots, preserves focus, and keeps commerce local", async () => {
    const user = userEvent.setup();
    const { onClose } = renderTour("collection");

    const storyPoint = screen.getByRole("button", {
      name: /Tailoring notes/,
    });
    await user.click(storyPoint);

    expect(
      screen.getByRole("heading", { name: "A study in proportion" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Demonstration only")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "A study in proportion" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: /Tailoring notes/ }),
    ).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();

    const productPoint = screen.getByRole("button", {
      name: /Orbit mini bag/,
    });
    await user.click(productPoint);

    expect(
      screen.getByRole("heading", { name: "Orbit mini bag" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("group", {
        name: "Interactive 3D view of Orbit mini bag",
      }),
    ).toHaveAccessibleDescription(
      "Drag to rotate. Use arrow keys, plus, minus, or Home while focused.",
    );

    const mineralFinish = screen.getByRole("radio", { name: /Mineral/ });
    await user.click(mineralFinish);
    expect(mineralFinish).toBeChecked();
    expect(screen.getByText("Mineral finish selected")).toHaveAttribute(
      "role",
      "status",
    );

    await user.click(
      screen.getByRole("button", { name: "Add to demo bag" }),
    );
    expect(
      screen.getByRole("button", { name: "Added to demo bag" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/No order, payment, or inventory request will be submitted/),
    ).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "Orbit mini bag" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: /Orbit mini bag/ }),
    ).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("copies scene-specific links and embeddable markup", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn((value: string) => {
      void value;
      return Promise.resolve();
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    window.history.replaceState({}, "", "/?campaign=launch#contact");
    renderTour("lounge");

    await user.click(
      within(
        screen.getByRole("navigation", { name: "Tour controls" }),
      ).getByRole("button", { name: "Share tour" }),
    );
    expect(
      screen.getByRole("heading", { name: "Share tour" }),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Copy tour link" }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copiedLink = String(writeText.mock.calls[0][0]);
    expect(copiedLink).toContain("campaign=launch");
    expect(copiedLink).toContain("tour=flagship");
    expect(copiedLink).toContain("room=lounge");
    expect(copiedLink).not.toContain("#contact");
    expect(
      screen.getByRole("button", { name: "Tour link copied" }),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Copy embed code" }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(String(writeText.mock.calls[1][0])).toContain(
      '<iframe src="http://localhost:3000/?campaign=launch&tour=flagship&room=lounge"',
    );
    expect(String(writeText.mock.calls[1][0])).toContain(
      'allow="fullscreen"',
    );
    expect(String(writeText.mock.calls[1][0])).not.toMatch(
      /(?:xr-spatial-tracking|webxr)/i,
    );
  });

  it("retains every room and hotspot in accessible static browsing mode", async () => {
    const user = userEvent.setup();
    panoramaMock.fallback = true;
    renderTour();

    const viewport = screen.getByRole("group", {
      name: "Static room view: Arrival",
    });
    await waitFor(() => expect(viewport).toHaveAttribute("data-fallback", "true"));
    expect(screen.getByText("Static browsing mode")).toBeInTheDocument();
    expect(
      screen.getByText(
        "The interactive view is unavailable, but every room and item remains accessible.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Axis travel folio/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: "Look and zoom controls" }),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /Enter Collection/ }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("dialog", { name: "Astra Atelier" }),
      ).toHaveAttribute("data-scene-id", "collection"),
    );
    expect(screen.getByTestId("panorama-renderer")).toHaveAttribute(
      "data-src",
      "/images/tours/flagship/collection-2048.webp",
    );
    expect(
      screen.getByRole("button", { name: /Meridian loafer/ }),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /Orbit mini bag/ }),
    );
    const staticProduct = screen.getByRole("img", {
      name: "Static product preview of Orbit mini bag",
    });
    expect(staticProduct).toHaveAccessibleDescription(
      "3D rendering is unavailable. Finish choices and product details remain accessible.",
    );
    expect(within(staticProduct).queryByRole("group", {
      name: "Product view controls",
    })).not.toBeInTheDocument();
    expect(within(staticProduct).queryByRole("button")).not.toBeInTheDocument();
    expect(within(staticProduct).queryByRole("img")).not.toBeInTheDocument();
    expect(staticProduct.querySelector("canvas")).not.toBeInTheDocument();
  });
});
