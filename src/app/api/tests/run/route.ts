import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { buildCaptureSlots, type CaptureExtent } from "@/lib/capture-plan";
import { processRoomPanorama, type ServerPanoramaFrame } from "@/server/panorama-processor";

export const runtime = "nodejs";
export const maxDuration = 240;

const TEST_CASES_ROOT = path.join(process.cwd(), "test-cases");

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp"]);

function imageExtension(filename: string): string | null {
  const ext = filename.split(".").pop()?.toLowerCase();
  return ext && IMAGE_EXTENSIONS.has(ext) ? ext : null;
}

async function loadTestCaseFrames(
  extentPath: string,
  extent: CaptureExtent,
): Promise<ServerPanoramaFrame[]> {
  const slots = buildCaptureSlots(extent);
  const frames: ServerPanoramaFrame[] = [];
  
  for (const slot of slots) {
    const dir = path.join(TEST_CASES_ROOT, extentPath);
    
    const files = await readdir(dir);
    const matchingFile = files.find((f) => {
      const ext = imageExtension(f);
      if (!ext) return false;
      const base = f.replace(/\.[^.]+$/, "");
      const padded = String(slot.sequence + 1).padStart(2, "0");
      return base === padded || base.endsWith(`-${slot.sequence}`);
    });
    
    if (!matchingFile) {
      throw new Error(`Missing image for sequence ${slot.sequence}`);
    }
    
    const imagePath = path.join(dir, matchingFile);
    const imageBuffer = await readFile(imagePath);
    const ext = imageExtension(matchingFile);
    
    frames.push({
      sequence: slot.sequence,
      band: slot.band,
      column: slot.column,
      image: imageBuffer,
      zoom: 1,
      mimeType: ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg",
    });
  }
  
  return frames;
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { path?: string; extent?: string };
    
    if (!body.path || typeof body.path !== "string") {
      return Response.json(
        { error: "Test case path is required." },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    
    const testCasePath = body.path.replace(/^\/|\/$/g, "");
    const fullPath = path.join(TEST_CASES_ROOT, testCasePath);
    
    if (!fullPath.startsWith(TEST_CASES_ROOT)) {
      return Response.json(
        { error: "Invalid test case path." },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    
    const extent = body.extent === "36-images" ? "full" : "quick";
    const extentDir = extent === "full" ? "36-images" : "12-images";
    
    if (!testCasePath.startsWith(extentDir)) {
      return Response.json(
        { error: `Test case ${testCasePath} does not match extent ${extent}.` },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    
    const frames = await loadTestCaseFrames(testCasePath, extent);
    const result = await processRoomPanorama(frames, { captureExtent: extent });
    
    return new Response(new Uint8Array(result.panorama), {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "image/jpeg",
        "X-Astra3D-Height": String(result.height),
        "X-Astra3D-Width": String(result.width),
        "X-Astra3D-Alignment": String(result.report.alignmentScore),
        "X-Astra3D-Coverage": String(result.report.coverage),
        "X-Astra3D-Coverage-Scope": result.report.coverageScope ?? "three bands",
        "X-Astra3D-Matched-Pairs": String(result.report.matchedPairs),
        "X-Astra3D-Method": result.report.method,
        "X-Astra3D-Retakes": result.report.retakeSequences.join(","),
        "X-Astra3D-Warnings": encodeURIComponent(JSON.stringify(result.report.warnings)),
      },
    });
  } catch (error) {
    console.error("Astra3D test runner failed", error);
    return Response.json(
      { 
        error: error instanceof Error ? error.message : "Test runner failed.",
      },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
