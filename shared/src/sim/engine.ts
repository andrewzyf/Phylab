import * as CANNON from "cannon-es";
import { DRAG_COEFFICIENTS } from "../constants";
import { boundingRadius, frontalArea, rampGeometry, type ResolvedDims } from "../geometry";
import { vec, type Vec3 } from "../math";
import {
  contactCoefficients,
  GROUND_ID,
  type ResolvedObject,
  type ResolvedScenario,
} from "../resolve";
import type { ObjectType } from "../schema";

const CYLINDER_SEGMENTS = 48;

/**
 * Cylinders are 48-sided prisms in cannon-es, so rolling on their side would bump over every facet.
 * When the cylinder is at least as long as its diameter we add spheres of the same radius along the
 * axis: they give a perfectly round rolling surface, while the flat end caps still come from the
 * prism (the spheres end flush with the caps, so standing upright is unaffected).
 */
function rollingSpheres(d: ResolvedDims): CANNON.Vec3[] {
  if (d.height < 2 * d.radius * 0.999) return [];
  const span = d.height - 2 * d.radius;
  const count = Math.max(1, Math.ceil(span / d.radius) + 1);
  const out: CANNON.Vec3[] = [];
  for (let i = 0; i < count; i++) {
    const y = count === 1 ? 0 : -span / 2 + (span * i) / (count - 1);
    out.push(new CANNON.Vec3(0, y, 0));
  }
  return out;
}

function makeShape(type: ObjectType, d: ResolvedDims): { shape: CANNON.Shape; offset?: CANNON.Vec3 } {
  switch (type) {
    case "sphere":
      return { shape: new CANNON.Sphere(d.radius) };
    case "box":
    case "plate":
      return { shape: new CANNON.Box(new CANNON.Vec3(d.width / 2, d.height / 2, d.depth / 2)) };
    case "cylinder": {
      // With rolling spheres present, shrink the prism slightly so only the round spheres touch
      // when the cylinder lies on its side.
      const r = rollingSpheres(d).length ? d.radius * 0.99 : d.radius;
      return { shape: new CANNON.Cylinder(r, r, d.height, CYLINDER_SEGMENTS) };
    }
    case "ramp": {
      const g = rampGeometry(d);
      // cannon's convex algorithms want the origin inside the hull: express vertices relative to the
      // centroid and offset the shape back to the footprint origin.
      const vertices = g.vertices.map((v) => new CANNON.Vec3(v[0] - g.centroid[0], v[1] - g.centroid[1], v[2] - g.centroid[2]));
      const shape = new CANNON.ConvexPolyhedron({ vertices, faces: g.faces });
      return { shape, offset: new CANNON.Vec3(...g.centroid) };
    }
  }
}


interface TaggedFriction extends CANNON.FrictionEquation {
  _pairKey?: string;
  _mu?: number;
  /** |g · n| for the contact that created this equation (first-step normal-force estimate). */
  _gn?: number;
  _contact?: CANNON.ContactEquation;
  /** 0 = first tangent, 1 = second tangent of the pair created for one contact point. */
  _slot?: number;
}

/** Approach speeds above this (m/s) are treated as impacts and get the full restitution response. */
const IMPACT_SPEED = 0.2;
/** Cap on the separation speed the solver may add to fix penetration (like PhysX's max depenetration velocity). */
const MAX_DEPENETRATION_SPEED = 0.25;
/** Constraint regularisation relative to the pair's inverse mass (mass-independent stiffness). */
const RELATIVE_EPS = 1e-4;

const tmpA = new CANNON.Vec3();
const tmpB = new CANNON.Vec3();

function relativeVelocity(c: { bi: CANNON.Body; bj: CANNON.Body; ri: CANNON.Vec3; rj: CANNON.Vec3 }, out: CANNON.Vec3) {
  // v_rel = (vj + wj × rj) - (vi + wi × ri)
  c.bj.angularVelocity.cross(c.rj, tmpA);
  tmpA.vadd(c.bj.velocity, tmpA);
  c.bi.angularVelocity.cross(c.ri, tmpB);
  tmpB.vadd(c.bi.velocity, tmpB);
  tmpA.vsub(tmpB, out);
  return out;
}

export interface EngineBody {
  id: string;
  body: CANNON.Body;
  obj: ResolvedObject;
}

/**
 * A cannon-es world built from a resolved scenario, with PhysicsLab's corrections:
 *  - exact principal inertia tensors (cannon approximates every body by its bounding box),
 *  - Coulomb friction bounded by μ·N·dt using the previous step's normal force (cannon bounds the
 *    friction *impulse* by μ·m·g, which makes sliding objects stop several times too early),
 *  - per-pair friction/restitution using PhysicsLab's contact rule,
 *  - zero artificial damping, no sleeping,
 *  - custom forces: applied forces, impulses, drag, springs, mutual gravitation.
 */
export class PhysicsEngine {
  readonly world: CANNON.World;
  readonly bodies: EngineBody[] = [];
  readonly byId = new Map<string, EngineBody>();
  readonly dt: number;
  time = 0;
  private readonly bodyIdOf = new Map<number, string>();
  private readonly pairCache = new Map<string, { friction: number; restitution: number }>();
  private prevNormal = new Map<string, number>();
  private readonly firedImpulses = new Set<string>();
  private readonly anchorBodies: CANNON.Body[] = [];
  readonly contactLog: { t: number; a: string; b: string }[] = [];
  private contactLogLimit = 5000;

  constructor(readonly rs: ResolvedScenario, dt: number) {
    this.dt = dt;
    const world = new CANNON.World();
    world.gravity.set(...rs.environment.gravityVec);
    world.allowSleep = false;
    (world.solver as CANNON.GSSolver).iterations = 30;
    (world.solver as CANNON.GSSolver).tolerance = 1e-9;
    world.broadphase = new CANNON.SAPBroadphase(world);
    world.defaultContactMaterial.friction = 1; // real μ is applied per pair below
    world.defaultContactMaterial.restitution = 0;
    world.dt = dt;
    this.world = world;

    if (rs.environment.ground) {
      const ground = new CANNON.Body({ mass: 0, type: CANNON.Body.STATIC, shape: new CANNON.Plane() });
      ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
      world.addBody(ground);
      this.bodyIdOf.set(ground.id, GROUND_ID);
    }

    for (const o of rs.objects) {
      const body = new CANNON.Body({
        mass: o.dynamic ? o.mass : 0,
        type: o.dynamic ? CANNON.Body.DYNAMIC : CANNON.Body.STATIC,
        linearDamping: 0,
        angularDamping: 0,
        allowSleep: false,
      });
      const { shape, offset } = makeShape(o.type, o.dims);
      body.addShape(shape, offset);
      if (o.type === "cylinder") for (const at of rollingSpheres(o.dims)) body.addShape(new CANNON.Sphere(o.dims.radius), at);
      body.position.set(...o.position);
      body.quaternion.set(...o.quaternion);
      body.velocity.set(...o.velocity);
      body.angularVelocity.set(...o.angularVelocity);
      if (o.dynamic) {
        // Replace cannon's AABB-based inertia estimate with the exact tensor.
        body.inertia.set(...o.inertia);
        body.invInertia.set(1 / o.inertia[0], 1 / o.inertia[1], 1 / o.inertia[2]);
        body.updateInertiaWorld(true);
      }
      body.aabbNeedsUpdate = true;
      world.addBody(body);
      const eb = { id: o.id, body, obj: o };
      this.bodies.push(eb);
      this.byId.set(o.id, eb);
      this.bodyIdOf.set(body.id, o.id);
    }

    for (const l of rs.links) {
      if (l.type !== "rod") continue;
      const a = this.byId.get(l.a);
      if (!a) continue;
      let other: CANNON.Body;
      if (l.b) {
        const b = this.byId.get(l.b);
        if (!b) continue;
        other = b.body;
      } else {
        other = new CANNON.Body({ mass: 0, type: CANNON.Body.STATIC });
        other.position.set(...l.anchor);
        world.addBody(other);
        this.anchorBodies.push(other);
      }
      const c = new CANNON.DistanceConstraint(a.body, other, l.length, 1e12);
      c.collideConnected = false;
      world.addConstraint(c);
    }

    this.installContactModel();
  }

  private pairKey(a: CANNON.Body, b: CANNON.Body): string {
    return a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;
  }

  private coefficients(a: CANNON.Body, b: CANNON.Body) {
    const key = this.pairKey(a, b);
    let c = this.pairCache.get(key);
    if (!c) {
      const ida = this.bodyIdOf.get(a.id);
      const idb = this.bodyIdOf.get(b.id);
      c = ida && idb ? contactCoefficients(this.rs, ida, idb) : { friction: 0, restitution: 0 };
      this.pairCache.set(key, c);
    }
    return c;
  }

  private installContactModel() {
    const world = this.world;
    const np = world.narrowphase;
    const origContact = np.createContactEquation.bind(np);
    np.createContactEquation = (bi, bj, si, sj, oa, ob) => {
      const c = origContact(bi, bj, si, sj, oa, ob);
      c.restitution = this.coefficients(bi, bj).restitution;
      return c;
    };
    const origFriction = np.createFrictionEquationsFromContact.bind(np);
    np.createFrictionEquationsFromContact = (contact, out) => {
      const mu = this.coefficients(contact.bi, contact.bj).friction;
      if (!(mu > 0)) return false;
      const n0 = out.length;
      const ok = origFriction(contact, out);
      if (ok) {
        const key = this.pairKey(contact.bi, contact.bj);
        const gn = Math.abs(world.gravity.dot(contact.ni));
        for (let i = n0; i < out.length; i++) {
          const f = out[i] as TaggedFriction;
          f._pairKey = key;
          f._mu = mu;
          f._gn = gn;
          f._contact = contact;
          f._slot = i - n0;
        }
      }
      return ok;
    };

    // emitContactEvents runs after narrowphase and before the solver: the right moment to correct
    // the contact and friction equations and to log new contacts.
    const origEmit = world.emitContactEvents.bind(world);
    const vrel = new CANNON.Vec3();
    const vt = new CANNON.Vec3();
    world.emitContactEvents = () => {
      const counts = new Map<string, number>();
      const impactDepth = new Map<string, { c: CANNON.ContactEquation; depth: number }>();
      for (const c of world.contacts) {
        const k = this.pairKey(c.bi, c.bj);
        counts.set(k, (counts.get(k) ?? 0) + 1);
        c.eps = RELATIVE_EPS * (c.bi.invMass + c.bj.invMass);
        c.bj.position.vadd(c.rj, tmpA);
        c.bi.position.vadd(c.ri, tmpB);
        tmpA.vsub(tmpB, tmpA); // cannon's vsub/vadd return nothing when given a target
        const depth = -c.ni.dot(tmpA);
        // Impacts: target exactly v_n' = -e·v_n. cannon's soft-contact defaults scale the velocity term
        // by b < 1 and add a penetration push, which makes bounce heights wrong and phase-dependent.
        const approach = relativeVelocity(c, vrel).dot(c.ni);
        if (approach < -IMPACT_SPEED) {
          c.b = 1;
          c.a = 0;
          const prev = impactDepth.get(k);
          if (depth > 0 && (!prev || prev.depth < depth)) impactDepth.set(k, { c, depth });
        } else {
          c.restitution = 0; // resting / slow contacts don't bounce (avoids jitter)
          if (depth > 0 && c.a * depth > MAX_DEPENETRATION_SPEED) c.a = MAX_DEPENETRATION_SPEED / depth;
        }
      }
      // Undo the penetration accumulated during the impact step by moving the bodies apart along the
      // normal (position projection). Correcting it with velocity instead would inject energy.
      for (const { c, depth } of impactDepth.values()) {
        const wi = c.bi.invMass;
        const wj = c.bj.invMass;
        const sum = wi + wj;
        if (sum <= 0) continue;
        c.bj.position.addScaledVector((depth * wj) / sum, c.ni, c.bj.position);
        c.bi.position.addScaledVector((-depth * wi) / sum, c.ni, c.bi.position);
      }
      for (const eq of world.frictionEquations as TaggedFriction[]) {
        if (!eq._pairKey || eq._mu === undefined) continue;
        eq.eps = RELATIVE_EPS * (eq.bi.invMass + eq.bj.invMass);
        const c = eq._contact;
        if (c) {
          // cannon's contact tangents are not unit length on tilted normals (friction scaled by
          // sqrt(1 - n.x^2)) and are fixed in space (anisotropic kinetic friction). Align the first
          // tangent with the sliding direction and keep both normalised.
          const n = c.ni;
          relativeVelocity(c, vrel);
          vrel.vsub(n.scale(vrel.dot(n), tmpA), vt);
          const slide = vt.length();
          if (slide > 1e-6) {
            vt.scale(1 / slide, vt);
          } else {
            n.tangents(vt, tmpB);
            vt.normalize();
          }
          if (eq._slot === 0) eq.t.copy(vt);
          else {
            n.cross(vt, eq.t);
            eq.t.normalize();
          }
        }
        let normal = this.prevNormal.get(eq._pairKey);
        if (normal === undefined) {
          // First step of this contact: estimate N from gravity along the contact normal.
          const invSum = eq.bi.invMass + eq.bj.invMass;
          const mred = invSum > 0 ? 1 / invSum : 0;
          normal = mred * (eq._gn ?? 0);
        }
        const n = counts.get(eq._pairKey) ?? 1;
        const bound = eq._mu * (normal / n) * world.dt;
        eq.maxForce = bound;
        eq.minForce = -bound;
      }
      origEmit();
    };
    world.addEventListener("beginContact", (e: { bodyA: CANNON.Body; bodyB: CANNON.Body }) => {
      if (this.contactLog.length >= this.contactLogLimit) return;
      const a = this.bodyIdOf.get(e.bodyA.id);
      const b = this.bodyIdOf.get(e.bodyB.id);
      // Contacts are detected on the positions at the start of this step, so the touch happened
      // somewhere in the previous step: log its midpoint.
      if (a && b) this.contactLog.push({ t: Math.max(0, this.time - this.dt / 2), a, b });
    });
    world.addEventListener("postStep", () => {
      const next = new Map<string, number>();
      for (const c of world.contacts) {
        const k = this.pairKey(c.bi, c.bj);
        next.set(k, (next.get(k) ?? 0) + Math.max(0, c.multiplier));
      }
      this.prevNormal = next;
    });
  }

  /** Apply scenario forces for the step starting at `this.time`. */
  private applyForces() {
    const t = this.time;
    const rs = this.rs;
    const dt = this.dt;

    const addForce = (eb: EngineBody, f: Vec3) => {
      eb.body.force.x += f[0];
      eb.body.force.y += f[1];
      eb.body.force.z += f[2];
    };
    /** Resistive force limited so it can at most stop the body within one step (no overshoot). */
    const addResistive = (eb: EngineBody, f: Vec3) => {
      const v: Vec3 = [eb.body.velocity.x, eb.body.velocity.y, eb.body.velocity.z];
      const maxF = (eb.obj.mass * vec.len(v)) / dt;
      const fl = vec.len(f);
      addForce(eb, fl > maxF && fl > 0 ? vec.scale(f, maxF / fl) : f);
    };

    for (const f of rs.forces) {
      if (f.type === "unsupported" || f.redundant) continue;
      if (f.type === "impulse") {
        if (t + dt / 2 < f.start || this.firedImpulses.has(f.id)) continue;
        this.firedImpulses.add(f.id);
        for (const id of f.appliesTo) {
          const eb = this.byId.get(id);
          if (!eb?.obj.dynamic) continue;
          const dv = vec.scale(f.direction, f.magnitude / eb.obj.mass);
          eb.body.velocity.x += dv[0];
          eb.body.velocity.y += dv[1];
          eb.body.velocity.z += dv[2];
        }
        continue;
      }
      if (t + dt / 2 < f.start || t + dt / 2 > f.end) continue;
      if (f.type === "applied_force") {
        for (const id of f.appliesTo) {
          const eb = this.byId.get(id);
          if (eb?.obj.dynamic) addForce(eb, vec.scale(f.direction, f.magnitude));
        }
      } else if (f.type === "gravity") {
        for (const id of f.appliesTo) {
          const eb = this.byId.get(id);
          if (eb?.obj.dynamic) addForce(eb, vec.scale(f.direction, f.magnitude * eb.obj.mass));
        }
      } else if (f.type === "drag") {
        for (const id of f.appliesTo) {
          const eb = this.byId.get(id);
          if (!eb?.obj.dynamic) continue;
          const v: Vec3 = [eb.body.velocity.x, eb.body.velocity.y, eb.body.velocity.z];
          const speed = vec.len(v);
          const k = f.dragModel === "quadratic" ? f.magnitude * speed : f.magnitude;
          addResistive(eb, vec.scale(v, -k));
        }
      } else if (f.type === "mutual_gravity") {
        const G = f.magnitude;
        const ids = f.appliesTo;
        for (let i = 0; i < ids.length; i++) {
          for (let j = i + 1; j < ids.length; j++) {
            const a = this.byId.get(ids[i]);
            const b = this.byId.get(ids[j]);
            if (!a || !b) continue;
            const ma = a.obj.physicalMass;
            const mb = b.obj.physicalMass;
            if (!(ma > 0 && mb > 0)) continue;
            const d: Vec3 = [
              b.body.position.x - a.body.position.x,
              b.body.position.y - a.body.position.y,
              b.body.position.z - a.body.position.z,
            ];
            const soft = 0.05 * (boundingRadius(a.obj.type, a.obj.dims) + boundingRadius(b.obj.type, b.obj.dims));
            const r2 = vec.dot(d, d) + soft * soft;
            const fm = (G * ma * mb) / r2;
            const dir = vec.scale(d, 1 / Math.sqrt(r2));
            if (a.obj.dynamic) addForce(a, vec.scale(dir, fm));
            if (b.obj.dynamic) addForce(b, vec.scale(dir, -fm));
          }
        }
      }
    }

    if (rs.environment.airResistance) {
      for (const eb of this.bodies) {
        if (!eb.obj.dynamic) continue;
        const v: Vec3 = [eb.body.velocity.x, eb.body.velocity.y, eb.body.velocity.z];
        const speed = vec.len(v);
        if (speed < 1e-9) continue;
        const k = 0.5 * rs.environment.airDensity * DRAG_COEFFICIENTS[eb.obj.type] * frontalArea(eb.obj.type, eb.obj.dims);
        addResistive(eb, vec.scale(v, -k * speed));
      }
    }

    for (const l of rs.links) {
      if (l.type !== "spring") continue;
      const a = this.byId.get(l.a);
      if (!a) continue;
      const b = l.b ? this.byId.get(l.b) : undefined;
      const pa: Vec3 = [a.body.position.x, a.body.position.y, a.body.position.z];
      const pb: Vec3 = b ? [b.body.position.x, b.body.position.y, b.body.position.z] : l.anchor;
      const d = vec.sub(pb, pa);
      const len = vec.len(d);
      if (len < 1e-9) continue;
      const n = vec.scale(d, 1 / len);
      const va: Vec3 = [a.body.velocity.x, a.body.velocity.y, a.body.velocity.z];
      const vb: Vec3 = b ? [b.body.velocity.x, b.body.velocity.y, b.body.velocity.z] : [0, 0, 0];
      const relSpeed = vec.dot(vec.sub(vb, va), n);
      const magnitude = l.stiffness * (len - l.length) + l.damping * relSpeed; // >0 pulls a toward b
      const fa = vec.scale(n, magnitude);
      if (a.obj.dynamic) addForce(a, fa);
      if (b?.obj.dynamic) addForce(b, vec.scale(fa, -1));
    }
  }

  step() {
    this.applyForces();
    this.world.step(this.dt);
    this.time += this.dt;
  }

  /** Current position of a link's second end (object or anchor). */
  linkEnd(l: { b: string | null; anchor: Vec3 }): Vec3 {
    if (!l.b) return l.anchor;
    const b = this.byId.get(l.b);
    return b ? [b.body.position.x, b.body.position.y, b.body.position.z] : l.anchor;
  }
}
