import { createTour, listTours, readTourBody, TourStoreError } from "@/server/house-tour-store";

export const runtime = "nodejs";

const CLIENT_HEADER = "room-studio-v1";

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET() {
  try {
    return json({ tours: await listTours() });
  } catch (error) {
    console.error("Astra3D tour listing failed", error);
    return json({ error: "Tours could not be listed.", tours: [] }, 500);
  }
}

export async function POST(request: Request) {
  if (request.headers.get("x-astra3d-client") !== CLIENT_HEADER) {
    return json({ error: "This endpoint only accepts Astra3D requests." }, 403);
  }
  try {
    const tour = await createTour(await readTourBody(request));
    return json({ tour }, 201);
  } catch (error) {
    if (error instanceof TourStoreError) return json({ error: error.message }, error.status);
    console.error("Astra3D tour create failed", error);
    return json({ error: "The tour could not be saved." }, 500);
  }
}
