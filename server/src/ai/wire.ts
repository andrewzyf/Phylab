/**
 * JSON Schemas for Claude's structured outputs.
 *
 * Structured outputs require every object to list all of its properties as required and to set
 * `additionalProperties: false`. Instead of optional fields and unions (which the grammar compiler
 * limits), the wire format uses explicit sentinels — 0 for "not applicable" dimensions, "" for "no
 * target", -1 for "unspecified" coefficients / "until the end" — which `wireToScenarioInput` maps back
 * to the canonical scenario format.
 */

type Json = Record<string, unknown>;

const obj = (properties: Record<string, Json>, description?: string): Json => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
  ...(description ? { description } : {}),
});
const str = (description?: string, extra: Json = {}): Json => ({ type: "string", ...(description ? { description } : {}), ...extra });
const num = (description?: string): Json => ({ type: "number", ...(description ? { description } : {}) });
const bool = (description?: string): Json => ({ type: "boolean", ...(description ? { description } : {}) });
const arr = (items: Json, description?: string): Json => ({ type: "array", items, ...(description ? { description } : {}) });
const vec3 = (description: string): Json => arr({ type: "number" }, `${description} Exactly three numbers [x, y, z].`);

const wireObject = obj({
  id: str("Unique snake_case id, e.g. ball_1."),
  label: str("Short display name, e.g. 'Ball'."),
  type: str("Shape.", { enum: ["sphere", "box", "cylinder", "ramp", "plate"] }),
  mass: num("kg. Must be > 0 for moving objects. For static objects use 0 unless its mass matters for gravitational attraction."),
  is_static: bool("true = fixed in place (ramps, floors, walls, cliffs, pivots)."),
  position: vec3("Centre of mass in metres (ramps: centre of the footprint on the ground). Ignored when placement.kind is not 'none'."),
  velocity: vec3("Initial velocity in m/s."),
  rotation: vec3("Euler angles in degrees (XYZ order). Ignored for on_ramp placement."),
  angular_velocity: vec3("Initial angular velocity in rad/s."),
  dimensions: obj(
    {
      radius: num("sphere/cylinder radius (m), else 0"),
      width: num("box/plate/ramp size along x (ramp: across its width along z), else 0"),
      height: num("box height (y) or plate thickness or cylinder length along its axis, else 0"),
      depth: num("box/plate size along z, else 0"),
      length: num("ramp: length of the sloped surface (m), else 0"),
      angle: num("ramp: incline angle in degrees, else 0"),
    },
    "Use 0 for dimensions that don't apply to this shape.",
  ),
  material: obj({
    name: str("e.g. steel, wood, rubber, plastic, glass, ice, stone, concrete, clay, foam, frictionless, custom"),
    friction_coefficient: num("0 = frictionless, typical 0.2–0.8"),
    restitution: num("0 = no bounce, 1 = perfectly elastic"),
    color: str("Hex colour like #ff6b4a, or '' for automatic."),
  }),
  placement: obj(
    {
      kind: str("Placement helper.", { enum: ["none", "on_ground", "on_ramp", "on_top_of", "pendulum"] }),
      target_id: str("on_ramp: the ramp id; on_top_of: the supporting object id; otherwise ''."),
      distance_from_top: num("on_ramp: metres down the slope from the ramp's top edge to the contact point; else 0."),
      lateral_offset: num("on_ramp: sideways offset across the ramp width (m); else 0."),
      anchor: vec3("pendulum: pivot point; else [0,0,0]."),
      length: num("pendulum: pivot-to-centre length (m); else 0."),
      angle: num("pendulum: release angle from vertical in degrees (positive swings toward +x); else 0."),
    },
    "Prefer placement helpers over hand-computed coordinates.",
  ),
  hollow: bool("Hollow sphere / thin-walled tube (hoop) instead of solid."),
});

const wireLink = obj({
  id: str(),
  type: str("rod = rigid fixed-length link; spring = Hooke's-law spring.", { enum: ["rod", "spring"] }),
  object_a: str("Object id."),
  object_b: str("Second object id, or '' to attach object_a to the fixed anchor point."),
  anchor: vec3("Fixed world point when object_b is ''; else [0,0,0]."),
  length: num("Rod length / spring rest length (m). 0 = use the initial distance."),
  stiffness: num("Spring constant k (N/m); 0 for rods."),
  damping: num("Spring damping (N·s/m); 0 for none."),
});

const wireForce = obj({
  id: str(),
  type: str("Extra forces only — gravity, normal, friction and tension are automatic.", {
    enum: ["applied_force", "impulse", "drag", "mutual_gravity"],
  }),
  magnitude: num("applied_force: N; impulse: N·s; drag: coefficient (linear b in N·s/m or quadratic c in N·s²/m²); mutual_gravity: G (use 6.674e-11)."),
  direction: vec3("Direction (normalised automatically). Use [0,0,0] for drag and mutual_gravity."),
  applies_to: arr({ type: "string" }, "Object ids ([] = all moving objects)."),
  start_time: num("s"),
  end_time: num("s, or -1 for 'until the end'."),
  drag_model: str("For drag forces; 'linear' otherwise.", { enum: ["linear", "quadratic"] }),
});

const wireContact = obj({
  object_a: str(),
  object_b: str("Object id or 'ground'."),
  friction: num("Coefficient for this pair."),
  restitution: num("Coefficient for this pair."),
});

const wireScenario = obj({
  name: str("Short scenario title."),
  description: str("The user's description (or your restatement)."),
  environment: obj({
    gravity: num("m/s² (9.81 Earth, 1.62 Moon, 3.71 Mars, 0 in space)."),
    simulation_duration: num("Seconds to simulate (1–120). Long enough to see the key event plus ~1 s."),
    time_scale: num("Suggested playback speed; 1 = real time."),
    ground: bool("Infinite floor at y = 0. false for space / hanging scenes that shouldn't hit a floor."),
    ground_friction: num("Floor friction, or -1 to let each object's own coefficient decide."),
    ground_restitution: num("Floor restitution, or -1 to let each object's own coefficient decide."),
    air_resistance: bool("Quadratic air drag on every moving object."),
    air_density: num("kg/m³ (1.225 at sea level)."),
  }),
  objects: arr(wireObject),
  links: arr(wireLink),
  forces: arr(wireForce),
  contacts: arr(wireContact, "Pair-specific coefficients; usually empty."),
  expected_outcome: str("Your prediction of what happens, with numbers."),
  physics_notes: str("The physics behind it, in plain language."),
});

const wireVariation = obj({
  label: str("Button text, e.g. 'Double the mass'."),
  description: str("One sentence on what it demonstrates."),
  changes: arr(
    obj({
      path: str("Dotted path: environment.gravity, objects.<id>.mass, objects.<id>.material.friction_coefficient, objects.<id>.dimensions.angle, objects.<id>.placement.length, objects.<id>.placement.angle, objects.<id>.velocity.0, links.<id>.stiffness, forces.<id>.magnitude …"),
      value: num("New numeric value."),
    }),
  ),
});

export const INTERPRET_SCHEMA: Json = obj({
  status: str("'ready' if the scenario can run; 'needs_clarification' only if it cannot sensibly run without answers.", {
    enum: ["ready", "needs_clarification"],
  }),
  reply: str("One or two conversational sentences for the chat."),
  interpretation: obj({
    summary: str("One-paragraph restatement of the setup."),
    objects: arr(obj({ name: str(), details: str("Properties and initial conditions.") })),
    forces: arr(obj({ name: str(), details: str() })),
    calculations: arr(obj({ label: str(), expression: str("Worked formula with numbers substituted."), result: str("Value with units.") })),
    assumptions: arr(str()),
    questions: arr(obj({ question: str(), options: arr(str(), "2–4 short replies the user can click, phrased as their answer.") })),
    expected_outcome: str(),
    physics_notes: str(),
  }),
  scenario: wireScenario,
  suggested_variations: arr(wireVariation),
});

export const EXPLAIN_SCHEMA: Json = obj({
  explanation: str("2–4 sentences explaining what changed and why, citing numbers."),
  key_points: arr(str(), "3–6 short bullet points."),
  suggestions: arr(wireVariation, "1–3 next experiments."),
});

// ---------------------------------------------------------------------------------------------

type Loose = Record<string, unknown>;
const isObj = (v: unknown): v is Loose => !!v && typeof v === "object" && !Array.isArray(v);

/** Map the sentinel-based wire scenario to canonical scenario input (still loose; parse afterwards). */
export function wireToScenarioInput(wire: unknown): unknown {
  if (!isObj(wire)) return wire;
  const w = { ...wire };
  const env = isObj(w.environment) ? { ...w.environment } : {};
  if (typeof env.ground_friction === "number" && env.ground_friction < 0) delete env.ground_friction;
  if (typeof env.ground_restitution === "number" && env.ground_restitution < 0) delete env.ground_restitution;

  const objects = Array.isArray(w.objects)
    ? w.objects.map((o) => {
        if (!isObj(o)) return o;
        const out: Loose = { ...o };
        if (out.is_static === true && out.mass === 0) out.mass = null;
        if (isObj(out.placement)) {
          const p: Loose = { ...out.placement };
          if (p.kind === "none") delete out.placement;
          else {
            if (p.target_id === "") delete p.target_id;
            if (p.kind !== "on_ramp") {
              delete p.distance_from_top;
              delete p.lateral_offset;
            }
            if (p.kind !== "pendulum") {
              delete p.anchor;
              delete p.length;
              delete p.angle;
            }
            out.placement = p;
          }
        }
        if (isObj(out.material) && out.material.color === "") {
          out.material = { ...out.material };
          delete (out.material as Loose).color;
        }
        return out;
      })
    : [];

  const links = Array.isArray(w.links)
    ? w.links.map((l) => {
        if (!isObj(l)) return l;
        const out: Loose = { ...l };
        if (out.object_b === "") {
          delete out.object_b;
        } else delete out.anchor;
        if (out.length === 0) delete out.length;
        if (out.type === "rod") {
          delete out.stiffness;
          delete out.damping;
        }
        return out;
      })
    : [];

  const forces = Array.isArray(w.forces)
    ? w.forces.map((f) => {
        if (!isObj(f)) return f;
        const out: Loose = { ...f };
        if (typeof out.end_time === "number" && out.end_time < 0) out.end_time = null;
        return out;
      })
    : [];

  const contacts = Array.isArray(w.contacts) ? w.contacts : [];
  return {
    metadata: { name: w.name, description: w.description, source: "ai" },
    environment: env,
    objects,
    links,
    forces,
    contacts,
    expected_outcome: w.expected_outcome ?? "",
    physics_notes: w.physics_notes ?? "",
  };
}

/** Canonical scenario → wire format (so the model can edit the current scenario in its own format). */
export function scenarioToWire(s: {
  metadata: { name: string; description: string };
  environment: Loose;
  objects: Loose[];
  links: Loose[];
  forces: Loose[];
  contacts: Loose[];
  expected_outcome: string;
  physics_notes: string;
}): Loose {
  const env = s.environment;
  return {
    name: s.metadata.name,
    description: s.metadata.description,
    environment: {
      gravity: env.gravity,
      simulation_duration: env.simulation_duration,
      time_scale: env.time_scale,
      ground: env.ground,
      ground_friction: env.ground_friction ?? -1,
      ground_restitution: env.ground_restitution ?? -1,
      air_resistance: env.air_resistance,
      air_density: env.air_density,
    },
    objects: s.objects.map((o) => {
      const d = (o.dimensions ?? {}) as Loose;
      const m = (o.material ?? {}) as Loose;
      const p = (o.placement ?? { kind: "none" }) as Loose;
      return {
        id: o.id,
        label: o.label ?? o.id,
        type: o.type,
        mass: o.mass ?? 0,
        is_static: o.is_static || o.mass === null || o.type === "ramp",
        position: o.position,
        velocity: o.velocity,
        rotation: o.rotation,
        angular_velocity: o.angular_velocity,
        dimensions: {
          radius: d.radius ?? 0,
          width: d.width ?? 0,
          height: d.height ?? 0,
          depth: d.depth ?? 0,
          length: d.length ?? 0,
          angle: d.angle ?? 0,
        },
        material: { name: m.name ?? "custom", friction_coefficient: m.friction_coefficient, restitution: m.restitution, color: m.color ?? "" },
        placement: {
          kind: p.kind ?? "none",
          target_id: p.target_id ?? "",
          distance_from_top: p.distance_from_top ?? 0,
          lateral_offset: p.lateral_offset ?? 0,
          anchor: p.anchor ?? [0, 0, 0],
          length: p.length ?? 0,
          angle: p.angle ?? 0,
        },
        hollow: !!o.hollow,
      };
    }),
    links: s.links.map((l) => ({
      id: l.id,
      type: l.type,
      object_a: l.object_a,
      object_b: l.object_b ?? "",
      anchor: l.anchor ?? [0, 0, 0],
      length: l.length ?? 0,
      stiffness: l.stiffness ?? 0,
      damping: l.damping ?? 0,
    })),
    forces: s.forces.map((f) => ({
      id: f.id,
      type: f.type,
      magnitude: f.magnitude,
      direction: f.direction,
      applies_to: f.applies_to,
      start_time: f.start_time,
      end_time: f.end_time ?? -1,
      drag_model: f.drag_model ?? "linear",
    })),
    contacts: s.contacts.map((c) => ({ object_a: c.object_a, object_b: c.object_b, friction: c.friction ?? 0.5, restitution: c.restitution ?? 0.3 })),
    expected_outcome: s.expected_outcome,
    physics_notes: s.physics_notes,
  };
}
