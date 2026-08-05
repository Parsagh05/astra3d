import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { ExperienceShowcase } from "@/components/platform/experience-showcase";
import { TourProvider } from "@/components/tour/tour-provider";
import { experiences } from "@/data/platform";

function renderShowcase() {
  render(
    <TourProvider>
      <ExperienceShowcase experiences={experiences} />
    </TourProvider>,
  );
}

describe("ExperienceShowcase", () => {
  it("supports roving keyboard focus and updates the selected experience", async () => {
    const user = userEvent.setup();
    renderShowcase();

    const retailTab = screen.getByRole("tab", { name: /Retail/ });
    const realEstateTab = screen.getByRole("tab", { name: /Real Estate/ });

    retailTab.focus();
    await user.keyboard("{ArrowRight}");

    expect(realEstateTab).toHaveFocus();
    expect(realEstateTab).toHaveAttribute("aria-selected", "true");
    expect(retailTab).toHaveAttribute("tabindex", "-1");
    expect(
      screen.getByRole("heading", {
        level: 3,
        name: "Make the materials tangible.",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", {
        name: /contemporary luxury residence/i,
      }),
    ).toHaveAttribute("src", "/images/experience-real-estate.webp");

    await user.keyboard("{End}");
    expect(screen.getByRole("tab", { name: /Art/ })).toHaveFocus();
    expect(
      screen.getByText("A gallery with infinite walls."),
    ).toBeInTheDocument();
  });

  it("changes the detail panel when a hotspot is activated", async () => {
    const user = userEvent.setup();
    renderShowcase();

    const checkoutHotspot = screen.getByRole("button", {
      name: "3 Instant checkout — explore hotspot",
    });
    expect(checkoutHotspot).toHaveAttribute("aria-pressed", "false");

    await user.click(checkoutHotspot);

    expect(checkoutHotspot).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("heading", {
        level: 3,
        name: "Keep momentum to the cart.",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Move visitors from inspiration to an existing commerce flow/),
    ).toBeInTheDocument();
  });
});
