"use client";

import { Camera, Check, Loader2, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Vector3 } from "three";

import { estimateSharpness, lockCameraAppearance } from "@/components/room-capture/capture-utils";
import { currentScreenAngle, deviceQuaternion } from "@/components/room-capture/device-pose";
import {
  addPhoto,
  createPhotoGuide,
  isBlurredPhoto,
  MAX_SCAN_PHOTOS,
  MIN_SCAN_PHOTOS,
  photoCoverageFraction,
  photoCoveredCells,
  photoHint,
  RECOMMENDED_SCAN_PHOTOS,
  replayPhotos,
  type PhotoGuide,
} from "@/lib/photo-scan-guide";
import { SCAN_ROWS } from "@/lib/scan-coverage";

import { PHOTO_MAX_DIMENSION } from "./scan-api";
import styles from "./scan.module.css";

type OrientationEventConstructor = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<"granted" | "denied">;
};

type Phase = "starting" | "ready" | "error";

type TakenPhoto = {
  blob: Blob;
  url: string;
  sharpness: number;
  forward: [number, number, number] | null;
};

/** How long a "blurry, take it again" message stays up. */
const NOTICE_MS = 2500;

function grabPhoto(video: HTMLVideoElement) {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) throw new Error("The camera is still starting. Try again in a moment.");
  const scale = Math.min(1, PHOTO_MAX_DIMENSION / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("This browser cannot save photos.");
  // The whole frame, uncropped: the 3D pipeline wants the camera's full view.
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  let sharpness = 0;
  try {
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    sharpness = estimateSharpness(pixels.data, pixels.width, pixels.height, Math.max(1, Math.round(pixels.width / 150)));
  } catch {
    // Without pixel access the blur check is skipped.
  }
  return new Promise<{ blob: Blob; sharpness: number }>((resolve, reject) => {
    canvas.toBlob((blob) => {
      canvas.width = canvas.height = 1;
      if (blob) resolve({ blob, sharpness });
      else reject(new Error("The photo could not be saved. Try again."));
    }, "image/jpeg", 0.92);
  });
}

/**
 * Full-screen camera for a photo-based 3D scan: the person takes a photo,
 * steps sideways, takes the next.  Motion sensors show which parts of the
 * room have been photographed and warn about big turns between photos;
 * blurred photos are refused so they can be taken again.
 */
export function ScanPhotoCapture({ onDone, onCancel }: { onDone: (photos: Blob[]) => void; onCancel: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const forwardRef = useRef<[number, number, number] | null>(null);
  const photosRef = useRef<TakenPhoto[]>([]);
  const lockedRef = useRef(false);
  const askedMotionRef = useRef(false);
  const noticeTimerRef = useRef<number | null>(null);
  const [phase, setPhase] = useState<Phase>("starting");
  const [error, setError] = useState<string | null>(null);
  const [photos, setPhotos] = useState<TakenPhoto[]>([]);
  const [guide, setGuide] = useState<PhotoGuide>(createPhotoGuide);
  const [hasMotion, setHasMotion] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [flash, setFlash] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => undefined);
        }
        setPhase("ready");
      } catch {
        if (cancelled) return;
        setError("The camera could not be opened. Allow camera access, or upload photos taken with the camera app.");
        setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  // Release thumbnails when the capture screen closes.
  useEffect(() => () => {
    photosRef.current.forEach((photo) => URL.revokeObjectURL(photo.url));
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
  }, []);

  useEffect(() => {
    const forward = new Vector3();
    const handle = (event: DeviceOrientationEvent) => {
      if (event.alpha === null || event.beta === null || event.gamma === null) return;
      const camera = deviceQuaternion(event.alpha, event.beta, event.gamma, currentScreenAngle());
      forward.set(0, 0, -1).applyQuaternion(camera);
      forwardRef.current = [forward.x, forward.y, forward.z];
    };
    window.addEventListener("deviceorientation", handle, true);
    return () => window.removeEventListener("deviceorientation", handle, true);
  }, []);

  const showNotice = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), NOTICE_MS);
  }, []);

  const updatePhotos = (next: TakenPhoto[]) => {
    photosRef.current = next;
    setPhotos(next);
    setGuide(replayPhotos(next.map((photo) => photo.forward)));
  };

  const takePhoto = async () => {
    const video = videoRef.current;
    if (!video || busy || photosRef.current.length >= MAX_SCAN_PHOTOS) return;
    setBusy(true);
    try {
      if (!askedMotionRef.current) {
        // iOS asks for motion access only from a tap.
        askedMotionRef.current = true;
        try {
          const orientation = typeof DeviceOrientationEvent === "undefined" ? undefined : (DeviceOrientationEvent as OrientationEventConstructor);
          if (typeof orientation?.requestPermission === "function") await orientation.requestPermission();
        } catch {
          // Photos work without motion guidance.
        }
      }
      const { blob, sharpness } = await grabPhoto(video);
      if (isBlurredPhoto(sharpness, photosRef.current.map((photo) => photo.sharpness))) {
        showNotice("Blurry: hold the phone still and take that one again");
        return;
      }
      const forward = forwardRef.current ? [...forwardRef.current] as [number, number, number] : null;
      if (forward) setHasMotion(true);
      const photo: TakenPhoto = { blob, url: URL.createObjectURL(blob), sharpness, forward };
      const next = [...photosRef.current, photo];
      photosRef.current = next;
      setPhotos(next);
      setGuide((current) => addPhoto(current, forward));
      setFlash((value) => value + 1);
      // Same brightness and colour in every photo keeps the 3D room from blotching.
      if (!lockedRef.current) {
        lockedRef.current = true;
        const [track] = streamRef.current?.getVideoTracks() ?? [];
        if (track) void lockCameraAppearance(track);
      }
    } catch (captureError) {
      showNotice(captureError instanceof Error ? captureError.message : "The photo could not be taken.");
    } finally {
      setBusy(false);
    }
  };

  const undo = () => {
    const last = photosRef.current.at(-1);
    if (!last) return;
    URL.revokeObjectURL(last.url);
    updatePhotos(photosRef.current.slice(0, -1));
  };

  const close = () => {
    if (photosRef.current.length > 0 && !window.confirm(`Discard ${photosRef.current.length} photos?`)) return;
    onCancel();
  };

  const finish = () => {
    const blobs = photosRef.current.map((photo) => photo.blob);
    onDone(blobs);
  };

  const count = photos.length;
  const hint = notice ? { tone: "warn" as const, text: notice } : photoHint(guide, hasMotion);
  const cells = photoCoveredCells(guide);
  const atLimit = count >= MAX_SCAN_PHOTOS;

  return (
    <div className={styles.recorder} role="dialog" aria-modal="true" aria-label="Take photos for 3D">
      <video ref={videoRef} className={styles.recorderVideo} muted playsInline autoPlay aria-hidden="true" />
      {flash > 0 ? <span key={flash} className={styles.shutterFlash} aria-hidden="true" /> : null}
      <div className={styles.recorderTop}>
        <button type="button" className={styles.recorderClose} onClick={close} aria-label="Close camera">
          <X aria-hidden="true" />
        </button>
        {phase === "ready" ? (
          <p className={styles.photoCounter} aria-live="polite">
            <strong>{count}</strong> {count === 1 ? "photo" : "photos"}
            <small>{count < MIN_SCAN_PHOTOS ? `at least ${MIN_SCAN_PHOTOS}` : `aim for ${RECOMMENDED_SCAN_PHOTOS}+`}</small>
          </p>
        ) : null}
      </div>

      {phase === "ready" ? (
        <div className={styles.recorderGuide}>
          <p className={styles.recorderHint} data-tone={hint.tone} role="status">{hint.text}</p>
          {hasMotion ? (
            <div className={styles.coverageMap} aria-label={`${Math.round(photoCoverageFraction(guide) * 100)}% of the room photographed`} role="img">
              {[...SCAN_ROWS].reverse().map((row) => (
                <div key={row} className={styles.coverageRow}>
                  <small>{row === "high" ? "Up" : row === "level" ? "Eye" : "Down"}</small>
                  {cells[SCAN_ROWS.indexOf(row)].map((covered, index) => (
                    <span key={index} data-covered={covered} />
                  ))}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className={styles.recorderBottom}>
        {phase === "starting" ? <p className={styles.recorderNote}><Loader2 aria-hidden="true" className={styles.spin} /> Opening the camera…</p> : null}
        {phase === "error" ? <p className={styles.recorderError} role="alert">{error}</p> : null}
        {phase === "ready" ? (
          <div className={styles.photoControls}>
            <div className={styles.photoSide}>
              {count > 0 ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element -- a local object URL */}
                  <img className={styles.lastPhoto} src={photos[count - 1].url} alt="" />
                  <button type="button" className={styles.photoSmallButton} onClick={undo} aria-label="Undo last photo">
                    <Undo2 aria-hidden="true" />
                  </button>
                </>
              ) : null}
            </div>
            <button
              type="button"
              className={styles.recordButton}
              data-shutter="true"
              onClick={() => void takePhoto()}
              aria-label="Take photo"
              disabled={busy || atLimit}
            >
              <Camera aria-hidden="true" />
            </button>
            <div className={styles.photoSide}>
              <button
                type="button"
                className={styles.photoDoneButton}
                onClick={finish}
                disabled={count < MIN_SCAN_PHOTOS || busy}
                aria-label={count < MIN_SCAN_PHOTOS ? `Done (needs ${MIN_SCAN_PHOTOS - count} more photos)` : "Done, build the 3D room"}
              >
                <Check aria-hidden="true" /> Done
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
