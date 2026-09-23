import { DEG, quat, vec, type Quat, type Vec3 } from "./math";
import type { ObjectType } from "./schema";

export interface ResolvedDims {
  radius: number;
  width: number;
  height: number;
  depth: number;
  length: number;
  angle: number;
}

/**
 * Ramp (wedge) geometry in the ramp's local frame. Origin = centre of the footprint on the bottom
 * face. The high end is at -x, so objects slide/roll toward +x. Width runs along z.
 */
export function rampGeometry(d: ResolvedDims) {
  const theta = d.angle * DEG;
  const base = d.length * Math.cos(theta);
  const rise = d.length * Math.sin(theta);
  const w = d.width;
  const vertices: Vec3[] = [
    [-base / 2, 0, -w / 2], // 0 back-low (high end, bottom)
    [base / 2, 0, -w / 2], // 1 back toe
    [-base / 2, rise, -w / 2], // 2 back-top
    [-base / 2, 0, w / 2], // 3 front-low
    [base / 2, 0, w / 2], // 4 front toe
    [-base / 2, rise, w / 2], // 5 front-top
  ];
  // Counter-clockwise when seen from outside (required by cannon-es ConvexPolyhedron).
  const faces = [
    [0, 1, 4, 3], // bottom
    [0, 2, 1], // back side (z-)
    [3, 4, 5], // front side (z+)
    [0, 3, 5, 2], // vertical back wall (x-)
    [1, 2, 5, 4], // sloped surface
  ];
  const centroid: Vec3 = [-base / 6, rise / 3, 0];
  return {
    theta,
    base,
    rise,
    vertices,
    faces,
    centroid,
    /** Point at the middle of the top edge of the slope (local). */
    top: [-base / 2, rise, 0] as Vec3,
    /** Unit vector pointing down the slope (local). */
    downSlope: [Math.cos(theta), -Math.sin(theta), 0] as Vec3,
    /** Outward unit normal of the sloped face (local). */
    normal: [Math.sin(theta), Math.cos(theta), 0] as Vec3,
  };
}

export function volumeOf(type: ObjectType, d: ResolvedDims, hollow = false): number {
  switch (type) {
    case "sphere":
      // Thin shell: treat as 10% of radius wall thickness for a density-derived mass.
      return hollow ? (4 / 3) * Math.PI * (d.radius ** 3 - (0.9 * d.radius) ** 3) : (4 / 3) * Math.PI * d.radius ** 3;
    case "cylinder":
      return hollow
        ? Math.PI * (d.radius ** 2 - (0.9 * d.radius) ** 2) * d.height
        : Math.PI * d.radius ** 2 * d.height;
    case "box":
    case "plate":
      return d.width * d.height * d.depth;
    case "ramp":
      return 0.5 * d.length * Math.cos(d.angle * DEG) * d.length * Math.sin(d.angle * DEG) * d.width;
  }
}

/** Principal moments of inertia in the body's local frame (exact, unlike cannon's AABB estimate). */
export function inertiaOf(type: ObjectType, mass: number, d: ResolvedDims, hollow = false): Vec3 {
  const m = mass;
  switch (type) {
    case "sphere": {
      const i = (hollow ? 2 / 3 : 2 / 5) * m * d.radius ** 2;
      return [i, i, i];
    }
    case "cylinder": {
      // Axis along local y.
      const r2 = d.radius ** 2;
      const h2 = d.height ** 2;
      if (hollow) return [(m * (6 * r2 + h2)) / 12, m * r2, (m * (6 * r2 + h2)) / 12];
      return [(m * (3 * r2 + h2)) / 12, 0.5 * m * r2, (m * (3 * r2 + h2)) / 12];
    }
    case "box":
    case "plate": {
      const { width: w, height: h, depth: dd } = d;
      return [(m * (h * h + dd * dd)) / 12, (m * (w * w + dd * dd)) / 12, (m * (w * w + h * h)) / 12];
    }
    case "ramp":
      return [m, m, m];
  }
}

/**
 * Distance from the centre to the lowest point of the shape along world "down" (-y) for a given
 * orientation. Used to rest objects on the ground / on top of others.
 */
export function supportDepth(type: ObjectType, d: ResolvedDims, q: Quat): number {
  const up = quat.rotate(quat.conj(q), [0, 1, 0]); // world up expressed in local coordinates
  switch (type) {
    case "sphere":
      return d.radius;
    case "cylinder": {
      const ay = Math.abs(up[1]);
      return ay * (d.height / 2) + d.radius * Math.sqrt(Math.max(0, 1 - ay * ay));
    }
    case "box":
    case "plate":
      return (Math.abs(up[0]) * d.width + Math.abs(up[1]) * d.height + Math.abs(up[2]) * d.depth) / 2;
    case "ramp":
      return 0;
  }
}

/** Height of the top surface above the centre (for stacking), for a given orientation. */
export function topHeight(type: ObjectType, d: ResolvedDims, q: Quat): number {
  if (type === "ramp") return d.length * Math.sin(d.angle * DEG);
  return supportDepth(type, d, q); // symmetric shapes
}

/** Radius of a sphere (around `position`) that encloses the shape. */
export function boundingRadius(type: ObjectType, d: ResolvedDims): number {
  switch (type) {
    case "sphere":
      return d.radius;
    case "cylinder":
      return Math.hypot(d.radius, d.height / 2);
    case "box":
    case "plate":
      return Math.hypot(d.width, d.height, d.depth) / 2;
    case "ramp": {
      const g = rampGeometry(d);
      return Math.hypot(g.base / 2, g.rise, d.width / 2);
    }
  }
}

/** Smallest characteristic thickness — used to choose a step size that avoids tunnelling. */
export function thinnestDimension(type: ObjectType, d: ResolvedDims): number {
  switch (type) {
    case "sphere":
      return 2 * d.radius;
    case "cylinder":
      return Math.min(2 * d.radius, d.height);
    case "box":
    case "plate":
      return Math.min(d.width, d.height, d.depth);
    case "ramp":
      return Math.max(0.05, Math.min(d.width, d.length * Math.sin(d.angle * DEG)));
  }
}

/** Cross-sectional area facing the flow (approximate, orientation-independent). */
export function frontalArea(type: ObjectType, d: ResolvedDims): number {
  switch (type) {
    case "sphere":
      return Math.PI * d.radius ** 2;
    case "cylinder":
      return 2 * d.radius * d.height;
    case "box":
    case "plate":
      return Math.max(d.width * d.height, d.width * d.depth, d.height * d.depth);
    case "ramp":
      return d.width * d.length;
  }
}

export function worldPoint(position: Vec3, q: Quat, local: Vec3): Vec3 {
  return vec.add(position, quat.rotate(q, local));
}
