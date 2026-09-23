import { DEFAULT_DIMENSIONS, MATERIALS, PALETTE, RAMP_COLOR, STATIC_COLOR } from "./constants";
import {
  boundingRadius,
  inertiaOf,
  rampGeometry,
  supportDepth,
  topHeight,
  volumeOf,
  type ResolvedDims,
} from "./geometry";
import { DEG, G_NEWTON, quat, vec, type Quat, type Vec3 } from "./math";
import {
  isStatic,
  type ContactOverride,
  type LinkType,
  type ObjectType,
  type Placement,
  type Scenario,
  type SimObject,
  type SupportedForceType,
} from "./schema";

export interface ResolvedObject {
  id: string;
  label: string;
  type: ObjectType;
  dynamic: boolean;
  /** Engine mass (0 for static bodies). */
  mass: number;
  /** Mass as specified by the scenario (used for gravitation between bodies, even static ones). */
  physicalMass: number;
  massFromDensity: boolean;
  position: Vec3;
  quaternion: Quat;
  velocity: Vec3;
  angularVelocity: Vec3;
  dims: ResolvedDims;
  hollow: boolean;
  inertia: Vec3;
  friction: number;
  restitution: number;
  color: string;
  materialName: string;
  placement?: Placement;
}

export interface ResolvedLink {
  id: string;
  type: LinkType;
  a: string;
  /** null → attached to the fixed world point `anchor`. */
  b: string | null;
  anchor: Vec3;
  length: number;
  stiffness: number;
  damping: number;
  /** Created automatically from a pendulum placement. */
  implicit: boolean;
}

export interface ResolvedForce {
  id: string;
  type: SupportedForceType | "unsupported";
  rawType: string;
  magnitude: number;
  direction: Vec3;
  appliesTo: string[];
  start: number;
  end: number;
  dragModel: "linear" | "quadratic";
  /** True when this entry just restates the environment gravity (ignored by the engine). */
  redundant: boolean;
}

export interface ResolvedEnvironment {
  gravity: number;
  gravityDir: Vec3;
  gravityVec: Vec3;
  duration: number;
  timeScale: number;
  ground: boolean;
  groundFriction?: number;
  groundRestitution?: number;
  airResistance: boolean;
  airDensity: number;
}

export interface ResolvedScenario {
  source: Scenario;
  environment: ResolvedEnvironment;
  objects: ResolvedObject[];
  links: ResolvedLink[];
  forces: ResolvedForce[];
  contacts: ContactOverride[];
  /** Human-readable notes about how helpers were interpreted. */
  notes: string[];
  /** Things the resolver could not honour (unknown ids, cycles...). Validation surfaces these. */
  problems: string[];
}

/** Gap left between resting objects and their support to avoid starting in penetration. */
export const REST_GAP = 5e-4;

function resolveDims(o: SimObject): ResolvedDims {
  const def = DEFAULT_DIMENSIONS[o.type];
  const d = o.dimensions ?? {};
  const pick = (v: number | undefined, fallback: number) => (v !== undefined && v !== 0 ? v : fallback);
  return {
    radius: pick(d.radius, def.radius),
    width: pick(d.width, def.width),
    height: pick(d.height, def.height),
    depth: pick(d.depth, def.depth),
    length: pick(d.length, def.length),
    angle: d.angle !== undefined && (o.type !== "ramp" || d.angle !== 0) ? d.angle : def.angle,
  };
}

function resolveMaterialDensity(o: SimObject): number | undefined {
  if (o.material.density !== undefined) return o.material.density;
  return MATERIALS[o.material.name]?.density;
}

/**
 * Turn a (validated-shape) scenario into concrete engine inputs: default dimensions, derived masses,
 * placement helpers → coordinates, pendulum rods, normalised forces. Pure and deterministic.
 */
export function resolveScenario(scenario: Scenario): ResolvedScenario {
  const notes: string[] = [];
  const problems: string[] = [];
  const env = scenario.environment;
  const dirLen = vec.len(env.gravity_direction);
  const gravityDir: Vec3 = dirLen > 1e-9 ? vec.norm(env.gravity_direction) : [0, -1, 0];
  const environment: ResolvedEnvironment = {
    gravity: env.gravity,
    gravityDir,
    gravityVec: vec.scale(gravityDir, env.gravity),
    duration: env.simulation_duration,
    timeScale: env.time_scale > 0 ? env.time_scale : 1,
    ground: env.ground,
    groundFriction: env.ground_friction,
    groundRestitution: env.ground_restitution,
    airResistance: env.air_resistance,
    airDensity: env.air_density,
  };

  const byId = new Map<string, SimObject>();
  for (const o of scenario.objects) byId.set(o.id, o);

  // --- first pass: intrinsic properties -------------------------------------------------------
  const base = new Map<string, ResolvedObject>();
  let paletteIndex = 0;
  for (const o of scenario.objects) {
    const dims = resolveDims(o);
    const stat = isStatic(o);
    let physicalMass: number;
    let massFromDensity = false;
    if (typeof o.mass === "number") physicalMass = o.mass;
    else if (o.mass === null) physicalMass = 0;
    else {
      const density = resolveMaterialDensity(o);
      if (density !== undefined && !stat) {
        physicalMass = density * volumeOf(o.type, dims, o.hollow);
        massFromDensity = true;
      } else physicalMass = stat ? 0 : 1;
    }
    const engineMass = stat ? 0 : physicalMass > 0 ? physicalMass : 1;
    let color = o.material.color;
    if (!color) color = stat ? (o.type === "ramp" ? RAMP_COLOR : STATIC_COLOR) : PALETTE[paletteIndex++ % PALETTE.length];
    else if (!stat) paletteIndex++;
    base.set(o.id, {
      id: o.id,
      label: o.label || o.id,
      type: o.type,
      dynamic: !stat,
      mass: engineMass,
      physicalMass,
      massFromDensity,
      position: [...o.position] as Vec3,
      quaternion: quat.fromEulerDeg(o.rotation),
      velocity: stat ? [0, 0, 0] : ([...o.velocity] as Vec3),
      angularVelocity: stat ? [0, 0, 0] : ([...o.angular_velocity] as Vec3),
      dims,
      hollow: o.hollow,
      inertia: inertiaOf(o.type, engineMass || 1, dims, o.hollow),
      friction: o.material.friction_coefficient,
      restitution: o.material.restitution,
      color,
      materialName: o.material.name,
      placement: o.placement,
    });
  }

  // --- second pass: placement helpers (resolved in dependency order) ---------------------------
  const done = new Set<string>();
  const visiting = new Set<string>();
  const implicitLinks: ResolvedLink[] = [];

  const place = (id: string): void => {
    if (done.has(id)) return;
    const r = base.get(id)!;
    const p = r.placement;
    if (!p || p.kind === "none") {
      done.add(id);
      return;
    }
    if (visiting.has(id)) {
      problems.push(`Placement of "${id}" is circular (it depends on itself).`);
      done.add(id);
      return;
    }
    visiting.add(id);
    const q0 = r.quaternion;

    switch (p.kind) {
      case "on_ground": {
        r.position = [r.position[0], supportDepth(r.type, r.dims, q0) + REST_GAP, r.position[2]];
        break;
      }
      case "on_top_of": {
        const t = p.target_id ? base.get(p.target_id) : undefined;
        if (!t) {
          problems.push(`"${id}" should sit on top of "${p.target_id ?? "?"}", but that object doesn't exist.`);
          break;
        }
        place(t.id);
        if (t.type === "ramp") {
          problems.push(`"${id}" uses on_top_of with a ramp — use on_ramp instead.`);
          break;
        }
        const [x0, , z0] = r.position;
        const useTargetXZ = x0 === 0 && z0 === 0;
        const y = t.position[1] + topHeight(t.type, t.dims, t.quaternion) + supportDepth(r.type, r.dims, q0) + REST_GAP;
        r.position = [useTargetXZ ? t.position[0] : x0, y, useTargetXZ ? t.position[2] : z0];
        break;
      }
      case "on_ramp": {
        const ramp = p.target_id ? base.get(p.target_id) : [...base.values()].find((o) => o.type === "ramp");
        if (!ramp || ramp.type !== "ramp") {
          problems.push(`"${id}" should be placed on ramp "${p.target_id ?? "?"}", but no such ramp exists.`);
          break;
        }
        place(ramp.id);
        const g = rampGeometry(ramp.dims);
        const size = boundingRadius(r.type, r.dims);
        const defaultS = Math.min(size + 0.02, ramp.dims.length / 2);
        let s = p.distance_from_top ?? defaultS;
        if (s < 0 || s > ramp.dims.length) {
          problems.push(
            `"${id}" is placed ${s} m from the top of "${ramp.id}", which is off the ramp (length ${ramp.dims.length} m).`,
          );
          s = Math.min(Math.max(s, 0), ramp.dims.length);
        }
        const lateral = p.lateral_offset ?? 0;
        const tilt = quat.fromAxisAngle([0, 0, 1], -g.theta);
        const local = r.type === "cylinder" ? quat.mul(tilt, quat.fromAxisAngle([1, 0, 0], Math.PI / 2)) : tilt;
        const offset =
          r.type === "sphere" || r.type === "cylinder" ? r.dims.radius : r.dims.height / 2; // box/plate lie flat
        const contact = vec.add(vec.add(g.top, vec.scale(g.downSlope, s)), [0, 0, lateral]);
        const centreLocal = vec.add(contact, vec.scale(g.normal, offset + REST_GAP));
        r.position = vec.add(ramp.position, quat.rotate(ramp.quaternion, centreLocal));
        r.quaternion = quat.mul(ramp.quaternion, local);
        break;
      }
      case "pendulum": {
        const anchor = p.anchor ?? ([r.position[0], r.position[1] + (p.length ?? 1), r.position[2]] as Vec3);
        const length = p.length && p.length > 0 ? p.length : Math.max(vec.dist(anchor, r.position), 0.1);
        const angle = (p.angle ?? 0) * DEG;
        // Swing in the plane containing gravity and +x.
        const down = gravityDir;
        const side = vec.norm(vec.sub([1, 0, 0], vec.scale(down, vec.dot([1, 0, 0], down))));
        const sideDir: Vec3 = vec.len(side) > 0.5 ? side : [0, 0, 1];
        r.position = vec.add(
          anchor,
          vec.add(vec.scale(down, length * Math.cos(angle)), vec.scale(sideDir, length * Math.sin(angle))),
        );
        const hasLink = scenario.links.some((l) => l.object_a === id && !l.object_b);
        if (!hasLink) {
          implicitLinks.push({
            id: `${id}_rod`,
            type: "rod",
            a: id,
            b: null,
            anchor,
            length,
            stiffness: 0,
            damping: 0,
            implicit: true,
          });
        }
        break;
      }
    }
    visiting.delete(id);
    done.add(id);
  };
  for (const o of scenario.objects) place(o.id);

  const objects = scenario.objects.map((o) => base.get(o.id)!);

  // --- links ---------------------------------------------------------------------------------
  const links: ResolvedLink[] = [...implicitLinks];
  for (const l of scenario.links) {
    const a = base.get(l.object_a);
    const b = l.object_b ? base.get(l.object_b) : undefined;
    if (!a) {
      problems.push(`Link "${l.id}" refers to unknown object "${l.object_a}".`);
      continue;
    }
    if (l.object_b && !b) {
      problems.push(`Link "${l.id}" refers to unknown object "${l.object_b}".`);
      continue;
    }
    if (!b && !l.anchor) {
      problems.push(`Link "${l.id}" needs either object_b or a fixed anchor point.`);
      continue;
    }
    const anchor: Vec3 = b ? [...b.position] as Vec3 : ([...l.anchor!] as Vec3);
    const currentDistance = vec.dist(a.position, anchor);
    let length = l.length && l.length > 0 ? l.length : currentDistance;
    if (l.type === "rod") {
      if (currentDistance < 1e-6) {
        problems.push(`Rod "${l.id}" has zero length — its ends are at the same point.`);
        continue;
      }
      if (Math.abs(length - currentDistance) > 0.01 * Math.max(length, 1e-3)) {
        if (!b && a.dynamic && !a.placement) {
          // Honour the stated length: slide the object along the anchor→object line.
          const dir = vec.norm(vec.sub(a.position, anchor));
          a.position = vec.add(anchor, vec.scale(dir, length));
          notes.push(`Moved "${a.id}" so rod "${l.id}" has its stated length of ${length} m.`);
        } else {
          notes.push(
            `Rod "${l.id}" is ${length} m long but its ends start ${currentDistance.toFixed(3)} m apart; using the actual distance.`,
          );
          length = currentDistance;
        }
      }
    }
    let stiffness = l.stiffness ?? 0;
    if (l.type === "spring" && !(stiffness > 0)) {
      stiffness = 20;
      notes.push(`Spring "${l.id}" had no stiffness; assumed k = 20 N/m.`);
    }
    links.push({
      id: l.id,
      type: l.type,
      a: l.object_a,
      b: l.object_b ?? null,
      anchor,
      length,
      stiffness,
      damping: l.damping ?? 0,
      implicit: false,
    });
  }

  // --- forces --------------------------------------------------------------------------------
  const dynamicIds = objects.filter((o) => o.dynamic).map((o) => o.id);
  const forces: ResolvedForce[] = [];
  for (const f of scenario.forces) {
    const known = ["applied_force", "impulse", "drag", "mutual_gravity", "gravity"].includes(f.type);
    const type = (known ? f.type : "unsupported") as ResolvedForce["type"];
    const unknownTargets = f.applies_to.filter((id) => !base.has(id));
    for (const u of unknownTargets) problems.push(`Force "${f.id}" applies to unknown object "${u}".`);
    let appliesTo = f.applies_to.filter((id) => base.has(id));
    if (appliesTo.length === 0) {
      appliesTo =
        type === "mutual_gravity" ? objects.filter((o) => o.physicalMass > 0 || o.dynamic).map((o) => o.id) : dynamicIds;
    }
    let magnitude = f.magnitude;
    if (type === "mutual_gravity" && !(magnitude > 0)) magnitude = G_NEWTON;
    const direction = vec.norm(f.direction);
    let redundant = false;
    if (type === "gravity") {
      const sameDir = vec.dot(direction, gravityDir) > 0.999 || vec.len(f.direction) < 1e-9;
      const sameMag = Math.abs(magnitude - env.gravity) < 1e-6 || magnitude === 0;
      redundant = sameDir && sameMag && f.applies_to.length === 0;
      if (redundant) notes.push(`Force "${f.id}" restates the environment gravity; it is applied once, not twice.`);
    }
    if (!known) notes.push(`Force type "${f.type}" is not supported yet and is ignored.`);
    forces.push({
      id: f.id,
      type,
      rawType: f.type,
      magnitude,
      direction: type === "gravity" && vec.len(f.direction) < 1e-9 ? gravityDir : direction,
      appliesTo,
      start: f.start_time,
      end: f.end_time === null || f.end_time === undefined ? Number.POSITIVE_INFINITY : f.end_time,
      dragModel: f.drag_model ?? "linear",
      redundant,
    });
  }

  return { source: scenario, environment, objects, links, forces, contacts: scenario.contacts, notes, problems };
}

export const GROUND_ID = "ground";

/**
 * Effective friction/restitution for a contact. Rule: an explicit pair override wins; otherwise the
 * SMALLER of the two surfaces' values is used (so "frictionless" on either surface makes the contact
 * frictionless, and a "perfectly inelastic" object never bounces). The ground defers to the object
 * unless the environment specifies ground coefficients.
 */
export function contactCoefficients(
  rs: Pick<ResolvedScenario, "objects" | "contacts" | "environment">,
  idA: string,
  idB: string,
): { friction: number; restitution: number } {
  const override = rs.contacts.find(
    (c) => (c.object_a === idA && c.object_b === idB) || (c.object_a === idB && c.object_b === idA),
  );
  const coeff = (id: string) => {
    if (id === GROUND_ID)
      return {
        friction: rs.environment.groundFriction ?? Number.POSITIVE_INFINITY,
        restitution: rs.environment.groundRestitution ?? Number.POSITIVE_INFINITY,
      };
    const o = rs.objects.find((x) => x.id === id);
    return { friction: o?.friction ?? 0.5, restitution: o?.restitution ?? 0.3 };
  };
  const a = coeff(idA);
  const b = coeff(idB);
  let friction = Math.min(a.friction, b.friction);
  let restitution = Math.min(a.restitution, b.restitution);
  if (!Number.isFinite(friction)) friction = 0.5;
  if (!Number.isFinite(restitution)) restitution = 0.3;
  if (override?.friction !== undefined) friction = override.friction;
  if (override?.restitution !== undefined) restitution = override.restitution;
  return { friction: Math.max(0, friction), restitution: Math.min(Math.max(0, restitution), 1.5) };
}
