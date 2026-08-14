import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { RoomStudio } from "@/components/room-capture";

describe("RoomStudio", () => {
  it("starts a guided single-room scan and provides the local HTTP camera fallback", async () => {
    const user = userEvent.setup();
    render(<RoomStudio />);

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Scan once. Look around forever.",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("Your scan stays on this device")).toBeInTheDocument();

    await user.clear(screen.getByRole("textbox", { name: "Room name" }));
    await user.type(screen.getByRole("textbox", { name: "Room name" }), "Living room");
    await user.click(screen.getByRole("button", { name: /Start room scan/i }));

    await waitFor(() => {
      expect(screen.getByText("One-video scan")).toBeInTheDocument();
    });
    expect(screen.getByRole("heading", { name: "Rotate. We capture." })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Record guided video" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use individual photos instead" })).toBeInTheDocument();
    expect(screen.getByText("0 / 24")).toBeInTheDocument();
  });
});
