/**
 * NeuralPulse — Three.js 3D activity visualization for Brain HQ loops.
 *
 * Renders a WebGL scene with:
 * - Central pulsing sphere (session heartbeat)
 * - Orbiting category nodes (edit, search, read, terminal, brain, agent)
 * - Particle trails for recent tool calls
 * - Auto-rotate + mouse interaction
 */

import { useRef, useMemo, useEffect, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { ActivityEntry, ActivityCategory } from "../../types/messages";

// ─── Category config ──────────────────────────────────────────────
interface CategoryMeta {
  color: string;
  label: string;
  emoji: string;
  angle: number;
}

const CATEGORIES: Record<ActivityCategory, CategoryMeta> = {
  edit: { color: "#f97316", label: "Edit", emoji: "✏️", angle: 0 },
  search: { color: "#3b82f6", label: "Search", emoji: "🔍", angle: Math.PI / 3 },
  read: { color: "#8b5cf6", label: "Read", emoji: "📖", angle: (2 * Math.PI) / 3 },
  terminal: { color: "#22c55e", label: "Terminal", emoji: "💻", angle: Math.PI },
  brain: { color: "#ec4899", label: "Brain", emoji: "🧠", angle: (4 * Math.PI) / 3 },
  agent: { color: "#06b6d4", label: "Agent", emoji: "🤖", angle: (5 * Math.PI) / 3 },
};

const ORBIT_RADIUS = 2.5;
const PARTICLE_COUNT = 60;

// ─── Central pulsing sphere ───────────────────────────────────────
function CoreSphere({ intensity }: { intensity: number }) {
  const meshRef = useRef<THREE.Mesh>(null);
  const matRef = useRef<THREE.MeshStandardMaterial>(null);

  useFrame(({ clock }) => {
    if (!meshRef.current || !matRef.current) return;
    const t = clock.getElapsedTime();
    const pulse = 0.35 + 0.1 * Math.sin(t * 2) + intensity * 0.15;
    meshRef.current.scale.setScalar(pulse);
    matRef.current.emissiveIntensity = 0.5 + intensity * 1.5 + Math.sin(t * 3) * 0.3;
  });

  return (
    <mesh ref={meshRef}>
      <sphereGeometry args={[1, 32, 32]} />
      <meshStandardMaterial
        ref={matRef}
        color="#a855f7"
        emissive="#a855f7"
        emissiveIntensity={1}
        transparent
        opacity={0.85}
      />
    </mesh>
  );
}

// ─── Category orbiting node ──────────────────────────────────────
function CategoryNode({
  meta,
  count,
  globalTime,
}: {
  meta: CategoryMeta;
  count: number;
  globalTime: number;
}) {
  const meshRef = useRef<THREE.Mesh>(null);
  const color = useMemo(() => new THREE.Color(meta.color), [meta.color]);

  useFrame(() => {
    if (!meshRef.current) return;
    const angle = meta.angle + globalTime * 0.3;
    meshRef.current.position.set(
      Math.cos(angle) * ORBIT_RADIUS,
      Math.sin(globalTime * 0.5 + meta.angle) * 0.4,
      Math.sin(angle) * ORBIT_RADIUS,
    );
    const s = 0.15 + Math.min(count, 10) * 0.04;
    meshRef.current.scale.setScalar(s);
  });

  return (
    <mesh ref={meshRef}>
      <sphereGeometry args={[1, 16, 16]} />
      <meshStandardMaterial
        color={color}
        emissive={color}
        emissiveIntensity={0.6 + Math.min(count, 10) * 0.15}
        transparent
        opacity={0.9}
      />
    </mesh>
  );
}

// ─── Particle system ─────────────────────────────────────────────
function Particles({ entries }: { entries: ActivityEntry[] }) {
  const pointsRef = useRef<THREE.Points>(null);
  const positionsRef = useRef(new Float32Array(PARTICLE_COUNT * 3));
  const colorsRef = useRef(new Float32Array(PARTICLE_COUNT * 3));
  const velocitiesRef = useRef<Array<{ vx: number; vy: number; vz: number; life: number }>>([]);

  // Spawn particles for new entries
  const lastCountRef = useRef(0);
  useEffect(() => {
    if (entries.length <= lastCountRef.current) {
      lastCountRef.current = entries.length;
      return;
    }
    const newEntries = entries.slice(lastCountRef.current);
    lastCountRef.current = entries.length;

    for (const entry of newEntries) {
      const catMeta = CATEGORIES[entry.category];
      if (!catMeta) continue;
      const color = new THREE.Color(catMeta.color);
      const angle = catMeta.angle + (Math.random() - 0.5) * 0.5;
      const idx = velocitiesRef.current.length % PARTICLE_COUNT;
      const speed = 0.02 + Math.random() * 0.02;
      velocitiesRef.current[idx] = {
        vx: Math.cos(angle) * speed,
        vy: (Math.random() - 0.5) * 0.01,
        vz: Math.sin(angle) * speed,
        life: 1.0,
      };
      const i3 = idx * 3;
      positionsRef.current[i3] = 0;
      positionsRef.current[i3 + 1] = 0;
      positionsRef.current[i3 + 2] = 0;
      colorsRef.current[i3] = color.r;
      colorsRef.current[i3 + 1] = color.g;
      colorsRef.current[i3 + 2] = color.b;
    }
  }, [entries]);

  useFrame(() => {
    if (!pointsRef.current) return;
    const pos = positionsRef.current;
    for (let i = 0; i < velocitiesRef.current.length; i++) {
      const v = velocitiesRef.current[i];
      if (!v || v.life <= 0) continue;
      const i3 = i * 3;
      pos[i3] += v.vx;
      pos[i3 + 1] += v.vy;
      pos[i3 + 2] += v.vz;
      v.life -= 0.008;
    }
    const geom = pointsRef.current.geometry;
    geom.attributes.position.needsUpdate = true;
  });

  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          args={[positionsRef.current, 3]}
          count={PARTICLE_COUNT}
        />
        <bufferAttribute
          attach="attributes-color"
          args={[colorsRef.current, 3]}
          count={PARTICLE_COUNT}
        />
      </bufferGeometry>
      <pointsMaterial size={0.08} vertexColors transparent opacity={0.7} sizeAttenuation />
    </points>
  );
}

// ─── Auto-rotate camera ──────────────────────────────────────────
function CameraRig() {
  const { camera } = useThree();
  const mouseRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      mouseRef.current.x = (e.clientX / window.innerWidth - 0.5) * 2;
      mouseRef.current.y = (e.clientY / window.innerHeight - 0.5) * 2;
    };
    window.addEventListener("mousemove", handler);
    return () => window.removeEventListener("mousemove", handler);
  }, []);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    const baseAngle = t * 0.15;
    const mx = mouseRef.current.x * 0.5;
    const my = mouseRef.current.y * 0.3;
    camera.position.set(
      Math.cos(baseAngle + mx) * 5,
      2 + my,
      Math.sin(baseAngle + mx) * 5,
    );
    camera.lookAt(0, 0, 0);
  });

  return null;
}

// ─── Scene contents (inside Canvas) ─────────────────────────────
function Scene({ entries }: { entries: ActivityEntry[] }) {
  const clockRef = useRef(0);

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const e of entries) {
      counts[e.category] = (counts[e.category] ?? 0) + 1;
    }
    return counts;
  }, [entries]);

  // Intensity = how active in last 10 seconds
  const intensity = useMemo(() => {
    const now = Date.now();
    const recent = entries.filter((e) => now - e.timestamp < 10_000).length;
    return Math.min(recent / 5, 1);
  }, [entries]);

  useFrame(({ clock }) => {
    clockRef.current = clock.getElapsedTime();
  });

  return (
    <>
      <ambientLight intensity={0.3} />
      <pointLight position={[5, 5, 5]} intensity={0.8} />

      <CoreSphere intensity={intensity} />

      {Object.entries(CATEGORIES).map(([cat, meta]) => (
        <CategoryNode
          key={cat}
          meta={meta}
          count={categoryCounts[cat] ?? 0}
          globalTime={clockRef.current}
        />
      ))}

      <Particles entries={entries} />
      <CameraRig />
    </>
  );
}

// ─── WebGL availability check ────────────────────────────────────
function isWebGLAvailable(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return !!(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

// ─── Fallback (no WebGL) ────────────────────────────────────────
function NoWebGLFallback({ entries }: { entries: ActivityEntry[] }) {
  return (
    <div className="text-center py-4 text-zinc-400 text-xs">
      <p>🏴‍☠️ WebGL no disponible — mostrando lista</p>
      <p className="mt-1">{entries.length} actividades registradas</p>
    </div>
  );
}

// ─── Legend overlay ─────────────────────────────────────────────
function Legend({ entries }: { entries: ActivityEntry[] }) {
  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const e of entries) {
      counts[e.category] = (counts[e.category] ?? 0) + 1;
    }
    return counts;
  }, [entries]);

  return (
    <div className="absolute bottom-1 left-1 flex flex-wrap gap-1.5 text-[10px]">
      {Object.entries(CATEGORIES)
        .filter(([cat]) => (categoryCounts[cat] ?? 0) > 0)
        .map(([cat, meta]) => (
          <span key={cat} className="flex items-center gap-0.5 opacity-70">
            <span
              className="inline-block w-2 h-2 rounded-full"
              style={{ backgroundColor: meta.color }}
            />
            {meta.emoji} {categoryCounts[cat]}
          </span>
        ))}
    </div>
  );
}

// ─── Public component ───────────────────────────────────────────
export interface NeuralPulseProps {
  entries: ActivityEntry[];
  height?: number;
}

export function NeuralPulse({ entries, height = 200 }: NeuralPulseProps) {
  const [webgl] = useState(isWebGLAvailable);

  if (!webgl) return <NoWebGLFallback entries={entries} />;
  if (entries.length === 0) return null;

  return (
    <div className="relative rounded-lg overflow-hidden border border-zinc-700/50 bg-zinc-900/80" style={{ height }}>
      <Canvas
        gl={{ antialias: true, alpha: true }}
        camera={{ position: [5, 2, 5], fov: 45 }}
        style={{ background: "transparent" }}
      >
        <Scene entries={entries} />
      </Canvas>
      <Legend entries={entries} />
    </div>
  );
}
