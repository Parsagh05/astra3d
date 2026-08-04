import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { DemoRequestProvider } from "@/components/demo-request";
import { SiteHeader } from "@/components/site-header";

function renderHeader() {
  return render(
    <DemoRequestProvider>
      <SiteHeader />
    </DemoRequestProvider>,
  );
}

describe("SiteHeader", () => {
  it("opens and closes the mobile navigation while preserving anchor targets", async () => {
    const user = userEvent.setup();
    renderHeader();

    const menuButton = screen.getByRole("button", {
      name: "Open navigation",
    });
    const mobileNavigation = screen.getByRole("navigation", {
      name: "Mobile navigation",
    });

    expect(menuButton).toHaveAttribute("aria-expanded", "false");
    expect(mobileNavigation).toHaveAttribute("data-open", "false");

    await user.click(menuButton);

    expect(
      screen.getByRole("button", { name: "Close navigation" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(mobileNavigation).toHaveAttribute("data-open", "true");

    const experiencesLink = within(mobileNavigation).getByRole("link", {
      name: "Experiences",
    });
    expect(experiencesLink).toHaveAttribute("href", "#experiences");

    await user.click(experiencesLink);

    expect(menuButton).toHaveAttribute("aria-expanded", "false");
    expect(mobileNavigation).toHaveAttribute("data-open", "false");
  });

  it("dismisses the open mobile navigation with Escape", async () => {
    const user = userEvent.setup();
    renderHeader();

    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    expect(
      screen.getByRole("navigation", { name: "Mobile navigation" }),
    ).toHaveAttribute("data-open", "true");

    await user.keyboard("{Escape}");

    expect(
      screen.getByRole("button", { name: "Open navigation" }),
    ).toHaveAttribute("aria-expanded", "false");
  });
});
