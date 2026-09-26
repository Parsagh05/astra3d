"use client";

import { ArrowLeft, Camera, CheckCircle2, CircleAlert, FolderInput, Loader2, Play, PlayCircle, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { BrandMark } from "@/components/brand-mark";
import { GeneratedRoomViewer } from "@/components/room-capture/generated-room-viewer";
import studio from "@/components/room-capture/room-capture.module.css";
import { toPanoramaMethod } from "@/lib/panorama-method";
import type { GeneratedRoomRecord, PanoramaQualityReport, SharedRoomProject } from "@/types/capture";

import styles from "./test-runner.module.css";

type TestCaseInfo = {
  path: string;
  name: string;
  group: string;
  extent: "quick" | "full";
  imageCount: number;
  hasImu: boolean;
  createdAt?: string;
  source?: string;
};

type InvalidTestCase = { path: string; imageCount: number; reason: string };

/** One runnable capture: a fixture in test-cases/ or a saved studio project. */
type Source =
  | { kind: "case"; id: string; name: string; photoCount: number; detail: string; testCase: TestCaseInfo }
  | { kind: "project"; id: string; name: string; photoCount: number; detail: string; project: SharedRoomProject };

type RunResult =
  | { status: "running" }
  | { status: "passed" | "warning"; room: GeneratedRoomRecord; quality: PanoramaQualityReport; durationMs: number; size: string }
  | { status: "failed"; error: string; durationMs?: number };

const CLIENT_HEADERS = { "Content-Type": "application/json", "X-Astra3D-Client": "room-studio-v1" };

function parseWarnings(value: string | null) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(decodeURIComponent(value)) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function readQuality(headers: Headers): PanoramaQualityReport {
  const retakes = headers.get("X-Astra3D-Retakes");
  return {
    method: toPanoramaMethod(headers.get("X-Astra3D-Method")),
    alignmentScore: Number(headers.get("X-Astra3D-Alignment")) || 0,
    coverage: Number(headers.get("X-Astra3D-Coverage")) || 0,
    coverageScope: headers.get("X-Astra3D-Coverage-Scope") === "eye-level ring" ? "eye-level ring" : "three bands",
    matchedPairs: Number(headers.get("X-Astra3D-Matched-Pairs")) || 0,
    fallbackPairs: Number(headers.get("X-Astra3D-Fallback-Pairs")) || 0,
    retakeSequences: retakes ? retakes.split(",").map(Number).filter((value) => Number.isInteger(value) && value >= 0) : [],
    warnings: parseWarnings(headers.get("X-Astra3D-Warnings")),
  };
}

function sourceKey(source: Source) {
  return `${source.kind}:${source.id}`;
}

function percent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function seconds(ms?: number) {
  return ms === undefined ? "—" : `${(ms / 1000).toFixed(1)} s`;
}

/**
 * Re-runs fixed captures through the current stitcher: the committed
 * fixtures in test-cases/ and every studio capture saved on this laptop.
 */
export function TestRunner() {
  const [testCases, setTestCases] = useState<TestCaseInfo[]>([]);
  const [invalid, setInvalid] = useState<InvalidTestCase[]>([]);
  const [projects, setProjects] = useState<SharedRoomProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, RunResult>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [batchRunning, setBatchRunning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [casesResponse, projectsResponse] = await Promise.all([
        fetch("/api/tests", { cache: "no-store" }),
        fetch("/api/projects", { cache: "no-store" }),
      ]);
      const casesPayload = await casesResponse.json() as { testCases?: TestCaseInfo[]; invalid?: InvalidTestCase[]; error?: string };
      const projectsPayload = await projectsResponse.json().catch(() => ({})) as { projects?: SharedRoomProject[] };
      setTestCases(casesPayload.testCases ?? []);
      setInvalid(casesPayload.invalid ?? []);
      setProjects((projectsPayload.projects ?? []).filter((project) => project.hasSourceFrames));
      if (casesPayload.error) setLoadError(casesPayload.error);
    } catch {
      setLoadError("The test list could not be loaded. Is the Astra3D server running?");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const request = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(request);
  }, [refresh]);

  const caseSources = useMemo<Source[]>(() => testCases.map((testCase) => ({
    kind: "case",
    id: testCase.path,
    name: testCase.name,
    photoCount: testCase.imageCount,
    detail: `${testCase.path}${testCase.hasImu ? " · motion data" : ""}`,
    testCase,
  })), [testCases]);
  const projectSources = useMemo<Source[]>(() => projects.map((project) => ({
    kind: "project",
    id: project.id,
    name: project.name,
    photoCount: project.photoCount,
    detail: `Saved ${new Date(project.createdAt).toLocaleString()}`,
    project,
  })), [projects]);

  const run = useCallback(async (source: Source) => {
    const key = sourceKey(source);
    setSelected(key);
    setResults((current) => ({ ...current, [key]: { status: "running" } }));
    const started = performance.now();
    try {
      const response = await fetch("/api/tests/run", {
        method: "POST",
        headers: CLIENT_HEADERS,
        body: JSON.stringify(source.kind === "case" ? { path: source.id } : { projectId: source.id }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string; durationMs?: number };
        setResults((current) => ({
          ...current,
          [key]: { status: "failed", error: payload.error ?? `HTTP ${response.status}`, durationMs: payload.durationMs },
        }));
        return;
      }
      const panorama = await response.blob();
      const quality = readQuality(response.headers);
      const durationMs = Number(response.headers.get("X-Astra3D-Duration-Ms")) || performance.now() - started;
      const room: GeneratedRoomRecord = {
        id: "latest-room",
        name: source.name,
        createdAt: new Date().toISOString(),
        photoCount: source.photoCount,
        panorama,
        processor: "laptop",
        quality,
        hasSourceFrames: true,
      };
      setResults((current) => ({
        ...current,
        [key]: {
          status: quality.retakeSequences.length > 0 || quality.warnings.length > 0 ? "warning" : "passed",
          room,
          quality,
          durationMs,
          size: `${response.headers.get("X-Astra3D-Width")}×${response.headers.get("X-Astra3D-Height")}`,
        },
      }));
    } catch (error) {
      setResults((current) => ({
        ...current,
        [key]: { status: "failed", error: error instanceof Error ? error.message : "The run failed." },
      }));
    }
  }, []);

  const runAll = async () => {
    setBatchRunning(true);
    for (const source of caseSources) await run(source);
    setBatchRunning(false);
  };

  const promote = async (project: SharedRoomProject) => {
    setNotice(null);
    const response = await fetch("/api/tests/promote", {
      method: "POST",
      headers: CLIENT_HEADERS,
      body: JSON.stringify({ projectId: project.id, name: project.name }),
    });
    const payload = await response.json().catch(() => ({})) as { testCase?: TestCaseInfo; error?: string };
    if (!response.ok || !payload.testCase) {
      setNotice(payload.error ?? "The capture could not be copied into test-cases/.");
      return;
    }
    setNotice(`Copied to test-cases/${payload.testCase.path}. Commit it to keep it with the project.`);
    await refresh();
  };

  const anyRunning = Object.values(results).some((result) => result.status === "running");
  const selectedResult = selected ? results[selected] : undefined;
  const selectedSource = [...caseSources, ...projectSources].find((source) => sourceKey(source) === selected);
  const summary = caseSources.reduce(
    (counts, source) => {
      const result = results[sourceKey(source)];
      if (result?.status === "passed") counts.passed += 1;
      else if (result?.status === "warning") counts.warning += 1;
      else if (result?.status === "failed") counts.failed += 1;
      return counts;
    },
    { passed: 0, warning: 0, failed: 0 },
  );

  const renderRow = (source: Source) => {
    const key = sourceKey(source);
    const result = results[key];
    return (
      <li key={key} className={styles.row} data-selected={selected === key} data-status={result?.status ?? "idle"}>
        <button type="button" className={styles.rowMain} onClick={() => setSelected(key)} disabled={!result}>
          <span className={styles.statusIcon} aria-hidden="true">
            {result?.status === "running" ? <Loader2 /> : result?.status === "failed" ? <CircleAlert /> : result ? <CheckCircle2 /> : <PlayCircle />}
          </span>
          <span>
            <strong>{source.name}</strong>
            <small>{source.photoCount} photos · {source.detail}</small>
            {result && result.status !== "running" ? (
              <small className={styles.metrics}>
                {result.status === "failed"
                  ? result.error
                  : `align ${percent(result.quality.alignmentScore)} · coverage ${percent(result.quality.coverage)} · ${result.quality.matchedPairs} pairs · ${seconds(result.durationMs)}`}
              </small>
            ) : null}
          </span>
        </button>
        <div className={styles.rowActions}>
          {source.kind === "project" ? (
            <button type="button" onClick={() => void promote(source.project)} disabled={anyRunning} aria-label={`Save ${source.name} as a test case`}>
              <FolderInput aria-hidden="true" /> Keep
            </button>
          ) : null}
          <button type="button" onClick={() => void run(source)} disabled={anyRunning} aria-label={`Run ${source.name}`}>
            <Play aria-hidden="true" /> Run
          </button>
        </div>
      </li>
    );
  };

  return (
    <div className={studio.studioShell}>
      <header className={studio.studioHeader}>
        <Link href="/" aria-label="Astra3D home"><BrandMark /></Link>
        <div><span /> Tests · panorama pipeline</div>
        <Link href="/test-maker" className={studio.backLink}><Camera aria-hidden="true" /> Test maker</Link>
      </header>

      <main className={`${studio.studioMain} ${styles.layout}`}>
        <section className={styles.sidebar} aria-labelledby="tests-title">
          <div className={styles.sidebarHeader}>
            <div>
              <p className={studio.kicker}>Regression runs</p>
              <h1 id="tests-title">Tests</h1>
            </div>
            <button type="button" className={styles.iconButton} onClick={() => void refresh()} aria-label="Reload test list" disabled={loading}>
              <RefreshCw aria-hidden="true" />
            </button>
          </div>

          {loadError ? <p className={studio.errorMessage} role="alert">{loadError}</p> : null}
          {notice ? <p className={styles.notice} role="status">{notice}</p> : null}

          <div className={styles.group}>
            <div className={styles.groupHeader}>
              <h2>Test cases <small>test-cases/</small></h2>
              <button type="button" onClick={() => void runAll()} disabled={anyRunning || caseSources.length === 0}>
                <PlayCircle aria-hidden="true" /> {batchRunning ? "Running…" : "Run all"}
              </button>
            </div>
            {caseSources.length > 0 && (summary.passed + summary.warning + summary.failed) > 0 ? (
              <p className={styles.summary}>
                <span data-kind="passed">{summary.passed} clean</span>
                <span data-kind="warning">{summary.warning} with warnings</span>
                <span data-kind="failed">{summary.failed} failed</span>
              </p>
            ) : null}
            {loading ? <p className={styles.empty}>Loading…</p> : caseSources.length === 0 ? (
              <div className={styles.empty}>
                <p>No test cases yet. Capture one with the <Link href="/test-maker">Test maker</Link>, or keep a saved capture below.</p>
                <pre>{`test-cases/
├── 12-images/<case>/01.jpg … 12.jpg
└── 36-images/<case>/01.jpg … 36.jpg`}</pre>
              </div>
            ) : (
              <ul className={styles.list}>{caseSources.map(renderRow)}</ul>
            )}
            {invalid.length > 0 ? (
              <details className={styles.invalid}>
                <summary>{invalid.length} folder{invalid.length === 1 ? "" : "s"} skipped</summary>
                <ul>{invalid.map((item) => <li key={item.path}><code>{item.path}</code> — {item.reason}</li>)}</ul>
              </details>
            ) : null}
          </div>

          <div className={styles.group}>
            <div className={styles.groupHeader}>
              <h2>Saved captures <small>.astra3d-data/</small></h2>
            </div>
            {loading ? null : projectSources.length === 0 ? (
              <p className={styles.empty}>Rooms captured in the <Link href="/studio">studio</Link> keep their original photos here and can be re-run with every new algorithm.</p>
            ) : (
              <ul className={styles.list}>{projectSources.map(renderRow)}</ul>
            )}
          </div>
        </section>

        <section className={styles.result} aria-live="polite">
          {!selectedResult ? (
            <div className={styles.placeholder}>
              <PlayCircle aria-hidden="true" />
              <p>Run a test case to stitch it with the current algorithm.</p>
              <small>Nothing is saved — the panorama and its quality report are shown here.</small>
            </div>
          ) : selectedResult.status === "running" ? (
            <div className={styles.placeholder}>
              <Loader2 aria-hidden="true" className={styles.spin} />
              <p>Stitching {selectedSource?.name}…</p>
              <small>Feature matching, exposure compensation and blending run on this computer.</small>
            </div>
          ) : selectedResult.status === "failed" ? (
            <div className={styles.placeholder} data-failed="true">
              <CircleAlert aria-hidden="true" />
              <p>{selectedSource?.name} failed</p>
              <small>{selectedResult.error}</small>
            </div>
          ) : (
            <>
              <dl className={styles.report}>
                <div><dt>Matched pairs</dt><dd>{selectedResult.quality.matchedPairs}</dd></div>
                <div><dt>Fallback pairs</dt><dd>{selectedResult.quality.fallbackPairs}</dd></div>
                <div><dt>Output</dt><dd>{selectedResult.size}</dd></div>
                <div><dt>Time</dt><dd>{seconds(selectedResult.durationMs)}</dd></div>
              </dl>
              {selectedResult.quality.warnings.length > 0 || selectedResult.quality.retakeSequences.length > 0 ? (
                <ul className={styles.warnings}>
                  {selectedResult.quality.retakeSequences.length > 0 ? (
                    <li>Suggested retakes: photos {selectedResult.quality.retakeSequences.map((sequence) => sequence + 1).join(", ")}</li>
                  ) : null}
                  {selectedResult.quality.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                </ul>
              ) : null}
              <GeneratedRoomViewer
                key={selected}
                room={selectedResult.room}
                onRetake={() => setSelected(null)}
              />
            </>
          )}
          <Link href="/test-maker" className={styles.backToMaker}>
            <ArrowLeft aria-hidden="true" /> Capture another test case
          </Link>
        </section>
      </main>
    </div>
  );
}
