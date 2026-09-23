import { z } from "zod";
import { MATERIALS } from "./constants";
import type { Vec3 } from "./math";

/**
 * The PhysicsLab scenario format.
 *
 * Conventions (shared with the AI system prompt — keep them in sync):
 *  - SI units everywhere (m, kg, s, N). Angles in the scenario are DEGREES; angular velocity is rad/s.
 *  - Right-handed, Y is up. The optional infinite ground is the plane y = 0.
 *  - `position` is the object's centre of mass, except for ramps where it is the centre of the ramp's
 *    footprint on its bottom face (so a ramp at [0,0,0] sits on the ground).
 *  - Placement helpers (`placement`) let a scenario say "on the ramp, 0.2 m from the top" instead of
 *    computing coordinates by hand; the resolver turns them into exact positions.
 */

const Vec3Schema = z.preprocess((v) => {
  if (v && typeof v === "object" && !Array.isArray(v) && "x" in v) {
    const o = v as Record<string, unknown>;
    return [o.x ?? 0, o.y ?? 0, o.z ?? 0];
  }
  if (typeof v === "number") return [v, 0, 0];
  return v;
}, z.tuple([z.number(), z.number(), z.number()])) as unknown as z.ZodType<Vec3, Vec3>;

export const OBJECT_TYPES = ["sphere", "box", "cylinder", "ramp", "plate"] as const;
export type ObjectType = (typeof OBJECT_TYPES)[number];

const TYPE_ALIASES: Record<string, ObjectType> = {
  sphere: "sphere", ball: "sphere", marble: "sphere", particle: "sphere", planet: "sphere", bob: "sphere",
  box: "box", cube: "box", block: "box", crate: "box", brick: "box", cuboid: "box",
  cylinder: "cylinder", disk: "cylinder", disc: "cylinder", wheel: "cylinder", can: "cylinder", hoop: "cylinder", ring: "cylinder",
  ramp: "ramp", incline: "ramp", wedge: "ramp", slope: "ramp", inclined_plane: "ramp",
  plate: "plate", plane: "plate", floor: "plate", wall: "plate", platform: "plate", table: "plate", board: "plate", slab: "plate",
};

export const PLACEMENT_KINDS = ["none", "on_ground", "on_ramp", "on_top_of", "pendulum"] as const;
export type PlacementKind = (typeof PLACEMENT_KINDS)[number];

export const PlacementSchema = z.object({
  kind: z.enum(PLACEMENT_KINDS).default("none"),
  /** Ramp id (on_ramp) or supporting object id (on_top_of). */
  target_id: z.string().optional(),
  /** on_ramp: distance along the incline from the ramp's top edge to the contact point (m). */
  distance_from_top: z.number().optional(),
  /** on_ramp: sideways offset across the ramp's width (m), for side-by-side races. */
  lateral_offset: z.number().optional(),
  /** pendulum: world-space pivot point. */
  anchor: Vec3Schema.optional(),
  /** pendulum: pivot-to-centre length (m). */
  length: z.number().optional(),
  /** pendulum: release angle from the vertical in degrees (positive swings toward +x). */
  angle: z.number().optional(),
});
export type Placement = z.infer<typeof PlacementSchema>;

export const MaterialSchema = z.object({
  name: z.string().default("custom"),
  friction_coefficient: z.number().default(0.5),
  restitution: z.number().default(0.3),
  /** Hex colour; empty string means "pick from the palette". */
  color: z.string().default(""),
  /** kg/m^3 — used to derive mass when `mass` is omitted. */
  density: z.number().optional(),
});
export type Material = z.infer<typeof MaterialSchema>;

export const DimensionsSchema = z.object({
  radius: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  depth: z.number().optional(),
  /** Ramps: length of the sloped surface (m). */
  length: z.number().optional(),
  /** Ramps: incline angle in degrees. */
  angle: z.number().optional(),
});
export type Dimensions = z.infer<typeof DimensionsSchema>;

export const ObjectSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  type: z.enum(OBJECT_TYPES),
  /** kg. `null` means immovable (static). Omit to derive from density × volume. */
  mass: z.number().nullable().optional(),
  is_static: z.boolean().default(false),
  position: Vec3Schema.default([0, 0, 0]),
  velocity: Vec3Schema.default([0, 0, 0]),
  /** Euler angles in degrees (XYZ order). */
  rotation: Vec3Schema.default([0, 0, 0]),
  /** rad/s */
  angular_velocity: Vec3Schema.default([0, 0, 0]),
  dimensions: DimensionsSchema.prefault({}),
  material: MaterialSchema.prefault({}),
  placement: PlacementSchema.optional(),
  /** Hollow sphere / thin-walled tube instead of a solid body (changes rotational inertia). */
  hollow: z.boolean().default(false),
  /** Spec-compatible constraint list. Only `fixed` is interpreted here; joints live in `links`. */
  constraints: z
    .array(z.object({ type: z.string(), parameters: z.record(z.string(), z.unknown()).optional() }))
    .optional(),
});
export type SimObject = z.infer<typeof ObjectSchema>;
export type SimObjectInput = z.input<typeof ObjectSchema>;

export const LINK_TYPES = ["rod", "spring"] as const;
export type LinkType = (typeof LINK_TYPES)[number];

export const LinkSchema = z.object({
  id: z.string().min(1),
  type: z.enum(LINK_TYPES),
  object_a: z.string().min(1),
  /** Second object id. Empty / omitted / "world" attaches object_a to the fixed `anchor` point. */
  object_b: z.string().optional(),
  anchor: Vec3Schema.optional(),
  /** Rod length or spring rest length (m). Omit/0 to use the initial distance. */
  length: z.number().optional(),
  /** Spring constant k (N/m). */
  stiffness: z.number().optional(),
  /** Spring damping (N·s/m). */
  damping: z.number().optional(),
});
export type Link = z.infer<typeof LinkSchema>;

export const SUPPORTED_FORCE_TYPES = ["applied_force", "impulse", "drag", "mutual_gravity", "gravity"] as const;
export type SupportedForceType = (typeof SUPPORTED_FORCE_TYPES)[number];

export const ForceSchema = z.object({
  id: z.string().min(1),
  /** applied_force | impulse | drag | mutual_gravity | gravity (other types are reported as unsupported). */
  type: z.string(),
  /**
   * applied_force: newtons. impulse: N·s. drag: coefficient (b in N·s/m for linear, c in N·s²/m² for
   * quadratic). mutual_gravity: G (0 → 6.674e-11).
   */
  magnitude: z.number().default(0),
  direction: Vec3Schema.default([1, 0, 0]),
  /** Object ids. Empty means every dynamic object. */
  applies_to: z.array(z.string()).default([]),
  start_time: z.number().default(0),
  /** null / omitted → until the end of the simulation. */
  end_time: z.number().nullable().optional(),
  drag_model: z.enum(["linear", "quadratic"]).optional(),
  varies_with: z.string().optional(),
});
export type Force = z.infer<typeof ForceSchema>;

export const ContactSchema = z.object({
  object_a: z.string(),
  /** Use "ground" for the floor. */
  object_b: z.string(),
  friction: z.number().optional(),
  restitution: z.number().optional(),
});
export type ContactOverride = z.infer<typeof ContactSchema>;

export const EnvironmentSchema = z.object({
  /** m/s^2 magnitude (0 = weightless). */
  gravity: z.number().default(9.81),
  gravity_direction: Vec3Schema.default([0, -1, 0]),
  /** Playback speed multiplier suggested by the scenario (1 = real time). */
  time_scale: z.number().default(1),
  simulation_duration: z.number().default(5),
  /** Infinite floor at y = 0. */
  ground: z.boolean().default(true),
  /** Omit to let each object's own coefficient decide contacts with the ground. */
  ground_friction: z.number().optional(),
  ground_restitution: z.number().optional(),
  air_resistance: z.boolean().default(false),
  air_density: z.number().default(1.225),
  boundary_conditions: z.string().default("none"),
});
export type Environment = z.infer<typeof EnvironmentSchema>;

export const MetadataSchema = z.object({
  name: z.string().default("Untitled scenario"),
  description: z.string().default(""),
  created_at: z.string().optional(),
  user_id: z.string().optional(),
  source: z.enum(["ai", "offline", "preset", "builder", "user", "shared"]).optional(),
});

export const ScenarioSchema = z.object({
  version: z.literal(1).default(1),
  metadata: MetadataSchema.prefault({}),
  environment: EnvironmentSchema.prefault({}),
  objects: z.array(ObjectSchema).default([]),
  links: z.array(LinkSchema).default([]),
  forces: z.array(ForceSchema).default([]),
  contacts: z.array(ContactSchema).default([]),
  expected_outcome: z.string().default(""),
  physics_notes: z.string().default(""),
});
export type Scenario = z.infer<typeof ScenarioSchema>;
export type ScenarioInput = z.input<typeof ScenarioSchema>;

// ---------------------------------------------------------------------------------------------
// Normalisation: accept the looser formats people (and models) naturally write, including the
// compact example format from the PhysicsLab spec (`scenario_name`, top-level `gravity`, `angle`
// on a "plane", string materials, `constraints: [{type: "fixed"}]`, ...).
// ---------------------------------------------------------------------------------------------

type Loose = Record<string, unknown>;
const isObj = (v: unknown): v is Loose => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export function normalizeObjectType(raw: unknown, hints: Loose = {}): ObjectType | undefined {
  if (typeof raw !== "string") return undefined;
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const mapped = TYPE_ALIASES[key];
  if (key === "plane" || key === "inclined_plane") {
    const dims = isObj(hints.dimensions) ? hints.dimensions : {};
    const angle = num(hints.angle) ?? num(dims.angle);
    if (angle && Math.abs(angle) > 0.01) return "ramp";
  }
  return mapped;
}

function normalizeMaterial(raw: unknown, obj: Loose): Loose {
  let m: Loose = {};
  if (typeof raw === "string") m = { name: raw };
  else if (isObj(raw)) m = { ...raw };
  // Spec example puts friction on the object itself.
  if (m.friction_coefficient === undefined) {
    const f = num(obj.friction_coefficient) ?? num(obj.friction) ?? num(m.friction);
    if (f !== undefined) m.friction_coefficient = f;
  }
  if (m.restitution === undefined) {
    const r = num(obj.restitution) ?? num(m.bounciness);
    if (r !== undefined) m.restitution = r;
  }
  if (m.color === undefined && typeof obj.color === "string") m.color = obj.color;
  const preset = typeof m.name === "string" ? MATERIALS[m.name.trim().toLowerCase().replace(/[\s-]+/g, "_")] : undefined;
  if (preset) {
    m.name = preset.name;
    m.friction_coefficient ??= preset.friction;
    m.restitution ??= preset.restitution;
    m.density ??= preset.density;
    if (m.color === undefined || m.color === "") m.color = preset.color;
  }
  delete m.friction;
  delete m.bounciness;
  return m;
}

function normalizeObject(raw: unknown, index: number): unknown {
  if (!isObj(raw)) return raw;
  const o: Loose = { ...raw };
  if (typeof o.id !== "string" || !o.id) o.id = typeof o.name === "string" && o.name ? String(o.name) : `object_${index + 1}`;
  const type = normalizeObjectType(o.type ?? o.shape, o);
  if (type) o.type = type;
  if (typeof o.type === "string" && /hoop|ring/i.test(String(raw.type)) && o.hollow === undefined) o.hollow = true;

  const dims: Loose = isObj(o.dimensions) ? { ...o.dimensions } : {};
  for (const k of ["radius", "width", "height", "depth", "length", "angle"] as const) {
    if (dims[k] === undefined && num(o[k]) !== undefined) dims[k] = o[k];
    delete o[k];
  }
  if (dims.size !== undefined && num(dims.size) !== undefined) {
    dims.width ??= dims.size;
    dims.height ??= dims.size;
    dims.depth ??= dims.size;
    delete dims.size;
  }
  // Wire format uses 0 for "not applicable" — drop those so defaults apply.
  for (const k of Object.keys(dims)) if (dims[k] === 0 && k !== "angle") delete dims[k];
  if (o.type === "ramp" && dims.angle === 0) delete dims.angle;
  o.dimensions = dims;

  o.material = normalizeMaterial(o.material, o);
  delete o.friction_coefficient;
  delete o.restitution;
  delete o.color;

  if (Array.isArray(o.constraints)) {
    const fixed = o.constraints.some((c) => isObj(c) && typeof c.type === "string" && /fixed|static|anchor/i.test(c.type));
    if (fixed) o.is_static = true;
  }
  if (o.static === true) o.is_static = true;
  delete o.static;

  if (isObj(o.placement)) {
    const p: Loose = { ...o.placement };
    if (p.target_id === undefined && typeof p.ramp_id === "string") p.target_id = p.ramp_id;
    if (p.target_id === "") delete p.target_id;
    delete p.ramp_id;
    if (p.kind === "none") return { ...o, placement: undefined };
    o.placement = p;
  }
  return o;
}

/**
 * Convert loose input (AI output, spec-style JSON, hand-written presets) into the canonical shape
 * accepted by `ScenarioSchema`. Never throws.
 */
export function normalizeScenarioInput(raw: unknown): unknown {
  if (!isObj(raw)) return raw;
  const s: Loose = { ...raw };

  const meta: Loose = isObj(s.metadata) ? { ...s.metadata } : {};
  if (meta.name === undefined && typeof s.scenario_name === "string") meta.name = s.scenario_name;
  if (meta.name === undefined && typeof s.name === "string") meta.name = s.name;
  if (meta.description === undefined && typeof s.description === "string") meta.description = s.description;
  s.metadata = meta;
  delete s.scenario_name;
  delete s.name;
  delete s.description;

  const env: Loose = isObj(s.environment) ? { ...s.environment } : {};
  if (env.gravity === undefined && num(s.gravity) !== undefined) env.gravity = s.gravity;
  if (env.simulation_duration === undefined) {
    const d = num(s.duration) ?? num(env.duration) ?? num(s.simulation_duration);
    if (d !== undefined) env.simulation_duration = d;
  }
  delete env.duration;
  delete s.gravity;
  delete s.duration;
  delete s.simulation_duration;
  s.environment = env;

  if (Array.isArray(s.objects)) s.objects = s.objects.map(normalizeObject);

  if (Array.isArray(s.forces)) {
    s.forces = s.forces.map((f, i) => {
      if (!isObj(f)) return f;
      const out: Loose = { ...f };
      if (typeof out.id !== "string" || !out.id) out.id = `force_${i + 1}`;
      if (typeof out.type === "string") out.type = out.type.trim().toLowerCase().replace(/[\s-]+/g, "_");
      if (out.type === "force" || out.type === "push" || out.type === "applied") out.type = "applied_force";
      if (typeof out.applies_to === "string") out.applies_to = out.applies_to ? [out.applies_to] : [];
      if (out.end_time === -1) out.end_time = null;
      return out;
    });
  }
  if (Array.isArray(s.links)) {
    s.links = s.links.map((l, i) => {
      if (!isObj(l)) return l;
      const out: Loose = { ...l };
      if (typeof out.id !== "string" || !out.id) out.id = `link_${i + 1}`;
      if (out.object_b === "" || out.object_b === "world" || out.object_b === "anchor") delete out.object_b;
      if (out.length === 0) delete out.length;
      return out;
    });
  }
  // The spec example lists global constraints like {type:"friction_coefficient", object, value}.
  if (Array.isArray(s.constraints) && Array.isArray(s.objects)) {
    for (const c of s.constraints) {
      if (!isObj(c) || typeof c.object !== "string") continue;
      const target = (s.objects as Loose[]).find((o) => isObj(o) && o.id === c.object);
      if (!target || num(c.value) === undefined) continue;
      if (c.type === "friction_coefficient") (target.material as Loose).friction_coefficient = c.value;
      if (c.type === "restitution") (target.material as Loose).restitution = c.value;
    }
  }
  delete s.constraints;
  if (typeof s.collision_behavior === "string") delete s.collision_behavior;
  return s;
}

export type ParseResult =
  | { ok: true; scenario: Scenario }
  | { ok: false; errors: string[] };

/** Normalise + validate the *shape* of a scenario (physics checks live in validate.ts). */
export function parseScenario(raw: unknown): ParseResult {
  const result = ScenarioSchema.safeParse(normalizeScenarioInput(raw));
  if (result.success) return { ok: true, scenario: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`),
  };
}

/** Parse or throw — convenient for presets and tests. */
export function makeScenario(raw: unknown): Scenario {
  const r = parseScenario(raw);
  if (!r.ok) throw new Error(`Invalid scenario:\n${r.errors.join("\n")}`);
  return r.scenario;
}

export function isStatic(o: SimObject): boolean {
  return o.is_static || o.mass === null || o.type === "ramp";
}
