import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RoomStudio } from "@/components/room-capture";
import type { GeneratedRoomRecord, SharedRoomProject } from "@/types/capture";

const sharedProject: SharedRoomProject = {
  id: "proj-1",
  name: "Studio loft",
  createdAt: "2026-08-14T12:00:00.000Z",
  photoCount: 24,
  hasSourceFrames: true,
  processor: "laptop",
};

const sharedRoom: GeneratedRoomRecord = {
  id: "latest-room",
  name: "Studio loft",
  createdAt: "2026-08-14T12:00:00.000Z",
  photoCount: 24,
  panorama: new Blob(["panorama"], { type: "image/jpeg" }),
  processor: "laptop",
  serverProjectId: "proj-1",
  hasSourceFrames: true,
};

vi.mock("@/components/tour/panorama-canvas", () => ({
  PanoramaCanvas: ({ src }: { src: string }) => (
    <div data-testid="generated-panorama" data-src={src} />
  ),
}));

vi.mock("@/components/room-capture/shared-projects-api", () => ({
  fetchSharedProjects: vi.fn(async () => [sharedProject]),
  loadSharedProject: vi.fn(async () => sharedRoom),
  syncSavedRoom: vi.fn(async () => null),
}));

vi.mock("@/components/room-capture/room-storage", () => ({
  saveGeneratedRoom: vi.fn(async () => undefined),
  loadGeneratedRoom: vi.fn(async () => undefined),
  deleteGeneratedRoom: vi.fn(async () => undefined),
}));

describe("RoomStudio shared room links", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState({}, "", "/studio/");
  });

  it("opens the linked shared project directly from a ?project= URL", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:astra3d-linked");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    window.history.replaceState({}, "", "/studio/?project=proj-1");

    render(<RoomStudio />);

    expect(
      await screen.findByRole("heading", { level: 1, name: "Studio loft" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Share room link" })).toBeInTheDocument();
  });

  it("reports a link that no longer matches a laptop project", async () => {
    window.history.replaceState({}, "", "/studio/?project=missing");

    render(<RoomStudio />);

    expect(
      await screen.findByText("The shared room link does not match a project on this laptop."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "Scan once. Look around forever." }),
    ).toBeInTheDocument();
  });
});
