"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { PerspectiveCamera, useTexture } from "@react-three/drei";
import { BackSide, Euler, MathUtils, SRGBColorSpace } from "three";
import { useEffect, useMemo, useRef } from "react";
import {
  clampPanoramaView,
  type PanoramaView,
  type PanoramaViewInput,
} from "./tour-math";

export type PanoramaSceneProps = PanoramaViewInput & {
  src: string;
  compact?: boolean;
  onContextLost?: () => void;
  onContextRestored?: () => void;
  onFailure?: () => void;
  onReady?: () => void;
};

function PanoramaTexture({ src }: Pick<PanoramaSceneProps, "src">) {
  const sourceTexture = useTexture(src);
  const renderer = useThree((state) => state.gl);
  const invalidate = useThree((state) => state.invalidate);
  const texture = useMemo(() => {
    const preparedTexture = sourceTexture.clone();
    preparedTexture.colorSpace = SRGBColorSpace;
    preparedTexture.anisotropy = Math.min(
      8,
      renderer.capabilities.getMaxAnisotropy(),
    );
    preparedTexture.needsUpdate = true;
    return preparedTexture;
  }, [renderer, sourceTexture]);

  useEffect(() => {
    invalidate();
    return () => texture.dispose();
  }, [invalidate, texture]);

  return (
    <mesh rotation={[0, Math.PI / 2, 0]}>
      <sphereGeometry args={[10, 64, 40]} />
      <meshBasicMaterial
        map={texture}
        side={BackSide}
        toneMapped={false}
      />
    </mesh>
  );
}

function CameraView({ fov, pitch, yaw }: PanoramaView) {
  const view = clampPanoramaView({ fov, pitch, yaw });
  const rotation = useMemo(
    () =>
      new Euler(
      MathUtils.degToRad(view.pitch),
      -MathUtils.degToRad(view.yaw),
      0,
        "YXZ",
      ),
    [view.pitch, view.yaw],
  );

  return (
    <PerspectiveCamera
      makeDefault
      far={30}
      fov={view.fov}
      near={0.01}
      position={[0, 0, 0]}
      rotation={rotation}
    />
  );
}

function RendererLifecycle({
  onContextLost,
  onContextRestored,
  onFailure,
  onReady,
}: Pick<
  PanoramaSceneProps,
  "onContextLost" | "onContextRestored" | "onFailure" | "onReady"
>) {
  const renderer = useThree((state) => state.gl);
  const hasSignalledReady = useRef(false);

  useEffect(() => {
    const canvas = renderer.domElement;
    const handleContextLoss = (event: Event) => {
      event.preventDefault();
      onContextLost?.();
      onFailure?.();
    };
    const handleContextRestore = () => onContextRestored?.();

    canvas.addEventListener("webglcontextlost", handleContextLoss, false);
    canvas.addEventListener("webglcontextrestored", handleContextRestore, false);

    return () => {
      canvas.removeEventListener("webglcontextlost", handleContextLoss, false);
      canvas.removeEventListener(
        "webglcontextrestored",
        handleContextRestore,
        false,
      );
    };
  }, [onContextLost, onContextRestored, onFailure, renderer]);

  useFrame(() => {
    if (!hasSignalledReady.current) {
      hasSignalledReady.current = true;
      onReady?.();
    }
  });

  return null;
}

export function PanoramaScene({
  compact = false,
  fieldOfView,
  fov,
  onContextLost,
  onContextRestored,
  onFailure,
  onReady,
  pitch,
  src,
  yaw,
}: PanoramaSceneProps) {
  const resolvedFov = fov ?? fieldOfView ?? 75;

  return (
    <Canvas
      aria-hidden="true"
      camera={{ fov: resolvedFov, near: 0.01, far: 30, position: [0, 0, 0] }}
      dpr={compact ? [1, 1.25] : [1, 1.75]}
      frameloop="demand"
      gl={{
        alpha: false,
        antialias: !compact,
        powerPreference: compact ? "low-power" : "high-performance",
      }}
      performance={{ min: 0.6 }}
    >
      <RendererLifecycle
        onContextLost={onContextLost}
        onContextRestored={onContextRestored}
        onFailure={onFailure}
        onReady={onReady}
      />
      <CameraView fov={resolvedFov} pitch={pitch} yaw={yaw} />
      <PanoramaTexture src={src} />
    </Canvas>
  );
}
