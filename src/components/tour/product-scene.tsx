"use client";

import { ContactShadows, RoundedBox } from "@react-three/drei";
import { Canvas, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three";

import type { FlagshipProductId } from "@/types/tour";

type ProductSceneProps = {
  color: string;
  productId: FlagshipProductId;
  rotation: number;
  zoom: number;
  onFailure: () => void;
};

export function ProductScene({
  color,
  productId,
  rotation,
  zoom,
  onFailure,
}: ProductSceneProps) {
  return (
    <Canvas
      aria-hidden="true"
      camera={{ position: [0, 0.6, 5.4], fov: 36 }}
      dpr={[1, 1.5]}
      frameloop="demand"
      gl={{ alpha: true, antialias: true, powerPreference: "low-power" }}
      style={{ background: "transparent" }}
    >
      <ProductContextMonitor onFailure={onFailure} />
      <ambientLight intensity={1.7} />
      <directionalLight position={[4, 5, 5]} intensity={3.4} />
      <directionalLight position={[-4, 2, -2]} color="#67d7ff" intensity={1.25} />
      <spotLight
        position={[0, 5, 1]}
        angle={0.55}
        penumbra={0.8}
        intensity={2.2}
      />

      <group
        position={[0, 0.15, 0]}
        rotation={[0.08, rotation, 0]}
        scale={zoom}
      >
        <ProductObject color={color} productId={productId} />
      </group>

      <ContactShadows
        position={[0, -1.25, 0]}
        opacity={0.4}
        scale={6}
        blur={2.8}
        far={4}
      />
    </Canvas>
  );
}

function ProductContextMonitor({ onFailure }: { onFailure: () => void }) {
  const gl = useThree((state) => state.gl);

  useEffect(() => {
    const canvas = gl.domElement;
    const handleContextLoss = (event: Event) => {
      event.preventDefault();
      onFailure();
    };

    canvas.addEventListener("webglcontextlost", handleContextLoss);
    return () =>
      canvas.removeEventListener("webglcontextlost", handleContextLoss);
  }, [gl, onFailure]);

  return null;
}

function ProductObject({
  color,
  productId,
}: {
  color: string;
  productId: FlagshipProductId;
}) {
  if (productId === "meridian-loafer") {
    return <Loafer color={color} />;
  }

  if (productId === "axis-travel-folio") {
    return <Folio color={color} />;
  }

  return <OrbitBag color={color} />;
}

function OrbitBag({ color }: { color: string }) {
  const handleCurve = useMemo(
    () =>
      new THREE.CatmullRomCurve3([
        new THREE.Vector3(-0.72, 0.95, 0),
        new THREE.Vector3(-0.62, 1.62, 0),
        new THREE.Vector3(0, 1.92, 0),
        new THREE.Vector3(0.62, 1.62, 0),
        new THREE.Vector3(0.72, 0.95, 0),
      ]),
    [],
  );

  return (
    <group position={[0, -0.18, 0]}>
      <RoundedBox args={[2.65, 1.65, 0.82]} radius={0.23} smoothness={6}>
        <LeatherMaterial color={color} />
      </RoundedBox>
      <RoundedBox
        args={[2.48, 0.92, 0.88]}
        position={[0, 0.43, 0.03]}
        radius={0.18}
        smoothness={6}
      >
        <LeatherMaterial color={color} roughness={0.34} />
      </RoundedBox>
      <mesh position={[0, 0.16, 0.49]}>
        <boxGeometry args={[0.46, 0.22, 0.08]} />
        <HardwareMaterial />
      </mesh>
      <mesh>
        <tubeGeometry args={[handleCurve, 64, 0.085, 16, false]} />
        <LeatherMaterial color={color} roughness={0.3} />
      </mesh>
      {[-1, 1].map((side) => (
        <mesh key={side} position={[side * 0.72, 0.83, 0]}>
          <torusGeometry args={[0.12, 0.035, 12, 24]} />
          <HardwareMaterial />
        </mesh>
      ))}
    </group>
  );
}

function Loafer({ color }: { color: string }) {
  return (
    <group position={[0, -0.45, 0]} rotation={[0, -0.28, 0]}>
      <RoundedBox
        args={[3.05, 0.32, 1.18]}
        position={[0, -0.48, 0]}
        radius={0.15}
        smoothness={6}
      >
        <meshStandardMaterial color="#10141c" roughness={0.48} />
      </RoundedBox>
      <RoundedBox
        args={[2.42, 0.88, 1.08]}
        position={[-0.18, -0.02, 0]}
        radius={0.34}
        smoothness={8}
      >
        <LeatherMaterial color={color} />
      </RoundedBox>
      <mesh position={[1.18, -0.08, 0]} scale={[0.72, 0.58, 0.56]}>
        <sphereGeometry args={[0.78, 48, 24]} />
        <LeatherMaterial color={color} />
      </mesh>
      <RoundedBox
        args={[0.75, 0.68, 0.98]}
        position={[-1.15, 0.02, 0]}
        radius={0.18}
        smoothness={5}
      >
        <LeatherMaterial color={color} roughness={0.38} />
      </RoundedBox>
      <mesh position={[0.25, 0.48, 0.55]} rotation={[0.08, 0, 0]}>
        <boxGeometry args={[0.9, 0.09, 0.05]} />
        <HardwareMaterial />
      </mesh>
    </group>
  );
}

function Folio({ color }: { color: string }) {
  return (
    <group position={[0, -0.05, 0]} rotation={[0.04, -0.15, -0.03]}>
      <RoundedBox args={[2.65, 1.9, 0.24]} radius={0.12} smoothness={6}>
        <LeatherMaterial color={color} roughness={0.5} />
      </RoundedBox>
      <RoundedBox
        args={[2.45, 0.86, 0.18]}
        position={[0, 0.45, 0.18]}
        rotation={[0.02, 0, -0.08]}
        radius={0.09}
        smoothness={5}
      >
        <LeatherMaterial color={color} roughness={0.36} />
      </RoundedBox>
      <mesh position={[0.72, 0.12, 0.31]}>
        <cylinderGeometry args={[0.13, 0.13, 0.08, 32]} />
        <HardwareMaterial />
      </mesh>
      <mesh position={[-0.95, 0, 0.2]}>
        <boxGeometry args={[0.018, 1.55, 0.02]} />
        <HardwareMaterial />
      </mesh>
    </group>
  );
}

function LeatherMaterial({
  color,
  roughness = 0.44,
}: {
  color: string;
  roughness?: number;
}) {
  return (
    <meshPhysicalMaterial
      color={color}
      roughness={roughness}
      metalness={0.04}
      clearcoat={0.34}
      clearcoatRoughness={0.4}
    />
  );
}

function HardwareMaterial() {
  return (
    <meshStandardMaterial
      color="#cdb183"
      metalness={0.88}
      roughness={0.2}
    />
  );
}
