import { analyzeScenario, type Analysis } from "../analysis/predict";
import { SPEED_OF_LIGHT, sig, vec } from "../math";
import { contactCoefficients, GROUND_ID, type ResolvedObject, type ResolvedScenario } from "../resolve";
import type { Interpretation } from "./types";

const n = (x: number, d = 3) => `${sig(x, d)}`;

export function describeShape(o: ResolvedObject): string {
  const d = o.dims;
  switch (o.type) {
    case "sphere":
      return `${o.hollow ? "hollow " : ""}sphere, radius ${n(d.radius)} m`;
    case "cylinder":
      return `${o.hollow ? "hollow " : ""}cylinder, radius ${n(d.radius)} m × ${n(d.height)} m`;
    case "box":
      return `box ${n(d.width)} × ${n(d.height)} × ${n(d.depth)} m`;
    case "plate":
      return `flat plate ${n(d.width)} × ${n(d.depth)} m, ${n(d.height)} m thick`;
    case "ramp":
      return `ramp at ${n(d.angle)}°, ${n(d.length)} m long (${n(d.length * Math.sin((d.angle * Math.PI) / 180))} m high)`;
  }
}

export function describeObject(o: ResolvedObject, rs: ResolvedScenario): string {
  const parts: string[] = [describeShape(o)];
  if (o.dynamic) parts.push(`mass ${n(o.physicalMass || o.mass)} kg${o.massFromDensity ? ` (from ${o.materialName} density)` : ""}`);
  else parts.push(o.physicalMass > 0 ? `fixed in place (mass ${n(o.physicalMass)} kg for gravity)` : "fixed in place");
  if (o.materialName && !["custom", "frictionless"].includes(o.materialName)) parts.push(o.materialName.replace("_", " "));
  parts.push(`μ = ${n(o.friction)}, restitution ${n(o.restitution)}`);
  const p = o.placement;
  if (p?.kind === "on_ramp") parts.push(`starts ${n(p.distance_from_top ?? 0)} m down from the top of ${labelOf(rs, p.target_id)}`);
  else if (p?.kind === "on_ground") parts.push("resting on the floor");
  else if (p?.kind === "on_top_of") parts.push(`resting on ${labelOf(rs, p.target_id)}`);
  else if (p?.kind === "pendulum") parts.push(`hangs on a ${n(p.length ?? 1)} m rod, released from ${n(p.angle ?? 0)}°`);
  else if (o.type !== "ramp") parts.push(`starts at (${o.position.map((c) => n(c)).join(", ")}) m`);
  const speed = vec.len(o.velocity);
  if (o.dynamic) {
    if (speed > 0) {
      parts.push(
        speed >= 0.01 * SPEED_OF_LIGHT
          ? `moving at ${n(speed / SPEED_OF_LIGHT)}c`
          : `moving at ${n(speed)} m/s toward (${vec.norm(o.velocity).map((c) => n(c, 2)).join(", ")})`,
      );
    } else parts.push("starts at rest");
    if (vec.len(o.angularVelocity) > 0) parts.push(`spinning at ${n(vec.len(o.angularVelocity))} rad/s`);
  }
  return parts.join("; ");
}

function labelOf(rs: ResolvedScenario, id?: string): string {
  if (!id) return "the ramp";
  return rs.objects.find((o) => o.id === id)?.label ?? id;
}

export function describeForces(rs: ResolvedScenario): { name: string; details: string }[] {
  const env = rs.environment;
  const out: { name: string; details: string }[] = [];
  const dyn = rs.objects.filter((o) => o.dynamic);
  if (env.gravity > 0) {
    const std = Math.abs(env.gravityDir[1] + 1) < 1e-6;
    out.push({
      name: "Gravity",
      details: `${n(env.gravity)} m/s² ${std ? "downward" : `along (${env.gravityDir.map((c) => n(c, 2)).join(", ")})`}, acting on every object (F = mg).`,
    });
  } else out.push({ name: "Gravity", details: "None — the scene is weightless." });

  const touching = dyn.some((o) => o.placement && o.placement.kind !== "pendulum") || env.ground;
  if (touching && dyn.length) {
    out.push({ name: "Normal force", details: "Perpendicular to every surface in contact; stops objects passing through each other." });
    const frictionPairs: string[] = [];
    for (const o of dyn) {
      const other = o.placement?.kind === "on_ramp" ? o.placement.target_id : o.placement?.kind === "on_top_of" ? o.placement.target_id : GROUND_ID;
      if (!other || (other === GROUND_ID && !env.ground)) continue;
      const mu = contactCoefficients(rs, o.id, other).friction;
      frictionPairs.push(`${o.label} on ${other === GROUND_ID ? "the floor" : labelOf(rs, other)}: μ = ${n(mu)}${mu === 0 ? " (frictionless)" : ""}`);
    }
    if (frictionPairs.length) out.push({ name: "Friction", details: `${frictionPairs.join("; ")}. Opposes sliding (at most μN).` });
  }
  for (const l of rs.links) {
    const a = labelOf(rs, l.a);
    const b = l.b ? labelOf(rs, l.b) : `the fixed point (${l.anchor.map((c) => n(c)).join(", ")})`;
    if (l.type === "rod") out.push({ name: `Tension (${l.implicit ? "pendulum rod" : l.id})`, details: `A rigid ${n(l.length)} m rod keeps ${a} at a fixed distance from ${b}.` });
    else
      out.push({
        name: `Spring force (${l.id})`,
        details: `F = −k·Δx with k = ${n(l.stiffness)} N/m and rest length ${n(l.length)} m between ${a} and ${b}${l.damping > 0 ? `, damping ${n(l.damping)} N·s/m` : ""}.`,
      });
  }
  for (const f of rs.forces) {
    if (f.redundant) continue;
    const who = f.appliesTo.map((id) => labelOf(rs, id)).join(", ") || "all objects";
    const window = f.end === Number.POSITIVE_INFINITY ? (f.start > 0 ? ` from t = ${n(f.start)} s` : "") : ` from t = ${n(f.start)} s to ${n(f.end)} s`;
    const dir = `(${f.direction.map((c) => n(c, 2)).join(", ")})`;
    switch (f.type) {
      case "applied_force":
        out.push({ name: `Applied force (${f.id})`, details: `${n(f.magnitude)} N along ${dir} on ${who}${window}.` });
        break;
      case "impulse":
        out.push({ name: `Impulse (${f.id})`, details: `${n(f.magnitude)} N·s along ${dir} on ${who} at t = ${n(f.start)} s.` });
        break;
      case "drag":
        out.push({
          name: `Drag (${f.id})`,
          details: f.dragModel === "quadratic" ? `F = −c|v|v with c = ${n(f.magnitude)} N·s²/m² on ${who}.` : `F = −b·v with b = ${n(f.magnitude)} N·s/m on ${who}.`,
        });
        break;
      case "mutual_gravity":
        out.push({ name: "Gravitational attraction", details: `F = G·m₁m₂/r² between ${who} (G = ${f.magnitude.toExponential(3)}).` });
        break;
      case "gravity":
        out.push({ name: `Extra gravity (${f.id})`, details: `${n(f.magnitude)} m/s² along ${dir} on ${who}.` });
        break;
      default:
        out.push({ name: `${f.rawType} (${f.id})`, details: "Not supported yet — ignored." });
    }
  }
  if (env.airResistance) out.push({ name: "Air resistance", details: `Quadratic drag ½ρC_dAv² with air density ${n(env.airDensity)} kg/m³.` });
  return out;
}

/** A complete interpretation derived purely from the scenario (no AI). */
export function describeScenario(rs: ResolvedScenario, analysis: Analysis = analyzeScenario(rs)): Interpretation {
  const objects = rs.objects.map((o) => ({ name: o.label, details: describeObject(o, rs) }));
  const calculations = analysis.predictions.map((p) => ({
    label: p.label,
    expression: p.formula,
    result: p.unit === "%" ? `${n(p.value)}%` : `${n(p.value)} ${p.unit}`,
  }));
  const s = rs.source;
  const dyn = rs.objects.filter((o) => o.dynamic).map((o) => o.label);
  return {
    summary:
      s.metadata.description ||
      `${s.metadata.name}: ${dyn.length ? dyn.join(", ") : "no moving objects"}${rs.environment.gravity === 0 ? " in weightless space" : ` under ${n(rs.environment.gravity)} m/s² gravity`}, simulated for ${n(rs.environment.duration)} s.`,
    objects,
    forces: describeForces(rs),
    calculations,
    assumptions: analysis.assumptions,
    questions: [],
    expected_outcome: s.expected_outcome,
    physics_notes: s.physics_notes,
  };
}
