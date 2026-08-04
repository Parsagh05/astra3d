import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HeroCanvas } from "@/components/hero-canvas";
import { setMediaQueryMatches } from "@/test/setup";

describe("HeroCanvas reduced-motion behavior", () => {
  it("keeps the static fallback even when WebGL is available", () => {
    setMediaQueryMatches("(prefers-reduced-motion: reduce)", true);

    const { container } = render(<HeroCanvas />);
    const portal = container.querySelector(".hero-portal__canvas");

    fireEvent.pointerEnter(portal!);

    expect(portal).toHaveAttribute("data-ready", "false");
    expect(portal?.querySelector("canvas")).not.toBeInTheDocument();
  });
});
