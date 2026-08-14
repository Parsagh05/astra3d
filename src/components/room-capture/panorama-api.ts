import type { CapturedFrame } from "@/types/capture";

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
};

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

export function createPanoramaUpload(frames: readonly CapturedFrame[]) {
  const formData = new FormData();
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
  }
  return formData;
}

async function readServerError(response: Blob) {
  try {
    const payload = JSON.parse(await response.text()) as PanoramaErrorPayload;
    return payload.error || "The laptop panorama processor rejected the capture.";
  } catch {
    return "The laptop panorama processor returned an unreadable response.";
  }
}

export function processPanoramaOnServer(
  frames: readonly CapturedFrame[],
  onUpdate: (update: PanoramaProcessingUpdate) => void,
) {
  return new Promise<Blob>((resolve, reject) => {
    let formData: FormData;
    try {
      onUpdate({ phase: "preparing", progress: 6 });
      formData = createPanoramaUpload(frames);
    } catch (error) {
      reject(error);
      return;
    }

    const request = new XMLHttpRequest();
    request.open("POST", "/api/panorama");
    request.responseType = "blob";
    request.timeout = 120_000;
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
        onUpdate({ phase: "receiving", progress: 100 });
        resolve(response);
        return;
      }

      void readServerError(response).then((message) => reject(new Error(message)));
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
