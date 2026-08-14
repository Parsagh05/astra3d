import { StrictMode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { GeneratedRoomViewer } from "@/components/room-capture/generated-room-viewer";
import type { GeneratedRoomRecord } from "@/types/capture";

vi.mock("@/components/tour/panorama-canvas", () => ({
  PanoramaCanvas: ({ src }: { src: string }) => (
    <div data-testid="generated-panorama" data-src={src} />
  ),
}));

describe("GeneratedRoomViewer", () => {
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
});
