import type { ObjectType } from "./schema";

/** Hard limits that keep the engine stable and the browser responsive. */
export const LIMITS = {
  maxDuration: 120,
  maxObjects: 60,
  maxForces: 40,
  maxLinks: 40,
  /** Base physics step (s). The engine may pick a smaller one for fast/small objects. */
  baseDt: 1 / 240,
  minDt: 1 / 4000,
  maxSteps: 400_000,
  /** Samples recorded per simulated second (for playback, charts and measurements). */
  sampleRate: 60,
  /** Anything beyond this distance from the origin is treated as "escaped" / unstable. */
  maxCoordinate: 1e7,
} as const;

export const DEFAULT_DIMENSIONS: Record<
  ObjectType,
  { radius: number; width: number; height: number; depth: number; length: number; angle: number }
> = {
  sphere: { radius: 0.2, width: 0, height: 0, depth: 0, length: 0, angle: 0 },
  box: { radius: 0, width: 0.5, height: 0.5, depth: 0.5, length: 0, angle: 0 },
  cylinder: { radius: 0.2, width: 0, height: 0.4, depth: 0, length: 0, angle: 0 },
  plate: { radius: 0, width: 4, height: 0.1, depth: 4, length: 0, angle: 0 },
  ramp: { radius: 0, width: 1.5, height: 0, depth: 0, length: 5, angle: 30 },
};

export interface MaterialPreset {
  name: string;
  /** kg/m^3 */
  density: number;
  friction: number;
  restitution: number;
  color: string;
}

/** Typical engineering values (rounded). Friction is a representative dry-contact coefficient. */
export const MATERIALS: Record<string, MaterialPreset> = {
  steel: { name: "steel", density: 7850, friction: 0.4, restitution: 0.6, color: "#9aa4b1" },
  iron: { name: "iron", density: 7870, friction: 0.45, restitution: 0.5, color: "#6f757d" },
  aluminum: { name: "aluminum", density: 2700, friction: 0.4, restitution: 0.5, color: "#c9ced6" },
  lead: { name: "lead", density: 11340, friction: 0.5, restitution: 0.1, color: "#5b5f66" },
  gold: { name: "gold", density: 19300, friction: 0.45, restitution: 0.4, color: "#e3b43c" },
  wood: { name: "wood", density: 600, friction: 0.45, restitution: 0.4, color: "#b07a45" },
  rubber: { name: "rubber", density: 1100, friction: 0.8, restitution: 0.8, color: "#e2553f" },
  plastic: { name: "plastic", density: 950, friction: 0.35, restitution: 0.55, color: "#4f8cff" },
  glass: { name: "glass", density: 2500, friction: 0.35, restitution: 0.65, color: "#9fd8e8" },
  ice: { name: "ice", density: 917, friction: 0.03, restitution: 0.2, color: "#d6f1ff" },
  stone: { name: "stone", density: 2600, friction: 0.6, restitution: 0.3, color: "#8a8378" },
  concrete: { name: "concrete", density: 2400, friction: 0.65, restitution: 0.25, color: "#a3a3a3" },
  clay: { name: "clay", density: 1800, friction: 0.7, restitution: 0.02, color: "#b5653d" },
  foam: { name: "foam", density: 60, friction: 0.6, restitution: 0.3, color: "#f2d16b" },
  tennis_ball: { name: "tennis_ball", density: 390, friction: 0.6, restitution: 0.75, color: "#d7f542" },
  basketball: { name: "basketball", density: 80, friction: 0.6, restitution: 0.8, color: "#e5782b" },
  frictionless: { name: "frictionless", density: 1000, friction: 0, restitution: 0.3, color: "#7fd6c2" },
};

/** Surface gravity (m/s^2) for common requests like "on the moon". */
export const GRAVITY_PRESETS: Record<string, number> = {
  earth: 9.81,
  moon: 1.62,
  mars: 3.71,
  venus: 8.87,
  mercury: 3.7,
  jupiter: 24.79,
  saturn: 10.44,
  uranus: 8.69,
  neptune: 11.15,
  pluto: 0.62,
  sun: 274,
  space: 0,
};

export const PALETTE = [
  "#4f8cff",
  "#ff6b4a",
  "#3fc47a",
  "#f5b83d",
  "#b06cff",
  "#27c2d6",
  "#ff5fa2",
  "#9ccc3a",
];

export const STATIC_COLOR = "#8792a2";
export const RAMP_COLOR = "#a58b6f";

/** Default drag coefficients (dimensionless C_d) by shape, used when air resistance is on. */
export const DRAG_COEFFICIENTS: Record<ObjectType, number> = {
  sphere: 0.47,
  box: 1.05,
  cylinder: 0.82,
  plate: 1.17,
  ramp: 1.0,
};

export const AIR_DENSITY = 1.225;
