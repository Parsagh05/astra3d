import type { CapturedFrame, PanoramaQualityReport } from "@/types/capture";

export type PanoramaProcessingPhase =
  | "preparing"
  | "uploading"
  | "processing"
  | "receiving";

export type PanoramaProcessingUpdate = {
  phase: PanoramaProcessingPhase;
  progress: number;
};

type PanoramaErrorPayload = {
  error?: string;
  code?: string;
  retakeSequences?: number[];
};

export type ProcessedPanorama = {
  panorama: Blob;
  quality: PanoramaQualityReport;
  projectId: string;
};

export class PanoramaUploadError extends Error {
  readonly code: string;
  readonly retakeSequences: number[];

  constructor(message: string, code = "PROCESSING_FAILED", retakeSequences: number[] = []) {
    super(message);
    this.name = "PanoramaUploadError";
    this.code = code;
    this.retakeSequences = retakeSequences;
  }
}

export function decodeCaptureDataUrl(dataUrl: string) {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/i.exec(dataUrl);
  if (!match) throw new Error("One of the captured photos has an invalid image format.");

  const binary = window.atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new Blob([bytes], { type: match[1].toLowerCase() });
}

export function createPanoramaUpload(frames: readonly CapturedFrame[], roomName = "My room") {
  const formData = new FormData();
  formData.append("room-name", roomName);
  for (const frame of [...frames].sort((a, b) => a.sequence - b.sequence)) {
    const image = decodeCaptureDataUrl(frame.dataUrl);
    const extension = image.type === "image/png"
      ? "png"
      : image.type === "image/webp"
        ? "webp"
        : "jpg";
    formData.append(
      `frame-${frame.sequence}`,
      image,
      `${frame.band}-${frame.column}.${extension}`,
    );
    formData.append(`zoom-${frame.sequence}`, String(frame.zoom));
    if (frame.imu) {
      formData.append(`imu-${frame.sequence}`, JSON.stringify({
        alpha: frame.imu.alpha,
        beta: frame.imu.beta,
        gamma: frame.imu.gamma,
      }));
    }
  }
  return formData;
}

async function readServerError(response: Blob) {
  try {
    const payload = JSON.parse(await response.text()) as PanoramaErrorPayload;
    return new PanoramaUploadError(
      payload.error || "The laptop panorama processor rejected the capture.",
      payload.code ?? "PROCESSING_FAILED",
      Array.isArray(payload.retakeSequences)
        ? payload.retakeSequences.filter((value) => Number.isInteger(value) && value >= 0 && value < 24)
        : [],
    );
  } catch {
    return new PanoramaUploadError("The laptop panorama processor returned an unreadable response.");
  }
}

function numberHeader(request: XMLHttpRequest, name: string, fallback: number) {
  const value = Number(request.getResponseHeader(name));
  return Number.isFinite(value) ? value : fallback;
}

function parseWarnings(value: string | null) {
  if (!value) return [];
  try {
    const warnings = JSON.parse(decodeURIComponent(value)) as unknown;
    return Array.isArray(warnings)
      ? warnings.filter((warning): warning is string => typeof warning === "string")
      : [];
  } catch {
    return [];
  }
}

function readQualityReport(request: XMLHttpRequest): PanoramaQualityReport {
  const retakeHeader = request.getResponseHeader("X-Astra3D-Retakes");
  const methodHeader = request.getResponseHeader("X-Astra3D-Method");
  return {
    method: methodHeader === "opencv-sift-spherical-v3"
      ? methodHeader
      : "opencv-sift-spherical-v4",
    alignmentScore: numberHeader(request, "X-Astra3D-Alignment", 0),
    coverage: numberHeader(request, "X-Astra3D-Coverage", 0),
    fallbackPairs: numberHeader(request, "X-Astra3D-Fallback-Pairs", 0),
    matchedPairs: numberHeader(request, "X-Astra3D-Matched-Pairs", 0),
    retakeSequences: retakeHeader
      ? retakeHeader.split(",").map(Number).filter((value) => Number.isInteger(value) && value >= 0 && value < 24)
      : [],
    warnings: parseWarnings(request.getResponseHeader("X-Astra3D-Warnings")),
  };
}

export function processPanoramaOnServer(
  frames: readonly CapturedFrame[],
  roomName: string,
  onUpdate: (update: PanoramaProcessingUpdate) => void,
) {
  return new Promise<ProcessedPanorama>((resolve, reject) => {
    let formData: FormData;
    try {
      onUpdate({ phase: "preparing", progress: 6 });
      formData = createPanoramaUpload(frames, roomName);
    } catch (error) {
      reject(error);
      return;
    }

    const request = new XMLHttpRequest();
    request.open("POST", "/api/panorama");
    request.responseType = "blob";
    request.timeout = 240_000;
    request.setRequestHeader("Accept", "image/jpeg");
    request.setRequestHeader("X-Astra3D-Client", "room-studio-v1");

    request.upload.addEventListener("progress", (event) => {
      const ratio = event.lengthComputable && event.total > 0
        ? event.loaded / event.total
        : 0;
      onUpdate({
        phase: "uploading",
        progress: Math.max(10, Math.min(58, Math.round(10 + ratio * 48))),
      });
    });
    request.upload.addEventListener("load", () => {
      onUpdate({ phase: "processing", progress: 64 });
    });
    request.addEventListener("progress", () => {
      onUpdate({ phase: "receiving", progress: 94 });
    });
    request.addEventListener("load", () => {
      const response = request.response as Blob;
      if (request.status >= 200 && request.status < 300 && response.type === "image/jpeg") {
        const projectId = request.getResponseHeader("X-Astra3D-Project-Id");
        if (!projectId) {
          reject(new Error("The laptop returned a panorama without a shared project ID."));
          return;
        }
        onUpdate({ phase: "receiving", progress: 100 });
        resolve({ panorama: response, quality: readQualityReport(request), projectId });
        return;
      }

      void readServerError(response).then(reject);
    });
    request.addEventListener("error", () => {
      reject(new Error("The phone could not reach the laptop processor. Keep npm run dev open and try again."));
    });
    request.addEventListener("timeout", () => {
      reject(new Error("Laptop processing took too long. Keep this tab open and try again."));
    });
    request.addEventListener("abort", () => {
      reject(new Error("Panorama processing was cancelled."));
    });

    request.send(formData);
  });
}
