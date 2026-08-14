import { readProjectPanorama } from "@/server/project-store";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  const result = await readProjectPanorama(projectId);
  if (!result) {
    return Response.json({ error: "Project panorama not found." }, { status: 404 });
  }
  return new Response(new Uint8Array(result.panorama), {
    headers: {
      "Cache-Control": "private, no-cache",
      "Content-Disposition": `inline; filename="astra3d-${result.project.id}-360.jpg"`,
      "Content-Type": "image/jpeg",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
