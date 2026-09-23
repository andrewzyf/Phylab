import { create } from "zustand";
import {
  analyzeScenario,
  applyChanges,
  describeScenario,
  checkPredictions,
  computeMetrics,
  DEFAULT_DIMENSIONS,
  makeScenario,
  MATERIALS,
  PRESETS,
  presetScenario,
  validateScenario,
  type Analysis,
  type Change,
  type ExplainResult,
  type InterpretResult,
  type ObjectType,
  type PredictionCheck,
  type PredictionSummary,
  type Recording,
  type RunMetrics,
  type Scenario,
  type SimObjectInput,
  type ValidationResult,
  type Variation,
  type Vec3,
} from "@physicslab/shared";
import { explain, fetchHealth, interpret, type ChatTurn, type Health } from "./api";
import { loadJson, saveJson } from "./lib/storage";
import { decodeScenario } from "./lib/share";
import { simRunner } from "./sim/runner";

export type VariantKey = "A" | "B";

export interface Variant {
  key: VariantKey;
  scenario: Scenario;
  validation: ValidationResult;
  analysis: Analysis;
  recording: Recording | null;
  checks: PredictionCheck[];
  metrics: RunMetrics | null;
  status: "simulating" | "ready" | "error" | "blocked";
  progress: number;
  error?: string;
  revision: number;
}

export interface ChatEntry {
  id: string;
  role: "user" | "assistant";
  text: string;
  result?: InterpretResult;
  pending?: boolean;
  error?: string;
  at: number;
}

export interface RunEntry {
  id: string;
  at: number;
  name: string;
  scenario: Scenario;
  metrics: RunMetrics | null;
  headline: { label: string; value: number; unit: string }[];
}

export interface SavedScenario {
  id: string;
  name: string;
  at: number;
  scenario: Scenario;
}

export type RightTab = "params" | "stats" | "charts" | "compare" | "history";
export type MobileTab = "describe" | "scene" | "params" | "stats" | "charts";

interface Baseline {
  scenario: Scenario;
  metrics: RunMetrics | null;
  predictions: PredictionSummary[];
}

export interface ViewOptions {
  grid: boolean;
  trails: boolean;
  vectors: boolean;
  labels: boolean;
  axes: boolean;
  follow: boolean;
}

interface State {
  variants: Partial<Record<VariantKey, Variant>>;
  editing: VariantKey;
  compare: boolean;
  time: number;
  playing: boolean;
  speed: number;
  loop: boolean;
  view: ViewOptions;
  selectedId: string | null;
  editMode: boolean;
  chat: ChatEntry[];
  busy: boolean;
  health: Health | null | undefined;
  history: RunEntry[];
  overlays: string[];
  overlayRecordings: Record<string, Recording>;
  baseline: Baseline | null;
  explanation: { status: "idle" | "loading" | "ready"; result?: ExplainResult; question?: string };
  interpretation: InterpretResult | null;
  rightTab: RightTab;
  mobileTab: MobileTab;
  libraryOpen: boolean;
  saved: SavedScenario[];
  toast: { text: string; id: number } | null;
  frameRequest: number;

  init(): Promise<void>;
  /** Load a scenario that didn't come from the chat, and post a card describing it in the chat. */
  openScenario(scenario: Scenario, origin: string): void;
  loadScenario(scenario: Scenario, opts?: { variant?: VariantKey; interpretation?: InterpretResult | null; autoplay?: boolean; keepTime?: boolean; frame?: boolean }): void;
  updateScenario(changes: Change[], variant?: VariantKey): void;
  applyVariation(v: Variation): void;
  run(): void;
  send(message: string): Promise<void>;
  play(): void;
  pause(): void;
  togglePlay(): void;
  reset(): void;
  seek(t: number): void;
  setSpeed(s: number): void;
  setLoop(l: boolean): void;
  tick(dtReal: number): void;
  setView(v: Partial<ViewOptions>): void;
  select(id: string | null): void;
  setEditMode(on: boolean): void;
  setEditing(k: VariantKey): void;
  toggleCompare(on?: boolean): void;
  copyAToB(): void;
  toggleOverlay(runId: string): void;
  removeRun(runId: string): void;
  restoreRun(runId: string): void;
  requestExplanation(question?: string): Promise<void>;
  addObject(type: ObjectType): void;
  deleteObject(id: string): void;
  moveObject(id: string, position: Vec3): void;
  setMaterial(id: string, material: string): void;
  addForce(objectId: string, type: "applied_force" | "impulse"): void;
  removeForce(forceId: string): void;
  setRightTab(t: RightTab): void;
  setMobileTab(t: MobileTab): void;
  setLibraryOpen(open: boolean): void;
  saveCurrent(name?: string): void;
  deleteSaved(id: string): void;
  showToast(text: string): void;
  requestFrame(): void;
}

const uid = () => Math.random().toString(36).slice(2, 10);
const HISTORY_KEY = "physicslab.history.v1";
const SAVED_KEY = "physicslab.saved.v1";
const CHAT_WELCOME: ChatEntry = {
  id: "welcome",
  role: "assistant",
  text: "Describe a physics scenario in plain language — for example \"a 2 kg ball rolls down a 30° ramp\" or \"a pendulum released from 60° on Mars\". I'll show you how I interpret it, then you can run it, tweak it, and compare variations.",
  at: 0,
};

let simDebounce: Record<string, ReturnType<typeof setTimeout> | undefined> = {};

export function predictionSummaries(v: Variant | undefined): PredictionSummary[] {
  if (!v) return [];
  return v.checks.map((c) => ({ id: c.prediction.id, label: c.prediction.label, value: c.prediction.value, unit: c.prediction.unit, measured: c.measured }));
}

export function objectLabels(s: Scenario | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const o of s?.objects ?? []) out[o.id] = o.label || o.id;
  return out;
}

function prepare(key: VariantKey, scenario: Scenario, revision: number): Variant {
  const validation = validateScenario(scenario);
  const analysis = analyzeScenario(validation.resolved);
  return {
    key,
    scenario,
    validation,
    analysis,
    recording: null,
    checks: analysis.predictions.map((p) => ({ prediction: p, measured: null, error: null, agrees: null })),
    metrics: null,
    status: validation.canRun ? "simulating" : "blocked",
    progress: 0,
    revision,
  };
}

function headlineOf(v: Variant): RunEntry["headline"] {
  const fromChecks = v.checks
    .filter((c) => c.measured !== null && c.prediction.unit !== "%")
    .slice(0, 3)
    .map((c) => ({ label: c.prediction.label, value: c.measured as number, unit: c.prediction.unit }));
  if (fromChecks.length) return fromChecks;
  return (v.metrics?.objects ?? []).slice(0, 3).map((o) => ({ label: `${objectLabels(v.scenario)[o.id] ?? o.id}: max speed`, value: o.maxSpeed, unit: "m/s" }));
}

export const useStore = create<State>()((set, get) => ({
  variants: {},
  editing: "A",
  compare: false,
  time: 0,
  playing: false,
  speed: 1,
  loop: false,
  view: { grid: true, trails: true, vectors: false, labels: true, axes: false, follow: false },
  selectedId: null,
  editMode: false,
  chat: [CHAT_WELCOME],
  busy: false,
  health: undefined,
  history: [],
  overlays: [],
  overlayRecordings: {},
  baseline: null,
  explanation: { status: "idle" },
  interpretation: null,
  rightTab: "params",
  mobileTab: "scene",
  libraryOpen: false,
  saved: [],
  toast: null,
  frameRequest: 0,

  async init() {
    set({ history: loadJson<RunEntry[]>(HISTORY_KEY, []).slice(0, 30), saved: loadJson<SavedScenario[]>(SAVED_KEY, []) });
    const shared = window.location.hash ? await decodeScenario(window.location.hash) : null;
    if (shared) {
      get().openScenario(shared, "from a share link");
      history.replaceState(null, "", window.location.pathname + window.location.search);
    } else {
      get().loadScenario(presetScenario(PRESETS[0].id), { frame: true });
    }
    set({ health: await fetchHealth() });
  },

  openScenario(scenario, origin) {
    get().loadScenario(scenario, { frame: true, interpretation: null });
    const v = get().variants.A;
    if (!v) return;
    const interpretation = describeScenario(v.validation.resolved, v.analysis);
    const result: InterpretResult = {
      status: "ready",
      reply: `Loaded “${scenario.metadata.name}” ${origin}. Press Run, or ask me to change something.`,
      interpretation,
      scenario,
      suggested_variations: [],
      source: "library",
      issues: v.validation.issues,
    };
    set((s) => ({ chat: [...s.chat, { id: uid(), role: "assistant", text: result.reply, result, at: Date.now() }], interpretation: result }));
  },

  loadScenario(scenario, opts = {}) {
    const key = opts.variant ?? "A";
    const prev = get().variants[key];
    const revision = (prev?.revision ?? 0) + 1;
    const variant = prepare(key, scenario, revision);
    set((s) => ({
      variants: { ...s.variants, [key]: variant },
      ...(opts.keepTime ? {} : { time: 0, playing: false }),
      ...(opts.interpretation !== undefined && key === "A" ? { interpretation: opts.interpretation } : {}),
      ...(opts.frame ? { frameRequest: s.frameRequest + 1 } : {}),
      selectedId: s.selectedId && scenario.objects.some((o) => o.id === s.selectedId) ? s.selectedId : null,
    }));
    if (!variant.validation.canRun) return;
    clearTimeout(simDebounce[key]);
    const start = () => {
      simRunner
        .run(key, scenario, (p) => {
          const v = get().variants[key];
          if (v?.revision === revision) set((s) => ({ variants: { ...s.variants, [key]: { ...v, progress: p } } }));
        })
        .then((recording) => {
          const v = get().variants[key];
          if (!v || v.revision !== revision) return;
          const checks = checkPredictions(recording, v.analysis.predictions);
          const metrics = computeMetrics(recording);
          set((s) => ({
            variants: { ...s.variants, [key]: { ...v, recording, checks, metrics, status: "ready", progress: 1 } },
            time: Math.min(s.time, recording.duration),
          }));
          if (opts.autoplay) set({ time: 0, playing: true });
          if (opts.frame) get().requestFrame();
        })
        .catch((err: Error) => {
          const v = get().variants[key];
          if (!v || v.revision !== revision) return;
          if (/terminated/i.test(err.message)) return;
          set((s) => ({ variants: { ...s.variants, [key]: { ...v, status: "error", error: err.message } } }));
        });
    };
    if (opts.keepTime) simDebounce[key] = setTimeout(start, 60);
    else start();
  },

  updateScenario(changes, variantKey) {
    const key = variantKey ?? get().editing;
    const v = get().variants[key];
    if (!v) return;
    try {
      const next = applyChanges(v.scenario, changes);
      get().loadScenario(next, { variant: key, keepTime: true });
      if (get().explanation.status !== "idle") set({ explanation: { status: "idle" } });
    } catch (err) {
      get().showToast(`Couldn't apply that change: ${(err as Error).message}`);
    }
  },

  applyVariation(variation) {
    const s = get();
    const a = s.variants.A;
    if (!a) return;
    // Keep the pre-variation state as the baseline so "what changed?" compares against it.
    if (a.status === "ready") set({ baseline: { scenario: a.scenario, metrics: a.metrics, predictions: predictionSummaries(a) } });
    s.updateScenario(variation.changes, "A");
    get().showToast(`Applied: ${variation.label}`);
  },

  run() {
    const s = get();
    const a = s.variants[s.editing] ?? s.variants.A;
    if (!a) return;
    if (!a.validation.canRun) {
      s.showToast("Fix the errors listed under the interpretation before running.");
      return;
    }
    set({ time: 0, playing: a.status === "ready", editMode: false, mobileTab: window.innerWidth < 900 ? "scene" : s.mobileTab });
    if (a.status !== "ready") {
      // Start as soon as the recording lands.
      const unsub = useStore.subscribe((st) => {
        const v = st.variants[a.key];
        if (v?.status === "ready") {
          unsub();
          set({ playing: true, time: 0 });
          recordRun(v);
        } else if (!v || v.revision !== a.revision) unsub();
      });
    } else recordRun(a);
  },

  async send(message) {
    const text = message.trim();
    if (!text || get().busy) return;
    const s = get();
    const userEntry: ChatEntry = { id: uid(), role: "user", text, at: Date.now() };
    const pending: ChatEntry = { id: uid(), role: "assistant", text: "", pending: true, at: Date.now() };
    const turns: ChatTurn[] = s.chat
      .filter((c) => c.id !== "welcome" && !c.pending && !c.error)
      .map((c) => ({ role: c.role, content: c.role === "assistant" ? `${c.text}${c.result?.interpretation.summary ? `\n${c.result.interpretation.summary}` : ""}` : c.text }));
    set({ chat: [...s.chat, userEntry, pending], busy: true, mobileTab: "describe" });
    try {
      const current = s.variants.A?.scenario ?? null;
      const result = await interpret(text, s.chat.length > 1 ? current : null, turns);
      set((st) => ({ chat: st.chat.map((c) => (c.id === pending.id ? { ...c, pending: false, text: result.reply, result } : c)) }));
      if (result.scenario) {
        const a = get().variants.A;
        if (a?.status === "ready") set({ baseline: { scenario: a.scenario, metrics: a.metrics, predictions: predictionSummaries(a) } });
        get().loadScenario(result.scenario, { interpretation: result, frame: true });
      }
    } catch (err) {
      set((st) => ({ chat: st.chat.map((c) => (c.id === pending.id ? { ...c, pending: false, text: "", error: (err as Error).message } : c)) }));
    } finally {
      set({ busy: false });
    }
  },

  play() {
    const s = get();
    const v = s.variants[s.editing] ?? s.variants.A;
    if (!v?.recording) return;
    if (s.time >= v.recording.duration - 1e-6) set({ time: 0 });
    set({ playing: true, editMode: false });
  },
  pause: () => set({ playing: false }),
  togglePlay() {
    if (get().playing) get().pause();
    else get().play();
  },
  reset: () => set({ time: 0, playing: false }),
  seek: (t) => set({ time: Math.max(0, t) }),
  setSpeed: (speed) => set({ speed }),
  setLoop: (loop) => set({ loop }),
  tick(dtReal) {
    const s = get();
    if (!s.playing) return;
    const recs = [s.variants.A?.recording, s.compare ? s.variants.B?.recording : null].filter(Boolean) as Recording[];
    if (!recs.length) return;
    const duration = Math.max(...recs.map((r) => r.duration));
    const scale = s.variants.A?.scenario.environment.time_scale ?? 1;
    let t = s.time + Math.min(dtReal, 0.1) * s.speed * scale;
    if (t >= duration) {
      if (s.loop) t = 0;
      else {
        set({ time: duration, playing: false });
        return;
      }
    }
    set({ time: t });
  },
  setView: (v) => set((s) => ({ view: { ...s.view, ...v } })),
  select: (id) => set({ selectedId: id }),
  setEditMode(on) {
    set({ editMode: on, playing: false, ...(on ? { time: 0 } : {}) });
  },
  setEditing: (k) => set({ editing: k }),
  toggleCompare(on) {
    const s = get();
    const next = on ?? !s.compare;
    if (next) {
      if (!s.variants.B && s.variants.A) get().loadScenario(structuredClone(s.variants.A.scenario), { variant: "B", keepTime: true, frame: true });
      set({ compare: true, editing: "B", rightTab: "compare" });
      // The viewport just split in two: re-frame once the layout has settled.
      setTimeout(() => get().requestFrame(), 50);
    } else {
      set({ compare: false, editing: "A" });
      setTimeout(() => get().requestFrame(), 50);
    }
  },
  copyAToB() {
    const a = get().variants.A;
    if (a) get().loadScenario(structuredClone(a.scenario), { variant: "B", keepTime: true });
  },
  toggleOverlay(runId) {
    const s = get();
    if (s.overlays.includes(runId)) {
      set({ overlays: s.overlays.filter((x) => x !== runId) });
      return;
    }
    const run = s.history.find((r) => r.id === runId);
    if (!run) return;
    set({ overlays: [...s.overlays, runId] });
    if (!s.overlayRecordings[runId]) {
      simRunner
        .run(`history-${runId}`, run.scenario)
        .then((rec) => set((st) => ({ overlayRecordings: { ...st.overlayRecordings, [runId]: rec } })))
        .catch(() => set((st) => ({ overlays: st.overlays.filter((x) => x !== runId) })));
    }
  },
  removeRun(runId) {
    set((s) => {
      const history = s.history.filter((r) => r.id !== runId);
      saveJson(HISTORY_KEY, history);
      return { history, overlays: s.overlays.filter((x) => x !== runId) };
    });
  },
  restoreRun(runId) {
    const run = get().history.find((r) => r.id === runId);
    if (run) get().openScenario(run.scenario, "from your run history");
  },

  async requestExplanation(question) {
    const s = get();
    const a = s.variants.A;
    if (!a) return;
    set({ explanation: { status: "loading", question } });
    const prev = s.baseline && JSON.stringify(s.baseline.scenario) !== JSON.stringify(a.scenario) ? s.baseline : null;
    const result = await explain({
      scenario: a.scenario,
      metrics: a.metrics,
      predictions: predictionSummaries(a),
      previous: prev,
      question,
    });
    set({ explanation: { status: "ready", result, question } });
  },

  addObject(type) {
    const s = get();
    const key = s.editing;
    const v = s.variants[key];
    const base = v?.scenario ?? makeScenario({});
    const n = base.objects.filter((o) => o.type === type).length + 1;
    const id = `${type}_${n}${base.objects.some((o) => o.id === `${type}_${n}`) ? `_${uid().slice(0, 3)}` : ""}`;
    const spread = base.objects.length;
    const material = type === "ramp" ? "wood" : type === "box" ? "wood" : type === "plate" ? "concrete" : "rubber";
    const obj: SimObjectInput = {
      id,
      label: `${type[0].toUpperCase()}${type.slice(1)} ${n}`,
      type,
      material: { name: material },
      dimensions: { ...DEFAULT_DIMENSIONS[type], ...(type === "plate" ? { width: 2, depth: 2 } : {}) },
      position: [((spread % 5) - 2) * 1.2, type === "ramp" ? 0 : 1.5, Math.floor(spread / 5) * 1.2],
      ...(type === "ramp" || type === "plate" ? { is_static: true, mass: null } : {}),
    };
    // Mass suggestion from material density × volume (the resolver does this when mass is omitted).
    const next = makeScenario({ ...base, objects: [...base.objects, obj] });
    get().loadScenario(next, { variant: key, keepTime: false });
    set({ selectedId: id, rightTab: "params" });
    const density = MATERIALS[material]?.density;
    const resolved = get().variants[key]?.validation.resolved.objects.find((o) => o.id === id);
    if (resolved?.dynamic && density) get().showToast(`Added a ${material} ${type}: suggested mass ${resolved.mass.toPrecision(3)} kg from its density (${density} kg/m³).`);
  },
  deleteObject(id) {
    const s = get();
    const v = s.variants[s.editing];
    if (!v) return;
    const next = makeScenario({
      ...v.scenario,
      objects: v.scenario.objects.filter((o) => o.id !== id),
      links: v.scenario.links.filter((l) => l.object_a !== id && l.object_b !== id),
      forces: v.scenario.forces.map((f) => ({ ...f, applies_to: f.applies_to.filter((x) => x !== id) })),
    });
    get().loadScenario(next, { variant: s.editing, keepTime: false });
    set({ selectedId: null });
  },
  moveObject(id, position) {
    const s = get();
    const v = s.variants[s.editing];
    const o = v?.scenario.objects.find((x) => x.id === id);
    if (!v || !o) return;
    const changes: Change[] = [{ path: `objects.${id}.position`, value: position }];
    if (o.placement && o.placement.kind !== "none") changes.push({ path: `objects.${id}.placement`, value: { kind: "none" } });
    s.updateScenario(changes);
  },
  setMaterial(id, material) {
    const m = MATERIALS[material];
    const s = get();
    const v = s.variants[s.editing];
    const o = v?.scenario.objects.find((x) => x.id === id);
    if (!m || !o || !v) return;
    s.updateScenario([
      { path: `objects.${id}.material.name`, value: m.name },
      { path: `objects.${id}.material.friction_coefficient`, value: m.friction },
      { path: `objects.${id}.material.restitution`, value: m.restitution },
      { path: `objects.${id}.material.density`, value: m.density },
      { path: `objects.${id}.material.color`, value: m.color },
    ]);
    const after = get().variants[s.editing]?.validation.resolved.objects.find((x) => x.id === id);
    if (after?.dynamic) {
      const suggested = suggestMass(o.type, after.dims, m.density, after.hollow);
      get().showToast(`Looks like ${m.name.replace("_", " ")}: μ ≈ ${m.friction}, e ≈ ${m.restitution}. A ${after.hollow ? "hollow" : "solid"} one this size would weigh about ${suggested.toPrecision(3)} kg — use “Suggested mass” to apply it.`);
    }
  },
  addForce(objectId, type) {
    const s = get();
    const v = s.variants[s.editing];
    if (!v) return;
    const base = type === "impulse" ? "kick" : "push";
    let id = `${base}_${objectId}`;
    for (let i = 2; v.scenario.forces.some((f) => f.id === id); i++) id = `${base}_${objectId}_${i}`;
    const o = v.validation.resolved.objects.find((x) => x.id === objectId);
    const magnitude = Number(((o?.mass ?? 1) * (type === "impulse" ? 2 : 5)).toPrecision(2));
    const next = makeScenario({
      ...v.scenario,
      forces: [
        ...v.scenario.forces,
        { id, type, magnitude, direction: [1, 0, 0], applies_to: [objectId], start_time: 0, end_time: type === "applied_force" ? Math.min(2, v.scenario.environment.simulation_duration) : null },
      ],
    });
    get().loadScenario(next, { variant: s.editing, keepTime: true });
    get().showToast(type === "impulse" ? `Added a ${magnitude} N·s kick along +x — adjust it under “${id}”.` : `Added a ${magnitude} N push along +x for 2 s — adjust it under “${id}”.`);
  },
  removeForce(forceId) {
    const s = get();
    const v = s.variants[s.editing];
    if (!v) return;
    get().loadScenario(makeScenario({ ...v.scenario, forces: v.scenario.forces.filter((f) => f.id !== forceId) }), { variant: s.editing, keepTime: true });
  },
  setRightTab: (t) => set({ rightTab: t }),
  setMobileTab: (t) => set({ mobileTab: t }),
  setLibraryOpen: (open) => set({ libraryOpen: open }),
  saveCurrent(name) {
    const a = get().variants[get().editing];
    if (!a) return;
    const entry: SavedScenario = { id: uid(), name: name || a.scenario.metadata.name, at: Date.now(), scenario: a.scenario };
    const saved = [entry, ...get().saved].slice(0, 100);
    set({ saved });
    get().showToast(saveJson(SAVED_KEY, saved) ? `Saved “${entry.name}” to your library.` : "Couldn't save — browser storage is unavailable.");
  },
  deleteSaved(id) {
    const saved = get().saved.filter((x) => x.id !== id);
    set({ saved });
    saveJson(SAVED_KEY, saved);
  },
  showToast(text) {
    const id = Date.now();
    set({ toast: { text, id } });
    setTimeout(() => {
      if (get().toast?.id === id) set({ toast: null });
    }, 4500);
  },
  requestFrame: () => set((s) => ({ frameRequest: s.frameRequest + 1 })),
}));

export function suggestMass(type: ObjectType, d: { radius: number; width: number; height: number; depth: number }, density: number, hollow: boolean): number {
  switch (type) {
    case "sphere":
      return density * (4 / 3) * Math.PI * (hollow ? d.radius ** 3 - (0.9 * d.radius) ** 3 : d.radius ** 3);
    case "cylinder":
      return density * Math.PI * (hollow ? d.radius ** 2 - (0.9 * d.radius) ** 2 : d.radius ** 2) * d.height;
    default:
      return density * d.width * d.height * d.depth;
  }
}

function recordRun(v: Variant) {
  const { history } = useStore.getState();
  const entry: RunEntry = { id: uid(), at: Date.now(), name: v.scenario.metadata.name, scenario: v.scenario, metrics: v.metrics, headline: headlineOf(v) };
  const last = history[0];
  const same = last && JSON.stringify(last.scenario) === JSON.stringify(v.scenario);
  const next = same ? history : [entry, ...history].slice(0, 30);
  // The baseline for "what changed?" explanations is the last run the user explicitly started.
  useStore.setState({ history: next, baseline: { scenario: v.scenario, metrics: v.metrics, predictions: predictionSummaries(v) } });
  saveJson(HISTORY_KEY, next);
}
