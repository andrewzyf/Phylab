import { vec, type Vec3 } from "../math";
import { bodyStateAtIndex, type Recording } from "../sim/recording";
import { evaluateMeasure } from "./measure";
import type { Prediction } from "./predict";

export interface ObjectMetrics {
  id: string;
  maxSpeed: number;
  finalSpeed: number;
  finalPosition: Vec3;
  displacement: number;
  pathLength: number;
  maxHeight: number;
  /** First time after which the object stays (almost) still until the end; null if it never settles. */
  timeToRest: number | null;
}

export interface RunMetrics {
  duration: number;
  objects: ObjectMetrics[];
  energyStart: number;
  energyEnd: number;
  /** Percentage of the peak kinetic energy that was lost (negative = gained). */
  energyLostPercent: number;
  collisions: number;
}

const REST_SPEED = 0.02;

export function computeMetrics(rec: Recording): RunMetrics {
  const objects: ObjectMetrics[] = [];
  for (const id of rec.bodyOrder) {
    const tr = rec.bodies[id];
    if (!tr.dynamic || rec.sampleCount === 0) continue;
    let maxSpeed = 0;
    let maxHeight = Number.NEGATIVE_INFINITY;
    let path = 0;
    let lastMoving = -1;
    let prev = bodyStateAtIndex(tr, 0).position;
    for (let i = 0; i < rec.sampleCount; i++) {
      const s = bodyStateAtIndex(tr, i);
      const speed = vec.len(s.velocity);
      maxSpeed = Math.max(maxSpeed, speed);
      maxHeight = Math.max(maxHeight, s.position[1]);
      path += vec.dist(prev, s.position);
      prev = s.position;
      if (speed > REST_SPEED) lastMoving = i;
    }
    const first = bodyStateAtIndex(tr, 0);
    const last = bodyStateAtIndex(tr, rec.sampleCount - 1);
    const settled = lastMoving < rec.sampleCount - 1 - Math.round(0.25 / rec.sampleInterval);
    objects.push({
      id,
      maxSpeed,
      finalSpeed: vec.len(last.velocity),
      finalPosition: last.position,
      displacement: vec.dist(first.position, last.position),
      pathLength: path,
      maxHeight,
      timeToRest: settled ? rec.times[Math.max(0, lastMoving + 1)] : null,
    });
  }
  const n = rec.sampleCount;
  let peakKE = 0;
  for (let i = 0; i < n; i++) peakKE = Math.max(peakKE, rec.energy.kinetic[i]);
  const e0 = n ? rec.energy.total[0] : 0;
  const e1 = n ? rec.energy.total[n - 1] : 0;
  return {
    duration: rec.duration,
    objects,
    energyStart: e0,
    energyEnd: e1,
    energyLostPercent: peakKE > 1e-12 ? (100 * (e0 - e1)) / peakKE : 0,
    collisions: rec.events.length,
  };
}

export interface PredictionCheck {
  prediction: Prediction;
  measured: number | null;
  /** Relative error (or absolute, for percentages). */
  error: number | null;
  agrees: boolean | null;
}

export function checkPredictions(rec: Recording, predictions: Prediction[]): PredictionCheck[] {
  return predictions.map((p) => {
    if (!p.measure) return { prediction: p, measured: null, error: null, agrees: null };
    const measured = evaluateMeasure(rec, p.measure);
    if (measured === null) return { prediction: p, measured: null, error: null, agrees: false };
    const absolute = p.unit === "%";
    const error = absolute
      ? measured - p.value
      : Math.abs(p.value) > 1e-9
        ? (measured - p.value) / Math.abs(p.value)
        : measured;
    return { prediction: p, measured, error, agrees: Math.abs(error) <= p.tolerance };
  });
}
