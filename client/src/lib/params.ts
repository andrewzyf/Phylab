import { isStatic, MATERIALS, type Scenario, type SimObject } from "@physicslab/shared";

export interface ParamSpec {
  path: string;
  label: string;
  unit: string;
  kind: "number" | "boolean";
  value: number | boolean;
  min: number;
  max: number;
  step: number;
  scale: "linear" | "log";
}

export interface ParamGroup {
  id: string;
  title: string;
  subtitle?: string;
  color?: string;
  params: ParamSpec[];
}

function num(path: string, label: string, value: number, unit: string, min: number, max: number, step = 0.01, scale: "linear" | "log" = "linear"): ParamSpec {
  const lo = scale === "log" ? Math.min(min, value > 0 ? value : min) : Math.min(min, value);
  const hi = Math.max(max, value);
  return { path, label, unit, kind: "number", value, min: lo, max: hi, step, scale };
}
const bool = (path: string, label: string, value: boolean): ParamSpec => ({ path, label, unit: "", kind: "boolean", value, min: 0, max: 1, step: 1, scale: "linear" });

function objectParams(o: SimObject, s: Scenario): ParamSpec[] {
  const p = `objects.${o.id}`;
  const out: ParamSpec[] = [];
  const d = o.dimensions;
  const stat = isStatic(o);
  if (o.type === "ramp") {
    out.push(num(`${p}.dimensions.angle`, "Angle", d.angle ?? 30, "°", 1, 85, 0.5));
    out.push(num(`${p}.dimensions.length`, "Slope length", d.length ?? 5, "m", 0.5, 20, 0.05));
    out.push(num(`${p}.dimensions.width`, "Width", d.width ?? 1.5, "m", 0.2, 10, 0.05));
  } else {
    if (!stat && typeof o.mass === "number") out.push(num(`${p}.mass`, "Mass", o.mass, "kg", 0.001, 10000, 0.001, "log"));
    if (o.type === "sphere") out.push(num(`${p}.dimensions.radius`, "Radius", d.radius ?? 0.2, "m", 0.01, 3, 0.005));
    if (o.type === "cylinder") {
      out.push(num(`${p}.dimensions.radius`, "Radius", d.radius ?? 0.2, "m", 0.01, 3, 0.005));
      out.push(num(`${p}.dimensions.height`, "Length", d.height ?? 0.4, "m", 0.01, 5, 0.005));
    }
    if (o.type === "box" || o.type === "plate") {
      out.push(num(`${p}.dimensions.width`, "Width (x)", d.width ?? 0.5, "m", 0.01, 20, 0.01));
      out.push(num(`${p}.dimensions.height`, o.type === "plate" ? "Thickness" : "Height (y)", d.height ?? 0.5, "m", 0.01, stat ? 100 : 20, 0.01));
      out.push(num(`${p}.dimensions.depth`, "Depth (z)", d.depth ?? 0.5, "m", 0.01, 20, 0.01));
    }
  }
  out.push(num(`${p}.material.friction_coefficient`, "Friction μ", o.material.friction_coefficient, "", 0, 1.5, 0.01));
  out.push(num(`${p}.material.restitution`, "Restitution e", o.material.restitution, "", 0, 1, 0.01));

  const pl = o.placement;
  if (!stat && pl?.kind === "on_ramp") {
    const ramp = s.objects.find((x) => x.id === pl.target_id);
    out.push(num(`${p}.placement.distance_from_top`, "Start down the slope", pl.distance_from_top ?? 0.1, "m", 0, ramp?.dimensions.length ?? 5, 0.01));
  } else if (!stat && pl?.kind === "pendulum") {
    out.push(num(`${p}.placement.length`, "Pendulum length", pl.length ?? 1, "m", 0.1, 10, 0.01));
    out.push(num(`${p}.placement.angle`, "Release angle", pl.angle ?? 30, "°", -179, 179, 0.5));
  } else if (o.type !== "ramp") {
    const axes = ["x", "y", "z"] as const;
    if (!pl || pl.kind === "none") {
      axes.forEach((a, i) => out.push(num(`${p}.position.${i}`, `Position ${a}`, o.position[i], "m", i === 1 ? 0 : -20, i === 1 ? 40 : 20, 0.01)));
    }
  }
  if (!stat) {
    const vmax = Math.max(20, 2 * Math.max(...o.velocity.map(Math.abs)));
    (["x", "y", "z"] as const).forEach((a, i) => out.push(num(`${p}.velocity.${i}`, `Velocity ${a}`, o.velocity[i], "m/s", -vmax, vmax, 0.01)));
    if (o.type === "sphere" || o.type === "cylinder") out.push(bool(`${p}.hollow`, "Hollow", o.hollow));
  }
  return out;
}

export function paramGroups(s: Scenario, objectColors: Record<string, string> = {}): ParamGroup[] {
  const env = s.environment;
  const groups: ParamGroup[] = [
    {
      id: "environment",
      title: "Environment",
      params: [
        num("environment.gravity", "Gravity", env.gravity, "m/s²", 0, 30, 0.01),
        num("environment.simulation_duration", "Duration", env.simulation_duration, "s", 0.5, 60, 0.1),
        bool("environment.air_resistance", "Air resistance", env.air_resistance),
        bool("environment.ground", "Floor", env.ground),
      ],
    },
  ];
  for (const o of s.objects) {
    const mat = MATERIALS[o.material.name] ? ` · ${o.material.name.replace("_", " ")}` : "";
    groups.push({
      id: o.id,
      title: o.label || o.id,
      subtitle: `${o.type}${isStatic(o) ? " · fixed" : ""}${mat}`,
      color: objectColors[o.id],
      params: objectParams(o, s),
    });
  }
  for (const l of s.links) {
    const p = `links.${l.id}`;
    const params =
      l.type === "spring"
        ? [
            num(`${p}.stiffness`, "Stiffness k", l.stiffness ?? 20, "N/m", 0.1, 10000, 0.1, "log"),
            num(`${p}.damping`, "Damping", l.damping ?? 0, "N·s/m", 0, 50, 0.01),
            num(`${p}.length`, "Rest length", l.length ?? 1, "m", 0.05, 10, 0.01),
          ]
        : [num(`${p}.length`, "Rod length", l.length ?? 1, "m", 0.05, 10, 0.01)];
    groups.push({ id: l.id, title: l.id, subtitle: l.type, params });
  }
  for (const f of s.forces) {
    const p = `forces.${f.id}`;
    const params: ParamSpec[] = [];
    if (f.type === "mutual_gravity") params.push(num(`${p}.magnitude`, "G", f.magnitude || 6.674e-11, "", 1e-12, 1e-8, 1e-13, "log"));
    else if (f.type === "drag") params.push(num(`${p}.magnitude`, "Coefficient", f.magnitude, "", 0, Math.max(5, f.magnitude * 5), 0.001));
    else params.push(num(`${p}.magnitude`, f.type === "impulse" ? "Impulse" : "Magnitude", f.magnitude, f.type === "impulse" ? "N·s" : "N", 0, Math.max(100, Math.abs(f.magnitude) * 5), 0.1));
    params.push(num(`${p}.start_time`, "Starts at", f.start_time, "s", 0, env.simulation_duration, 0.05));
    if (f.type === "applied_force" && f.end_time !== null && f.end_time !== undefined) params.push(num(`${p}.end_time`, "Ends at", f.end_time, "s", 0, env.simulation_duration, 0.05));
    groups.push({ id: f.id, title: f.id, subtitle: f.type.replace("_", " "), params });
  }
  return groups;
}

// Log-scale slider helpers: the <input type=range> runs 0..1000 in log space.
export const LOG_STEPS = 1000;
export function toSlider(spec: ParamSpec, v: number): number {
  if (spec.scale !== "log") return v;
  const lo = Math.log10(Math.max(spec.min, 1e-15));
  const hi = Math.log10(spec.max);
  return Math.round(((Math.log10(Math.max(v, spec.min)) - lo) / (hi - lo)) * LOG_STEPS);
}
export function fromSlider(spec: ParamSpec, s: number): number {
  if (spec.scale !== "log") return s;
  const lo = Math.log10(Math.max(spec.min, 1e-15));
  const hi = Math.log10(spec.max);
  const v = 10 ** (lo + (s / LOG_STEPS) * (hi - lo));
  return Number.parseFloat(v.toPrecision(3));
}
