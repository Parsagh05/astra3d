import { listProjects, savePanoramaProject } from "@/server/project-store";
import type { PanoramaQualityReport } from "@/types/capture";

export const runtime = "nodejs";

const MAX_PANORAMA_BYTES = 20 * 1024 * 1024;
const PROCESSOR_CLIENT = "room-studio-v1";

function isFileUpload(value: FormDataEntryValue | null): value is File {
  return value !== null && typeof value !== "string" &&
    typeof value.arrayBuffer === "function" &&
    typeof value.type === "string" &&
    typeof value.size === "number";
}

function parseQuality(value: FormDataEntryValue | null) {
  if (typeof value !== "string" || value.length > 8_000) return undefined;
  try {
    const candidate = JSON.parse(value) as Partial<PanoramaQualityReport>;
    if (
      candidate.method !== "opencv-sift-spherical-v3" ||
      !Number.isFinite(candidate.alignmentScore) ||
      !Number.isFinite(candidate.coverage) ||
      !Number.isInteger(candidate.matchedPairs) ||
      !Number.isInteger(candidate.fallbackPairs) ||
      !Array.isArray(candidate.retakeSequences) ||
      !Array.isArray(candidate.warnings)
    ) return undefined;
    return candidate as PanoramaQualityReport;
  } catch {
    return undefined;
  }
}

export async function GET() {
  try {
    return Response.json(
      { projects: await listProjects() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("Astra3D project listing failed", error);
    return Response.json(
      { error: "The shared laptop project library is unavailable." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export async function POST(request: Request) {
  if (request.headers.get("x-astra3d-client") !== PROCESSOR_CLIENT) {
    return Response.json({ error: "This endpoint only accepts Astra3D room projects." }, { status: 403 });
  }
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PANORAMA_BYTES + 16_384) {
    return Response.json({ error: "The panorama is too large." }, { status: 413 });
  }

  try {
    const formData = await request.formData();
    const panorama = formData.get("panorama");
    if (!isFileUpload(panorama) || panorama.type !== "image/jpeg" || panorama.size === 0) {
      return Response.json({ error: "A valid panorama JPEG is required." }, { status: 415 });
    }
    if (panorama.size > MAX_PANORAMA_BYTES) {
      return Response.json({ error: "The panorama is too large." }, { status: 413 });
    }
    const nameValue = formData.get("name");
    const createdAtValue = formData.get("created-at");
    const photoCountValue = Number(formData.get("photo-count"));
    const project = await savePanoramaProject({
      name: typeof nameValue === "string" ? nameValue : "My room",
      createdAt: typeof createdAtValue === "string" ? createdAtValue : undefined,
      photoCount: Number.isFinite(photoCountValue) ? photoCountValue : 0,
      panorama: Buffer.from(await panorama.arrayBuffer()),
      quality: parseQuality(formData.get("quality")),
    });
    return Response.json({ project }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Astra3D legacy project import failed", error);
    return Response.json(
      { error: "The panorama could not be added to the shared laptop library." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
