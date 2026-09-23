/** Small, dependency-free vector/quaternion helpers shared by the engine, analyzer and renderer. */

export type Vec3 = [number, number, number];
/** Quaternion stored as [x, y, z, w] (same layout as three.js and cannon-es). */
export type Quat = [number, number, number, number];

export const DEG = Math.PI / 180;
export const SPEED_OF_LIGHT = 299_792_458;
export const G_NEWTON = 6.674e-11;

export const vec = {
  add: (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ],
  len: (a: Vec3): number => Math.hypot(a[0], a[1], a[2]),
  dist: (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
  norm: (a: Vec3): Vec3 => {
    const l = Math.hypot(a[0], a[1], a[2]);
    return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
  },
  lerp: (a: Vec3, b: Vec3, t: number): Vec3 => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ],
  isFinite: (a: Vec3): boolean => a.every((c) => Number.isFinite(c)),
  zero: (): Vec3 => [0, 0, 0],
};

export const quat = {
  identity: (): Quat => [0, 0, 0, 1],
  /** Euler angles in degrees, intrinsic XYZ order (matches three.js `Euler(x, y, z, "XYZ")`). */
  fromEulerDeg: (e: Vec3): Quat => {
    const [x, y, z] = [e[0] * DEG * 0.5, e[1] * DEG * 0.5, e[2] * DEG * 0.5];
    const c1 = Math.cos(x), c2 = Math.cos(y), c3 = Math.cos(z);
    const s1 = Math.sin(x), s2 = Math.sin(y), s3 = Math.sin(z);
    return [
      s1 * c2 * c3 + c1 * s2 * s3,
      c1 * s2 * c3 - s1 * c2 * s3,
      c1 * c2 * s3 + s1 * s2 * c3,
      c1 * c2 * c3 - s1 * s2 * s3,
    ];
  },
  fromAxisAngle: (axis: Vec3, angleRad: number): Quat => {
    const n = vec.norm(axis);
    const s = Math.sin(angleRad / 2);
    return [n[0] * s, n[1] * s, n[2] * s, Math.cos(angleRad / 2)];
  },
  /** Hamilton product a*b (apply b first, then a). */
  mul: (a: Quat, b: Quat): Quat => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ],
  conj: (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]],
  rotate: (q: Quat, v: Vec3): Vec3 => {
    const [qx, qy, qz, qw] = q;
    // t = 2 * cross(q.xyz, v)
    const tx = 2 * (qy * v[2] - qz * v[1]);
    const ty = 2 * (qz * v[0] - qx * v[2]);
    const tz = 2 * (qx * v[1] - qy * v[0]);
    return [
      v[0] + qw * tx + (qy * tz - qz * ty),
      v[1] + qw * ty + (qz * tx - qx * tz),
      v[2] + qw * tz + (qx * ty - qy * tx),
    ];
  },
  normalize: (q: Quat): Quat => {
    const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
  },
  slerp: (a: Quat, b: Quat, t: number): Quat => {
    let [bx, by, bz, bw] = b;
    let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
    if (cos < 0) {
      cos = -cos;
      bx = -bx; by = -by; bz = -bz; bw = -bw;
    }
    if (cos > 0.9995) {
      return quat.normalize([
        a[0] + (bx - a[0]) * t,
        a[1] + (by - a[1]) * t,
        a[2] + (bz - a[2]) * t,
        a[3] + (bw - a[3]) * t,
      ]);
    }
    const theta = Math.acos(cos);
    const sin = Math.sin(theta);
    const wa = Math.sin((1 - t) * theta) / sin;
    const wb = Math.sin(t * theta) / sin;
    return [a[0] * wa + bx * wb, a[1] * wa + by * wb, a[2] * wa + bz * wb, a[3] * wa + bw * wb];
  },
};

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Round to a sensible number of significant figures for display / explanations. */
export function sig(x: number, digits = 3): number {
  if (!Number.isFinite(x) || x === 0) return x;
  return Number.parseFloat(x.toPrecision(digits));
}

/** Arithmetic–geometric mean, used for the exact large-amplitude pendulum period. */
export function agm(a: number, b: number): number {
  for (let i = 0; i < 40 && Math.abs(a - b) > 1e-15 * a; i++) {
    const an = (a + b) / 2;
    b = Math.sqrt(a * b);
    a = an;
  }
  return (a + b) / 2;
}

/** Solve s = v0 t + a t^2 / 2 for the smallest positive t (NaN if never reached). */
export function timeToTravel(s: number, v0: number, a: number): number {
  if (Math.abs(a) < 1e-12) return v0 > 1e-12 ? s / v0 : Number.NaN;
  const disc = v0 * v0 + 2 * a * s;
  if (disc < 0) return Number.NaN;
  const t = (-v0 + Math.sqrt(disc)) / a;
  return t >= 0 ? t : Number.NaN;
}
