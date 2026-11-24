// @vitest-environment node
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "astra3d-tours-"));
  process.env.ASTRA3D_DATA_DIR = root;
  vi.resetModules();
});

afterEach(async () => {
  delete process.env.ASTRA3D_DATA_DIR;
  if (!path.resolve(root).startsWith(path.resolve(tmpdir()))) throw new Error("Refusing to clean an unexpected path.");
  await rm(root, { recursive: true, force: true });
});

const PROJECT_A = "0f8fad5b-d9cb-469f-a165-70867728950e";
const PROJECT_B = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

const input = {
  name: "Our house",
  startSpotId: "hall",
  spots: [
    { id: "hall", projectId: PROJECT_A, name: "Hall", startYaw: 0, links: [{ id: "to-kitchen", targetSpotId: "kitchen", yaw: 45, pitch: -20 }] },
    { id: "kitchen", projectId: PROJECT_B, name: "Kitchen", startYaw: 0, links: [] },
  ],
};

function request(method: string, body?: unknown, client = "room-studio-v1") {
  return new Request("http://localhost/api/tours", {
    method,
    headers: { "Content-Type": "application/json", "X-Astra3D-Client": client },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

const params = (tourId: string) => ({ params: Promise.resolve({ tourId }) });

async function loadRoutes() {
  return { tours: await import("@/app/api/tours/route"), tour: await import("@/app/api/tours/[tourId]/route") };
}

describe("tours API", () => {
  it("creates, lists, updates and deletes a tour", async () => {
    const { tours, tour } = await loadRoutes();
    const created = await tours.POST(request("POST", input));
    expect(created.status).toBe(201);
    const { tour: saved } = await created.json();
    expect(saved).toMatchObject({ name: "Our house", startSpotId: "hall", spots: [{ id: "hall", links: [{ targetSpotId: "kitchen", yaw: 45 }] }, { id: "kitchen" }] });
    expect(await readdir(path.join(root, "tours"))).toEqual([`${saved.id}.json`]);

    expect((await (await tours.GET()).json()).tours).toHaveLength(1);
    const fetched = await (await tour.GET(new Request("http://localhost"), params(saved.id))).json();
    expect(fetched.tour.id).toBe(saved.id);

    const back = { ...input, spots: [input.spots[0], { ...input.spots[1], links: [{ id: "to-hall", targetSpotId: "hall", yaw: -135, pitch: -20 }] }] };
    const updated = await tour.PUT(request("PUT", back), params(saved.id));
    expect(updated.status).toBe(200);
    const { tour: afterUpdate } = await updated.json();
    expect(afterUpdate.spots[1].links).toEqual([{ id: "to-hall", targetSpotId: "hall", yaw: -135, pitch: -20 }]);
    expect(afterUpdate.createdAt).toBe(saved.createdAt);

    expect((await tour.DELETE(request("DELETE"), params(saved.id))).status).toBe(204);
    expect((await tour.GET(new Request("http://localhost"), params(saved.id))).status).toBe(404);
    expect((await tour.DELETE(request("DELETE"), params(saved.id))).status).toBe(404);
  });

  it("rejects foreign clients, bad JSON, invalid tours and unknown ids", async () => {
    const { tours, tour } = await loadRoutes();
    expect((await tours.POST(request("POST", input, "curl"))).status).toBe(403);
    expect((await tours.POST(request("POST", "{not json"))).status).toBe(400);
    const invalid = await tours.POST(request("POST", { spots: [] }));
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error).toMatch(/at least one room/);
    expect((await tours.POST(request("POST", "x".repeat(300 * 1024)))).status).toBe(413);
    expect((await tour.PUT(request("PUT", input), params("../../etc/passwd"))).status).toBe(404);
    expect((await tour.GET(new Request("http://localhost"), params("not-a-uuid"))).status).toBe(404);
    expect((await (await tours.GET()).json()).tours).toEqual([]);
  });
});
