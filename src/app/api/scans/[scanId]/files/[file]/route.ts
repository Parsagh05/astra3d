import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

import { scanFileInfo, scanFileType } from "@/server/scan-store";
import { SCAN_FILES, type ScanFile } from "@/types/scan";

export const runtime = "nodejs";

function isScanFile(value: string): value is ScanFile {
  return (SCAN_FILES as readonly string[]).includes(value);
}

function stream(filePath: string, start: number, end: number) {
  return Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream<Uint8Array>;
}

/**
 * Serves a scan's results.  scene.splat can be tens of megabytes, so it
 * streams from disk and honours single Range requests (resumable downloads,
 * progressive loading).
 */
export async function GET(request: Request, { params }: { params: Promise<{ scanId: string; file: string }> }) {
  const { scanId, file } = await params;
  if (!isScanFile(file)) return Response.json({ error: "Unknown file." }, { status: 404 });
  const info = await scanFileInfo(scanId, file);
  if (!info) return Response.json({ error: "File not found." }, { status: 404 });

  const etag = `"${info.size.toString(16)}-${info.modified.getTime().toString(16)}"`;
  const headers: Record<string, string> = {
    "Content-Type": scanFileType(file),
    "Accept-Ranges": "bytes",
    // Re-processing rewrites these files, so revalidate every time.
    "Cache-Control": "no-cache",
    ETag: etag,
    "Last-Modified": info.modified.toUTCString(),
  };
  if (file === "scene.ply" || file === "scene.splat") {
    headers["Content-Disposition"] = `attachment; filename="astra3d-${scanId.slice(0, 8)}-${file}"`;
  }
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }

  const range = request.headers.get("range");
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    let start = match?.[1] ? Number(match[1]) : NaN;
    let end = match?.[2] ? Number(match[2]) : info.size - 1;
    if (match && !match[1] && match[2]) {
      // Suffix range: the last N bytes.
      start = Math.max(0, info.size - Number(match[2]));
      end = info.size - 1;
    }
    end = Math.min(end, info.size - 1);
    if (!match || !Number.isFinite(start) || start > end || start >= info.size) {
      return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${info.size}` } });
    }
    return new Response(stream(info.path, start, end), {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${info.size}`, "Content-Length": String(end - start + 1) },
    });
  }
  if (info.size === 0) return new Response(null, { headers: { ...headers, "Content-Length": "0" } });
  return new Response(stream(info.path, 0, info.size - 1), { headers: { ...headers, "Content-Length": String(info.size) } });
}
