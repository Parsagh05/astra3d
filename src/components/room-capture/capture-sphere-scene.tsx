"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useState, type RefObject } from "react";
import {
  BufferGeometry,
  Float32BufferAttribute,
  MathUtils,
  PerspectiveCamera,
  Quaternion,
  SRGBColorSpace,
  TextureLoader,
  Vector3,
  type Texture,
} from "three";

import { STILL_HORIZONTAL_FOV, STILL_VERTICAL_FOV } from "@/lib/guided-capture";

import { viewQuaternion } from "./device-pose";
import type { SphereShot } from "./capture-sphere-view";
import type { CaptureEngineState } from "./use-guided-capture";

const GRID_RADIUS = 20;
const SHOT_DISTANCE = 10;
const SHOT_WIDTH = 2 * SHOT_DISTANCE * Math.tan(MathUtils.degToRad(STILL_HORIZONTAL_FOV / 2));
const SHOT_HEIGHT = 2 * SHOT_DISTANCE * Math.tan(MathUtils.degToRad(STILL_VERTICAL_FOV / 2));

/**
 * The scene only changes when the phone moves, so it renders on demand: one
 * frame per new pose instead of a continuous loop that would drain the
 * battery and compete with the motion sensor for the main thread.
 */
function PoseInvalidator({ engineRef, fov }: { engineRef: RefObject<CaptureEngineState>; fov: number }) {
  const invalidate = useThree((state) => state.invalidate);
  useEffect(() => {
    invalidate();
  }, [fov, invalidate]);
  useEffect(() => {
    const last = new Quaternion(0, 0, 0, 0);
    let frame = 0;
    const watch = () => {
      frame = window.requestAnimationFrame(watch);
      const pose = engineRef.current?.pose;
      if (pose && !pose.equals(last)) {
        last.copy(pose);
        invalidate();
      }
    };
    frame = window.requestAnimationFrame(watch);
    return () => window.cancelAnimationFrame(frame);
  }, [engineRef, invalidate]);
  return null;
}

function CameraRig({ engineRef, fov }: { engineRef: RefObject<CaptureEngineState>; fov: number }) {
  useFrame((state) => {
    const camera = state.camera as PerspectiveCamera;
    if (Math.abs(camera.fov - fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    const pose = engineRef.current?.pose;
    if (pose) camera.quaternion.copy(pose);
  });
  return null;
}

/** Latitude and longitude lines every 30°, like a globe seen from inside. */
function SphereGrid() {
  const geometry = useMemo(() => {
    const points: number[] = [];
    const segments = 96;
    const push = (yaw: number, pitch: number) => {
      const y = MathUtils.degToRad(yaw);
      const p = MathUtils.degToRad(pitch);
      points.push(
        GRID_RADIUS * Math.sin(y) * Math.cos(p),
        GRID_RADIUS * Math.sin(p),
        -GRID_RADIUS * Math.cos(y) * Math.cos(p),
      );
    };
    for (let pitch = -60; pitch <= 60; pitch += 30) {
      for (let step = 0; step < segments; step += 1) {
        push((step / segments) * 360, pitch);
        push(((step + 1) / segments) * 360, pitch);
      }
    }
    for (let yaw = 0; yaw < 360; yaw += 30) {
      for (let step = 0; step < segments / 2; step += 1) {
        push(yaw, -90 + (step / (segments / 2)) * 180);
        push(yaw, -90 + ((step + 1) / (segments / 2)) * 180);
      }
    }
    const buffer = new BufferGeometry();
    buffer.setAttribute("position", new Float32BufferAttribute(points, 3));
    return buffer;
  }, []);
  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <lineSegments geometry={geometry} renderOrder={-1}>
      <lineBasicMaterial color="#9fb6d6" transparent opacity={0.38} depthWrite={false} />
    </lineSegments>
  );
}

function ShotPlane({ shot, order }: { shot: SphereShot; order: number }) {
  const [texture, setTexture] = useState<Texture | null>(null);

  useEffect(() => {
    if (!shot.url) return;
    let active = true;
    new TextureLoader().load(shot.url, (loaded) => {
      if (!active) {
        loaded.dispose();
        return;
      }
      loaded.colorSpace = SRGBColorSpace;
      setTexture(loaded);
    });
    return () => {
      active = false;
    };
  }, [shot.url]);
  useEffect(() => () => texture?.dispose(), [texture]);

  const placement = useMemo(() => {
    const quaternion = shot.view
      ? new Quaternion(...shot.view)
      : viewQuaternion(shot.yaw, shot.pitch);
    return {
      quaternion,
      position: new Vector3(0, 0, -SHOT_DISTANCE).applyQuaternion(quaternion),
    };
  }, [shot.pitch, shot.view, shot.yaw]);

  if (!texture) return null;
  return (
    <mesh position={placement.position} quaternion={placement.quaternion} renderOrder={order}>
      <planeGeometry args={[SHOT_WIDTH, SHOT_HEIGHT]} />
      <meshBasicMaterial map={texture} toneMapped={false} depthTest={false} depthWrite={false} />
    </mesh>
  );
}

/**
 * The photo-sphere behind the live window: a dark globe grid with every
 * captured still painted where it was taken, so the user sees coverage grow.
 */
export function CaptureSphereScene({
  engineRef,
  fov,
  shots,
  onReady,
}: {
  engineRef: RefObject<CaptureEngineState>;
  fov: number;
  shots: readonly SphereShot[];
  onReady?: () => void;
}) {
  return (
    <Canvas
      dpr={[1, 1.75]}
      flat
      frameloop="demand"
      gl={{ antialias: true, alpha: false, powerPreference: "low-power" }}
      camera={{ fov, near: 0.1, far: 60, position: [0, 0, 0] }}
      onCreated={({ gl }) => {
        gl.setClearColor("#070b12");
        onReady?.();
      }}
      style={{ position: "absolute", inset: 0 }}
    >
      <PoseInvalidator engineRef={engineRef} fov={fov} />
      <CameraRig engineRef={engineRef} fov={fov} />
      <SphereGrid />
      {shots.map((shot, index) => <ShotPlane key={shot.key} shot={shot} order={index} />)}
    </Canvas>
  );
}
