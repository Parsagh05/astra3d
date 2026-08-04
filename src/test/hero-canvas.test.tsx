import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { HeroCanvas } from "@/components/hero-canvas";

describe("HeroCanvas", () => {
  it("keeps the static fallback state when WebGL is unavailable", () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
    const { container } = render(<HeroCanvas />);
    const portal = container.querySelector(".hero-portal__canvas");

    fireEvent.pointerEnter(portal!);

    expect(portal).toHaveAttribute("data-ready", "false");
    expect(portal).toHaveAttribute("aria-hidden", "true");
    expect(portal?.querySelector("canvas")).not.toBeInTheDocument();
  });
});
