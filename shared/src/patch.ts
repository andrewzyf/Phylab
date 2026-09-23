import { parseScenario, type Scenario } from "./schema";

/**
 * A single parameter change, addressed by a dotted path. Entity collections are addressed by id:
 *   "environment.gravity", "objects.ball_1.mass", "objects.ball_1.material.friction_coefficient",
 *   "objects.ball_1.velocity.0", "forces.push.magnitude", "links.spring_1.stiffness".
 */
export interface Change {
  path: string;
  value: unknown;
}

const ENTITY_COLLECTIONS = new Set(["objects", "forces", "links"]);

type Container = Record<string, unknown> | unknown[];

function step(container: unknown, key: string, collection: string | null): unknown {
  if (Array.isArray(container)) {
    if (collection && ENTITY_COLLECTIONS.has(collection)) {
      return container.find((e) => (e as { id?: string })?.id === key);
    }
    const i = Number(key);
    return Number.isInteger(i) ? container[i] : undefined;
  }
  if (container && typeof container === "object") return (container as Record<string, unknown>)[key];
  return undefined;
}

export function getPath(scenario: unknown, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = scenario;
  let prev: string | null = null;
  for (const p of parts) {
    cur = step(cur, p, prev);
    prev = p;
    if (cur === undefined) return undefined;
  }
  return cur;
}

function setIn(root: unknown, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur: unknown = root;
  let prev: string | null = null;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    let next = step(cur, p, prev);
    if (next === undefined || next === null) {
      if (Array.isArray(cur)) throw new Error(`Path "${path}": no entry "${p}".`);
      if (!cur || typeof cur !== "object") throw new Error(`Path "${path}" is not valid.`);
      next = /^\d+$/.test(parts[i + 1]) ? [] : {};
      (cur as Record<string, unknown>)[p] = next;
    }
    prev = p;
    cur = next;
  }
  const last = parts[parts.length - 1];
  if (Array.isArray(cur)) {
    const idx = Number(last);
    if (!Number.isInteger(idx)) throw new Error(`Path "${path}": expected an index.`);
    (cur as unknown[])[idx] = value;
  } else if (cur && typeof cur === "object") {
    (cur as Record<string, unknown>)[last] = value;
  } else throw new Error(`Path "${path}" is not valid.`);
}

/** Apply changes immutably. Throws if a path is invalid or the result is not a valid scenario. */
export function applyChanges(scenario: Scenario, changes: Change[]): Scenario {
  const draft = structuredClone(scenario) as unknown as Container;
  for (const c of changes) setIn(draft, c.path, c.value);
  const parsed = parseScenario(draft);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.scenario;
}

/** List leaf differences (numbers, booleans, strings) between two scenarios, addressed by path. */
export function diffScenarios(a: Scenario, b: Scenario): { path: string; from: unknown; to: unknown }[] {
  const out: { path: string; from: unknown; to: unknown }[] = [];
  const walk = (x: unknown, y: unknown, path: string, collection: string | null) => {
    if (Array.isArray(x) && Array.isArray(y) && collection && ENTITY_COLLECTIONS.has(collection)) {
      const ids = new Set([...x, ...y].map((e) => (e as { id: string }).id));
      for (const id of ids) {
        const ex = x.find((e) => (e as { id: string }).id === id);
        const ey = y.find((e) => (e as { id: string }).id === id);
        if (!ex || !ey) out.push({ path: `${path}.${id}`, from: ex ? "present" : "absent", to: ey ? "present" : "absent" });
        else walk(ex, ey, `${path}.${id}`, null);
      }
      return;
    }
    if (x && y && typeof x === "object" && typeof y === "object") {
      const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
      for (const k of keys) {
        const key = path ? `${path}.${k}` : k;
        walk((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k], key, k);
      }
      return;
    }
    if (x !== y && !(Number.isNaN(x) && Number.isNaN(y))) out.push({ path, from: x, to: y });
  };
  walk(a, b, "", null);
  return out.filter((d) => !d.path.startsWith("metadata."));
}
