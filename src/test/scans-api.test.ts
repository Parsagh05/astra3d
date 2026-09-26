// @vitest-environment node
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "astra3d-scans-"));
  process.env.ASTRA3D_DATA_DIR = root;
  // The routes would otherwise spawn the Python pipeline.
  process.env.ASTRA3D_SCAN_WORKER = "external";
  vi.resetModules();
});

afterEach(async () => {
  delete process.env.ASTRA3D_DATA_DIR;
  delete process.env.ASTRA3D_SCAN_WORKER;
  delete process.env.ASTRA3D_SCAN_MAX_BYTES;
  if (!path.resolve(root).startsWith(path.resolve(tmpdir()))) throw new Error("Refusing to clean an unexpected path.");
  await rm(root, { recursive: true, force: true });
});

const video = Buffer.alloc(200 * 1024, 7);

function upload(body: BodyInit, options: { type?: string; name?: string; client?: string } = {}) {
  const url = new URL("http://localhost/api/scans");
  if (options.name !== undefined) url.searchParams.set("name", options.name);
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": options.type ?? "video/mp4", "X-Astra3D-Client": options.client ?? "room-studio-v1" },
    body,
    duplex: "half",
  } as RequestInit);
}

const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

async function loadRoutes() {
  const scans = await import("@/app/api/scans/route");
  const scan = await import("@/app/api/scans/[scanId]/route");
  const retry = await import("@/app/api/scans/[scanId]/retry/route");
  const files = await import("@/app/api/scans/[scanId]/files/[file]/route");
  return { scans, scan, retry, files };
}

async function readJob(id: string) {
  return JSON.parse(await readFile(path.join(root, "scans", id, "job.json"), "utf8"));
}

async function writeJob(id: string, fields: Record<string, unknown>) {
  await writeFile(path.join(root, "scans", id, "job.json"), JSON.stringify({ ...(await readJob(id)), ...fields }));
}

describe("scans API", () => {
  it("streams an uploaded video to disk and queues it for the worker", async () => {
    const { scans } = await loadRoutes();
    const response = await scans.POST(upload(video, { name: "  Living\u0000 room  " }));
    expect(response.status).toBe(201);
    const { scan } = await response.json();
    expect(scan).toMatchObject({ name: "Living room", status: "queued", stage: "queued", progress: 0, video: { bytes: video.length, mimeType: "video/mp4" } });
    // The worker's contract: job.json plus the video, and nothing half-written left behind.
    const stored = await readJob(scan.id);
    expect(stored).toMatchObject({ version: 1, id: scan.id, video: { file: "video.mp4" } });
    expect((await stat(path.join(root, "scans", scan.id, "video.mp4"))).size).toBe(video.length);
    expect((await readdir(path.join(root, "scans"))).filter((name) => name.startsWith("."))).toEqual([]);
    // Internal fields stay on the server.
    expect(scan.video.file).toBeUndefined();

    const list = await (await scans.GET()).json();
    expect(list).toMatchObject({ worker: "external", scans: [{ id: scan.id }] });
  });

  it("rejects foreign clients, other file types, empty and oversized videos", async () => {
    const { scans } = await loadRoutes();
    expect((await scans.POST(upload(video, { client: "curl" }))).status).toBe(403);
    expect((await scans.POST(upload(video, { type: "image/png" }))).status).toBe(415);
    expect((await scans.POST(upload(Buffer.alloc(10)))).status).toBe(400);
    process.env.ASTRA3D_SCAN_MAX_BYTES = String(100 * 1024);
    const tooLarge = await scans.POST(upload(video));
    expect(tooLarge.status).toBe(413);
    expect((await tooLarge.json()).error).toMatch(/larger than/);
    // Failed uploads leave no job and no staging folder.
    expect(await readdir(path.join(root, "scans"))).toEqual([]);
  });

  it("marks a running job whose worker went silent as failed, and retries it", async () => {
    const { scans, scan: scanRoute, retry } = await loadRoutes();
    const { scan } = await (await scans.POST(upload(video))).json();
    const old = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    await writeJob(scan.id, { status: "running", stage: "poses", progress: 0.2, heartbeatAt: old, updatedAt: old });
    await writeFile(path.join(root, "scans", scan.id, "claim.lock"), "dead-worker\n");

    const fetched = await (await scanRoute.GET(new Request("http://localhost"), params({ scanId: scan.id }))).json();
    expect(fetched.scan).toMatchObject({ status: "failed", error: expect.stringMatching(/stopped responding/) });

    const retried = await retry.POST(
      new Request("http://localhost", { method: "POST", headers: { "X-Astra3D-Client": "room-studio-v1" } }),
      params({ scanId: scan.id }),
    );
    expect(retried.status).toBe(200);
    expect((await retried.json()).scan).toMatchObject({ status: "queued", progress: 0, error: null });
    await expect(stat(path.join(root, "scans", scan.id, "claim.lock"))).rejects.toThrow();
  });

  it("refuses to delete a job a worker holds, and deletes it once released", async () => {
    const { scans, scan: scanRoute } = await loadRoutes();
    const { scan } = await (await scans.POST(upload(video))).json();
    const remove = () => scanRoute.DELETE(
      new Request("http://localhost", { method: "DELETE", headers: { "X-Astra3D-Client": "room-studio-v1" } }),
      params({ scanId: scan.id }),
    );
    await writeFile(path.join(root, "scans", scan.id, "claim.lock"), "worker\n");
    expect((await remove()).status).toBe(409);
    await rm(path.join(root, "scans", scan.id, "claim.lock"));
    expect((await remove()).status).toBe(204);
    expect(await readdir(path.join(root, "scans"))).toEqual([]);
    expect((await remove()).status).toBe(404);
  });

  it("serves result files with range support and only known names", async () => {
    const { scans, files } = await loadRoutes();
    const { scan } = await (await scans.POST(upload(video))).json();
    const splat = Buffer.from(Array.from({ length: 64 }, (_, index) => index));
    await writeFile(path.join(root, "scans", scan.id, "scene.splat"), splat);

    const full = await files.GET(new Request("http://localhost"), params({ scanId: scan.id, file: "scene.splat" }));
    expect(full.status).toBe(200);
    expect(full.headers.get("content-length")).toBe("64");
    expect(Buffer.from(await full.arrayBuffer())).toEqual(splat);

    const partial = await files.GET(
      new Request("http://localhost", { headers: { Range: "bytes=32-35" } }),
      params({ scanId: scan.id, file: "scene.splat" }),
    );
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe("bytes 32-35/64");
    expect([...Buffer.from(await partial.arrayBuffer())]).toEqual([32, 33, 34, 35]);

    const suffix = await files.GET(
      new Request("http://localhost", { headers: { Range: "bytes=-2" } }),
      params({ scanId: scan.id, file: "scene.splat" }),
    );
    expect([...Buffer.from(await suffix.arrayBuffer())]).toEqual([62, 63]);

    const unsatisfiable = await files.GET(
      new Request("http://localhost", { headers: { Range: "bytes=100-" } }),
      params({ scanId: scan.id, file: "scene.splat" }),
    );
    expect(unsatisfiable.status).toBe(416);

    const cached = await files.GET(
      new Request("http://localhost", { headers: { "If-None-Match": full.headers.get("etag")! } }),
      params({ scanId: scan.id, file: "scene.splat" }),
    );
    expect(cached.status).toBe(304);

    expect((await files.GET(new Request("http://localhost"), params({ scanId: scan.id, file: "video.mp4" }))).status).toBe(404);
    expect((await files.GET(new Request("http://localhost"), params({ scanId: scan.id, file: "poster.jpg" }))).status).toBe(404);
    expect((await files.GET(new Request("http://localhost"), params({ scanId: "../../etc", file: "scene.json" }))).status).toBe(404);
  });
});
