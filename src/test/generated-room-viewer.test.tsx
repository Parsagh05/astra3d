import { StrictMode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GeneratedRoomViewer } from "@/components/room-capture/generated-room-viewer";
import type { GeneratedRoomRecord } from "@/types/capture";

vi.mock("@/components/tour/panorama-canvas", () => ({
  PanoramaCanvas: ({ src }: { src: string }) => (
    <div data-testid="generated-panorama" data-src={src} />
  ),
}));

describe("GeneratedRoomViewer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps the active panorama URL alive through a Strict Mode remount", async () => {
    const createdUrls: string[] = [];
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
      const url = `blob:astra3d-${createdUrls.length + 1}`;
      createdUrls.push(url);
      return url;
    });
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

    const room: GeneratedRoomRecord = {
      id: "latest-room",
      name: "Living room",
      createdAt: "2026-08-14T12:00:00.000Z",
      photoCount: 24,
      panorama: new Blob(["panorama"], { type: "image/jpeg" }),
    };

    const { unmount } = render(
      <StrictMode>
        <GeneratedRoomViewer room={room} onRetake={vi.fn()} />
      </StrictMode>,
    );

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(2));

    const activeUrl = createdUrls.at(-1);
    expect(screen.getByTestId("generated-panorama")).toHaveAttribute("data-src", activeUrl);
    expect(revokeObjectURL).toHaveBeenCalledWith(createdUrls[0]);
    expect(revokeObjectURL).not.toHaveBeenCalledWith(activeUrl);

    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith(activeUrl);
  });

  it("copies a shareable laptop room link and toggles motion controls", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:astra3d-share");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.stubGlobal("DeviceOrientationEvent", class DeviceOrientationEventStub {});

    const room: GeneratedRoomRecord = {
      id: "latest-room",
      name: "Studio loft",
      createdAt: "2026-08-14T12:00:00.000Z",
      photoCount: 24,
      panorama: new Blob(["panorama"], { type: "image/jpeg" }),
      processor: "laptop",
      serverProjectId: "proj-42",
      hasSourceFrames: true,
    };

    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<GeneratedRoomViewer room={room} onRetake={vi.fn()} />);

    const shareButton = await screen.findByRole("button", { name: "Share room link" });
    await user.click(shareButton);
    expect(writeText).toHaveBeenCalledWith(
      `${window.location.origin}/studio/?project=proj-42`,
    );
    expect(screen.getByRole("button", { name: "Link copied" })).toBeInTheDocument();

    const gyroButton = await screen.findByRole("button", { name: "Look around by moving the phone" });
    expect(gyroButton).toHaveAttribute("aria-pressed", "false");
    await user.click(gyroButton);
    expect(gyroButton).toHaveAttribute("aria-pressed", "true");

    const autoRotateButton = screen.getByRole("button", { name: "Rotate the room automatically" });
    expect(autoRotateButton).toHaveAttribute("aria-pressed", "false");
    await user.click(autoRotateButton);
    expect(autoRotateButton).toHaveAttribute("aria-pressed", "true");
    // Auto-rotate and gyroscope steering are mutually exclusive.
    expect(gyroButton).toHaveAttribute("aria-pressed", "false");
  });

  it("keeps the share action private when the room has no laptop project", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:astra3d-private");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

    const room: GeneratedRoomRecord = {
      id: "latest-room",
      name: "Private den",
      createdAt: "2026-08-14T12:00:00.000Z",
      photoCount: 24,
      panorama: new Blob(["panorama"], { type: "image/jpeg" }),
    };

    render(<GeneratedRoomViewer room={room} onRetake={vi.fn()} />);

    await screen.findByRole("button", { name: "Download 360 JPG" });
    expect(screen.queryByRole("button", { name: "Share room link" })).not.toBeInTheDocument();
  });
});
