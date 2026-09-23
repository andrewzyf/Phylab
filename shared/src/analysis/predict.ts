import { rampGeometry, supportDepth } from "../geometry";
import { agm, DEG, quat, sig, timeToTravel, vec, type Vec3 } from "../math";
import {
  contactCoefficients,
  GROUND_ID,
  type ResolvedLink,
  type ResolvedObject,
  type ResolvedScenario,
} from "../resolve";
import type { Measure } from "./measure";

export interface Prediction {
  id: string;
  /** Object the prediction is about (if any). */
  object?: string;
  label: string;
  value: number;
  unit: string;
  /** Worked formula with numbers substituted, for explanations. */
  formula: string;
  measure?: Measure;
  /** Acceptable relative difference between predicted and measured (absolute for energy %). */
  tolerance: number;
}

export type Archetype =
  | "ramp"
  | "projectile"
  | "free_fall"
  | "pendulum"
  | "spring"
  | "collision"
  | "orbit"
  | "general";

export interface Analysis {
  archetypes: Archetype[];
  predictions: Prediction[];
  /** Modelling assumptions behind the predictions. */
  assumptions: string[];
  energy: "conserved" | "decreases" | "changes" | "may_decrease";
}

const f3 = (x: number) => `${sig(x, 3)}`;
/** Format a number that will be squared or multiplied: negatives get parentheses. */
const p3 = (x: number) => (x < 0 ? `(${f3(x)})` : f3(x));

function roundFactor(o: ResolvedObject): number | null {
  if (o.type === "sphere") return o.hollow ? 2 / 3 : 2 / 5;
  if (o.type === "cylinder") return o.hollow ? 1 : 1 / 2;
  return null;
}

function shapeName(o: ResolvedObject): string {
  if (o.type === "sphere") return o.hollow ? "hollow sphere" : "solid sphere";
  if (o.type === "cylinder") return o.hollow ? "thin hoop / tube" : "solid cylinder";
  return o.type;
}

interface Aabb {
  min: Vec3;
  max: Vec3;
}

function aabbOf(o: ResolvedObject): Aabb {
  const d = o.dims;
  let corners: Vec3[];
  if (o.type === "ramp") corners = rampGeometry(d).vertices;
  else {
    const hx = o.type === "sphere" || o.type === "cylinder" ? d.radius : d.width / 2;
    const hy = o.type === "sphere" ? d.radius : d.height / 2;
    const hz = o.type === "sphere" || o.type === "cylinder" ? d.radius : d.depth / 2;
    corners = [];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) corners.push([sx * hx, sy * hy, sz * hz]);
  }
  const world = corners.map((c) => vec.add(o.position, quat.rotate(o.quaternion, c)));
  return {
    min: [0, 1, 2].map((k) => Math.min(...world.map((w) => w[k]))) as Vec3,
    max: [0, 1, 2].map((k) => Math.max(...world.map((w) => w[k]))) as Vec3,
  };
}

const inside = (p: Vec3, b: Aabb, pad: number) =>
  p.every((c, k) => c >= b.min[k] - pad && c <= b.max[k] + pad);

/**
 * Closed-form predictions for recognisable setups, each paired with a way to measure the same
 * quantity from the simulation. This is how PhysicsLab checks itself: the solver's numbers and the
 * engine's numbers should agree.
 */
export function analyzeScenario(rs: ResolvedScenario): Analysis {
  const env = rs.environment;
  const g = env.gravity;
  const gdir = env.gravityDir;
  const up: Vec3 = vec.scale(gdir, -1);
  const predictions: Prediction[] = [];
  const assumptions: string[] = [];
  const archetypes = new Set<Archetype>();
  const dyn = rs.objects.filter((o) => o.dynamic);
  const standardGravity = Math.abs(gdir[1] + 1) < 1e-6;

  const linksOf = (id: string) => rs.links.filter((l) => l.a === id || l.b === id);
  const forcedIds = new Set<string>();
  for (const f of rs.forces) {
    if (f.type === "unsupported" || f.redundant) continue;
    for (const id of f.appliesTo) forcedIds.add(id);
  }
  const isFree = (o: ResolvedObject) => !forcedIds.has(o.id) && !env.airResistance;

  if (env.airResistance) assumptions.push("Air resistance is on, so closed-form (vacuum) predictions are skipped.");

  for (const o of dyn) {
    const links = linksOf(o.id);
    const p = o.placement;

    // ---------------------------------------------------------------- ramp
    if (p?.kind === "on_ramp" && links.length === 0 && isFree(o) && g > 0) {
      const ramp = rs.objects.find((x) => x.id === p.target_id && x.type === "ramp") ?? rs.objects.find((x) => x.type === "ramp");
      if (!ramp) continue;
      archetypes.add("ramp");
      const geo = rampGeometry(ramp.dims);
      const theta = geo.theta;
      const down = quat.rotate(ramp.quaternion, geo.downSlope);
      const mu = contactCoefficients(rs, o.id, ramp.id).friction;
      const s0 = Math.min(Math.max(p.distance_from_top ?? 0, 0), ramp.dims.length);
      const v0 = vec.dot(o.velocity, down);
      const k = roundFactor(o);
      let a: number;
      let formula: string;
      let mode: string;
      const gs = g * Math.sin(theta);
      const deg = f3(ramp.dims.angle);
      if (mu === 0) {
        a = gs;
        formula = `a = g·sin θ = ${f3(g)} × sin ${deg}° = ${f3(a)} m/s²`;
        mode = "slides without friction (no torque, so it doesn't spin up)";
      } else if (k !== null) {
        const needed = (Math.tan(theta) * k) / (1 + k);
        if (mu >= needed) {
          a = gs / (1 + k);
          formula = `a = g·sin θ / (1 + I/mr²) = ${f3(gs)} / (1 + ${f3(k)}) = ${f3(a)} m/s²`;
          mode = `rolls without slipping (μ = ${f3(mu)} ≥ ${f3(needed)} needed)`;
        } else {
          a = g * (Math.sin(theta) - mu * Math.cos(theta));
          formula = `a = g(sin θ − μ cos θ) = ${f3(g)}(sin ${deg}° − ${f3(mu)} cos ${deg}°) = ${f3(a)} m/s²`;
          mode = `slips while rolling (μ = ${f3(mu)} < ${f3(needed)} needed to roll cleanly)`;
        }
      } else {
        if (Math.abs(v0) < 1e-6 && mu >= Math.tan(theta)) {
          a = 0;
          formula = `μ = ${f3(mu)} ≥ tan θ = ${f3(Math.tan(theta))}, so static friction holds it`;
          mode = "stays put";
        } else {
          a = g * (Math.sin(theta) - mu * Math.cos(theta));
          formula = `a = g(sin θ − μ cos θ) = ${f3(g)}(sin ${deg}° − ${f3(mu)} cos ${deg}°) = ${f3(a)} m/s²`;
          mode = "slides with kinetic friction";
        }
      }
      assumptions.push(`${o.label} (${shapeName(o)}) ${mode}.`);
      // Short, disc-like cylinders roll on a faceted prism in the engine (see engine.ts), so allow more.
      const faceted = o.type === "cylinder" && o.dims.height < 2 * o.dims.radius * 0.999;
      predictions.push({
        id: `${o.id}_ramp_accel`,
        object: o.id,
        label: `${o.label}: acceleration down the ramp`,
        value: a,
        unit: "m/s²",
        formula,
        tolerance: faceted ? 0.08 : 0.03,
      });
      // Travel until the object's leading edge reaches the bottom of the slope.
      const edge = k !== null ? o.dims.radius * Math.tan(theta / 2) : o.dims.width / 2;
      const distance = Math.max(0, ramp.dims.length - s0 - edge);
      if (a > 1e-6 || v0 > 1e-6) {
        const t = timeToTravel(distance, v0, a);
        if (Number.isFinite(t) && t <= env.duration) {
          const v = v0 + a * t;
          const axisMeasure = { object: o.id, axis: down, distance };
          // Measure the acceleration over the first 70% of the run, well clear of the floor at the toe.
          predictions[predictions.length - 1].measure = { kind: "accel_to_distance", ...axisMeasure, distance: 0.7 * distance };
          predictions.push({
            id: `${o.id}_ramp_time`,
            object: o.id,
            label: `${o.label}: time to reach the bottom`,
            value: t,
            unit: "s",
            formula:
              v0 === 0
                ? `t = √(2d / a) = √(2 × ${f3(distance)} / ${f3(a)}) = ${f3(t)} s`
                : `d = v₀t + ½at² with d = ${f3(distance)} m, v₀ = ${f3(v0)} m/s → t = ${f3(t)} s`,
            measure: { kind: "time_to_distance", ...axisMeasure },
            tolerance: faceted ? 0.05 : 0.03,
          });
          predictions.push({
            id: `${o.id}_ramp_speed`,
            object: o.id,
            label: `${o.label}: speed at the bottom`,
            value: v,
            unit: "m/s",
            formula: `v = v₀ + at = ${f3(v0)} + ${f3(a)} × ${f3(t)} = ${f3(v)} m/s`,
            measure: { kind: "speed_at_distance", ...axisMeasure },
            tolerance: faceted ? 0.06 : 0.03,
          });
        } else if (Number.isFinite(t)) {
          assumptions.push(`${o.label} needs about ${f3(t)} s to reach the bottom — longer than the ${env.duration} s run.`);
        }
      }
      continue;
    }

    // ---------------------------------------------------------------- pendulum
    const rods = links.filter((l) => l.type === "rod");
    if (rods.length === 1 && links.length === 1 && rods[0].b === null && isFree(o) && g > 0) {
      archetypes.add("pendulum");
      const rod = rods[0];
      const L = rod.length;
      const r = vec.sub(o.position, rod.anchor);
      const cosT = Math.max(-1, Math.min(1, vec.dot(vec.norm(r), gdir)));
      const theta0 = Math.acos(cosT);
      const v0 = vec.len(o.velocity);
      const energy = 0.5 * v0 * v0 + g * L * (1 - cosT); // per unit mass, relative to the bottom
      const T0 = 2 * Math.PI * Math.sqrt(L / g);
      const horizontal = vec.sub(r, vec.scale(gdir, vec.dot(r, gdir)));
      const vHoriz = vec.sub(o.velocity, vec.scale(gdir, vec.dot(o.velocity, gdir)));
      const axis = vec.len(horizontal) > 1e-6 ? vec.norm(horizontal) : vec.norm(vHoriz);
      const bottomClearance = vec.dot(rod.anchor, up) - L - supportDepth(o.type, o.dims, o.quaternion);
      if (env.ground && bottomClearance < 0) {
        assumptions.push(`${o.label}'s swing reaches below the floor, so it will hit the ground; period predictions skipped.`);
        continue;
      }
      if (energy < 2 * g * L) {
        const thetaMax = Math.acos(1 - energy / (g * L));
        const T = T0 / agm(1, Math.cos(thetaMax / 2));
        const vmax = Math.sqrt(2 * energy);
        predictions.push({
          id: `${o.id}_period`,
          object: o.id,
          label: `${o.label}: period of swing`,
          value: T,
          unit: "s",
          formula:
            thetaMax < 10 * DEG
              ? `T ≈ 2π√(L/g) = 2π√(${f3(L)}/${f3(g)}) = ${f3(T)} s`
              : `T = 2π√(L/g) / AGM(1, cos(θ₀/2)) = ${f3(T0)} × ${f3(T / T0)} = ${f3(T)} s (large-angle correction; small-angle formula gives ${f3(T0)} s)`,
          measure: axis.some((c) => c !== 0) ? { kind: "period", object: o.id, center: rod.anchor, axis } : undefined,
          tolerance: 0.02,
        });
        predictions.push({
          id: `${o.id}_vmax`,
          object: o.id,
          label: `${o.label}: speed at the bottom of the swing`,
          value: vmax,
          unit: "m/s",
          formula: `v = √(2gL(1 − cos θ₀)) = √(2 × ${f3(g)} × ${f3(L)} × (1 − cos ${f3(thetaMax / DEG)}°)) = ${f3(vmax)} m/s`,
          measure: { kind: "max_speed", object: o.id },
          tolerance: 0.02,
        });
        assumptions.push(`${o.label} is treated as a point mass on a rigid, massless rod of length ${f3(L)} m.`);
        if (theta0 > 90 * DEG) assumptions.push("Released above horizontal: a rigid rod keeps it on a circle (a string would go slack).");
      } else {
        const vBottom = Math.sqrt(2 * energy);
        const vTop = Math.sqrt(Math.max(0, 2 * energy - 4 * g * L));
        predictions.push({
          id: `${o.id}_loop_bottom`,
          object: o.id,
          label: `${o.label}: speed at the bottom (loops all the way round)`,
          value: vBottom,
          unit: "m/s",
          formula: `v_bottom = √(v₀² + 2gL(1 − cos θ₀)) = ${f3(vBottom)} m/s; v_top = ${f3(vTop)} m/s`,
          measure: { kind: "max_speed", object: o.id },
          tolerance: 0.02,
        });
      }
      continue;
    }

    // ---------------------------------------------------------------- spring oscillator
    const springs = links.filter((l) => l.type === "spring");
    if (springs.length === 1 && links.length === 1 && springs[0].b === null && isFree(o)) {
      const s = springs[0];
      const offset = vec.sub(o.position, s.anchor);
      const d0 = vec.len(offset);
      if (d0 > 1e-6) {
        const u = vec.norm(offset);
        const gu = g * vec.dot(gdir, u);
        const aligned = g === 0 || Math.abs(Math.abs(vec.dot(gdir, u)) - 1) < 0.004;
        const restingOnFloor =
          env.ground && Math.abs(vec.dot(gdir, u)) < 0.05 && o.position[1] - supportDepth(o.type, o.dims, o.quaternion) < 0.01;
        const vPerp = vec.len(vec.sub(o.velocity, vec.scale(u, vec.dot(o.velocity, u))));
        if ((aligned || restingOnFloor) && vPerp < 1e-6) {
          archetypes.add("spring");
          const m = o.mass;
          const k = s.stiffness;
          const w0 = Math.sqrt(k / m);
          const zeta = s.damping / (2 * Math.sqrt(k * m));
          const dEq = s.length + (aligned ? (m * gu) / k : 0);
          const center = vec.add(s.anchor, vec.scale(u, dEq));
          if (zeta < 1) {
            const wd = w0 * Math.sqrt(1 - zeta * zeta);
            const T = (2 * Math.PI) / wd;
            predictions.push({
              id: `${o.id}_spring_period`,
              object: o.id,
              label: `${o.label}: oscillation period`,
              value: T,
              unit: "s",
              formula:
                zeta === 0
                  ? `T = 2π√(m/k) = 2π√(${f3(m)}/${f3(k)}) = ${f3(T)} s`
                  : `T = 2π / (ω₀√(1 − ζ²)) with ω₀ = ${f3(w0)} rad/s, ζ = ${f3(zeta)} → ${f3(T)} s`,
              measure: { kind: "period", object: o.id, center, axis: u },
              tolerance: 0.02,
            });
            const amplitude = Math.hypot(d0 - dEq, vec.dot(o.velocity, u) / w0);
            if (zeta === 0 && !(restingOnFloor && contactCoefficients(rs, o.id, GROUND_ID).friction > 0)) {
              predictions.push({
                id: `${o.id}_spring_vmax`,
                object: o.id,
                label: `${o.label}: maximum speed`,
                value: amplitude * w0,
                unit: "m/s",
                formula: `v_max = Aω = ${f3(amplitude)} × ${f3(w0)} = ${f3(amplitude * w0)} m/s`,
                measure: { kind: "max_speed", object: o.id },
                tolerance: 0.02,
              });
            }
            if (aligned && g > 0) assumptions.push(`Gravity only shifts ${o.label}'s equilibrium by mg/k = ${f3((m * Math.abs(gu)) / k)} m; the period is unchanged.`);
            if (restingOnFloor && contactCoefficients(rs, o.id, GROUND_ID).friction > 0)
              assumptions.push(`Floor friction will shrink ${o.label}'s swings over time (the period stays the same).`);
          } else {
            assumptions.push(`${o.label}'s spring is ${zeta === 1 ? "critically" : "over"}-damped (ζ = ${f3(zeta)}), so it returns without oscillating.`);
          }
          continue;
        }
      }
    }

    // ---------------------------------------------------------------- projectile / free fall
    if (!p && links.length === 0 && isFree(o) && g > 0 && env.ground && standardGravity) {
      const depth = supportDepth(o.type, o.dims, o.quaternion);
      const h = o.position[1] - depth;
      const vy = o.velocity[1];
      const vh = Math.hypot(o.velocity[0], o.velocity[2]);
      if (h < 0.005 && vy <= 0) continue; // resting on the floor
      const tf = (vy + Math.sqrt(vy * vy + 2 * g * h)) / g;
      if (!(tf > 0) || tf > env.duration) continue;
      // Is the path clear of other objects?
      let clear = true;
      const others = rs.objects.filter((x) => x.id !== o.id).map(aabbOf);
      const pad = depth * 0.99;
      for (let i = 1; i <= 60 && clear; i++) {
        const t = (tf * i) / 60;
        const pt: Vec3 = [o.position[0] + o.velocity[0] * t, o.position[1] + vy * t - 0.5 * g * t * t, o.position[2] + o.velocity[2] * t];
        if (others.some((b) => inside(pt, b, pad))) clear = false;
      }
      if (!clear) {
        assumptions.push(`${o.label}'s flight path is blocked by another object, so no closed-form landing prediction.`);
        continue;
      }
      const kind: Archetype = vh > 1e-3 || vy > 1e-3 ? "projectile" : "free_fall";
      archetypes.add(kind);
      const vyImpact = vy - g * tf;
      const vImpact = Math.hypot(vh, vyImpact);
      predictions.push({
        id: `${o.id}_flight_time`,
        object: o.id,
        label: kind === "free_fall" ? `${o.label}: time to hit the ground` : `${o.label}: time of flight`,
        value: tf,
        unit: "s",
        formula:
          vy === 0
            ? `t = √(2h/g) = √(2 × ${f3(h)} / ${f3(g)}) = ${f3(tf)} s`
            : `t = (v_y + √(v_y² + 2gh)) / g = (${f3(vy)} + √(${p3(vy)}² + 2 × ${f3(g)} × ${f3(h)})) / ${f3(g)} = ${f3(tf)} s`,
        measure: { kind: "first_contact_time", object: o.id, other: GROUND_ID },
        tolerance: 0.02,
      });
      if (vh > 1e-3) {
        predictions.push({
          id: `${o.id}_range`,
          object: o.id,
          label: `${o.label}: horizontal distance travelled before landing`,
          value: vh * tf,
          unit: "m",
          formula: `x = v_x·t = ${f3(vh)} × ${f3(tf)} = ${f3(vh * tf)} m`,
          measure: { kind: "range_at_first_contact", object: o.id, other: GROUND_ID, up },
          tolerance: 0.02,
        });
      }
      predictions.push({
        id: `${o.id}_impact_speed`,
        object: o.id,
        label: `${o.label}: speed just before impact`,
        value: vImpact,
        unit: "m/s",
        formula:
          vh > 1e-3
            ? `v = √(v_x² + v_y²) = √(${p3(vh)}² + ${p3(vyImpact)}²) = ${f3(vImpact)} m/s`
            : `v = √(v₀² + 2gh) = ${f3(vImpact)} m/s`,
        measure: { kind: "speed_at_first_contact", object: o.id, other: GROUND_ID, gravity: env.gravityVec },
        tolerance: 0.02,
      });
      if (vy > 1e-3) {
        const hmax = o.position[1] + (vy * vy) / (2 * g);
        predictions.push({
          id: `${o.id}_max_height`,
          object: o.id,
          label: `${o.label}: maximum height (centre)`,
          value: hmax,
          unit: "m",
          formula: `h_max = y₀ + v_y²/(2g) = ${f3(o.position[1])} + ${p3(vy)}²/(2 × ${f3(g)}) = ${f3(hmax)} m`,
          measure: { kind: "max_height", object: o.id, up, offset: 0 },
          tolerance: 0.02,
        });
      }
      const e = contactCoefficients(rs, o.id, GROUND_ID).restitution;
      // Only predict the bounce if its apex happens before the run ends.
      if (o.type === "sphere" && e > 0.05 && tf + (e * Math.abs(vyImpact)) / g < env.duration - 0.05) {
        const bounce = (e * vyImpact) ** 2 / (2 * g);
        predictions.push({
          id: `${o.id}_bounce`,
          object: o.id,
          label: `${o.label}: height of the first bounce`,
          value: bounce,
          unit: "m",
          formula: `h₁ = (e·v_y)² / (2g) = (${f3(e)} × ${f3(Math.abs(vyImpact))})² / (2 × ${f3(g)}) = ${f3(bounce)} m`,
          measure: { kind: "bounce_height", object: o.id, other: GROUND_ID, up, offset: depth },
          tolerance: 0.05,
        });
      }
      assumptions.push(`${o.label} flies without air resistance and lands on the floor (y = 0).`);
      continue;
    }
  }

  // ---------------------------------------------------------------- head-on collision
  if (dyn.length === 2 && dyn.every((o) => o.type === "sphere" && linksOf(o.id).length === 0 && isFree(o) && !o.placement)) {
    const [a, b] = dyn;
    const line = vec.sub(b.position, a.position);
    const n = vec.norm(line);
    const va = vec.dot(a.velocity, n);
    const vb = vec.dot(b.velocity, n);
    const perp = (v: Vec3, s: number) => vec.len(vec.sub(v, vec.scale(n, s)));
    const onFrictionlessFloor =
      env.ground &&
      Math.abs(vec.dot(n, gdir)) < 1e-3 &&
      [a, b].every(
        (o) => Math.abs(o.position[1] - o.dims.radius) < 0.01 && contactCoefficients(rs, o.id, GROUND_ID).friction === 0,
      );
    const weightless = g === 0;
    if ((weightless || onFrictionlessFloor) && va - vb > 1e-6 && perp(a.velocity, va) < 1e-6 && perp(b.velocity, vb) < 1e-6) {
      archetypes.add("collision");
      const e = contactCoefficients(rs, a.id, b.id).restitution;
      const M = a.mass + b.mass;
      const p = a.mass * va + b.mass * vb;
      const va2 = (p + b.mass * e * (vb - va)) / M;
      const vb2 = (p + a.mass * e * (va - vb)) / M;
      const delay = 0.1;
      predictions.push({
        id: `${a.id}_after`,
        object: a.id,
        label: `${a.label}: velocity after the collision (along the line of impact)`,
        value: va2,
        unit: "m/s",
        formula: `v₁' = (m₁v₁ + m₂v₂ + m₂e(v₂ − v₁)) / (m₁ + m₂) = ${f3(va2)} m/s (e = ${f3(e)})`,
        measure: { kind: "velocity_after_contact", object: a.id, other: b.id, axis: n, delay },
        tolerance: 0.03,
      });
      predictions.push({
        id: `${b.id}_after`,
        object: b.id,
        label: `${b.label}: velocity after the collision (along the line of impact)`,
        value: vb2,
        unit: "m/s",
        formula: `v₂' = (m₁v₁ + m₂v₂ + m₁e(v₁ − v₂)) / (m₁ + m₂) = ${f3(vb2)} m/s`,
        measure: { kind: "velocity_after_contact", object: b.id, other: a.id, axis: n, delay },
        tolerance: 0.03,
      });
      assumptions.push(`Momentum along the line of impact is conserved: ${f3(p)} kg·m/s before and after.`);
    }
  }

  // ---------------------------------------------------------------- two-body orbit
  const grav = rs.forces.filter((f) => f.type === "mutual_gravity");
  if (grav.length === 1 && grav[0].appliesTo.length === 2 && g === 0) {
    const [ia, ib] = grav[0].appliesTo;
    const A = rs.objects.find((o) => o.id === ia)!;
    const B = rs.objects.find((o) => o.id === ib)!;
    const [heavy, light] = A.physicalMass >= B.physicalMass ? [A, B] : [B, A];
    if (light.dynamic && linksOf(light.id).length === 0 && linksOf(heavy.id).length === 0) {
      archetypes.add("orbit");
      const G = grav[0].magnitude;
      const mu = G * (heavy.physicalMass + (heavy.dynamic ? light.physicalMass : 0));
      const r = vec.sub(light.position, heavy.position);
      const v = vec.sub(light.velocity, heavy.velocity);
      const rl = vec.len(r);
      const energy = vec.dot(v, v) / 2 - mu / rl;
      const hvec = vec.cross(r, v);
      const vcirc = Math.sqrt(mu / rl);
      if (energy < 0) {
        const aAxis = -mu / (2 * energy);
        const ecc = Math.sqrt(Math.max(0, 1 + (2 * energy * vec.dot(hvec, hvec)) / (mu * mu)));
        const T = 2 * Math.PI * Math.sqrt(aAxis ** 3 / mu);
        predictions.push({
          id: `${light.id}_orbit_period`,
          object: light.id,
          label: `${light.label}: orbital period`,
          value: T,
          unit: "s",
          formula: `T = 2π√(a³/GM) with a = ${f3(aAxis)} m, GM = ${f3(mu)} m³/s² → ${f3(T)} s (eccentricity ${f3(ecc)})`,
          measure: {
            kind: "period",
            object: light.id,
            center: heavy.position,
            relativeTo: heavy.dynamic ? heavy.id : undefined,
            axis: vec.norm(vec.cross(hvec, r)),
            sameDirection: true,
          },
          tolerance: 0.03,
        });
        assumptions.push(
          `${light.label} starts at ${f3(vec.len(v))} m/s; a circular orbit at this distance needs ${f3(vcirc)} m/s, so the orbit is ${ecc < 0.02 ? "nearly circular" : `elliptical (e = ${f3(ecc)})`}.`,
        );
      } else {
        predictions.push({
          id: `${light.id}_escape`,
          object: light.id,
          label: `${light.label}: escape speed at the start`,
          value: Math.sqrt(2) * vcirc,
          unit: "m/s",
          formula: `v_esc = √(2GM/r) = ${f3(Math.sqrt(2) * vcirc)} m/s < v₀ = ${f3(vec.len(v))} m/s, so it escapes`,
          tolerance: 0.02,
        });
      }
    }
  }

  // ---------------------------------------------------------------- energy expectation
  let energy: Analysis["energy"];
  const external = rs.forces.some((f) => !f.redundant && (f.type === "applied_force" || f.type === "impulse" || f.type === "gravity"));
  const dissipative =
    env.airResistance ||
    rs.forces.some((f) => f.type === "drag" && f.magnitude > 0) ||
    rs.links.some((l) => l.type === "spring" && l.damping > 0);
  if (external) energy = "changes";
  else if (dissipative) energy = "decreases";
  else {
    const touches = dyn.some((o) => {
      if (o.placement?.kind === "on_ramp") {
        const ramp = rs.objects.find((x) => x.id === o.placement?.target_id) ?? rs.objects.find((x) => x.type === "ramp");
        const c = ramp ? contactCoefficients(rs, o.id, ramp.id) : { friction: 1, restitution: 0 };
        const rolls = roundFactor(o) !== null;
        return !(c.friction === 0 || rolls) || env.ground; // rolling without slipping is lossless until it hits the floor
      }
      const anyContact = env.ground || rs.objects.length > 1;
      return anyContact && !(archetypes.has("pendulum") || archetypes.has("spring") || archetypes.has("orbit"));
    });
    energy = touches ? "may_decrease" : "conserved";
  }
  if (energy === "conserved" && dyn.length > 0) {
    predictions.push({
      id: "energy_conservation",
      label: "Total mechanical energy change",
      value: 0,
      unit: "%",
      formula: "No friction, drag or collisions act, so KE + PE stays constant",
      measure: { kind: "energy_change_percent" },
      tolerance: 2,
    });
  }
  if (archetypes.size === 0) archetypes.add("general");
  return { archetypes: [...archetypes], predictions, assumptions, energy };
}

export function linkLabel(l: ResolvedLink): string {
  return l.type === "rod" ? `rod ${l.id}` : `spring ${l.id}`;
}
