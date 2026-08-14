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
        name: "Turn phone photos into your first 360° room.",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("Photos stay on this device")).toBeInTheDocument();

    await user.clear(screen.getByRole("textbox", { name: "Room name" }));
    await user.type(screen.getByRole("textbox", { name: "Room name" }), "Living room");
    await user.click(screen.getByRole("button", { name: /Start room scan/i }));

    await waitFor(() => {
      expect(screen.getByText("Android camera mode")).toBeInTheDocument();
    });
    expect(screen.getByRole("heading", { name: "Photograph every layer." })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Capture 1" })).toBeInTheDocument();
    expect(screen.getByText("0 / 24")).toBeInTheDocument();
  });
});
