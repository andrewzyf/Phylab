import type { RunMetrics } from "../analysis/metrics";
import { sig } from "../math";
import { diffScenarios, type Change } from "../patch";
import type { Scenario } from "../schema";
import type { ExplainResult, Variation } from "./types";

export interface PredictionSummary {
  id: string;
  label: string;
  value: number;
  unit: string;
  measured?: number | null;
}

export interface ExplainRequest {
  scenario: Scenario;
  metrics?: RunMetrics | null;
  predictions?: PredictionSummary[];
  previous?: {
    scenario: Scenario;
    metrics?: RunMetrics | null;
    predictions?: PredictionSummary[];
  } | null;
  /** Optional free-form question from the user ("why did it stop sooner?"). */
  question?: string;
}

const pct = (a: number, b: number) => (Math.abs(a) > 1e-12 ? ((b - a) / Math.abs(a)) * 100 : 0);
const fmt = (x: number) => `${sig(x, 3)}`;

function friendlyPath(path: string, scenario: Scenario): string {
  const parts = path.split(".");
  if (parts[0] === "environment") return parts[1].replace(/_/g, " ");
  if (parts[0] === "objects") {
    const o = scenario.objects.find((x) => x.id === parts[1]);
    const name = o?.label || parts[1];
    const field = parts.slice(2).join(" ").replace(/_/g, " ").replace("material ", "").replace("dimensions ", "").replace("placement ", "");
    return `${name} ${field}`.trim();
  }
  if (parts[0] === "links" || parts[0] === "forces") return `${parts[1]} ${parts.slice(2).join(" ").replace(/_/g, " ")}`;
  return path;
}

/**
 * Rule-based explanation of how a parameter change affected the results. Used when no AI model is
 * configured, and as grounding data for the AI explanation.
 */
export function explainOffline(req: ExplainRequest): ExplainResult {
  const points: string[] = [];
  const suggestions: Variation[] = [];
  const prev = req.previous;
  const diffs = prev ? diffScenarios(prev.scenario, req.scenario).filter((d) => typeof d.from === "number" || typeof d.to === "number" || typeof d.to === "boolean") : [];

  for (const d of diffs.slice(0, 6)) {
    const name = friendlyPath(d.path, req.scenario);
    if (typeof d.from === "number" && typeof d.to === "number") {
      points.push(`${name}: ${fmt(d.from)} → ${fmt(d.to)} (${pct(d.from, d.to) >= 0 ? "+" : ""}${fmt(pct(d.from, d.to))}%).`);
    } else points.push(`${name}: ${String(d.from)} → ${String(d.to)}.`);
  }

  // Compare matching predictions.
  const insights: string[] = [];
  if (prev?.predictions && req.predictions) {
    for (const p of req.predictions) {
      const q = prev.predictions.find((x) => x.id === p.id);
      if (!q || Math.abs(q.value) < 1e-12) continue;
      const change = pct(q.value, p.value);
      if (Math.abs(change) < 0.05) insights.push(`${p.label} is unchanged at ${fmt(p.value)} ${p.unit}.`);
      else insights.push(`${p.label}: ${fmt(q.value)} → ${fmt(p.value)} ${p.unit} (${change >= 0 ? "+" : ""}${fmt(change)}%).`);
    }
  }

  // Physics insights for common parameter changes.
  const changedMass = diffs.find((d) => /\.mass$/.test(d.path));
  const changedGravity = diffs.find((d) => d.path === "environment.gravity");
  const changedFriction = diffs.find((d) => /friction/.test(d.path));
  const changedAngle = diffs.find((d) => /dimensions\.angle$/.test(d.path));
  const changedLength = diffs.find((d) => /placement\.length$/.test(d.path));
  const changedStiffness = diffs.find((d) => /stiffness$/.test(d.path));
  const changedRestitution = diffs.find((d) => /restitution$/.test(d.path));
  const hasPendulum = req.scenario.objects.some((o) => o.placement?.kind === "pendulum");
  const hasSpring = req.scenario.links.some((l) => l.type === "spring");
  const hasRamp = req.scenario.objects.some((o) => o.type === "ramp");

  if (changedMass && !hasSpring) {
    insights.push(
      "Changing the mass scales both the gravitational force (mg) and the inertia (m) equally, so accelerations under gravity and friction stay the same. What does change is momentum and kinetic energy — a heavier object hits harder and takes more force to stop.",
    );
  }
  if (changedMass && hasSpring) {
    insights.push("For a mass on a spring the period is 2π√(m/k): four times the mass doubles the period.");
    suggestions.push({ label: "Stiffen the spring to compensate", description: "Scale k by the same factor as the mass to restore the original period.", changes: [] });
  }
  if (changedGravity && typeof changedGravity.to === "number" && typeof changedGravity.from === "number") {
    const r = Math.sqrt(changedGravity.from / Math.max(changedGravity.to, 1e-9));
    insights.push(
      hasPendulum
        ? `A pendulum's period scales as 1/√g, so this gravity change multiplies the period by about ${fmt(r)}.`
        : `Times to fall scale as 1/√g (×${fmt(r)} here) and speeds on landing as √g.`,
    );
  }
  if (changedFriction && hasRamp) {
    insights.push(
      "On a ramp, friction does two jobs: for sliding objects it subtracts μg·cos θ from the acceleration; for round objects it supplies the torque that makes them roll, which diverts some energy into spinning.",
    );
  } else if (changedFriction) {
    insights.push("Kinetic friction decelerates a sliding object at μg, so the stopping distance v²/(2μg) is inversely proportional to μ.");
  }
  if (changedAngle && hasRamp) insights.push("Acceleration down the incline grows with sin θ; past tan θ = μ friction can no longer hold an object still.");
  if (changedLength && hasPendulum) insights.push("Period grows with √L: doubling the length multiplies the period by √2 ≈ 1.41.");
  if (changedStiffness) insights.push("A stiffer spring (larger k) oscillates faster: the period goes as 1/√k.");
  if (changedRestitution) insights.push("Restitution sets how much speed survives each impact; bounce heights scale with e².");

  // Metrics comparison.
  if (req.metrics && prev?.metrics) {
    for (const o of req.metrics.objects) {
      const q = prev.metrics.objects.find((x) => x.id === o.id);
      if (!q) continue;
      if (Math.abs(pct(q.maxSpeed, o.maxSpeed)) > 1) {
        insights.push(`${o.id}: peak speed ${fmt(q.maxSpeed)} → ${fmt(o.maxSpeed)} m/s.`);
      }
      if (o.timeToRest !== null && q.timeToRest !== null && Math.abs(o.timeToRest - q.timeToRest) > 0.05) {
        insights.push(`${o.id}: comes to rest at ${fmt(o.timeToRest)} s instead of ${fmt(q.timeToRest)} s.`);
      }
    }
  }

  if (!prev) {
    const m = req.metrics;
    if (m) {
      for (const o of m.objects.slice(0, 3)) {
        insights.push(`${o.id} reaches a top speed of ${fmt(o.maxSpeed)} m/s and travels ${fmt(o.pathLength)} m in total.`);
      }
      if (Math.abs(m.energyLostPercent) > 1) insights.push(`About ${fmt(m.energyLostPercent)}% of the peak kinetic energy was lost to friction, drag or inelastic impacts.`);
      else insights.push("Total mechanical energy stayed essentially constant — nothing dissipated it.");
    }
    for (const p of req.predictions ?? []) {
      if (p.measured === null || p.measured === undefined) continue;
      const err = pct(p.value, p.measured);
      insights.push(`${p.label}: theory ${fmt(p.value)} ${p.unit}, simulation ${fmt(p.measured)} ${p.unit} (${Math.abs(err) < 3 ? "agree" : `${fmt(err)}% apart`}).`);
    }
  }

  const explanation = prev
    ? diffs.length
      ? `You changed ${diffs.length === 1 ? friendlyPath(diffs[0].path, req.scenario) : `${diffs.length} parameters`}. ${insights[0] ?? "The results below show the effect."}`
      : "Nothing physical changed between the two runs."
    : insights[0] ?? "Run the simulation to see results.";

  return {
    explanation,
    key_points: [...points, ...insights.slice(1)].slice(0, 8),
    suggestions: suggestions.filter((s) => s.changes.length > 0),
    source: "offline",
  };
}

export type { Change };
