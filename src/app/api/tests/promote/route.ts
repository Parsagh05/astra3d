import { promoteProjectToTestCase, TestCaseError } from "@/server/test-case-store";

export const runtime = "nodejs";

const CLIENT_HEADER = "room-studio-v1";

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** Copies a saved studio capture into test-cases/ so it is kept with the code. */
export async function POST(request: Request) {
  if (request.headers.get("x-astra3d-client") !== CLIENT_HEADER) {
    return json({ error: "This endpoint only accepts Astra3D requests." }, 403);
  }
  let body: { projectId?: unknown; name?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return json({ error: "Send a JSON body with a projectId." }, 400);
  }
  if (typeof body.projectId !== "string") return json({ error: "A projectId is required." }, 400);
  try {
    const testCase = await promoteProjectToTestCase(
      body.projectId,
      typeof body.name === "string" ? body.name : undefined,
    );
    return json({ testCase }, 201);
  } catch (error) {
    if (error instanceof TestCaseError) return json({ error: error.message }, error.status);
    console.error("Astra3D test case promotion failed", error);
    return json({ error: "The project could not be copied into test-cases/." }, 500);
  }
}
