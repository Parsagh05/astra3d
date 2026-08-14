"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { clampPanoramaView, type PanoramaViewInput } from "./tour-math";

type PanoramaFallbackCanvasProps = PanoramaViewInput & {
  alt: string;
  onFailure?: () => void;
  onReady?: () => void;
  src: string;
};

function normalizeHeading(value: number) {
  return ((value % 360) + 360) % 360;
}

export function PanoramaFallbackCanvas({
  alt,
  fieldOfView,
  fov,
  onFailure,
  onReady,
  pitch,
  src,
  yaw,
}: PanoramaFallbackCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const onFailureRef = useRef(onFailure);
  const onReadyRef = useRef(onReady);
  const [image, setImage] = useState<HTMLImageElement | null>(null);

  useEffect(() => {
    onFailureRef.current = onFailure;
    onReadyRef.current = onReady;
  }, [onFailure, onReady]);

  useEffect(() => {
    let active = true;
    const nextImage = new window.Image();
    nextImage.decoding = "async";
    nextImage.onload = () => {
      if (!active) return;
      setImage(nextImage);
      onReadyRef.current?.();
    };
    nextImage.onerror = () => {
      if (active) onFailureRef.current?.();
    };
    nextImage.src = src;

    return () => {
      active = false;
      nextImage.src = "";
    };
  }, [src]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image?.naturalWidth || !image.naturalHeight) return;

    const bounds = canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
    const outputWidth = Math.max(1, Math.round(bounds.width * pixelRatio));
    const outputHeight = Math.max(1, Math.round(bounds.height * pixelRatio));
    if (canvas.width !== outputWidth || canvas.height !== outputHeight) {
      canvas.width = outputWidth;
      canvas.height = outputHeight;
    }

    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return;

    const view = clampPanoramaView({
      fov: fov ?? fieldOfView ?? 75,
      pitch,
      yaw,
    });
    const aspect = outputWidth / outputHeight;
    const verticalRadians = view.fov * Math.PI / 180;
    const horizontalDegrees = Math.min(
      179,
      2 * Math.atan(Math.tan(verticalRadians / 2) * aspect) * 180 / Math.PI,
    );
    const sourceWidth = image.naturalWidth * horizontalDegrees / 360;
    const sourceHeight = Math.min(
      image.naturalHeight,
      image.naturalHeight * view.fov / 180,
    );
    const sourceTop = Math.max(
      0,
      Math.min(
        image.naturalHeight - sourceHeight,
        image.naturalHeight * (0.5 - view.pitch / 180) - sourceHeight / 2,
      ),
    );
    let sourceLeft = normalizeHeading(view.yaw) / 360 * image.naturalWidth - sourceWidth / 2;
    sourceLeft = normalizeHeading(sourceLeft / image.naturalWidth * 360) / 360 * image.naturalWidth;
    let remaining = sourceWidth;
    let destinationLeft = 0;

    context.fillStyle = "#030914";
    context.fillRect(0, 0, outputWidth, outputHeight);
    while (remaining > 0.01) {
      const segmentWidth = Math.min(remaining, image.naturalWidth - sourceLeft);
      const destinationWidth = outputWidth * segmentWidth / sourceWidth;
      context.drawImage(
        image,
        sourceLeft,
        sourceTop,
        segmentWidth,
        sourceHeight,
        destinationLeft,
        0,
        destinationWidth,
        outputHeight,
      );
      remaining -= segmentWidth;
      destinationLeft += destinationWidth;
      sourceLeft = 0;
    }
  }, [fieldOfView, fov, image, pitch, yaw]);

  useEffect(() => {
    draw();
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [draw]);

  return (
    <canvas
      ref={canvasRef}
      aria-label={alt}
      role="img"
      style={{ height: "100%", inset: 0, position: "absolute", width: "100%" }}
    />
  );
}
