"use client";

import {
  ArrowLeft,
  Camera,
  Check,
  ChevronRight,
  CircleGauge,
  ImagePlus,
  LockKeyhole,
  RotateCcw,
  ScanLine,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BrandMark } from "@/components/brand-mark";
import type { CapturedFrame, GeneratedRoomRecord } from "@/types/capture";

import {
  buildCaptureSlots,
  CAPTURE_BANDS,
  CAPTURE_COLUMNS,
  captureVideoFrame,
  getCaptureProgress,
  normalizeRoomPhoto,
  stitchRoomPanorama,
  TOTAL_CAPTURE_SLOTS,
} from "./capture-utils";
import { GeneratedRoomViewer } from "./generated-room-viewer";
import {
  deleteGeneratedRoom,
  loadGeneratedRoom,
  saveGeneratedRoom,
} from "./room-storage";
import styles from "./room-capture.module.css";

type StudioStage = "intro" | "capture" | "processing" | "result";
type CameraMode = "idle" | "requesting" | "live" | "file" | "denied";

const captureSlots = buildCaptureSlots();

export function RoomStudio() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [stage, setStage] = useState<StudioStage>("intro");
  const [cameraMode, setCameraMode] = useState<CameraMode>("idle");
  const [roomName, setRoomName] = useState("My room");
  const [frames, setFrames] = useState<CapturedFrame[]>([]);
  const [room, setRoom] = useState<GeneratedRoomRecord | null>(null);
  const [loadingSavedRoom, setLoadingSavedRoom] = useState(true);
  const [processingProgress, setProcessingProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  const [liveCameraAvailable, setLiveCameraAvailable] = useState(false);

  const activeSlot = captureSlots[frames.length];
  const activeBand = CAPTURE_BANDS.find((band) => band.id === activeSlot?.band);
  const currentBandFrames = activeSlot
    ? frames.filter((frame) => frame.band === activeSlot.band).length
    : CAPTURE_COLUMNS;
  const captureComplete = frames.length === TOTAL_CAPTURE_SLOTS;

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  useEffect(() => {
    let active = true;
    loadGeneratedRoom()
      .then((savedRoom) => {
        if (active && savedRoom) setRoom(savedRoom);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setLoadingSavedRoom(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => stopCamera, [stopCamera]);

  const startCamera = useCallback(async () => {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
      setCameraMode("file");
      return;
    }

    setLiveCameraAvailable(true);
    setCameraMode("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1440 },
        },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraMode("live");
    } catch {
      setCameraMode("denied");
      setError("Camera preview was blocked. You can still use Android’s native camera for every guided photo.");
    }
  }, []);

  const beginCapture = () => {
    setFrames([]);
    setError(null);
    setStage("capture");
    window.requestAnimationFrame(() => void startCamera());
  };

  const addFrame = useCallback((dataUrl: string) => {
    setError(null);
    setFlash(true);
    window.setTimeout(() => setFlash(false), 160);
    setFrames((current) => {
      const slot = captureSlots[current.length];
      if (!slot) return current;
      const next = [...current, { ...slot, dataUrl, capturedAt: Date.now() }];
      if (next.length === TOTAL_CAPTURE_SLOTS) stopCamera();
      return next;
    });
  }, [stopCamera]);

  const takeLivePhoto = () => {
    if (!videoRef.current) return;
    try {
      addFrame(captureVideoFrame(videoRef.current));
    } catch (captureError) {
      setError(captureError instanceof Error ? captureError.message : "The photo could not be captured.");
    }
  };

  const importPhoto = async (file: File | undefined) => {
    if (!file) return;
    try {
      addFrame(await normalizeRoomPhoto(file));
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "The photo could not be prepared.");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const undoLast = () => {
    setFrames((current) => current.slice(0, -1));
    setError(null);
    if (!streamRef.current && cameraMode === "live") void startCamera();
  };

  const buildRoom = async () => {
    setStage("processing");
    setProcessingProgress(0);
    setError(null);
    stopCamera();

    try {
      const panorama = await stitchRoomPanorama(frames, setProcessingProgress);
      const generatedRoom: GeneratedRoomRecord = {
        id: "latest-room",
        name: roomName.trim() || "My room",
        createdAt: new Date().toISOString(),
        photoCount: frames.length,
        panorama,
      };
      setRoom(generatedRoom);
      setFrames([]);
      try {
        await saveGeneratedRoom(generatedRoom);
      } catch {
        setError("The panorama is ready, but this browser did not allow persistent local storage.");
      }
      setStage("result");
    } catch (processingError) {
      setError(processingError instanceof Error ? processingError.message : "The room could not be assembled.");
      setStage("capture");
    }
  };

  const resetStudio = async () => {
    stopCamera();
    setFrames([]);
    setRoom(null);
    setStage("intro");
    setCameraMode("idle");
    setError(null);
    try {
      await deleteGeneratedRoom();
    } catch {
      // The in-memory reset still succeeds when private browsing blocks IndexedDB.
    }
  };

  const bandCompletion = useMemo(
    () => CAPTURE_BANDS.map((band) => ({
      ...band,
      count: frames.filter((frame) => frame.band === band.id).length,
    })),
    [frames],
  );

  return (
    <div className={styles.studioShell}>
      <header className={styles.studioHeader}>
        <Link href="/" aria-label="Astra3D home"><BrandMark /></Link>
        <div><span /> Room Capture Lab · local MVP</div>
        <Link href="/" className={styles.backLink}><ArrowLeft aria-hidden="true" /> Back to site</Link>
      </header>

      <main className={styles.studioMain}>
        {stage === "intro" ? (
          <section className={styles.intro} aria-labelledby="studio-title">
            <div className={styles.introCopy}>
              <p className={styles.kicker}><ScanLine aria-hidden="true" /> Single-room capture</p>
              <h1 id="studio-title">Turn phone photos into your first 360° room.</h1>
              <p>
                Stand in one fixed spot. Astra3D guides you through 24 overlapping photos, blends them locally, and opens the result as a swipeable room.
              </p>

              <label className={styles.roomNameField}>
                <span>Room name</span>
                <input
                  value={roomName}
                  maxLength={48}
                  onChange={(event) => setRoomName(event.target.value)}
                  placeholder="Living room"
                />
              </label>

              <button className={styles.primaryButton} type="button" onClick={beginCapture}>
                <Camera aria-hidden="true" /> Start room scan <ChevronRight aria-hidden="true" />
              </button>

              {!loadingSavedRoom && room ? (
                <button className={styles.savedRoomButton} type="button" onClick={() => setStage("result")}>
                  <span><Check aria-hidden="true" /></span>
                  <span><strong>Open saved room</strong><small>{room.name} · {room.photoCount} photos</small></span>
                  <ChevronRight aria-hidden="true" />
                </button>
              ) : null}
            </div>

            <div className={styles.captureBlueprint} aria-label="Capture process overview">
              <div className={styles.blueprintPhone}>
                <span className={styles.phoneCamera} />
                <div><ScanLine aria-hidden="true" /><strong>24</strong><small>guided views</small></div>
              </div>
              <div className={styles.orbitRing} aria-hidden="true">
                {Array.from({ length: 8 }, (_, index) => <i key={index} style={{ "--index": index } as React.CSSProperties} />)}
              </div>
              <div className={styles.blueprintStats}>
                <span><CircleGauge aria-hidden="true" /><strong>3 bands</strong><small>upper · eye · lower</small></span>
                <span><Sparkles aria-hidden="true" /><strong>Local blend</strong><small>4096 × 2048 output</small></span>
              </div>
            </div>

            <div className={styles.preflight}>
              <article><strong>01 · Pick the center</strong><p>Stand near the center and keep your feet in exactly one place.</p></article>
              <article><strong>02 · Keep it upright</strong><p>Use portrait orientation. Rotate your body, not the phone around the room.</p></article>
              <article><strong>03 · Freeze the scene</strong><p>Use even light and ask people to stay out until all 24 photos finish.</p></article>
            </div>

            <div className={styles.privacyBanner}>
              <LockKeyhole aria-hidden="true" />
              <div><strong>Photos stay on this device</strong><p>No upload, account, cloud processing, or analytics are used by this capture MVP.</p></div>
            </div>
          </section>
        ) : null}

        {stage === "capture" ? (
          <section className={styles.captureStage} aria-labelledby="capture-title">
            <div className={styles.captureTopbar}>
              <button type="button" onClick={() => { stopCamera(); setStage("intro"); }}>
                <ArrowLeft aria-hidden="true" /> Exit scan
              </button>
              <div>
                <span>Room progress</span>
                <strong>{frames.length} / {TOTAL_CAPTURE_SLOTS}</strong>
              </div>
              <div className={styles.progressTrack} aria-label={`${getCaptureProgress(frames.length)} percent captured`}>
                <span style={{ width: `${getCaptureProgress(frames.length)}%` }} />
              </div>
            </div>

            <div className={styles.captureWorkspace}>
              <div className={styles.cameraPanel}>
                <div className={styles.cameraViewport} data-flash={flash}>
                  {cameraMode === "live" || cameraMode === "requesting" ? (
                    <video ref={videoRef} autoPlay muted playsInline aria-label="Rear camera preview" />
                  ) : (
                    <div className={styles.fileCameraFallback}>
                      <ImagePlus aria-hidden="true" />
                      <strong>{cameraMode === "denied" ? "Camera preview blocked" : "Android camera mode"}</strong>
                      <p>Each Capture button opens your phone camera. Return here after taking every photo.</p>
                    </div>
                  )}
                  <div className={styles.cameraGrid} aria-hidden="true"><i /><i /></div>
                  <div className={styles.levelGuide} aria-hidden="true"><span /></div>
                  {activeBand ? (
                    <div className={styles.cameraInstruction}>
                      <span>{activeBand.label} · {activeBand.tilt}</span>
                      <strong>Direction {Math.min(currentBandFrames + 1, CAPTURE_COLUMNS)} of {CAPTURE_COLUMNS}</strong>
                    </div>
                  ) : null}
                  {cameraMode === "requesting" ? <p className={styles.cameraLoading}>Starting rear camera…</p> : null}
                </div>

                <div className={styles.directionRing} aria-label="Current rotation coverage">
                  <div><span style={{ transform: `rotate(${activeSlot?.yaw ?? 360}deg)` }} /></div>
                  {Array.from({ length: CAPTURE_COLUMNS }, (_, index) => {
                    const captured = index < currentBandFrames || captureComplete;
                    const current = index === currentBandFrames && !captureComplete;
                    return <i key={index} data-captured={captured} data-current={current} style={{ "--index": index } as React.CSSProperties}>{captured ? <Check aria-hidden="true" /> : index + 1}</i>;
                  })}
                  <strong>{activeBand?.label ?? "Complete"}</strong>
                  <small>{activeBand?.instruction ?? "All room angles captured."}</small>
                </div>

                <div className={styles.captureControls}>
                  <button type="button" onClick={undoLast} disabled={frames.length === 0} aria-label="Retake previous photo">
                    <RotateCcw aria-hidden="true" /> Retake
                  </button>
                  {!captureComplete ? (
                    cameraMode === "live" ? (
                      <button className={styles.shutterButton} type="button" onClick={takeLivePhoto} aria-label={`Capture photo ${frames.length + 1}`}>
                        <span><Camera aria-hidden="true" /></span>
                      </button>
                    ) : (
                      <button className={styles.fileCaptureButton} type="button" onClick={() => fileInputRef.current?.click()}>
                        <Camera aria-hidden="true" /> Capture {frames.length + 1}
                      </button>
                    )
                  ) : (
                    <button className={styles.buildButton} type="button" onClick={() => void buildRoom()}>
                      <Sparkles aria-hidden="true" /> Build my 360
                    </button>
                  )}
                  <span className={styles.controlSpacer} aria-hidden="true" />
                </div>

                <input
                  ref={fileInputRef}
                  className={styles.hiddenInput}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={(event) => void importPhoto(event.target.files?.[0])}
                />
              </div>

              <aside className={styles.captureRail}>
                <p className={styles.kicker}>Coverage map</p>
                <h1 id="capture-title">Photograph every layer.</h1>
                <p>Complete eight directions before changing the phone tilt. Maintain generous overlap between neighboring photos.</p>
                <div className={styles.bandList}>
                  {bandCompletion.map((band) => (
                    <div key={band.id} data-active={band.id === activeSlot?.band} data-complete={band.count === CAPTURE_COLUMNS}>
                      <span>{band.count === CAPTURE_COLUMNS ? <Check aria-hidden="true" /> : band.tilt}</span>
                      <div><strong>{band.label}</strong><small>{band.count} / {CAPTURE_COLUMNS} views</small></div>
                      <i><b style={{ width: `${(band.count / CAPTURE_COLUMNS) * 100}%` }} /></i>
                    </div>
                  ))}
                </div>
                <div className={styles.scanTip}>
                  <strong>For cleaner seams</strong>
                  <p>Rotate slowly clockwise and keep the phone lens over the same invisible center point.</p>
                </div>
                {error ? <p className={styles.errorMessage} role="alert">{error}</p> : null}
                {(cameraMode === "denied" || cameraMode === "file") && liveCameraAvailable ? (
                  <button className={styles.retryCamera} type="button" onClick={() => void startCamera()}>
                    <Camera aria-hidden="true" /> Retry live camera
                  </button>
                ) : null}
              </aside>
            </div>
          </section>
        ) : null}

        {stage === "processing" ? (
          <section className={styles.processing} aria-labelledby="processing-title">
            <div
              className={styles.processingOrb}
              style={{ "--progress": `${processingProgress * 3.6}deg` } as React.CSSProperties}
            >
              <ScanLine aria-hidden="true" /><span />
            </div>
            <p className={styles.kicker}>On-device panorama assembly</p>
            <h1 id="processing-title">Building {roomName.trim() || "your room"}…</h1>
            <p>Normalizing perspective bands, feathering overlap, and exporting a 2:1 panorama.</p>
            <div className={styles.processingTrack}><span style={{ width: `${processingProgress}%` }} /></div>
            <strong>{processingProgress}%</strong>
            <small>Keep this tab open. No images are being uploaded.</small>
          </section>
        ) : null}

        {stage === "result" && room ? <GeneratedRoomViewer room={room} onRetake={() => void resetStudio()} /> : null}
      </main>
    </div>
  );
}
