import { CaptureUploadError, parseCaptureUpload } from "@/server/capture-upload";
import { discoverTestCases, saveTestCase, TestCaseError, type InvalidTestCase, type TestCaseInfo } from "@/server/test-case-store";

export const runtime = "nodejs";

const CLIENT_HEADER = "room-studio-v1";

export type TestCasesResponse = {
  testCases: TestCaseInfo[];
  invalid: InvalidTestCase[];
};

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET() {
  try {
    const { cases, invalid } = await discoverTestCases();
    return json({ testCases: cases, invalid } satisfies TestCasesResponse);
  } catch (error) {
    console.error("Astra3D test case discovery failed", error);
    return json({ error: "Test case discovery failed.", testCases: [], invalid: [] }, 500);
  }
}

/** Saves a complete capture from the test maker straight into test-cases/. */
export async function POST(request: Request) {
  if (request.headers.get("x-astra3d-client") !== CLIENT_HEADER) {
    return json({ error: "This endpoint only accepts Astra3D captures." }, 403);
  }
  try {
    const upload = await parseCaptureUpload(request);
    const testCase = await saveTestCase({
      name: upload.name,
      extent: upload.extent,
      frames: upload.frames,
      source: "test-maker",
    });
    return json({ testCase }, 201);
  } catch (error) {
    if (error instanceof CaptureUploadError || error instanceof TestCaseError) {
      return json({ error: error.message }, error.status);
    }
    console.error("Astra3D test case save failed", error);
    return json({ error: "The test case could not be saved. Check that test-cases/ is writable." }, 500);
  }
}
