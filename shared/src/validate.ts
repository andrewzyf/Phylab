import { LIMITS, MATERIALS } from "./constants";
import { supportDepth, thinnestDimension } from "./geometry";
import { SPEED_OF_LIGHT, sig, vec } from "./math";
import type { Change } from "./patch";
import { GROUND_ID, resolveScenario, type ResolvedScenario } from "./resolve";
import { isStatic, type Scenario } from "./schema";
import { PhysicsEngine } from "./sim/engine";

export type Severity = "error" | "warning" | "info";

export interface Issue {
  severity: Severity;
  code: string;
  message: string;
  /** Object / force / link the issue is about. */
  target?: string;
  path?: string;
  suggestion?: string;
  /** Machine-applicable fix the UI can offer as a button. */
  fix?: { label: string; changes: Change[] };
}

export interface ValidationResult {
  issues: Issue[];
  canRun: boolean;
  resolved: ResolvedScenario;
}

const fmt = (x: number, unit = "") => `${sig(x, 3)}${unit ? ` ${unit}` : ""}`;

/**
 * Physics-level validation: impossible values, contradictions, extreme or unstable setups.
 * Errors block running; warnings and info are shown alongside the interpretation.
 */
export function validateScenario(scenario: Scenario, resolved?: ResolvedScenario): ValidationResult {
  const rs = resolved ?? resolveScenario(scenario);
  const issues: Issue[] = [];
  const add = (i: Issue) => issues.push(i);
  const env = scenario.environment;

  // --- environment -----------------------------------------------------------------------------
  if (env.gravity < 0) {
    add({
      severity: "warning",
      code: "negative_gravity",
      path: "environment.gravity",
      message: `Gravity is negative (${env.gravity} m/s²), so everything will fall upward.`,
      suggestion: "If you meant normal gravity, use a positive value; to point gravity elsewhere, change gravity_direction.",
      fix: { label: `Use +${Math.abs(env.gravity)} m/s²`, changes: [{ path: "environment.gravity", value: Math.abs(env.gravity) }] },
    });
  } else if (env.gravity > 1000) {
    add({
      severity: "warning",
      code: "extreme_gravity",
      path: "environment.gravity",
      message: `Gravity of ${env.gravity} m/s² is over 100× Earth's. Objects will move extremely fast and may tunnel through each other.`,
    });
  }
  if (!(env.simulation_duration > 0)) {
    add({
      severity: "error",
      code: "bad_duration",
      path: "environment.simulation_duration",
      message: "The simulation duration must be greater than zero.",
      fix: { label: "Run for 5 s", changes: [{ path: "environment.simulation_duration", value: 5 }] },
    });
  } else if (env.simulation_duration > LIMITS.maxDuration) {
    add({
      severity: "warning",
      code: "long_duration",
      path: "environment.simulation_duration",
      message: `Durations are capped at ${LIMITS.maxDuration} s; the run will stop there.`,
      fix: { label: `Use ${LIMITS.maxDuration} s`, changes: [{ path: "environment.simulation_duration", value: LIMITS.maxDuration }] },
    });
  }
  if (env.air_resistance && env.air_density < 0) {
    add({ severity: "error", code: "negative_density", path: "environment.air_density", message: "Air density can't be negative." });
  }
  if (scenario.objects.length === 0) {
    add({ severity: "error", code: "empty", message: "There are no objects to simulate yet." });
  }
  if (scenario.objects.length > LIMITS.maxObjects) {
    add({ severity: "error", code: "too_many_objects", message: `At most ${LIMITS.maxObjects} objects are supported.` });
  }

  // --- objects ---------------------------------------------------------------------------------
  const seen = new Set<string>();
  for (const o of scenario.objects) {
    const p = `objects.${o.id}`;
    const name = o.label || o.id;
    if (seen.has(o.id)) add({ severity: "error", code: "duplicate_id", target: o.id, message: `Two objects share the id "${o.id}".` });
    seen.add(o.id);
    if (o.id === GROUND_ID) add({ severity: "error", code: "reserved_id", target: o.id, message: `"${GROUND_ID}" is reserved for the floor; rename this object.` });

    const stat = isStatic(o);
    if (typeof o.mass === "number" && o.mass < 0) {
      add({
        severity: "error",
        code: "negative_mass",
        target: o.id,
        path: `${p}.mass`,
        message: `${name} has negative mass (${o.mass} kg). Negative mass isn't real in classical physics.`,
        suggestion:
          "Did you mean a repulsive force instead? Or should this object have positive mass but move in the opposite direction?",
        fix: { label: `Use +${Math.abs(o.mass)} kg`, changes: [{ path: `${p}.mass`, value: Math.abs(o.mass) }] },
      });
    } else if (o.mass === 0 && !o.is_static && o.type !== "ramp") {
      add({
        severity: "error",
        code: "zero_mass",
        target: o.id,
        path: `${p}.mass`,
        message: `${name} has zero mass. A massless object would feel no gravity and respond infinitely to any push, which classical mechanics can't simulate.`,
        suggestion: "Did you mean a very light particle (e.g. 1 g), or an object fixed in place?",
        fix: { label: "Make it 1 g", changes: [{ path: `${p}.mass`, value: 0.001 }] },
      });
    } else if (!stat && typeof o.mass === "number" && o.mass > 1e9) {
      add({
        severity: "info",
        code: "huge_mass",
        target: o.id,
        message: `${name} is extremely massive (${o.mass.toExponential(2)} kg). That's fine for orbits, but contacts with light objects may be stiff.`,
      });
    }

    const d = o.dimensions;
    for (const k of ["radius", "width", "height", "depth", "length"] as const) {
      const v = d[k];
      if (v !== undefined && v < 0) {
        add({
          severity: "error",
          code: "negative_dimension",
          target: o.id,
          path: `${p}.dimensions.${k}`,
          message: `${name} has a negative ${k} (${v} m).`,
          fix: { label: `Use ${Math.abs(v)} m`, changes: [{ path: `${p}.dimensions.${k}`, value: Math.abs(v) }] },
        });
      }
    }
    const r = rs.objects.find((x) => x.id === o.id);
    if (r) {
      const thin = thinnestDimension(r.type, r.dims);
      if (thin > 0 && thin < 2e-3) {
        add({
          severity: "warning",
          code: "tiny_object",
          target: o.id,
          message: `${name} is very small (${fmt(thin * 1000, "mm")}). The engine may be less accurate below a few millimetres.`,
        });
      }
    }
    if (o.type === "ramp") {
      const angle = d.angle ?? 30;
      if (!(angle > 0 && angle < 90)) {
        add({
          severity: "error",
          code: "bad_ramp_angle",
          target: o.id,
          path: `${p}.dimensions.angle`,
          message: `A ramp angle must be between 0° and 90° (got ${angle}°).`,
          fix: { label: "Use 30°", changes: [{ path: `${p}.dimensions.angle`, value: 30 }] },
        });
      }
    }

    const speed = vec.len(o.velocity);
    if (speed >= SPEED_OF_LIGHT) {
      add({
        severity: "error",
        code: "faster_than_light",
        target: o.id,
        path: `${p}.velocity`,
        message: `${name} would move at ${fmt(speed / SPEED_OF_LIGHT)}c — faster than light, which no massive object can do.`,
        suggestion: "Pick a speed below the speed of light (299,792,458 m/s).",
      });
    } else if (speed >= 0.1 * SPEED_OF_LIGHT) {
      add({
        severity: "warning",
        code: "relativistic",
        target: o.id,
        message: `${name} moves at ${fmt((100 * speed) / SPEED_OF_LIGHT)}% of the speed of light. Classical physics breaks down here (time dilation, length contraction).`,
        suggestion:
          "Relativistic simulation isn't available yet, so this runs with classical mechanics — treat the numbers as a Newtonian approximation.",
      });
    } else if (speed > 2000) {
      add({
        severity: "info",
        code: "very_fast",
        target: o.id,
        message: `${name} starts very fast (${fmt(speed, "m/s")}). The engine shrinks its time step to avoid tunnelling, so the run may take longer.`,
      });
    }

    if (stat && (speed > 0 || vec.len(o.angular_velocity) > 0)) {
      add({
        severity: "warning",
        code: "static_with_velocity",
        target: o.id,
        path: `${p}.is_static`,
        message: `${name} is fixed in place but also has a starting velocity. These contradict each other; the velocity is ignored.`,
        suggestion: "Should it be fixed in place, or moving?",
        fix: { label: "Let it move", changes: [{ path: `${p}.is_static`, value: false }, ...(o.mass === null ? [{ path: `${p}.mass`, value: 1 }] : [])] },
      });
    }

    const mu = o.material.friction_coefficient;
    if (mu < 0) {
      add({
        severity: "error",
        code: "negative_friction",
        target: o.id,
        path: `${p}.material.friction_coefficient`,
        message: `${name} has a negative friction coefficient (${mu}); friction can only resist motion.`,
        fix: { label: "Use 0 (frictionless)", changes: [{ path: `${p}.material.friction_coefficient`, value: 0 }] },
      });
    } else if (mu > 2) {
      add({
        severity: "warning",
        code: "high_friction",
        target: o.id,
        message: `${name} has an unusually high friction coefficient (${mu}); most real surfaces are below 1.5.`,
      });
    }
    const e = o.material.restitution;
    if (e < 0) {
      add({
        severity: "error",
        code: "negative_restitution",
        target: o.id,
        path: `${p}.material.restitution`,
        message: `${name} has negative restitution (${e}); restitution runs from 0 (no bounce) to 1 (perfectly elastic).`,
        fix: { label: "Use 0", changes: [{ path: `${p}.material.restitution`, value: 0 }] },
      });
    } else if (e > 1) {
      add({
        severity: "warning",
        code: "superelastic",
        target: o.id,
        path: `${p}.material.restitution`,
        message: `${name} has restitution ${e} > 1, so every bounce adds energy — physically impossible without an energy source.`,
        fix: { label: "Use 1 (perfectly elastic)", changes: [{ path: `${p}.material.restitution`, value: 1 }] },
      });
    }
    if (o.material.name && o.material.name !== "custom" && !MATERIALS[o.material.name] && o.material.density === undefined && o.mass === undefined) {
      add({
        severity: "info",
        code: "unknown_material",
        target: o.id,
        message: `Material "${o.material.name}" isn't in the library, so ${name} gets a default mass of 1 kg.`,
      });
    }

    const pl = o.placement;
    if (pl?.kind === "pendulum" && pl.length !== undefined && pl.length <= 0) {
      add({ severity: "error", code: "bad_pendulum_length", target: o.id, message: `The pendulum length for ${name} must be positive.` });
    }
    if (pl?.kind === "pendulum" && (pl.angle ?? 0) === 0 && speed === 0) {
      add({
        severity: "info",
        code: "pendulum_at_rest",
        target: o.id,
        message: `${name} hangs straight down with no push, so it will stay still.`,
        fix: { label: "Release from 30°", changes: [{ path: `${p}.placement.angle`, value: 30 }] },
      });
    }
    if (pl?.kind === "pendulum" && Math.abs(pl.angle ?? 0) > 90) {
      add({
        severity: "info",
        code: "pendulum_over_90",
        target: o.id,
        message: `${name} starts above the pivot. PhysicsLab uses a rigid rod, so it won't go slack like a string would.`,
      });
    }

    // Below the floor?
    if (env.ground && r && !pl && o.type !== "ramp") {
      const lowest = r.position[1] - supportDepth(r.type, r.dims, r.quaternion);
      if (lowest < -0.01) {
        add({
          severity: "warning",
          code: "below_ground",
          target: o.id,
          message: `${name} starts ${fmt(-lowest, "m")} below the floor and will be shoved out violently.`,
          fix: { label: "Rest it on the floor", changes: [{ path: `${p}.placement`, value: { kind: "on_ground" } }] },
        });
      }
    }
  }

  // --- links -----------------------------------------------------------------------------------
  for (const l of scenario.links) {
    const p = `links.${l.id}`;
    if (l.stiffness !== undefined && l.stiffness < 0) {
      add({ severity: "error", code: "negative_stiffness", target: l.id, path: `${p}.stiffness`, message: `Spring "${l.id}" has negative stiffness, which would push the bodies apart without limit.` });
    }
    if (l.damping !== undefined && l.damping < 0) {
      add({ severity: "error", code: "negative_damping", target: l.id, path: `${p}.damping`, message: `Spring "${l.id}" has negative damping, which would pump energy in.` });
    }
    if (l.length !== undefined && l.length < 0) {
      add({ severity: "error", code: "negative_length", target: l.id, path: `${p}.length`, message: `Link "${l.id}" has a negative length.` });
    }
    const a = scenario.objects.find((o) => o.id === l.object_a);
    const b = l.object_b ? scenario.objects.find((o) => o.id === l.object_b) : undefined;
    if (a && isStatic(a) && (!l.object_b || (b && isStatic(b)))) {
      add({ severity: "info", code: "inert_link", target: l.id, message: `Link "${l.id}" only connects fixed things, so it has no effect.` });
    }
  }

  // --- forces ----------------------------------------------------------------------------------
  for (const f of scenario.forces) {
    const p = `forces.${f.id}`;
    const rf = rs.forces.find((x) => x.id === f.id);
    if (rf?.type === "unsupported") {
      const later = /buoyan|magnet|electr|fluid|lift|tension|normal|friction/.test(f.type);
      add({
        severity: "warning",
        code: "unsupported_force",
        target: f.id,
        message: `"${f.type}" forces aren't supported yet, so "${f.id}" is ignored.`,
        suggestion: later
          ? /normal|friction|tension/.test(f.type)
            ? "Normal, friction and tension forces are computed automatically from contacts and links — no need to add them."
            : "This force type is on the roadmap. For now you can approximate it with an applied force."
          : undefined,
      });
      continue;
    }
    if ((f.type === "applied_force" || f.type === "impulse" || f.type === "gravity") && vec.len(f.direction) < 1e-9) {
      add({ severity: "error", code: "zero_direction", target: f.id, path: `${p}.direction`, message: `Force "${f.id}" has no direction (0, 0, 0).` });
    }
    if (f.type === "drag" && f.magnitude < 0) {
      add({ severity: "error", code: "negative_drag", target: f.id, path: `${p}.magnitude`, message: `Drag "${f.id}" has a negative coefficient, which would speed objects up.` });
    }
    if (f.end_time !== null && f.end_time !== undefined && f.end_time < f.start_time) {
      add({ severity: "error", code: "force_window", target: f.id, message: `Force "${f.id}" ends (${f.end_time} s) before it starts (${f.start_time} s).` });
    }
    if (f.type === "applied_force" && f.magnitude < 0) {
      add({ severity: "info", code: "negative_magnitude", target: f.id, message: `Force "${f.id}" has a negative magnitude, so it acts opposite to its direction vector.` });
    }
    if (f.start_time > env.simulation_duration) {
      add({ severity: "warning", code: "force_after_end", target: f.id, message: `Force "${f.id}" starts after the simulation ends, so it never acts.` });
    }
  }

  // --- resolver findings -----------------------------------------------------------------------
  for (const problem of rs.problems) add({ severity: "error", code: "reference", message: problem });
  for (const note of rs.notes) add({ severity: "info", code: "note", message: note });

  // --- initial overlaps (checked with the real collision detector) -------------------------------
  if (!issues.some((i) => i.severity === "error")) {
    for (const ov of findInitialOverlaps(rs)) {
      if (ov.b === GROUND_ID || ov.a === GROUND_ID) {
        const id = ov.a === GROUND_ID ? ov.b : ov.a;
        if (issues.some((i) => i.code === "below_ground" && i.target === id)) continue;
        const o = scenario.objects.find((x) => x.id === id);
        if (o && o.type !== "ramp" && !isStatic(o)) {
          add({
            severity: "warning",
            code: "below_ground",
            target: id,
            message: `${o.label || id} starts ${fmt(ov.depth * 100, "cm")} inside the floor and will be shoved out.`,
            fix: { label: "Rest it on the floor", changes: [{ path: `objects.${id}.placement`, value: { kind: "on_ground" } }] },
          });
        }
        continue;
      }
      add({
        severity: "warning",
        code: "overlap",
        target: ov.a,
        message: `"${ov.a}" and "${ov.b}" start overlapping by ${fmt(ov.depth * 100, "cm")}; they'll be pushed apart violently at t = 0.`,
      });
    }
  }

  return { issues, canRun: !issues.some((i) => i.severity === "error"), resolved: rs };
}

/** Pairs of bodies that interpenetrate at t = 0 by more than a small tolerance. */
export function findInitialOverlaps(rs: ResolvedScenario): { a: string; b: string; depth: number }[] {
  const out = new Map<string, { a: string; b: string; depth: number }>();
  try {
    const engine = new PhysicsEngine(rs, 1e-6);
    const idOf = new Map<number, string>();
    for (const eb of engine.bodies) idOf.set(eb.body.id, eb.id);
    for (const body of engine.world.bodies) if (!idOf.has(body.id) && body.shapes.length) idOf.set(body.id, GROUND_ID);
    engine.world.step(1e-7);
    for (const c of engine.world.contacts) {
      const a = idOf.get(c.bi.id);
      const b = idOf.get(c.bj.id);
      if (!a || !b) continue;
      const pj = c.bj.position.vadd(c.rj);
      const pi = c.bi.position.vadd(c.ri);
      const depth = -c.ni.dot(pj.vsub(pi));
      const sizeA = a === GROUND_ID ? Infinity : thinnestOf(rs, a);
      const sizeB = b === GROUND_ID ? Infinity : thinnestOf(rs, b);
      const tol = Math.max(0.005, 0.05 * Math.min(sizeA, sizeB));
      if (depth > tol) {
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        const prev = out.get(key);
        if (!prev || prev.depth < depth) out.set(key, { a, b, depth });
      }
    }
  } catch {
    // Overlap detection is best-effort; never block validation on it.
  }
  return [...out.values()];
}

function thinnestOf(rs: ResolvedScenario, id: string): number {
  const o = rs.objects.find((x) => x.id === id);
  return o ? thinnestDimension(o.type, o.dims) : Infinity;
}
