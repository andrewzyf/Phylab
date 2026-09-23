import { analyzeScenario } from "../analysis/predict";
import { GRAVITY_PRESETS, MATERIALS } from "../constants";
import { SPEED_OF_LIGHT, sig, type Vec3 } from "../math";
import { applyChanges, getPath, type Change } from "../patch";
import { resolveScenario } from "../resolve";
import { makeScenario, type Scenario, type ScenarioInput, type SimObjectInput } from "../schema";
import { validateScenario } from "../validate";
import { describeScenario } from "./describe";
import type { ClarifyingQuestion, InterpretResult, Variation } from "./types";

/*
 * A deterministic, rule-based interpreter used when no AI model is configured (or reachable).
 * It recognises the classic textbook setups and common follow-up edits. It is intentionally
 * conservative: whatever it had to assume is listed, and ambiguities become questions.
 */

type Kind = "sphere" | "box" | "cylinder";

interface CommonObject {
  re: RegExp;
  label: string;
  kind: Kind;
  mass: number;
  dims: { radius?: number; width?: number; height?: number; depth?: number };
  material: string;
  hollow?: boolean;
}

/** Everyday objects with realistic masses and sizes, used when the description names them. */
const COMMON_OBJECTS: CommonObject[] = [
  { re: /bowling balls?/, label: "Bowling ball", kind: "sphere", mass: 7, dims: { radius: 0.109 }, material: "plastic" },
  { re: /tennis balls?/, label: "Tennis ball", kind: "sphere", mass: 0.057, dims: { radius: 0.0335 }, material: "tennis_ball" },
  { re: /basketballs?/, label: "Basketball", kind: "sphere", mass: 0.62, dims: { radius: 0.12 }, material: "basketball", hollow: true },
  { re: /golf balls?/, label: "Golf ball", kind: "sphere", mass: 0.046, dims: { radius: 0.0214 }, material: "rubber" },
  { re: /baseballs?/, label: "Baseball", kind: "sphere", mass: 0.145, dims: { radius: 0.0368 }, material: "plastic" },
  { re: /(?:soccer|foot) ?balls?/, label: "Football", kind: "sphere", mass: 0.43, dims: { radius: 0.11 }, material: "rubber", hollow: true },
  { re: /ping[- ]?pong balls?|table tennis balls?/, label: "Ping-pong ball", kind: "sphere", mass: 0.0027, dims: { radius: 0.02 }, material: "plastic", hollow: true },
  { re: /cannon ?balls?/, label: "Cannonball", kind: "sphere", mass: 5.4, dims: { radius: 0.055 }, material: "iron" },
  { re: /marbles?/, label: "Marble", kind: "sphere", mass: 0.005, dims: { radius: 0.008 }, material: "glass" },
  { re: /watermelons?/, label: "Watermelon", kind: "sphere", mass: 5, dims: { radius: 0.13 }, material: "foam" },
  { re: /apples?/, label: "Apple", kind: "sphere", mass: 0.2, dims: { radius: 0.04 }, material: "wood" },
  { re: /feathers?/, label: "Feather", kind: "box", mass: 0.005, dims: { width: 0.25, height: 0.006, depth: 0.04 }, material: "foam" },
  { re: /hammers?/, label: "Hammer", kind: "box", mass: 1, dims: { width: 0.1, height: 0.1, depth: 0.3 }, material: "steel" },
  { re: /bricks?/, label: "Brick", kind: "box", mass: 2.5, dims: { width: 0.215, height: 0.065, depth: 0.1025 }, material: "concrete" },
  { re: /coins?/, label: "Coin", kind: "cylinder", mass: 0.0075, dims: { radius: 0.012, height: 0.002 }, material: "steel" },
  { re: /soup cans?|tin cans?/, label: "Can", kind: "cylinder", mass: 0.4, dims: { radius: 0.037, height: 0.11 }, material: "aluminum" },
];

export function findCommonObjects(text: string): { obj: CommonObject; index: number }[] {
  const t = text.toLowerCase();
  const out: { obj: CommonObject; index: number }[] = [];
  for (const obj of COMMON_OBJECTS) {
    const m = new RegExp(String.raw`\b${obj.re.source}\b`).exec(t);
    if (m) out.push({ obj, index: m.index });
  }
  // "a baseball" also matches "ball" patterns etc. — keep distinct labels, in order of mention
  return out.sort((a, b) => a.index - b.index).filter((x, i, arr) => arr.findIndex((y) => y.obj.label === x.obj.label) === i);
}

interface Quantity {
  value: number;
  index: number;
  raw: string;
}

const NUM = String.raw`(-?\d+(?:[.,]\d+)?(?:e-?\d+)?)`;
const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, a: 1, an: 1, single: 1, twelve: 12,
};

const toNum = (s: string) => Number.parseFloat(s.replace(",", "."));

function all(re: RegExp, text: string, map: (m: RegExpExecArray) => number | null): Quantity[] {
  const out: Quantity[] = [];
  const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  let m: RegExpExecArray | null;
  while ((m = r.exec(text))) {
    const v = map(m);
    if (v !== null && Number.isFinite(v)) out.push({ value: v, index: m.index, raw: m[0] });
  }
  return out;
}

export interface Extracted {
  masses: Quantity[];
  speeds: Quantity[];
  angles: Quantity[];
  lengths: Quantity[];
  forces: Quantity[];
  springK?: number;
  friction?: number;
  frictionWord?: string;
  restitution?: number;
  gravity?: number;
  gravityName?: string;
  duration?: number;
  forceDuration?: number;
  damping?: number;
  airResistance?: boolean;
  material?: string;
  kind: Kind;
  hollow: boolean;
  count: number;
  fixed: boolean;
}

export function extractQuantities(text: string): Extracted {
  const t = ` ${text.toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ")} `;
  const masses = all(new RegExp(String.raw`${NUM}\s*(kg|kilograms?|kilos?|grams?|g)\b`), t, (m) => {
    const v = toNum(m[1]);
    return /^g|gram/.test(m[2]) ? v / 1000 : v;
  });
  for (const q of all(new RegExp(String.raw`mass(?: of)?\s*(?:=|:|is|of)?\s*${NUM}(?!\s*(?:kg|g\b|kilo|gram))`), t, (m) => toNum(m[1]))) {
    if (!masses.some((x) => Math.abs(x.index - q.index) < 12)) masses.push(q);
  }
  masses.sort((a, b) => a.index - b.index);

  const speeds = all(new RegExp(String.raw`${NUM}\s*(m\/s|meters? per second|metres? per second|km\/h|kph|kilometers? per hour|mph|miles per hour)`), t, (m) => {
    const v = toNum(m[1]);
    if (/km|kph|kilomet/.test(m[2])) return v / 3.6;
    if (/mph|miles/.test(m[2])) return v * 0.44704;
    return v;
  });
  for (const q of all(new RegExp(String.raw`${NUM}\s*c\b|${NUM}\s*%\s*(?:of\s*)?(?:the\s*)?speed of light`), t, (m) =>
    m[1] !== undefined ? toNum(m[1]) * SPEED_OF_LIGHT : (toNum(m[2]) / 100) * SPEED_OF_LIGHT,
  ))
    speeds.push(q);
  if (/speed of light/.test(t) && !speeds.some((s) => s.value >= 0.01 * SPEED_OF_LIGHT)) {
    speeds.push({ value: SPEED_OF_LIGHT, index: t.indexOf("speed of light"), raw: "speed of light" });
  }
  speeds.sort((a, b) => a.index - b.index);

  const angles = all(new RegExp(String.raw`${NUM}\s*(?:°|degrees?|degs?\b)`), t, (m) => toNum(m[1]));
  const lengths = all(new RegExp(String.raw`${NUM}\s*(mm|cm|km|m|meters?|metres?|centimet(?:er|re)s?|millimet(?:er|re)s?|feet|foot|ft)\b(?!\s*(?:\/|per\b))`), t, (m) => {
    const v = toNum(m[1]);
    const u = m[2];
    if (/^cm|centi/.test(u)) return v / 100;
    if (/^mm|milli/.test(u)) return v / 1000;
    if (/^km/.test(u)) return v * 1000;
    if (/^f/.test(u)) return v * 0.3048;
    return v;
  });
  const forces = all(new RegExp(String.raw`${NUM}\s*(n|newtons?)\b(?!\s*\/|·|\*|\s*per)`), t, (m) => toNum(m[1]));

  let springK: number | undefined;
  const k1 = new RegExp(String.raw`\bk\s*(?:=|of|is)\s*${NUM}`).exec(t) ?? new RegExp(String.raw`${NUM}\s*(?:n\/m|newtons? per met)`).exec(t);
  if (k1) springK = toNum(k1[1]);
  const kWords = new RegExp(String.raw`(?:spring constant|stiffness)(?: of)?\s*(?:=|is)?\s*${NUM}`).exec(t);
  if (kWords) springK = toNum(kWords[1]);

  let friction: number | undefined;
  let frictionWord: string | undefined;
  const fr =
    new RegExp(String.raw`(?:coefficient of (?:kinetic |static )?friction|friction coefficient|friction|μ|\bmu\b)\s*(?:=|of|is|:)?\s*${NUM}`).exec(t) ??
    new RegExp(String.raw`${NUM}\s*(?:coefficient of )?friction`).exec(t);
  if (fr) friction = toNum(fr[1]);
  else if (/frictionless|no friction|without friction|smooth|zero friction/.test(t)) {
    friction = 0;
    frictionWord = "frictionless";
  } else if (/\b(icy|on ice|ice rink)\b/.test(t)) {
    friction = 0.05;
    frictionWord = "icy";
  } else if (/\brough\b/.test(t)) {
    friction = 0.6;
    frictionWord = "rough";
  }

  let restitution: number | undefined;
  const re = new RegExp(String.raw`(?:coefficient of restitution|restitution|bounciness|\be)\s*(?:=|of|is|:)?\s*${NUM}`).exec(t);
  if (re) restitution = toNum(re[1]);
  else if (/perfectly inelastic|completely inelastic|stick together|sticks together|clay/.test(t)) restitution = 0;
  else if (/perfectly elastic|elastic collision|\belastic\b(?! band)/.test(t) && !/inelastic/.test(t)) restitution = 1;
  else if (/\binelastic\b/.test(t)) restitution = 0.5;
  else if (/super ?bouncy|very bouncy/.test(t)) restitution = 0.9;
  else if (/bouncy/.test(t)) restitution = 0.8;

  let gravity: number | undefined;
  let gravityName: string | undefined;
  const gm = new RegExp(String.raw`(?:\bg\b|gravity(?: of)?)\s*(?:=|is|of)?\s*${NUM}\s*(?:m\/s)`).exec(t);
  if (gm) gravity = toNum(gm[1]);
  else if (/zero gravity|zero-g|no gravity|weightless|in (?:deep |outer )?space|microgravity/.test(t)) {
    gravity = 0;
    gravityName = "space";
  } else {
    for (const [name, g] of Object.entries(GRAVITY_PRESETS)) {
      if (name === "earth" || name === "space") continue;
      if (new RegExp(String.raw`\b(?:on|at|near)\s+(?:the\s+)?${name}\b|\b${name}(?:'s)? (?:gravity|surface)`).test(t)) {
        gravity = g;
        gravityName = name;
        break;
      }
    }
  }

  let duration: number | undefined;
  const dm = new RegExp(String.raw`(?:simulate|run|for)\s+(?:it\s+)?(?:for\s+)?${NUM}\s*(?:s|secs?|seconds?)\b(?!\s*(?:then|and))`).exec(t);
  let forceDuration: number | undefined;
  const fdm = new RegExp(String.raw`(?:for|during)\s+${NUM}\s*(?:s|secs?|seconds?)\b`).exec(t);
  if (fdm && forces.length) forceDuration = toNum(fdm[1]);
  else if (dm) duration = toNum(dm[1]);

  let damping: number | undefined;
  const dmp = new RegExp(String.raw`damping(?: coefficient)?(?: of)?\s*(?:=|is)?\s*${NUM}`).exec(t);
  if (dmp) damping = toNum(dmp[1]);
  else if (/\bdamped\b|with damping/.test(t)) damping = 0.5;

  let airResistance: boolean | undefined;
  if (/no air resistance|without air resistance|ignore air|in a vacuum|vacuum/.test(t)) airResistance = false;
  else if (/air resistance|air drag|with drag|aerodynamic drag/.test(t)) airResistance = true;

  let material: string | undefined;
  const matAliases: Record<string, string> = { wooden: "wood", metal: "steel", metallic: "steel", "tennis ball": "tennis_ball", "rubber ball": "rubber", marble: "glass", bowling: "stone" };
  for (const [alias, mat] of Object.entries(matAliases)) if (new RegExp(String.raw`\b${alias}\b`).test(t)) material ??= mat;
  for (const name of Object.keys(MATERIALS)) {
    const word = name.replace("_", " ");
    if (name !== "frictionless" && new RegExp(String.raw`\b${word}\b`).test(t)) {
      material = name;
      break;
    }
  }

  let kind: Kind = "sphere";
  let hollow = false;
  const kindMatch = /\b(balls?|spheres?|marbles?|planets?|bobs?|particles?|blocks?|box(?:es)?|cubes?|crates?|bricks?|cylinders?|cans?|wheels?|disks?|discs?|rollers?|logs?|hoops?|rings?|pipes?|tubes?)\b/.exec(t);
  if (kindMatch) {
    const w = kindMatch[1];
    if (/block|box|cube|crate|brick/.test(w)) kind = "box";
    else if (/cylinder|can|wheel|disk|disc|roller|log/.test(w)) kind = "cylinder";
    else if (/hoop|ring|pipe|tube/.test(w)) {
      kind = "cylinder";
      hollow = true;
    }
  }
  if (/hollow|shell|thin-walled|basketball/.test(t)) hollow = true;

  let count = 1;
  const cm = /\b(two|three|four|five|six|seven|eight|nine|ten|twelve|\d+)\s+(?:identical\s+|equal\s+|small\s+|large\s+|big\s+|heavy\s+|light\s+|steel\s+|rubber\s+|wooden\s+)?(balls|spheres|blocks|boxes|cubes|objects|masses|marbles|cylinders|crates)\b/.exec(t);
  if (cm) count = WORD_NUMBERS[cm[1]] ?? (Number.parseInt(cm[1], 10) || 1);

  const fixed = /\b(fixed in place|bolted|nailed|immovable|stuck in place|cannot move|can't move|anchored)\b/.test(t);

  return {
    masses,
    speeds,
    angles,
    lengths,
    forces,
    springK,
    friction,
    frictionWord,
    restitution,
    gravity,
    gravityName,
    duration,
    forceDuration,
    damping,
    airResistance,
    material,
    kind,
    hollow,
    count,
    fixed,
  };
}

/** The length closest after one of the context words (e.g. "cliff", "high", "long"). */
function lengthNear(text: string, lengths: Quantity[], words: RegExp, window = 40): Quantity | undefined {
  const t = text.toLowerCase();
  let best: Quantity | undefined;
  let bestD = Number.POSITIVE_INFINITY;
  const re = new RegExp(words.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    for (const q of lengths) {
      const d = Math.abs(q.index - m.index);
      if (d < window && d < bestD) {
        best = q;
        bestD = d;
      }
    }
  }
  return best;
}

type Archetype = "pendulum" | "spring" | "orbit" | "ramp" | "collision" | "projectile" | "drop" | "slide" | "tower";

function detectArchetype(t: string, x: Extracted): Archetype | null {
  if (/pendulum|\bbob\b|swings? from/.test(t)) return "pendulum";
  if (/spring|oscillat|harmonic|hooke/.test(t) || x.springK !== undefined) return "spring";
  if (/\borbit|satellite|revolv|circles? (?:around|round)|around (?:a|the) (?:star|sun|planet)/.test(t)) return "orbit";
  if (/ramp|incline|slope|inclined plane|\bhill\b|wedge/.test(t)) return "ramp";
  if (/tower|stack of|domino/.test(t)) return "tower";
  if (/collid|collision|\bhits?\b|crash|strikes?|bump(?:s|ed)? into|smash/.test(t) && (x.count >= 2 || x.masses.length >= 2 || x.speeds.length >= 2)) return "collision";
  if (/throw|thrown|launch|fired|fires|kick|shot|shoots|projectile|cannon|tossed|toss|hurl/.test(t)) return "projectile";
  if (/drop|dropped|falls?\b|falling|free ?fall|let go|released? from|bounc/.test(t)) return "drop";
  if (/slid(?:e|es|ing)|push(?:ed|es)?|shove|sliding|pull(?:ed|s)? (?:with|by)|applied force|drag(?:ged)? across/.test(t) || x.forces.length > 0) return "slide";
  if (x.speeds.length > 0) return "projectile";
  return null;
}

const EDIT_HINTS =
  /^(?:now |ok[, ]+|okay[, ]+|what if |try |and |also |then |please )?(?:make|change|set|increase|decrease|double|triple|halve|reduce|raise|lower|add|remove|use|put|move|switch|turn|give|with|without|no |more|less|faster|slower|heavier|lighter|steeper|shallower|longer|shorter|bouncier|roll|slide|on the|on mars|in space|what about)/;

function mainDynamicId(s: Scenario): string | undefined {
  const dyn = s.objects.filter((o) => !o.is_static && o.mass !== null && o.type !== "ramp");
  return dyn[dyn.length - 1]?.id;
}

/** Interpret a follow-up message as edits to the current scenario. Returns null if nothing matched. */
export function offlineEdits(message: string, current: Scenario): { changes: Change[]; notes: string[] } | null {
  const t = ` ${message.toLowerCase()} `;
  const x = extractQuantities(message);
  const changes: Change[] = [];
  const notes: string[] = [];
  const main = mainDynamicId(current);
  const ramp = current.objects.find((o) => o.type === "ramp");
  const pendulum = current.objects.find((o) => o.placement?.kind === "pendulum");
  const spring = current.links.find((l) => l.type === "spring");
  const obj = main ? current.objects.find((o) => o.id === main) : undefined;

  const factor = /\bdouble|twice\b/.test(t) ? 2 : /\btriple|three times\b/.test(t) ? 3 : /\bhalve|half\b/.test(t) ? 0.5 : /\bten times|10x|10 times\b/.test(t) ? 10 : null;

  // Mass
  if (obj && main) {
    if (x.masses.length) {
      changes.push({ path: `objects.${main}.mass`, value: x.masses[0].value });
      notes.push(`Mass of ${obj.label ?? main} → ${sig(x.masses[0].value)} kg.`);
    } else if (factor && /mass|heavier|lighter|weight/.test(t)) {
      const m = typeof obj.mass === "number" ? obj.mass : 1;
      changes.push({ path: `objects.${main}.mass`, value: m * factor });
      notes.push(`Mass × ${factor} → ${sig(m * factor)} kg.`);
    } else if (/heavier/.test(t)) {
      const m = typeof obj.mass === "number" ? obj.mass : 1;
      changes.push({ path: `objects.${main}.mass`, value: m * 2 });
      notes.push(`Mass doubled → ${sig(m * 2)} kg.`);
    } else if (/lighter/.test(t)) {
      const m = typeof obj.mass === "number" ? obj.mass : 1;
      changes.push({ path: `objects.${main}.mass`, value: m / 2 });
      notes.push(`Mass halved → ${sig(m / 2)} kg.`);
    }
  }

  // Friction
  const setFriction = (mu: number) => {
    const ids = [...(ramp ? [ramp.id] : []), ...(main ? [main] : [])];
    for (const id of ids) changes.push({ path: `objects.${id}.material.friction_coefficient`, value: mu });
    if (current.environment.ground_friction !== undefined || !ramp) changes.push({ path: "environment.ground_friction", value: mu });
    notes.push(`Friction coefficient → ${sig(mu)}.`);
  };
  if (/roll(?:s|ing)? without slipping|make it roll|\broll\b|rolling friction/.test(t) && x.friction === undefined) setFriction(0.5);
  else if (x.friction !== undefined) setFriction(x.friction);
  else if (/add friction|with friction|more friction|rougher/.test(t)) setFriction(0.5);
  else if (/less friction|slipperier|slippery/.test(t)) setFriction(0.05);

  // Angles
  if (x.angles.length) {
    if (ramp) {
      changes.push({ path: `objects.${ramp.id}.dimensions.angle`, value: x.angles[0].value });
      notes.push(`Ramp angle → ${x.angles[0].value}°.`);
    } else if (pendulum) {
      changes.push({ path: `objects.${pendulum.id}.placement.angle`, value: x.angles[0].value });
      notes.push(`Release angle → ${x.angles[0].value}°.`);
    }
  } else if (ramp && /steeper/.test(t)) {
    const a = Math.min(80, (ramp.dimensions.angle ?? 30) + 15);
    changes.push({ path: `objects.${ramp.id}.dimensions.angle`, value: a });
    notes.push(`Ramp angle → ${a}°.`);
  } else if (ramp && /shallower|gentler|less steep/.test(t)) {
    const a = Math.max(5, (ramp.dimensions.angle ?? 30) - 10);
    changes.push({ path: `objects.${ramp.id}.dimensions.angle`, value: a });
    notes.push(`Ramp angle → ${a}°.`);
  }

  // Lengths (pendulum length / ramp length)
  if (x.lengths.length && pendulum && /length|long|rod|string/.test(t)) {
    changes.push({ path: `objects.${pendulum.id}.placement.length`, value: x.lengths[0].value });
    notes.push(`Pendulum length → ${sig(x.lengths[0].value)} m.`);
  } else if (pendulum && factor && /length|longer|shorter|rod|string/.test(t)) {
    const L = (pendulum.placement?.length ?? 1) * factor;
    changes.push({ path: `objects.${pendulum.id}.placement.length`, value: L });
    notes.push(`Pendulum length → ${sig(L)} m.`);
  } else if (x.lengths.length && ramp && /ramp|length|long/.test(t)) {
    changes.push({ path: `objects.${ramp.id}.dimensions.length`, value: x.lengths[0].value });
    notes.push(`Ramp length → ${sig(x.lengths[0].value)} m.`);
  }

  // Speed
  if (obj && main) {
    const v = obj.velocity;
    const speed = Math.hypot(...v);
    const dir: Vec3 = speed > 0 ? [v[0] / speed, v[1] / speed, v[2] / speed] : [1, 0, 0];
    let target: number | undefined;
    if (x.speeds.length) target = x.speeds[0].value;
    else if (factor && /speed|fast|velocity/.test(t)) target = speed * factor;
    else if (/faster/.test(t)) target = Math.max(speed * 1.5, 1);
    else if (/slower/.test(t)) target = speed * 0.5;
    if (target !== undefined) {
      changes.push({ path: `objects.${main}.velocity`, value: [dir[0] * target, dir[1] * target, dir[2] * target] });
      notes.push(`Initial speed → ${sig(target)} m/s.`);
    }
  }

  // Environment
  if (x.gravity !== undefined) {
    changes.push({ path: "environment.gravity", value: x.gravity });
    notes.push(`Gravity → ${x.gravity} m/s²${x.gravityName ? ` (${x.gravityName})` : ""}.`);
  } else if (factor && /gravity/.test(t)) {
    const g = current.environment.gravity * factor;
    changes.push({ path: "environment.gravity", value: g });
    notes.push(`Gravity → ${sig(g)} m/s².`);
  }
  if (x.airResistance !== undefined) {
    changes.push({ path: "environment.air_resistance", value: x.airResistance });
    notes.push(`Air resistance ${x.airResistance ? "on" : "off"}.`);
  }
  if (x.duration !== undefined) {
    changes.push({ path: "environment.simulation_duration", value: x.duration });
    notes.push(`Duration → ${x.duration} s.`);
  } else if (/longer|more time/.test(t) && !pendulum && !ramp) {
    changes.push({ path: "environment.simulation_duration", value: current.environment.simulation_duration * 2 });
  }

  // Restitution
  if (x.restitution !== undefined && main) {
    changes.push({ path: `objects.${main}.material.restitution`, value: x.restitution });
    for (const o of current.objects) if (o.id !== main && !o.is_static) changes.push({ path: `objects.${o.id}.material.restitution`, value: x.restitution });
    notes.push(`Restitution → ${x.restitution}.`);
  } else if (main && obj && /bouncier|more bouncy/.test(t)) {
    const e = Math.min(1, obj.material.restitution + 0.2);
    changes.push({ path: `objects.${main}.material.restitution`, value: e });
    notes.push(`Restitution → ${sig(e)}.`);
  }

  // Springs
  if (spring) {
    if (x.springK !== undefined) {
      changes.push({ path: `links.${spring.id}.stiffness`, value: x.springK });
      notes.push(`Spring constant → ${x.springK} N/m.`);
    } else if (factor && /stiff|spring|k\b/.test(t)) {
      const k = (spring.stiffness ?? 20) * factor;
      changes.push({ path: `links.${spring.id}.stiffness`, value: k });
      notes.push(`Spring constant → ${sig(k)} N/m.`);
    } else if (/stiffer/.test(t)) {
      const k = (spring.stiffness ?? 20) * 2;
      changes.push({ path: `links.${spring.id}.stiffness`, value: k });
      notes.push(`Spring constant → ${sig(k)} N/m.`);
    }
    if (x.damping !== undefined) {
      changes.push({ path: `links.${spring.id}.damping`, value: x.damping });
      notes.push(`Damping → ${x.damping} N·s/m.`);
    } else if (/no damping|undamped/.test(t)) changes.push({ path: `links.${spring.id}.damping`, value: 0 });
  }

  if (/\bno\b/.test(t) && /question|that's it|fine|as is|keep/.test(t)) return { changes: [], notes: ["Keeping the scenario as it is."] };
  return changes.length ? { changes, notes } : null;
}

const sphereR = (m: number, material?: string) => {
  const density = material ? (MATERIALS[material]?.density ?? 1000) : 1000;
  const r = Math.cbrt((3 * m) / (4 * Math.PI * density));
  return Math.min(0.5, Math.max(0.05, sig(r, 2)));
};

function fromCommon(c: CommonObject, id: string, x: Extracted, mass?: number, extra: Partial<SimObjectInput> = {}): SimObjectInput {
  const material: Record<string, unknown> = { name: c.material };
  if (x.restitution !== undefined) material.restitution = x.restitution;
  return {
    id,
    label: c.label,
    type: c.kind,
    mass: mass ?? c.mass,
    hollow: c.hollow ?? false,
    dimensions: { ...c.dims },
    material: material as SimObjectInput["material"],
    ...extra,
  };
}

function objectFrom(x: Extracted, id: string, label: string, mass: number, extra: Partial<SimObjectInput> = {}, defaultMaterial?: string): SimObjectInput {
  const material = x.material ?? defaultMaterial ?? (x.kind === "box" ? "wood" : "rubber");
  const size = x.kind === "sphere" ? sphereR(Math.abs(mass) || 1, material) : Math.min(0.6, Math.max(0.15, sig(Math.cbrt((Math.abs(mass) || 1) / 600), 2)));
  const dimensions =
    x.kind === "sphere"
      ? { radius: size }
      : x.kind === "box"
        ? { width: size * 1.2, height: size, depth: size }
        : { radius: size / 2, height: size };
  const materialDef: Record<string, unknown> = { name: material };
  if (x.restitution !== undefined) materialDef.restitution = x.restitution;
  return {
    id,
    label,
    type: x.kind,
    mass,
    hollow: x.hollow,
    dimensions,
    material: materialDef as SimObjectInput["material"],
    ...(x.fixed ? { is_static: true } : {}),
    ...extra,
  };
}

interface Built {
  summary?: string;
  scenario: ScenarioInput;
  assumptions: string[];
  questions: ClarifyingQuestion[];
  variations: Variation[];
}

function build(archetype: Archetype, text: string, x: Extracted): Built {
  const t = text.toLowerCase();
  const assumptions: string[] = [];
  const questions: ClarifyingQuestion[] = [];
  const variations: Variation[] = [];
  const g = x.gravity ?? 9.81;
  const env: Record<string, unknown> = { gravity: g };
  if (x.gravityName) assumptions.push(`Gravity set to ${g} m/s² (${x.gravityName}).`);
  if (x.airResistance) env.air_resistance = true;
  const named = findCommonObjects(text);
  const mass = x.masses[0]?.value ?? named[0]?.obj.mass ?? 1;
  if (!x.masses.length && named.length) assumptions.push(`Used typical real-world masses and sizes (${named.map((n) => `${n.obj.label.toLowerCase()} ${sig(n.obj.mass)} kg`).join(", ")}).`);
  else if (!x.masses.length) assumptions.push("No mass given — assumed 1 kg.");
  const kindName = x.kind === "box" ? "block" : x.kind === "cylinder" ? (x.hollow ? "hoop" : "cylinder") : "ball";
  const title = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const noAirQuestion: ClarifyingQuestion = { question: "Should I include air resistance?", options: ["No, keep it in a vacuum", "Yes, add air resistance"] };

  switch (archetype) {
    case "ramp": {
      const angle = x.angles[0]?.value ?? 30;
      if (!x.angles.length) {
        assumptions.push("No angle given — assumed a 30° ramp.");
        questions.push({ question: "How steep is the ramp?", options: ["15 degrees", "30 degrees", "45 degrees"] });
      }
      const length = lengthNear(text, x.lengths, /ramp|incline|slope|long|length/)?.value ?? 5;
      if (!lengthNear(text, x.lengths, /ramp|incline|slope|long|length/)) assumptions.push("Ramp length assumed 5 m.");
      const rolling = /roll/.test(t);
      let mu = x.friction;
      if (mu === undefined) {
        if (rolling) {
          mu = 0.5;
          assumptions.push("\"Rolling\" needs friction to spin the object up; assumed μ = 0.5 so it rolls without slipping.");
        } else {
          mu = 0.3;
          assumptions.push("No friction given — assumed μ = 0.3.");
        }
        questions.push({ question: "What friction should the ramp have?", options: ["Frictionless", "Friction 0.3", "Friction 0.8"] });
      } else if (mu === 0 && rolling && x.kind !== "box") {
        assumptions.push("You said \"rolling\" but also \"frictionless\": without friction nothing makes the ball spin, so it slides (a = g·sin θ).");
        questions.push({
          question: "You said 'rolling down' a frictionless ramp — should it slide without friction, or roll without slipping?",
          options: ["Slide frictionlessly (as described)", "Roll without slipping"],
        });
      }
      const s0 = 0.15;
      env.simulation_duration = Math.min(20, Math.max(3, Math.ceil(Math.sqrt((2 * length) / Math.max(0.3, g * Math.sin((angle * Math.PI) / 180) * 0.5)) + 1.5)));
      const obj = objectFrom(x, `${kindName}_1`, title(kindName), mass, {
        placement: { kind: "on_ramp", target_id: "ramp_1", distance_from_top: s0 },
        material: { ...(objectFrom(x, "", "", mass).material as object), friction_coefficient: mu } as SimObjectInput["material"],
      });
      questions.push(noAirQuestion);
      variations.push(
        { label: mu === 0 ? "Add friction (μ = 0.5)" : "Make it frictionless", description: mu === 0 ? "With friction a ball rolls instead of sliding, and accelerates at 5/7 of the frictionless rate." : "Remove friction to see the maximum possible acceleration, g·sin θ.", changes: [{ path: "objects.ramp_1.material.friction_coefficient", value: mu === 0 ? 0.5 : 0 }, { path: `objects.${obj.id}.material.friction_coefficient`, value: mu === 0 ? 0.5 : 0 }] },
        { label: `Steeper ramp (${Math.min(75, angle + 15)}°)`, description: "Acceleration grows with sin θ.", changes: [{ path: "objects.ramp_1.dimensions.angle", value: Math.min(75, angle + 15) }] },
        { label: "Double the mass", description: "Surprise: the acceleration doesn't change — both gravity and inertia double.", changes: [{ path: `objects.${obj.id}.mass`, value: mass * 2 }] },
      );
      return {
        summary: `A ${sig(mass)} kg ${kindName} starts near the top of a ${sig(length)} m ramp inclined at ${angle}°${mu === 0 ? " with no friction" : ` (μ = ${sig(mu)})`} and ${mu === 0 || x.kind === "box" ? "slides" : "rolls"} down under gravity.`,
        scenario: {
          metadata: { name: `${title(kindName)} on a ${angle}° ramp` },
          environment: env,
          objects: [
            { id: "ramp_1", label: "Ramp", type: "ramp", dimensions: { length, angle, width: 1.5 }, material: { name: mu === 0 ? "frictionless" : "wood", friction_coefficient: mu } },
            obj,
          ],
        },
        assumptions,
        questions,
        variations,
      };
    }

    case "pendulum": {
      const L = lengthNear(text, x.lengths, /pendulum|length|long|string|rod|rope/)?.value ?? x.lengths[0]?.value ?? 1;
      if (!x.lengths.length) assumptions.push("No length given — assumed 1 m.");
      const angle = x.angles[0]?.value ?? 30;
      if (!x.angles.length) {
        assumptions.push("No release angle given — assumed 30°.");
        questions.push({ question: "From what angle is it released?", options: ["10 degrees (small swing)", "45 degrees", "90 degrees"] });
      }
      assumptions.push("The rod is rigid and massless; the bob is treated as a point mass at the end.");
      const anchorY = sig(L + 0.6, 3);
      const period = 2 * Math.PI * Math.sqrt(L / Math.max(g, 0.01));
      env.simulation_duration = Math.min(30, Math.max(6, Math.ceil(period * 3)));
      env.ground = true;
      const bob = objectFrom({ ...x, kind: "sphere" }, "bob", "Bob", mass, {
        dimensions: { radius: Math.min(0.1, Math.max(0.04, L * 0.05)) },
        placement: { kind: "pendulum", anchor: [0, anchorY, 0], length: L, angle },
      }, "steel");
      questions.push({ question: "Should I add air resistance so the swing slowly dies away?", options: ["No, ideal pendulum", "Yes, add air resistance"] });
      variations.push(
        { label: "Small swing (10°)", description: "Close to the small-angle formula T = 2π√(L/g).", changes: [{ path: "objects.bob.placement.angle", value: 10 }] },
        { label: `Longer rod (${sig(L * 4)} m)`, description: "Four times the length doubles the period.", changes: [{ path: "objects.bob.placement.length", value: L * 4 }] },
        { label: "Double the mass", description: "The period doesn't depend on mass.", changes: [{ path: "objects.bob.mass", value: mass * 2 }] },
      );
      return {
        summary: `A ${sig(mass)} kg bob on a ${sig(L)} m rigid rod is pulled ${angle}° from vertical and released to swing freely.`,
        scenario: { metadata: { name: `Pendulum (${sig(L)} m, ${angle}°)` }, environment: env, objects: [bob] },
        assumptions,
        questions,
        variations,
      };
    }

    case "spring": {
      const k = x.springK ?? 20;
      if (x.springK === undefined) {
        assumptions.push("No spring constant given — assumed k = 20 N/m.");
        questions.push({ question: "How stiff is the spring?", options: ["k = 10 N/m", "k = 50 N/m", "k = 200 N/m"] });
      }
      const horizontal = /horizontal|on a table|on the floor|on a surface|sideways/.test(t) || x.gravity === 0;
      const pull = lengthNear(text, x.lengths, /pull|stretch|compress|displac|amplitude/)?.value ?? 0.3;
      if (!lengthNear(text, x.lengths, /pull|stretch|compress|displac|amplitude/)) assumptions.push("Pulled 0.3 m from equilibrium and released.");
      const rest = 1;
      const T = 2 * Math.PI * Math.sqrt(Math.abs(mass) / k);
      env.simulation_duration = Math.min(30, Math.max(5, Math.ceil(T * 4)));
      const links = [{ id: "spring_1", type: "spring" as const, object_a: "mass_1", anchor: [0, 0, 0] as Vec3, length: rest, stiffness: k, damping: x.damping ?? 0 }];
      let obj: SimObjectInput;
      if (horizontal) {
        env.ground = x.gravity !== 0;
        env.ground_friction = x.friction ?? 0;
        if (x.friction === undefined && x.gravity !== 0) assumptions.push("Frictionless floor, so only the spring acts horizontally.");
        const size = 0.3;
        obj = objectFrom({ ...x, kind: x.kind === "sphere" ? "box" : x.kind }, "mass_1", "Mass", mass, {
          dimensions: { width: size, height: size, depth: size },
          position: [rest + pull, x.gravity === 0 ? 1 : size / 2 + 5e-4, 0],
        }, "steel");
        links[0].anchor = [0, x.gravity === 0 ? 1 : size / 2 + 5e-4, 0];
        (obj.material as Record<string, unknown>).friction_coefficient = x.friction ?? 0;
      } else {
        env.ground = false;
        const eq = rest + (Math.abs(mass) * g) / k;
        links[0].anchor = [0, sig(eq + pull + 1.2, 3), 0];
        obj = objectFrom({ ...x, kind: x.kind === "cylinder" ? "cylinder" : x.kind }, "mass_1", "Mass", mass, { position: [0, sig(1.2, 3), 0] }, "steel");
        assumptions.push(`Hangs vertically; gravity stretches the spring by mg/k = ${sig((Math.abs(mass) * g) / k)} m at equilibrium.`);
      }
      variations.push(
        { label: "Stiffer spring (k × 4)", description: "Four times the stiffness halves the period.", changes: [{ path: "links.spring_1.stiffness", value: k * 4 }] },
        { label: "Add damping", description: "Watch the amplitude decay as energy is dissipated.", changes: [{ path: "links.spring_1.damping", value: 0.1 * 2 * Math.sqrt(k * Math.abs(mass)) }] },
        { label: "Quadruple the mass", description: "Four times the mass doubles the period.", changes: [{ path: "objects.mass_1.mass", value: mass * 4 }] },
      );
      return {
        summary: `A ${sig(mass)} kg mass on a ${horizontal ? "horizontal" : "vertical"} spring (k = ${k} N/m${x.damping ? `, damping ${x.damping} N·s/m` : ""}) is displaced ${sig(pull)} m from equilibrium and released.`,
        scenario: { metadata: { name: `Mass on a spring (k = ${k} N/m)` }, environment: env, objects: [obj], links },
        assumptions,
        questions,
        variations,
      };
    }

    case "orbit": {
      env.gravity = x.gravity ?? 0;
      env.ground = false;
      const starMass = x.masses.length >= 2 ? Math.max(...x.masses.map((m) => m.value)) : 1e11;
      const planetMass = x.masses.length >= 2 ? Math.min(...x.masses.map((m) => m.value)) : x.masses[0]?.value && x.masses[0].value < 1e6 ? x.masses[0].value : 1;
      const r = lengthNear(text, x.lengths, /distance|radius|away|orbit|apart|at/)?.value ?? 4;
      const G = 6.674e-11;
      const vc = Math.sqrt((G * starMass) / r);
      const v = x.speeds[0]?.value ?? vc;
      if (!x.speeds.length) assumptions.push(`Planet launched at the circular-orbit speed √(GM/r) = ${sig(vc)} m/s.`);
      assumptions.push("Masses are scaled so the orbit fits on screen; Newton's law of gravitation is unchanged.");
      const T = (2 * Math.PI * r) / vc;
      env.simulation_duration = Math.min(120, Math.max(10, Math.ceil(T * 2)));
      variations.push(
        { label: "Slower launch (elliptical)", description: "Below circular speed the planet falls inward on an ellipse.", changes: [{ path: "objects.planet.velocity", value: [0, 0, -v * 0.8] }] },
        { label: "Escape!", description: "At √2 × circular speed the planet escapes.", changes: [{ path: "objects.planet.velocity", value: [0, 0, -vc * 1.45] }] },
      );
      return {
        summary: `A ${sig(planetMass)} kg planet starts ${sig(r)} m from a ${starMass.toExponential(1)} kg star moving sideways at ${sig(v)} m/s; Newtonian gravity bends its path into an orbit.`,
        scenario: {
          metadata: { name: "Planetary orbit" },
          environment: env,
          objects: [
            { id: "star", label: "Star", type: "sphere", is_static: true, mass: starMass, position: [0, 2, 0], dimensions: { radius: 0.5 }, material: { name: "gold", color: "#ffcf4a" } },
            { id: "planet", label: "Planet", type: "sphere", mass: planetMass, position: [r, 2, 0], velocity: [0, 0, -v], dimensions: { radius: 0.15 }, material: { name: "stone", color: "#4f8cff" } },
          ],
          forces: [{ id: "gravity_pull", type: "mutual_gravity", magnitude: G, applies_to: ["star", "planet"] }],
        },
        assumptions,
        questions,
        variations,
      };
    }

    case "collision": {
      const inSpace = x.gravity === 0;
      env.gravity = inSpace ? 0 : g;
      env.ground = !inSpace;
      const m1 = x.masses[0]?.value ?? 1;
      const m2 = x.masses[1]?.value ?? (x.masses[0] ? m1 : 1);
      const v1 = x.speeds[0]?.value ?? 3;
      const stationary = /stationary|at rest|resting|still|sitting/.test(t);
      const v2 = stationary ? 0 : x.speeds[1] ? -x.speeds[1].value : 0;
      if (!x.speeds.length) assumptions.push("No speed given — the first object moves at 3 m/s.");
      const e = x.restitution ?? 1;
      if (x.restitution === undefined) {
        assumptions.push("Collision type not stated — assumed perfectly elastic (e = 1).");
        questions.push({ question: "Is the collision elastic or inelastic?", options: ["Perfectly elastic (e = 1)", "Inelastic (e = 0.5)", "They stick together (e = 0)"] });
      }
      if (!inSpace) {
        env.ground_friction = 0;
        assumptions.push("Frictionless floor, so the balls slide without spinning and momentum is conserved along the line.");
      }
      const kind: Kind = x.kind === "box" ? "box" : "sphere";
      const mk = (id: string, label: string, m: number, xpos: number, v: number) =>
        objectFrom({ ...x, kind, restitution: e }, id, label, m, {
          position: [xpos, 0, 0],
          velocity: [v, 0, 0],
          ...(inSpace ? { position: [xpos, 1, 0] as Vec3 } : { placement: { kind: "on_ground" as const } }),
          material: { name: x.material ?? "steel", restitution: e, friction_coefficient: inSpace ? 0.3 : 0 } as SimObjectInput["material"],
        });
      env.simulation_duration = 4;
      variations.push(
        { label: "Make it inelastic (e = 0.3)", description: "Momentum is still conserved, but kinetic energy isn't.", changes: [{ path: "objects.object_1.material.restitution", value: 0.3 }, { path: "objects.object_2.material.restitution", value: 0.3 }] },
        { label: "Equal masses", description: "In an elastic collision equal masses swap velocities (Newton's cradle).", changes: [{ path: "objects.object_2.mass", value: m1 }] },
      );
      return {
        summary: `A ${sig(m1)} kg ${kindName} moving at ${sig(v1)} m/s meets a ${sig(m2)} kg ${kindName}${v2 === 0 ? " at rest" : ` moving at ${sig(-v2)} m/s toward it`} head-on${inSpace ? " in weightless space" : " on a frictionless floor"} (restitution ${e}).`,
        scenario: {
          metadata: { name: `${e === 1 ? "Elastic" : e === 0 ? "Perfectly inelastic" : "Inelastic"} collision` },
          environment: env,
          objects: [mk("object_1", `${sig(m1)} kg ${kindName}`, m1, -2, v1), mk("object_2", `${sig(m2)} kg ${kindName}`, m2, 1, v2)],
        },
        assumptions,
        questions,
        variations,
      };
    }

    case "projectile":
    case "drop": {
      const platformWords = /cliff|building|tower|table|roof|bridge|ledge|balcony|wall|platform|window/;
      const heightQ =
        lengthNear(text, x.lengths, /cliff|building|tower|table|roof|bridge|ledge|balcony|high|tall|height|above|from|up/) ?? (archetype === "drop" ? x.lengths[0] : undefined);
      let h = heightQ?.value ?? (archetype === "drop" ? 2 : 0);
      if (!heightQ && archetype === "drop") assumptions.push("No height given — dropped from 2 m.");
      const hasPlatform = platformWords.test(t) && h > 0;
      const speed = x.speeds[0]?.value ?? (archetype === "projectile" ? 10 : 0);
      if (!x.speeds.length && archetype === "projectile") assumptions.push("No speed given — launched at 10 m/s.");
      let angle = x.angles[0]?.value ?? (/horizontal/.test(t) ? 0 : /straight up|vertically|upward/.test(t) ? 90 : archetype === "projectile" ? (hasPlatform ? 0 : 45) : 0);
      if (archetype === "projectile" && !x.angles.length && !/horizontal|straight up|vertical|upward/.test(t)) {
        assumptions.push(`No launch angle given — assumed ${angle}°.`);
        questions.push({ question: "At what angle is it launched?", options: ["Horizontally (0°)", "45 degrees", "Straight up (90°)"] });
      }
      if (/straight down|downward/.test(t)) angle = -90;
      const rad = (angle * Math.PI) / 180;
      const multi = archetype === "drop" && named.length >= 2;
      const obj = named.length
        ? fromCommon(named[0].obj, "object_1", x, x.masses.length && (!multi || x.masses.length >= named.length) ? x.masses[0].value : undefined)
        : objectFrom(x, kindName === "block" ? "block" : "ball", title(kindName), mass);
      const r =
        obj.type === "box" ? ((obj.dimensions as { height?: number }).height ?? 0.3) / 2 : (obj.dimensions as { radius?: number }).radius ?? 0.15;
      const objects: SimObjectInput[] = [];
      if (hasPlatform) {
        const depth = 6;
        objects.push({ id: "platform", label: title((platformWords.exec(t)?.[0] ?? "cliff")), type: "box", is_static: true, mass: null, position: [-depth / 2, h / 2, 0], dimensions: { width: depth, height: h, depth: 6 }, material: { name: "stone" } });
        obj.position = [r + 0.01, h + r + 5e-4, 0];
        assumptions.push(`Launched from the edge of a ${sig(h)} m ${platformWords.exec(t)?.[0] ?? "cliff"}.`);
      } else {
        obj.position = [0, h + r + 5e-4, 0];
        if (h === 0) assumptions.push("Launched from ground level.");
      }
      obj.velocity = [sig(speed * Math.cos(rad), 6), sig(speed * Math.sin(rad), 6), 0];
      objects.push(obj);
      if (multi) {
        let xpos = 0;
        for (let i = 1; i < Math.min(named.length, 6); i++) {
          const c = named[i].obj;
          const m = x.masses.length >= named.length ? x.masses[i].value : undefined;
          xpos += 1;
          const o = fromCommon(c, `object_${i + 1}`, x, m);
          const depth = c.kind === "sphere" ? c.dims.radius! : c.kind === "cylinder" ? c.dims.radius! : c.dims.height! / 2;
          o.position = [xpos, h + depth + 5e-4, 0];
          objects.push(o);
        }
        assumptions.push("All objects are released at the same moment from the same height.");
      } else if (x.count > 1 && archetype === "drop") {
        // e.g. "drop two balls of 1 kg and 10 kg"
        for (let i = 1; i < Math.min(x.count, 6); i++) {
          const m = x.masses[i]?.value ?? mass;
          const o = objectFrom(x, `${obj.id}_${i + 1}`, `${title(kindName)} ${i + 1}`, m);
          const ri = (o.dimensions as { radius?: number }).radius ?? 0.15;
          o.position = [i * 1.0, h + ri + 5e-4, 0];
          objects.push(o);
        }
        (objects[hasPlatform ? 1 : 0] as SimObjectInput).label = `${title(kindName)} 1`;
      }
      const vy = speed * Math.sin(rad);
      const tf = g > 0 ? (vy + Math.sqrt(vy * vy + 2 * g * Math.max(h, 0))) / g : 3;
      const bounce = /bounc/.test(t);
      env.simulation_duration = Math.min(60, Math.max(2, Math.ceil((tf + (bounce ? 3 : 0.8)) * 2) / 2));
      if (bounce && x.restitution === undefined) (obj.material as Record<string, unknown>).restitution = 0.8;
      if (x.airResistance === undefined) questions.push(noAirQuestion);
      const mainId = obj.id;
      variations.push(
        { label: "Try it on the Moon", description: "Lower gravity: longer, higher flight.", changes: [{ path: "environment.gravity", value: 1.62 }] },
        archetype === "projectile"
          ? { label: "Double the speed", description: "Range grows with the square of the speed for ground launches.", changes: [{ path: `objects.${mainId}.velocity`, value: [obj.velocity[0] * 2, obj.velocity[1] * 2, 0] }] }
          : { label: "Make it bouncier (e = 0.9)", description: "Each bounce keeps e² of the height.", changes: [{ path: `objects.${mainId}.material.restitution`, value: 0.9 }] },
        { label: "Add air resistance", description: "Drag slows it down and shortens the flight.", changes: [{ path: "environment.air_resistance", value: true }] },
      );
      return {
        summary:
          archetype === "drop"
            ? `${objects.filter((o) => !o.is_static).map((o) => `${o.label} (${sig(Number(o.mass))} kg)`).join(" and ")} ${multi ? "are" : "is"} released from rest ${sig(h)} m above the ground${g !== 9.81 ? ` with g = ${g} m/s²` : ""}.`
            : `${obj.label} (${sig(Number(obj.mass))} kg) is launched at ${sig(speed)} m/s, ${angle}° above horizontal, from ${hasPlatform ? `the edge of a ${sig(h)} m ${platformWords.exec(t)?.[0] ?? "cliff"}` : h > 0 ? `${sig(h)} m up` : "the ground"}.`,
        scenario: {
          metadata: { name: archetype === "drop" ? (multi ? `Dropping ${named.map((n) => n.obj.label.toLowerCase()).join(" and ")}` : `Dropped ${(obj.label ?? kindName).toLowerCase()}`) : `Launched ${(obj.label ?? kindName).toLowerCase()}` },
          environment: env,
          objects,
        },
        assumptions,
        questions,
        variations,
      };
    }

    case "slide": {
      const speed = x.speeds[0]?.value ?? 0;
      const F = x.forces[0]?.value;
      const mu = x.friction ?? 0.3;
      if (x.friction === undefined) {
        assumptions.push("No friction given — assumed μ = 0.3.");
        questions.push({ question: "How slippery is the floor?", options: ["Frictionless (ice)", "Friction 0.3", "Friction 0.6"] });
      }
      const obj = objectFrom({ ...x, kind: x.kind === "sphere" && !/ball/.test(t) ? "box" : x.kind }, "object_1", title(x.kind === "sphere" && /ball/.test(t) ? "ball" : "block"), mass, {
        position: [-3, 0, 0],
        velocity: [speed, 0, 0],
        placement: { kind: "on_ground" },
      });
      (obj.material as Record<string, unknown>).friction_coefficient = mu;
      const forces = F !== undefined ? [{ id: "push", type: "applied_force", magnitude: F, direction: [1, 0, 0] as Vec3, applies_to: ["object_1"], start_time: 0, end_time: x.forceDuration ?? null }] : [];
      if (F === undefined && speed === 0) assumptions.push("No push or speed given — it starts at rest.");
      env.simulation_duration = Math.min(20, Math.max(3, Math.ceil((x.forceDuration ?? 0) + (speed > 0 ? speed / (mu * g + 0.1) : 2) + 1)));
      variations.push(
        { label: "Make it icy (μ = 0.05)", description: "Less friction: it slides much further.", changes: [{ path: "objects.object_1.material.friction_coefficient", value: 0.05 }] },
        { label: "Double the mass", description: "Friction force doubles, but so does inertia — the stopping distance is unchanged.", changes: [{ path: "objects.object_1.mass", value: mass * 2 }] },
      );
      return {
        summary: F !== undefined
          ? `A ${sig(mass)} kg ${(obj.label ?? "block").toLowerCase()} on a floor (μ = ${sig(mu)}) is pushed with ${sig(F)} N${x.forceDuration ? ` for ${x.forceDuration} s` : ""}.`
          : `A ${sig(mass)} kg ${(obj.label ?? "block").toLowerCase()} slides across a floor at ${sig(speed)} m/s with μ = ${sig(mu)} slowing it.`,
        scenario: { metadata: { name: F !== undefined ? "Pushed block" : "Sliding block" }, environment: env, objects: [obj], forces },
        assumptions,
        questions,
        variations,
      };
    }

    case "tower": {
      const n = Math.min(12, Math.max(2, x.count > 1 ? x.count : 6));
      const objects: SimObjectInput[] = Array.from({ length: n }, (_, i) => ({
        id: `block_${i + 1}`,
        label: `Block ${i + 1}`,
        type: "box" as const,
        mass: 0.5,
        position: [2, 0.2 + i * 0.4005, 0] as Vec3,
        dimensions: { width: 0.4, height: 0.4, depth: 0.4 },
        material: { name: "wood" },
      }));
      objects.push({ id: "ball", label: "Ball", type: "sphere", mass: mass === 1 ? 5 : mass, position: [-3, 0.3, 0], velocity: [x.speeds[0]?.value ?? 6, 0, 0], dimensions: { radius: 0.3 }, material: { name: "steel" } });
      env.simulation_duration = 5;
      return { scenario: { metadata: { name: "Tower knock-down" }, environment: env, objects }, assumptions, questions, variations };
    }
  }
}

function finalize(scenarioInput: ScenarioInput, description: string, extras: Omit<Built, "scenario">, reply: string): InterpretResult {
  const scenario = makeScenario({
    ...scenarioInput,
    metadata: { ...(scenarioInput.metadata ?? {}), description, source: "offline", created_at: new Date().toISOString() },
  });
  const rs = resolveScenario(scenario);
  const analysis = analyzeScenario(rs);
  const interpretation = describeScenario(rs, analysis);
  if (extras.summary) interpretation.summary = extras.summary;
  interpretation.assumptions = [...extras.assumptions, ...analysis.assumptions];
  interpretation.questions = extras.questions.slice(0, 3);
  const first = analysis.predictions[0];
  interpretation.expected_outcome = analysis.predictions.length
    ? analysis.predictions
        .filter((p) => p.unit !== "%")
        .slice(0, 3)
        .map((p) => `${p.label}: ${sig(p.value, 3)} ${p.unit}`)
        .join(". ") + "."
    : "Run it to see what happens — no closed-form prediction applies to this setup.";
  if (!first) interpretation.physics_notes ||= "";
  const validation = validateScenario(scenario, rs);
  return {
    status: "ready",
    reply,
    interpretation,
    scenario,
    suggested_variations: extras.variations.filter((v) => {
      try {
        applyChanges(scenario, v.changes);
        return true;
      } catch {
        return false;
      }
    }),
    source: "offline",
    issues: validation.issues,
  };
}

/**
 * Interpret a natural-language description (or a follow-up edit to `current`) without an AI model.
 */
export function interpretOffline(message: string, current?: Scenario | null): InterpretResult {
  const text = message.trim();
  const t = text.toLowerCase();
  const x = extractQuantities(text);
  const archetype = detectArchetype(t, x);

  // Follow-up edits to the existing scenario.
  if (current && current.objects.length && (!archetype || EDIT_HINTS.test(t.trim()) || text.split(/\s+/).length <= 6)) {
    const edits = offlineEdits(text, current);
    if (edits) {
      let next = current;
      const applied: string[] = [];
      for (const c of edits.changes) {
        try {
          if (getPath(next, c.path.split(".").slice(0, -1).join(".")) === undefined && !c.path.startsWith("environment")) continue;
          next = applyChanges(next, [c]);
          applied.push(c.path);
        } catch {
          // skip invalid edits
        }
      }
      if (applied.length || edits.changes.length === 0) {
        return finalize(
          next,
          next.metadata.description,
          { assumptions: edits.notes, questions: [], variations: [] },
          edits.changes.length ? `Updated: ${edits.notes.join(" ")}` : edits.notes.join(" "),
        );
      }
    }
  }

  if (!archetype) {
    return {
      status: "needs_clarification",
      reply:
        "I couldn't recognise a physics setup in that. Could you describe the objects and what happens to them? For example: \"a 2 kg ball rolls down a 30° ramp\" or \"a pendulum 1 m long released from 45°\".",
      interpretation: {
        summary: "Not enough information to build a scenario yet.",
        objects: [],
        forces: [],
        calculations: [],
        assumptions: [],
        questions: [
          { question: "What kind of setup is it?", options: ["A ball rolling down a ramp", "A pendulum", "A projectile launched from a cliff", "Two balls colliding"] },
        ],
        expected_outcome: "",
        physics_notes: "",
      },
      scenario: null,
      suggested_variations: [],
      source: "offline",
    };
  }

  const built = build(archetype, text, x);
  if (x.fixed) built.assumptions.push("You said it's fixed in place, so it's modelled as an immovable object.");
  if (x.duration !== undefined) (built.scenario.environment as Record<string, unknown>).simulation_duration = x.duration;
  const reply = `Here's how I've set it up. ${built.questions.length ? "A couple of things weren't specified, so I made assumptions — answer the questions below to refine it, or run it as is." : "Review the setup and press Run when ready."}`;
  return finalize(built.scenario, text, built, reply);
}
