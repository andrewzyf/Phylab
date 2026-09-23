import { quat, vec, type Quat, type Vec3 } from "../math";

export interface BodyTrack {
  id: string;
  dynamic: boolean;
  mass: number;
  /** For static bodies every array holds a single sample. */
  pos: Float64Array;
  quat: Float64Array;
  vel: Float64Array;
  angVel: Float64Array;
  kinetic: Float64Array;
  potential: Float64Array;
}

export interface ContactEvent {
  t: number;
  a: string;
  b: string;
}

export interface Recording {
  /** Simulated time actually covered (can be shorter than requested if the run was stopped). */
  duration: number;
  requestedDuration: number;
  dt: number;
  sampleInterval: number;
  sampleCount: number;
  times: Float64Array;
  bodyOrder: string[];
  bodies: Record<string, BodyTrack>;
  energy: {
    kinetic: Float64Array;
    gravitational: Float64Array;
    elastic: Float64Array;
    total: Float64Array;
  };
  events: ContactEvent[];
  warnings: string[];
  steps: number;
  computeMs: number;
}

export interface BodyState {
  position: Vec3;
  quaternion: Quat;
  velocity: Vec3;
  angularVelocity: Vec3;
  kinetic: number;
  potential: number;
}

const read3 = (a: Float64Array, i: number): Vec3 => [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]];
const read4 = (a: Float64Array, i: number): Quat => [a[i * 4], a[i * 4 + 1], a[i * 4 + 2], a[i * 4 + 3]];

export function sampleIndexAt(rec: Recording, t: number): { i0: number; i1: number; f: number } {
  if (rec.sampleCount <= 1) return { i0: 0, i1: 0, f: 0 };
  const x = Math.min(Math.max(t, 0), rec.duration) / rec.sampleInterval;
  const i0 = Math.min(Math.floor(x), rec.sampleCount - 1);
  const i1 = Math.min(i0 + 1, rec.sampleCount - 1);
  return { i0, i1, f: i1 === i0 ? 0 : x - i0 };
}

export function bodyStateAtIndex(track: BodyTrack, i: number): BodyState {
  const k = track.dynamic ? i : 0;
  return {
    position: read3(track.pos, k),
    quaternion: read4(track.quat, k),
    velocity: read3(track.vel, k),
    angularVelocity: read3(track.angVel, k),
    kinetic: track.kinetic[k],
    potential: track.potential[k],
  };
}

/** Interpolated state at time t (linear for vectors, slerp for orientation). */
export function bodyStateAt(rec: Recording, id: string, t: number): BodyState | undefined {
  const track = rec.bodies[id];
  if (!track) return undefined;
  if (!track.dynamic) return bodyStateAtIndex(track, 0);
  const { i0, i1, f } = sampleIndexAt(rec, t);
  const a = bodyStateAtIndex(track, i0);
  if (f === 0) return a;
  const b = bodyStateAtIndex(track, i1);
  return {
    position: vec.lerp(a.position, b.position, f),
    quaternion: quat.slerp(a.quaternion, b.quaternion, f),
    velocity: vec.lerp(a.velocity, b.velocity, f),
    angularVelocity: vec.lerp(a.angularVelocity, b.angularVelocity, f),
    kinetic: a.kinetic + (b.kinetic - a.kinetic) * f,
    potential: a.potential + (b.potential - a.potential) * f,
  };
}

/** Central-difference acceleration at sample i. */
export function accelerationAtIndex(rec: Recording, id: string, i: number): Vec3 {
  const track = rec.bodies[id];
  if (!track?.dynamic || rec.sampleCount < 3) return [0, 0, 0];
  const lo = Math.max(0, i - 1);
  const hi = Math.min(rec.sampleCount - 1, i + 1);
  if (hi === lo) return [0, 0, 0];
  const dt = (hi - lo) * rec.sampleInterval;
  return vec.scale(vec.sub(read3(track.vel, hi), read3(track.vel, lo)), 1 / dt);
}

/**
 * Velocity at time t extrapolated from the two samples strictly before t. Use this for quantities
 * measured "just before" an event (impacts), where interpolating across the event would blend in
 * the post-event velocity.
 */
export function velocityBefore(rec: Recording, id: string, t: number): Vec3 | undefined {
  const track = rec.bodies[id];
  if (!track) return undefined;
  if (!track.dynamic) return [0, 0, 0];
  let i = Math.min(Math.floor(t / rec.sampleInterval), rec.sampleCount - 1);
  while (i > 0 && rec.times[i] >= t) i--;
  const v1 = bodyStateAtIndex(track, i).velocity;
  if (i === 0) return v1;
  const v0 = bodyStateAtIndex(track, i - 1).velocity;
  const f = (t - rec.times[i]) / rec.sampleInterval;
  return vec.add(v1, vec.scale(vec.sub(v1, v0), f));
}

export function accelerationAt(rec: Recording, id: string, t: number): Vec3 {
  const { i0, i1, f } = sampleIndexAt(rec, t);
  return vec.lerp(accelerationAtIndex(rec, id, i0), accelerationAtIndex(rec, id, i1), f);
}

export function energyAt(rec: Recording, t: number) {
  const { i0, i1, f } = sampleIndexAt(rec, t);
  const lerp = (a: Float64Array) => a[i0] + (a[i1] - a[i0]) * f;
  return {
    kinetic: lerp(rec.energy.kinetic),
    gravitational: lerp(rec.energy.gravitational),
    elastic: lerp(rec.energy.elastic),
    total: lerp(rec.energy.total),
  };
}

/** All typed arrays inside a recording, for zero-copy transfer out of a Web Worker. */
export function recordingTransferables(rec: Recording): ArrayBuffer[] {
  const out: ArrayBuffer[] = [rec.times.buffer as ArrayBuffer];
  for (const b of Object.values(rec.bodies)) {
    out.push(
      b.pos.buffer as ArrayBuffer,
      b.quat.buffer as ArrayBuffer,
      b.vel.buffer as ArrayBuffer,
      b.angVel.buffer as ArrayBuffer,
      b.kinetic.buffer as ArrayBuffer,
      b.potential.buffer as ArrayBuffer,
    );
  }
  out.push(
    rec.energy.kinetic.buffer as ArrayBuffer,
    rec.energy.gravitational.buffer as ArrayBuffer,
    rec.energy.elastic.buffer as ArrayBuffer,
    rec.energy.total.buffer as ArrayBuffer,
  );
  return out;
}
