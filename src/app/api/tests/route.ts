import { readdir } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";

const TEST_CASES_ROOT = path.join(process.cwd(), "test-cases");

export type TestCaseInfo = {
  name: string;
  extent: "12-images" | "36-images";
  imageCount: number;
  path: string;
};

export type TestCasesResponse = {
  testCases: TestCaseInfo[];
};

async function discoverTestCases(): Promise<TestCaseInfo[]> {
  const cases: TestCaseInfo[] = [];
  
  try {
    const extentDirs = await readdir(TEST_CASES_ROOT, { withFileTypes: true });
    
    for (const extentDir of extentDirs) {
      if (!extentDir.isDirectory()) continue;
      if (extentDir.name !== "12-images" && extentDir.name !== "36-images") continue;
      
      const extentPath = path.join(TEST_CASES_ROOT, extentDir.name);
      
      try {
        const caseDirs = await readdir(extentPath, { withFileTypes: true });
        
        for (const caseDir of caseDirs) {
          if (!caseDir.isDirectory()) continue;
          
          const imageCount = extentDir.name === "12-images" ? 12 : 36;
          
          cases.push({
            name: caseDir.name,
            extent: extentDir.name as "12-images" | "36-images",
            imageCount,
            path: `${extentDir.name}/${caseDir.name}`,
          });
        }
      } catch {
        // Skip if we can't read the directory
      }
    }
  } catch {
    // TEST_CASES_ROOT doesn't exist yet - return empty
  }
  
  return cases;
}

export async function GET() {
  try {
    const testCases = await discoverTestCases();
    
    return Response.json(
      { testCases } satisfies TestCasesResponse,
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("Astra3D test case discovery failed", error);
    return Response.json(
      { error: "Test case discovery failed.", testCases: [] },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
