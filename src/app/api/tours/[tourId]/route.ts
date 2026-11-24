import { deleteTour, getTour, readTourBody, TourStoreError, updateTour } from "@/server/house-tour-store";

export const runtime = "nodejs";

const CLIENT_HEADER = "room-studio-v1";

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

type Context = { params: Promise<{ tourId: string }> };

export async function GET(_request: Request, { params }: Context) {
  const { tourId } = await params;
  const tour = await getTour(tourId);
  return tour ? json({ tour }) : json({ error: "Tour not found." }, 404);
}

export async function PUT(request: Request, { params }: Context) {
  if (request.headers.get("x-astra3d-client") !== CLIENT_HEADER) {
    return json({ error: "This endpoint only accepts Astra3D requests." }, 403);
  }
  const { tourId } = await params;
  try {
    return json({ tour: await updateTour(tourId, await readTourBody(request)) });
  } catch (error) {
    if (error instanceof TourStoreError) return json({ error: error.message }, error.status);
    console.error("Astra3D tour update failed", error);
    return json({ error: "The tour could not be saved." }, 500);
  }
}

export async function DELETE(request: Request, { params }: Context) {
  if (request.headers.get("x-astra3d-client") !== CLIENT_HEADER) {
    return json({ error: "This endpoint only accepts Astra3D requests." }, 403);
  }
  const { tourId } = await params;
  try {
    await deleteTour(tourId);
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof TourStoreError) return json({ error: error.message }, error.status);
    console.error("Astra3D tour delete failed", error);
    return json({ error: "The tour could not be deleted." }, 500);
  }
}
