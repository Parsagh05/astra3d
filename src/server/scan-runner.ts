import { spawn } from "node:child_process";
import { appendFile } from "node:fs/promises";
import path from "node:path";

import { failUnfinishedScan, nextQueuedScan, scanDirectory } from "@/server/scan-store";

/**
 * Runs queued scans in this server process, one at a time, by spawning
 * scripts/splat_pipeline.py.  Set ASTRA3D_SCAN_WORKER=external when a
 * separate worker (e.g. the GPU container from docker-compose.gpu.yml)
 * watches the scans folder instead; this runner then stays idle.
 */

type RunnerState = { active: string | null; draining: boolean };

const globalRunner = globalThis as typeof globalThis & { __astra3dScanRunner?: RunnerState };

function state(): RunnerState {
  globalRunner.__astra3dScanRunner ??= { active: null, draining: false };
  return globalRunner.__astra3dScanRunner;
}

export function scanWorkerMode(): "local" | "external" {
  return process.env.ASTRA3D_SCAN_WORKER === "external" ? "external" : "local";
}

export function isScanActive(id: string) {
  return state().active === id.toLowerCase();
}

const CLAIMED_ELSEWHERE = 3;

function pythonCommand() {
  return process.env.ASTRA3D_PYTHON || (process.platform === "win32" ? "python" : "python3");
}

function runPipeline(id: string, directory: string) {
  return new Promise<string | typeof CLAIMED_ELSEWHERE | null>((resolve) => {
    const log = path.join(directory, "pipeline.log");
    const script = path.join(process.cwd(), "scripts", "splat_pipeline.py");
    // The job folder is data, not code: keep it out of the build trace.
    const child = spawn(/*turbopackIgnore: true*/ pythonCommand(), [script, "--job", directory], {
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const record = (chunk: Buffer) => {
      void appendFile(log, chunk).catch(() => undefined);
    };
    child.stdout.on("data", record);
    child.stderr.on("data", record);
    child.on("error", (error) => {
      console.error(`Astra3D scan ${id}: could not start the pipeline`, error);
      void appendFile(log, `Could not start ${pythonCommand()}: ${error.message}\n`).catch(() => undefined);
      resolve("The 3D pipeline could not start. Install Python and requirements-panorama.txt on the server.");
    });
    child.on("close", (code) => {
      // 3: another worker already claimed the job; it is not ours to fail.
      if (code === 0 || code === CLAIMED_ELSEWHERE) {
        resolve(code === 0 ? null : CLAIMED_ELSEWHERE);
        return;
      }
      console.error(`Astra3D scan ${id}: pipeline exited with ${code}`);
      resolve("Processing stopped unexpectedly (the server may be out of memory). Details are in pipeline.log.");
    });
  });
}

/** Starts processing the queue if nothing is running. Safe to call often. */
export function kickScanQueue() {
  if (scanWorkerMode() === "external") return;
  const runner = state();
  if (runner.draining) return;
  runner.draining = true;
  void (async () => {
    try {
      for (;;) {
        const job = await nextQueuedScan();
        const directory = job ? scanDirectory(job.id) : null;
        if (!job || !directory) break;
        runner.active = job.id.toLowerCase();
        const failure = await runPipeline(job.id, directory);
        runner.active = null;
        if (failure === CLAIMED_ELSEWHERE) break;
        // The pipeline marks its own failures; this catches a process that
        // never started or was killed before it could.
        await failUnfinishedScan(job.id, failure ?? "Processing stopped before the scan finished. Retry to process it again.");
      }
    } catch (error) {
      console.error("Astra3D scan queue failed", error);
    } finally {
      runner.active = null;
      runner.draining = false;
    }
  })();
}
