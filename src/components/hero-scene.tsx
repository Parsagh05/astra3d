"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { MathUtils, type Group, type Mesh } from "three";
import { useEffect, useRef } from "react";

type HeroSceneProps = {
  active: boolean;
  compact: boolean;
  onFailure: () => void;
  onReady: () => void;
};

type ShowroomProps = Pick<HeroSceneProps, "active" | "compact">;

function RendererLifecycle({
  onFailure,
  onReady,
}: Pick<HeroSceneProps, "onFailure" | "onReady">) {
  const renderer = useThree((state) => state.gl);
  const hasSignalled = useRef(false);

  useEffect(() => {
    const canvas = renderer.domElement;
    const handleContextLoss = (event: Event) => {
      event.preventDefault();
      onFailure();
    };

    canvas.addEventListener("webglcontextlost", handleContextLoss, false);
    return () =>
      canvas.removeEventListener("webglcontextlost", handleContextLoss, false);
  }, [onFailure, renderer]);

  useFrame(() => {
    if (!hasSignalled.current) {
      hasSignalled.current = true;
      onReady();
    }
  });

  return null;
}

function ProductPlinth({
  accent,
  compact,
  position,
  shape,
}: {
  accent: string;
  compact: boolean;
  position: [number, number, number];
  shape: "jewel" | "loop" | "monolith";
}) {
  return (
    <group position={position}>
      <mesh castShadow={!compact} receiveShadow={!compact}>
        <cylinderGeometry args={[0.36, 0.42, 0.66, compact ? 16 : 32]} />
        <meshStandardMaterial
          color="#172638"
          metalness={0.72}
          roughness={0.28}
        />
      </mesh>
      <mesh position={[0, 0.35, 0]}>
        <cylinderGeometry args={[0.27, 0.31, 0.035, compact ? 16 : 32]} />
        <meshBasicMaterial color={accent} transparent opacity={0.5} />
      </mesh>

      {shape === "jewel" ? (
        <mesh position={[0, 0.76, 0]} castShadow={!compact}>
          <octahedronGeometry args={[0.29, compact ? 0 : 1]} />
          <meshPhysicalMaterial
            color="#86e4ff"
            emissive="#1676a6"
            emissiveIntensity={0.42}
            metalness={0.28}
            roughness={0.08}
            transmission={compact ? 0 : 0.48}
            transparent
            opacity={compact ? 0.9 : 0.72}
          />
        </mesh>
      ) : null}

      {shape === "loop" ? (
        <mesh
          position={[0, 0.76, 0]}
          rotation={[Math.PI / 2, 0.2, 0]}
          castShadow={!compact}
        >
          <torusGeometry
            args={[0.23, 0.075, compact ? 8 : 14, compact ? 28 : 56]}
          />
          <meshStandardMaterial
            color="#d9b569"
            emissive="#7c5311"
            emissiveIntensity={0.28}
            metalness={0.82}
            roughness={0.18}
          />
        </mesh>
      ) : null}

      {shape === "monolith" ? (
        <mesh
          position={[0, 0.77, 0]}
          rotation={[0.08, -0.35, -0.08]}
          castShadow={!compact}
        >
          <boxGeometry args={[0.3, 0.52, 0.2]} />
          <meshPhysicalMaterial
            color="#8a8cff"
            emissive="#35328e"
            emissiveIntensity={0.38}
            metalness={0.55}
            roughness={0.12}
          />
        </mesh>
      ) : null}
    </group>
  );
}

function Showroom({ active, compact }: ShowroomProps) {
  const showroom = useRef<Group>(null);
  const orbit = useRef<Group>(null);
  const centerpiece = useRef<Mesh>(null);

  useFrame((state, delta) => {
    if (!active) {
      return;
    }

    const pointerX = MathUtils.clamp(state.pointer.x, -1, 1);
    const pointerY = MathUtils.clamp(state.pointer.y, -1, 1);

    if (showroom.current) {
      showroom.current.rotation.y = MathUtils.damp(
        showroom.current.rotation.y,
        pointerX * 0.1,
        3.8,
        delta,
      );
      showroom.current.rotation.x = MathUtils.damp(
        showroom.current.rotation.x,
        -pointerY * 0.045,
        3.8,
        delta,
      );
      showroom.current.position.y = Math.sin(state.clock.elapsedTime * 0.55) * 0.025;
    }

    if (orbit.current) {
      orbit.current.rotation.y += delta * 0.055;
      orbit.current.rotation.z += delta * 0.025;
    }

    if (centerpiece.current) {
      centerpiece.current.rotation.y += delta * 0.18;
      centerpiece.current.rotation.x += delta * 0.07;
    }
  });

  return (
    <group ref={showroom} position={[0, 0.02, 0]}>
      <mesh position={[0, -1.38, -0.1]} receiveShadow={!compact}>
        <cylinderGeometry args={[2.48, 2.68, 0.2, compact ? 32 : 64]} />
        <meshStandardMaterial
          color="#0b1726"
          metalness={0.76}
          roughness={0.24}
        />
      </mesh>
      <mesh position={[0, -1.265, -0.08]}>
        <cylinderGeometry args={[2.22, 2.35, 0.045, compact ? 32 : 64]} />
        <meshBasicMaterial color="#164965" transparent opacity={0.74} />
      </mesh>

      <mesh position={[0, 0.12, -0.78]} receiveShadow={!compact}>
        <planeGeometry args={[4.05, 3.08]} />
        <meshPhysicalMaterial
          color="#14334d"
          metalness={0.22}
          opacity={compact ? 0.3 : 0.42}
          roughness={0.12}
          transmission={compact ? 0 : 0.38}
          transparent
          thickness={0.38}
        />
      </mesh>

      {[-2.08, 2.08].map((x) => (
        <group key={x} position={[x, 0.1, -0.45]}>
          <mesh castShadow={!compact}>
            <boxGeometry args={[0.22, 3.1, 0.36]} />
            <meshStandardMaterial
              color="#a9bdc9"
              metalness={0.88}
              roughness={0.18}
            />
          </mesh>
          <mesh position={[x < 0 ? 0.125 : -0.125, 0, 0.19]}>
            <boxGeometry args={[0.025, 2.7, 0.025]} />
            <meshBasicMaterial color="#54d6ff" />
          </mesh>
        </group>
      ))}

      <mesh position={[0, 1.66, -0.45]} castShadow={!compact}>
        <boxGeometry args={[4.38, 0.23, 0.36]} />
        <meshStandardMaterial
          color="#b1c3cc"
          metalness={0.88}
          roughness={0.18}
        />
      </mesh>
      <mesh position={[0, 1.515, -0.255]}>
        <boxGeometry args={[3.92, 0.028, 0.03]} />
        <meshBasicMaterial color="#54d6ff" />
      </mesh>

      {!compact ? (
        <>
          <mesh position={[-1.45, 0.55, -0.68]}>
            <boxGeometry args={[0.02, 1.7, 0.08]} />
            <meshBasicMaterial color="#31506a" transparent opacity={0.7} />
          </mesh>
          <mesh position={[1.45, 0.55, -0.68]}>
            <boxGeometry args={[0.02, 1.7, 0.08]} />
            <meshBasicMaterial color="#31506a" transparent opacity={0.7} />
          </mesh>
        </>
      ) : null}

      <ProductPlinth
        accent="#54d6ff"
        compact={compact}
        position={[-1.08, -0.91, -0.08]}
        shape="jewel"
      />
      <ProductPlinth
        accent="#dfbc6c"
        compact={compact}
        position={[0, -0.91, -0.02]}
        shape="loop"
      />
      <ProductPlinth
        accent="#8d8cff"
        compact={compact}
        position={[1.08, -0.91, -0.08]}
        shape="monolith"
      />

      <mesh ref={centerpiece} position={[0, 0.68, -0.4]}>
        <icosahedronGeometry args={[0.23, compact ? 0 : 1]} />
        <meshPhysicalMaterial
          color="#c6f4ff"
          emissive="#159ac7"
          emissiveIntensity={0.48}
          metalness={0.2}
          roughness={0.06}
          transmission={compact ? 0 : 0.62}
          transparent
          opacity={compact ? 0.86 : 0.7}
        />
      </mesh>

      <group ref={orbit} position={[0, 0.05, -0.15]}>
        <mesh rotation={[0.22, 0.16, 0.08]}>
          <torusGeometry
            args={[2.48, 0.008, 4, compact ? 56 : 112]}
          />
          <meshBasicMaterial
            color="#54d6ff"
            transparent
            opacity={0.58}
          />
        </mesh>
        <mesh rotation={[Math.PI / 2, 0.08, -0.12]}>
          <torusGeometry
            args={[2.18, 0.006, 4, compact ? 48 : 96]}
          />
          <meshBasicMaterial
            color="#8d8cff"
            transparent
            opacity={0.38}
          />
        </mesh>
      </group>
    </group>
  );
}

export function HeroScene({
  active,
  compact,
  onFailure,
  onReady,
}: HeroSceneProps) {
  return (
    <Canvas
      aria-hidden="true"
      camera={{ fov: compact ? 43 : 39, position: [0, 0.3, 6.7] }}
      className="hero-portal__webgl"
      dpr={compact ? [1, 1.25] : [1, 1.75]}
      frameloop={active ? "always" : "demand"}
      gl={{
        alpha: true,
        antialias: !compact,
        powerPreference: compact ? "low-power" : "high-performance",
      }}
      performance={{ min: 0.55 }}
      shadows={!compact}
    >
      <RendererLifecycle onFailure={onFailure} onReady={onReady} />
      <color attach="background" args={["#06111e"]} />
      <fog attach="fog" args={["#06111e", 6.8, 10.5]} />
      <ambientLight intensity={0.38} />
      <hemisphereLight args={["#a6eaff", "#03070d", 1.15]} />
      <spotLight
        castShadow={!compact}
        color="#c9f6ff"
        intensity={22}
        angle={0.48}
        penumbra={0.75}
        position={[-2.4, 4.2, 3.2]}
      />
      <pointLight
        color="#38b6ff"
        intensity={16}
        distance={7}
        position={[2.7, 0.6, 2.4]}
      />
      <pointLight
        color="#8d8cff"
        intensity={8}
        distance={5}
        position={[-2.5, -0.4, 1.2]}
      />
      <Showroom active={active} compact={compact} />
    </Canvas>
  );
}
