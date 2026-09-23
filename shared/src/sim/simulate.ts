import { LIMITS } from "../constants";
import { supportDepth, thinnestDimension } from "../geometry";
import { G_NEWTON, quat, vec, type Vec3 } from "../math";
import type { ResolvedScenario } from "../resolve";
import { PhysicsEngine } from "./engine";
import type { BodyTrack, Recording } from "./recording";

export interface SimulateOptions {
  /** Override the simulated duration (s). */
  duration?: number;
  /** Force a specific step size (s). Otherwise chosen from object sizes and speeds. */
  dt?: number;
  sampleRate?: number;
  /** Called periodically with progress in [0, 1]. */
  onProgress?: (fraction: number) => void;
  /** Return true to abort early (the partial recording is returned). */
  shouldStop?: () => boolean;
}

/** Pick a step small enough that the fastest object can't tunnel through the thinnest one. */
export function chooseTimeStep(rs: ResolvedScenario): number {
  const g = rs.environment.gravity;
  let vmax = 0;
  let thinnest = Number.POSITIVE_INFINITY;
  for (const o of rs.objects) {
    thinnest = Math.min(thinnest, thinnestDimension(o.type, o.dims));
    if (!o.dynamic) continue;
    const drop = Math.max(0, o.position[1] - supportDepth(o.type, o.dims, o.quaternion));
    const v = vec.len(o.velocity) + Math.sqrt(2 * Math.max(g, 0) * drop);
    vmax = Math.max(vmax, v);
  }
  for (const f of rs.forces) {
    if (f.type !== "impulse") continue;
    for (const id of f.appliesTo) {
      const o = rs.objects.find((x) => x.id === id);
      if (o?.dynamic) vmax = Math.max(vmax, f.magnitude / o.mass);
    }
  }
  if (!Number.isFinite(thinnest) || vmax < 1e-6) return LIMITS.baseDt;
  const dt = thinnest / (4 * vmax);
  return Math.min(LIMITS.baseDt, Math.max(LIMITS.minDt, dt));
}

/**
 * Run a resolved scenario headlessly with a fixed time step and return a sampled recording.
 * Deterministic: the same scenario always produces the same recording.
 */
export function simulate(rs: ResolvedScenario, options: SimulateOptions = {}): Recording {
  const started = typeof performance !== "undefined" ? performance.now() : Date.now();
  const warnings: string[] = [];
  const requested = Math.min(Math.max(options.duration ?? rs.environment.duration, 0), LIMITS.maxDuration);
  let dt = options.dt ?? chooseTimeStep(rs);
  let steps = Math.ceil(requested / dt - 1e-9);
  if (steps > LIMITS.maxSteps) {
    dt = requested / LIMITS.maxSteps;
    steps = LIMITS.maxSteps;
    warnings.push(`Time step raised to ${(dt * 1000).toFixed(2)} ms to keep the run fast; very fast objects may tunnel.`);
  }
  const sampleRate = options.sampleRate ?? LIMITS.sampleRate;
  const sampleEvery = Math.max(1, Math.round(1 / sampleRate / dt));
  const sampleInterval = sampleEvery * dt;
  const maxSamples = Math.floor(steps / sampleEvery) + 1;

  const engine = new PhysicsEngine(rs, dt);
  const gdir = rs.environment.gravityDir;
  const g = rs.environment.gravity;

  const tracks: Record<string, BodyTrack> = {};
  for (const eb of engine.bodies) {
    const n = eb.obj.dynamic ? maxSamples : 1;
    tracks[eb.id] = {
      id: eb.id,
      dynamic: eb.obj.dynamic,
      mass: eb.obj.mass,
      pos: new Float64Array(n * 3),
      quat: new Float64Array(n * 4),
      vel: new Float64Array(n * 3),
      angVel: new Float64Array(n * 3),
      kinetic: new Float64Array(n),
      potential: new Float64Array(n),
    };
  }
  const times = new Float64Array(maxSamples);
  const eK = new Float64Array(maxSamples);
  const eG = new Float64Array(maxSamples);
  const eE = new Float64Array(maxSamples);
  const eT = new Float64Array(maxSamples);

  const springs = rs.links.filter((l) => l.type === "spring");
  const mutual = rs.forces.filter((f) => f.type === "mutual_gravity");

  let sample = 0;
  const record = (): boolean => {
    let ke = 0;
    let pe = 0;
    let unstable = false;
    for (const eb of engine.bodies) {
      const tr = tracks[eb.id];
      if (!eb.obj.dynamic && sample > 0) continue;
      const k = eb.obj.dynamic ? sample : 0;
      const b = eb.body;
      const p: Vec3 = [b.position.x, b.position.y, b.position.z];
      const v: Vec3 = [b.velocity.x, b.velocity.y, b.velocity.z];
      const w: Vec3 = [b.angularVelocity.x, b.angularVelocity.y, b.angularVelocity.z];
      const q: [number, number, number, number] = [b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w];
      if (!vec.isFinite(p) || Math.abs(p[0]) > LIMITS.maxCoordinate || Math.abs(p[1]) > LIMITS.maxCoordinate || Math.abs(p[2]) > LIMITS.maxCoordinate) {
        unstable = true;
      }
      tr.pos.set(p, k * 3);
      tr.quat.set(q, k * 4);
      tr.vel.set(v, k * 3);
      tr.angVel.set(w, k * 3);
      let kinetic = 0;
      let potential = 0;
      if (eb.obj.dynamic) {
        const wl = quat.rotate(quat.conj(q), w);
        const I = eb.obj.inertia;
        kinetic = 0.5 * eb.obj.mass * vec.dot(v, v) + 0.5 * (I[0] * wl[0] ** 2 + I[1] * wl[1] ** 2 + I[2] * wl[2] ** 2);
        potential = -eb.obj.mass * g * vec.dot(p, gdir);
        ke += kinetic;
        pe += potential;
      }
      tr.kinetic[k] = kinetic;
      tr.potential[k] = potential;
    }
    let elastic = 0;
    for (const s of springs) {
      const a = engine.byId.get(s.a);
      if (!a) continue;
      const pa: Vec3 = [a.body.position.x, a.body.position.y, a.body.position.z];
      const d = vec.dist(pa, engine.linkEnd(s)) - s.length;
      elastic += 0.5 * s.stiffness * d * d;
    }
    for (const f of mutual) {
      const G = f.magnitude || G_NEWTON;
      for (let i = 0; i < f.appliesTo.length; i++) {
        for (let j = i + 1; j < f.appliesTo.length; j++) {
          const a = engine.byId.get(f.appliesTo[i]);
          const b = engine.byId.get(f.appliesTo[j]);
          if (!a || !b) continue;
          const r = a.body.position.distanceTo(b.body.position);
          if (r > 1e-9) pe -= (G * a.obj.physicalMass * b.obj.physicalMass) / r;
        }
      }
    }
    times[sample] = engine.time;
    eK[sample] = ke;
    eG[sample] = pe;
    eE[sample] = elastic;
    eT[sample] = ke + pe + elastic;
    sample++;
    return !unstable;
  };

  let ok = record();
  let step = 0;
  const progressEvery = Math.max(1, Math.floor(steps / 50));
  while (ok && step < steps) {
    engine.step();
    step++;
    if (step % sampleEvery === 0) {
      ok = record();
      if (!ok) warnings.push(`The simulation became numerically unstable at t = ${engine.time.toFixed(2)} s and was stopped.`);
    }
    if (options.onProgress && step % progressEvery === 0) options.onProgress(step / steps);
    if (options.shouldStop?.()) {
      warnings.push(`Stopped early at t = ${engine.time.toFixed(2)} s.`);
      break;
    }
  }

  const count = sample;
  const trim = (a: Float64Array, width: number) => (a.length === count * width ? a : a.slice(0, count * width));
  for (const tr of Object.values(tracks)) {
    if (!tr.dynamic) continue;
    tr.pos = trim(tr.pos, 3);
    tr.quat = trim(tr.quat, 4);
    tr.vel = trim(tr.vel, 3);
    tr.angVel = trim(tr.angVel, 3);
    tr.kinetic = trim(tr.kinetic, 1);
    tr.potential = trim(tr.potential, 1);
  }
  const finished = typeof performance !== "undefined" ? performance.now() : Date.now();
  return {
    duration: count > 0 ? times[count - 1] : 0,
    requestedDuration: requested,
    dt,
    sampleInterval,
    sampleCount: count,
    times: trim(times, 1),
    bodyOrder: engine.bodies.map((b) => b.id),
    bodies: tracks,
    energy: { kinetic: trim(eK, 1), gravitational: trim(eG, 1), elastic: trim(eE, 1), total: trim(eT, 1) },
    events: engine.contactLog.slice(),
    warnings,
    steps: step,
    computeMs: finished - started,
  };
}
