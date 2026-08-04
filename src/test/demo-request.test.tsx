import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import {
  DemoRequestProvider,
  DemoTrigger,
} from "@/components/demo-request";

function renderDemoFlow() {
  render(
    <DemoRequestProvider>
      <DemoTrigger>Open demo request</DemoTrigger>
    </DemoRequestProvider>,
  );
}

describe("demo request flow", () => {
  it("opens with focus, validates required fields, and reaches local success", async () => {
    const user = userEvent.setup();
    renderDemoFlow();

    const trigger = screen.getByRole("button", { name: "Open demo request" });
    await user.click(trigger);

    expect(
      screen.getByRole("dialog", { name: /Tell us where you want to take people/ }),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Full name")).toHaveFocus());
    expect(document.body).toHaveStyle({ overflow: "hidden" });

    await user.click(screen.getByRole("button", { name: /Prepare my brief/ }));

    expect(screen.getByText("Enter your full name.")).toBeInTheDocument();
    expect(screen.getByText("Enter a valid work email.")).toBeInTheDocument();
    expect(
      screen.getByText("Enter your company or studio name."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Choose the experience you want to build."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: /^Full name/ }),
    ).toHaveFocus();

    await user.type(
      screen.getByRole("textbox", { name: /^Full name/ }),
      "Alex Morgan",
    );
    await user.type(
      screen.getByRole("textbox", { name: /^Work email/ }),
      "alex@studio.test",
    );
    await user.type(
      screen.getByRole("textbox", { name: /^Company or studio/ }),
      "Northstar Studio",
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: /^Industry/ }),
      "Retail",
    );
    await user.type(
      screen.getByLabelText(/What should the experience achieve/),
      "Launch an interactive flagship.",
    );
    await user.click(screen.getByRole("button", { name: /Prepare my brief/ }));

    expect(screen.getByRole("status")).toHaveTextContent(
      "Thanks, Alex. This front-end preview keeps your details in this browser",
    );
    expect(screen.queryByLabelText("Work email")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
    expect(document.body).not.toHaveStyle({ overflow: "hidden" });
  });

  it("dismisses an incomplete request with Escape and restores trigger focus", async () => {
    const user = userEvent.setup();
    renderDemoFlow();

    const trigger = screen.getByRole("button", { name: "Open demo request" });
    await user.click(trigger);
    await waitFor(() => expect(screen.getByLabelText("Full name")).toHaveFocus());

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });
});
