import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { RoomStudio } from "@/components/room-capture";

describe("RoomStudio", () => {
  it("requires a secure live camera and never falls back to recording video", async () => {
    const user = userEvent.setup();
    render(<RoomStudio />);

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Scan once. Look around forever.",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("Private laptop processing")).toBeInTheDocument();

    await user.clear(screen.getByRole("textbox", { name: "Room name" }));
    await user.type(screen.getByRole("textbox", { name: "Room name" }), "Living room");
    await user.click(screen.getByRole("button", { name: /Start room scan/i }));

    await waitFor(() => {
      expect(screen.getByText("Secure live camera required")).toBeInTheDocument();
    });
    expect(screen.getByRole("heading", { name: "Rotate. We capture." })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Secure connection required" })).toBeDisabled();
    expect(screen.queryByText(/record guided video/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/individual photos/i)).not.toBeInTheDocument();
    expect(screen.getByText("0 / 24")).toBeInTheDocument();
  });
});
