import { vec, type Vec3 } from "../math";
import { GROUND_ID } from "../resolve";
import { bodyStateAt, bodyStateAtIndex, velocityBefore, type Recording } from "../sim/recording";

/** How to read a predicted quantity back out of a simulation recording. */
export type Measure =
  | { kind: "time_to_distance"; object: string; axis: Vec3; distance: number }
  | { kind: "speed_at_distance"; object: string; axis: Vec3; distance: number }
  | { kind: "accel_to_distance"; object: string; axis: Vec3; distance: number }
  | { kind: "first_contact_time"; object: string; other: string }
  | { kind: "range_at_first_contact"; object: string; other: string; up: Vec3 }
  | { kind: "speed_at_first_contact"; object: string; other: string; gravity: Vec3 }
  | { kind: "bounce_height"; object: string; other: string; up: Vec3; offset: number }
  | { kind: "max_height"; object: string; up: Vec3; offset: number }
  | { kind: "period"; object: string; center: Vec3; axis: Vec3; relativeTo?: string; sameDirection?: boolean }
  | { kind: "max_speed"; object: string }
  | { kind: "velocity_after_contact"; object: string; other: string; axis: Vec3; delay: number }
  | { kind: "energy_change_percent" };

const pos = (rec: Recording, id: string, i: number): Vec3 => bodyStateAtIndex(rec.bodies[id], i).position;
const vel = (rec: Recording, id: string, i: number): Vec3 => bodyStateAtIndex(rec.bodies[id], i).velocity;

function firstContact(rec: Recording, a: string, b: string): number | null {
  const e = rec.events.find((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a) || (b === "*" && (x.a === a || x.b === a)));
  return e ? e.t : null;
}

function nthContact(rec: Recording, a: string, b: string, n: number): number | null {
  let count = 0;
  for (const x of rec.events) {
    if ((x.a === a && x.b === b) || (x.a === b && x.b === a)) {
      count++;
      if (count === n) return x.t;
    }
  }
  return null;
}

function crossingTime(rec: Recording, id: string, axis: Vec3, distance: number): number | null {
  const tr = rec.bodies[id];
  if (!tr?.dynamic) return null;
  const p0 = pos(rec, id, 0);
  let prev = 0;
  for (let i = 1; i < rec.sampleCount; i++) {
    const s = vec.dot(vec.sub(pos(rec, id, i), p0), axis);
    if (s >= distance) {
      const f = s === prev ? 0 : (distance - prev) / (s - prev);
      return rec.times[i - 1] + f * (rec.times[i] - rec.times[i - 1]);
    }
    prev = s;
  }
  return null;
}

/** Evaluate a measure on a recording. Returns null when the event never happened in the run. */
export function evaluateMeasure(rec: Recording, m: Measure): number | null {
  if ("object" in m && !rec.bodies[m.object]) return null;
  switch (m.kind) {
    case "time_to_distance":
      return crossingTime(rec, m.object, m.axis, m.distance);
    case "speed_at_distance": {
      const t = crossingTime(rec, m.object, m.axis, m.distance);
      if (t === null) return null;
      return vec.len(velocityBefore(rec, m.object, t)!);
    }
    case "accel_to_distance": {
      const t = crossingTime(rec, m.object, m.axis, m.distance);
      if (t === null || t <= 0) return null;
      const v1 = vec.dot(velocityBefore(rec, m.object, t)!, m.axis);
      const v0 = vec.dot(vel(rec, m.object, 0), m.axis);
      return (v1 - v0) / t;
    }
    case "first_contact_time":
      return firstContact(rec, m.object, m.other);
    case "range_at_first_contact": {
      const t = firstContact(rec, m.object, m.other);
      if (t === null) return null;
      const d = vec.sub(bodyStateAt(rec, m.object, t)!.position, pos(rec, m.object, 0));
      const horizontal = vec.sub(d, vec.scale(m.up, vec.dot(d, m.up)));
      return vec.len(horizontal);
    }
    case "speed_at_first_contact": {
      const t = firstContact(rec, m.object, m.other);
      if (t === null) return null;
      // Take the last sample strictly before impact and extrapolate ballistically (samples straddling
      // the impact would blend the pre- and post-impact velocities).
      let i = Math.floor(t / rec.sampleInterval);
      while (i > 0 && rec.times[i] >= t) i--;
      const dt = t - rec.times[i];
      return vec.len(vec.add(vel(rec, m.object, i), vec.scale(m.gravity, dt)));
    }
    case "bounce_height": {
      const t1 = nthContact(rec, m.object, m.other, 1);
      if (t1 === null) return null;
      const t2 = nthContact(rec, m.object, m.other, 2) ?? rec.duration;
      let best = Number.NEGATIVE_INFINITY;
      for (let i = 0; i < rec.sampleCount; i++) {
        const t = rec.times[i];
        if (t <= t1 + rec.sampleInterval || t >= t2) continue;
        best = Math.max(best, vec.dot(pos(rec, m.object, i), m.up) - m.offset);
      }
      return Number.isFinite(best) ? best : null;
    }
    case "max_height": {
      let best = Number.NEGATIVE_INFINITY;
      for (let i = 0; i < rec.sampleCount; i++) best = Math.max(best, vec.dot(pos(rec, m.object, i), m.up) - m.offset);
      return Number.isFinite(best) ? best : null;
    }
    case "period": {
      const crossings: { t: number; dir: number }[] = [];
      let prev: number | null = null;
      for (let i = 0; i < rec.sampleCount; i++) {
        const center = m.relativeTo ? pos(rec, m.relativeTo, i) : m.center;
        const s = vec.dot(vec.sub(pos(rec, m.object, i), center), m.axis);
        if (prev !== null && ((prev > 0 && s <= 0) || (prev < 0 && s >= 0))) {
          const f = prev / (prev - s);
          crossings.push({ t: rec.times[i - 1] + f * rec.sampleInterval, dir: s < prev ? -1 : 1 });
        }
        prev = s;
      }
      if (m.sameDirection) {
        const down = crossings.filter((c) => c.dir === crossings[0]?.dir);
        if (down.length < 2) return null;
        return (down[down.length - 1].t - down[0].t) / (down.length - 1);
      }
      if (crossings.length < 3) return null;
      return (2 * (crossings[crossings.length - 1].t - crossings[0].t)) / (crossings.length - 1);
    }
    case "max_speed": {
      let best = 0;
      for (let i = 0; i < rec.sampleCount; i++) best = Math.max(best, vec.len(vel(rec, m.object, i)));
      return best;
    }
    case "velocity_after_contact": {
      const t = firstContact(rec, m.object, m.other);
      if (t === null) return null;
      const at = Math.min(t + m.delay, rec.duration);
      return vec.dot(bodyStateAt(rec, m.object, at)!.velocity, m.axis);
    }
    case "energy_change_percent": {
      const n = rec.sampleCount;
      if (n < 2) return null;
      let scale = 0;
      for (let i = 0; i < n; i++) scale = Math.max(scale, Math.abs(rec.energy.kinetic[i]));
      if (scale < 1e-12) return 0;
      return (100 * (rec.energy.total[n - 1] - rec.energy.total[0])) / scale;
    }
  }
}

export { GROUND_ID };
