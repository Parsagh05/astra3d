"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { BrandMark } from "@/components/brand-mark";
import { GeneratedRoomViewer } from "@/components/room-capture/generated-room-viewer";
import type { GeneratedRoomRecord, PanoramaQualityReport } from "@/types/capture";

type TestCaseInfo = {
  name: string;
  extent: "12-images" | "36-images";
  imageCount: number;
  path: string;
};

type TestState = {
  status: "idle" | "loading" | "running" | "error";
  error?: string;
  result?: {
    room: GeneratedRoomRecord;
  };
};

function parseQualityReport(headers: Headers): PanoramaQualityReport {
  const retakeHeader = headers.get("X-Astra3D-Retakes");
  const methodHeader = headers.get("X-Astra3D-Method");
  
  return {
    method: (methodHeader as PanoramaQualityReport["method"]) ?? "opencv-sift-spherical-v4",
    alignmentScore: Number(headers.get("X-Astra3D-Alignment")) || 0,
    coverage: Number(headers.get("X-Astra3D-Coverage")) || 0,
    coverageScope: headers.get("X-Astra3D-Coverage-Scope") as "eye-level ring" | "three bands" | undefined,
    matchedPairs: Number(headers.get("X-Astra3D-Matched-Pairs")) || 0,
    fallbackPairs: 0,
    retakeSequences: retakeHeader
      ? retakeHeader.split(",").map(Number).filter((v) => Number.isInteger(v) && v >= 0)
      : [],
    warnings: [],
  };
}

export function TestRunner() {
  const [testCases, setTestCases] = useState<TestCaseInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [testState, setTestState] = useState<TestState>({ status: "idle" });
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const initRef = useRef(false);

  const fetchTestCases = useCallback(async () => {
    try {
      const response = await fetch("/api/tests");
      const data = await response.json() as { testCases: TestCaseInfo[]; error?: string };
      if (data.error) {
        console.error("Failed to fetch test cases:", data.error);
      }
      setTestCases(data.testCases || []);
    } catch (err) {
      console.error("Failed to fetch test cases:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!initRef.current) {
      initRef.current = true;
      fetchTestCases();
    }
  }, [fetchTestCases]);

  const runTest = useCallback(async (testCase: TestCaseInfo) => {
    setSelectedPath(testCase.path);
    setTestState({ status: "running" });

    try {
      const response = await fetch("/api/tests/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: testCase.path, extent: testCase.extent }),
      });

      if (!response.ok) {
        const errorData = await response.json() as { error?: string };
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      const blob = await response.blob();
      const quality = parseQualityReport(response.headers);

      const room: GeneratedRoomRecord = {
        id: "latest-room" as const,
        name: `${testCase.name} (${testCase.extent})`,
        createdAt: new Date().toISOString(),
        photoCount: testCase.imageCount,
        panorama: blob,
        processor: "laptop",
        quality,
        hasSourceFrames: true,
      };

      setTestState({ status: "idle", result: { room } });
    } catch (err) {
      setTestState({
        status: "error",
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }, []);

  const groupedCases = testCases.reduce((acc, tc) => {
    if (!acc[tc.extent]) acc[tc.extent] = [];
    acc[tc.extent].push(tc);
    return acc;
  }, {} as Record<string, TestCaseInfo[]>);

  return (
    <div style={{ minHeight: "100vh", background: "var(--color-surface-0)" }}>
      <header style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "1rem 2rem",
        borderBottom: "1px solid var(--color-line)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
          <BrandMark />
          <span style={{ color: "var(--color-muted)" }}>Test Runner</span>
        </div>
        <Link href="/" style={{ color: "var(--color-muted)", fontSize: "0.875rem" }}>
          ← Back to site
        </Link>
      </header>

      <main style={{ display: "flex", height: "calc(100vh - 65px)" }}>
        <aside style={{
          width: "320px",
          borderRight: "1px solid var(--color-line)",
          overflow: "auto",
          padding: "1.5rem",
        }}>
          <h1 style={{ fontSize: "1.25rem", fontWeight: 600, marginBottom: "1.5rem" }}>
            Test Cases
          </h1>

          {loading ? (
            <p style={{ color: "var(--color-muted)" }}>Loading...</p>
          ) : testCases.length === 0 ? (
            <div>
              <p style={{ color: "var(--color-muted)", marginBottom: "1rem" }}>
                No test cases found.
              </p>
              <p style={{ color: "var(--color-muted)", fontSize: "0.875rem" }}>
                Add test cases to <code style={{ background: "var(--color-surface-2)", padding: "0.25rem 0.5rem", borderRadius: "0.25rem" }}>test-cases/</code> directory.
              </p>
              <div style={{ marginTop: "1rem", fontSize: "0.875rem", color: "var(--color-muted)" }}>
                <p style={{ marginBottom: "0.5rem" }}>Structure:</p>
                <pre style={{ background: "var(--color-surface-2)", padding: "0.75rem", borderRadius: "0.5rem", overflow: "auto" }}>
{`test-cases/
├── 12-images/
│   └── case-001/
│       ├── 01.jpg
│       └── ...
└── 36-images/
    └── case-001/
        ├── 01.jpg
        └── ...`}
                </pre>
              </div>
            </div>
          ) : (
            Object.entries(groupedCases).map(([extent, cases]) => (
              <div key={extent} style={{ marginBottom: "2rem" }}>
                <h2 style={{ fontSize: "0.875rem", color: "var(--color-muted)", marginBottom: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  {extent.replace("-", " ")} — {cases.length} case{cases.length !== 1 ? "s" : ""}
                </h2>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                  {cases.map((tc) => (
                    <button
                      key={tc.path}
                      onClick={() => void runTest(tc)}
                      disabled={testState.status === "running"}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "0.75rem 1rem",
                        background: selectedPath === tc.path ? "var(--color-surface-2)" : "transparent",
                        border: "1px solid var(--color-line)",
                        borderRadius: "0.5rem",
                        color: "var(--color-ice)",
                        cursor: testState.status === "running" ? "not-allowed" : "pointer",
                        textAlign: "left",
                        opacity: testState.status === "running" ? 0.6 : 1,
                      }}
                    >
                      <span>{tc.name}</span>
                      <span style={{ color: "var(--color-muted)", fontSize: "0.75rem" }}>
                        {tc.imageCount} img
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ))
          )}
        </aside>

        <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
          {testState.status === "idle" && !testState.result ? (
            <div style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--color-muted)",
            }}>
              <div style={{ textAlign: "center" }}>
                <p style={{ marginBottom: "0.5rem" }}>Select a test case to run</p>
                <p style={{ fontSize: "0.875rem" }}>The panorama will be processed and displayed here</p>
              </div>
            </div>
          ) : testState.status === "running" ? (
            <div style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--color-muted)",
            }}>
              <div style={{ textAlign: "center" }}>
                <p style={{ marginBottom: "0.5rem" }}>Processing test case...</p>
                <p style={{ fontSize: "0.875rem" }}>Running panorama pipeline</p>
              </div>
            </div>
          ) : testState.status === "error" ? (
            <div style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--color-muted)",
            }}>
              <div style={{ textAlign: "center", color: "#ff6b6b" }}>
                <p style={{ marginBottom: "0.5rem" }}>Error</p>
                <p style={{ fontSize: "0.875rem" }}>{testState.error}</p>
              </div>
            </div>
          ) : testState.result ? (
            <div style={{ flex: 1 }}>
              <GeneratedRoomViewer
                room={testState.result.room}
                onRetake={() => setTestState({ status: "idle" })}
              />
            </div>
          ) : null}
        </div>
      </main>
    </div>
  );
}
