import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HeroCanvas } from "@/components/hero-canvas";

describe("HeroCanvas progressive enhancement", () => {
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
