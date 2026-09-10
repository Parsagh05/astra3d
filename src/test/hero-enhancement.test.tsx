import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HeroCanvas } from "@/components/hero-canvas";
import { setMediaQueryMatches } from "./setup";

describe("HeroCanvas progressive enhancement", () => {
  it("keeps the static hero on touch devices even after tapping", () => {
    setMediaQueryMatches("(pointer: coarse)", true);
    const { container } = render(<HeroCanvas />);
    const portal = container.querySelector(".hero-portal__canvas")!;
    fireEvent.pointerEnter(portal);
    fireEvent.touchStart(portal);
    expect(portal.querySelector("canvas")).not.toBeInTheDocument();
  });
  it("defers the WebGL scene until the visitor signals intent", async () => {
    const { container } = render(<HeroCanvas />);
    const portal = container.querySelector(".hero-portal__canvas");

    expect(portal?.querySelector("canvas")).not.toBeInTheDocument();

    fireEvent.pointerEnter(portal!);

    await waitFor(() => {
      expect(portal?.querySelector("canvas")).toBeInTheDocument();
    });
  });
});
