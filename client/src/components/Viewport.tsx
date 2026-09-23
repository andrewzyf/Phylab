import { useEffect, useRef } from "react";
import type { ObjectType } from "@physicslab/shared";
import { cssVar, useThrottledTime, type Theme } from "../hooks";
import { fmt, fmtTime } from "../lib/format";
import { SceneView } from "../three/SceneView";
import { useStore, type VariantKey, type ViewOptions } from "../store";
import { Icon, type IconName } from "./Icon";

const views = new Map<VariantKey, SceneView>();
export const getSceneView = (k: VariantKey = "A") => views.get(k);

function sceneTheme() {
  return {
    background: cssVar("--scene-bg") || "#12151b",
    ground: cssVar("--scene-ground") || "#1c2029",
    grid: cssVar("--scene-grid") || "#2a303a",
    gridMajor: cssVar("--scene-grid-major") || "#3a4250",
    text: cssVar("--text-primary") || "#fff",
  };
}

function SceneCanvas({ variantKey, theme, linked }: { variantKey: VariantKey; theme: Theme; linked: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const viewRef = useRef<SceneView | null>(null);
  const variant = useStore((s) => s.variants[variantKey]);
  const view = useStore((s) => s.view);
  const selectedId = useStore((s) => s.selectedId);
  const editMode = useStore((s) => s.editMode);
  const editing = useStore((s) => s.editing);
  const frameRequest = useStore((s) => s.frameRequest);

  useEffect(() => {
    const el = ref.current!;
    const sv = new SceneView(el, () => useStore.getState().time, {
      onSelect: (id) => {
        const s = useStore.getState();
        s.select(id);
        if (s.editing !== variantKey && s.compare) s.setEditing(variantKey);
        if (id && window.innerWidth >= 1100) s.setRightTab("params");
      },
      onMoved: (id, p) => useStore.getState().moveObject(id, p),
      onCameraChange: () => {
        if (!useStore.getState().compare) return;
        for (const [k, other] of views) if (k !== variantKey) other.copyCamera(sv);
      },
    }, sceneTheme());
    viewRef.current = sv;
    views.set(variantKey, sv);
    return () => {
      sv.dispose();
      views.delete(variantKey);
      viewRef.current = null;
    };
  }, [variantKey]);

  useEffect(() => {
    viewRef.current?.setTheme(sceneTheme());
  }, [theme]);

  useEffect(() => {
    const sv = viewRef.current;
    if (!sv || !variant) return;
    sv.setScenario(variant.validation.resolved, variant.recording);
  }, [variant?.validation.resolved, variant?.recording]);

  useEffect(() => {
    const sv = viewRef.current;
    if (!sv) return;
    sv.frame();
    if (linked) for (const [k, other] of views) if (k !== variantKey) other.copyCamera(sv);
  }, [frameRequest, !!variant?.recording, variant?.scenario.metadata.name]);

  useEffect(() => viewRef.current?.setView(view), [view]);
  useEffect(() => viewRef.current?.setSelected(editing === variantKey ? selectedId : null), [selectedId, editing]);
  useEffect(() => viewRef.current?.setEditMode(editMode && editing === variantKey), [editMode, editing]);

  return <div className="scene-host" ref={ref} />;
}

function StatusOverlay({ variantKey }: { variantKey: VariantKey }) {
  const v = useStore((s) => s.variants[variantKey]);
  const compare = useStore((s) => s.compare);
  const editing = useStore((s) => s.editing);
  if (!v) return null;
  const errors = v.validation.issues.filter((i) => i.severity === "error");
  return (
    <div className="scene-status">
      {compare ? <span className={`variant-tag ${editing === variantKey ? "active" : ""}`}>{variantKey}</span> : null}
      <span className="scene-name">{v.scenario.metadata.name}</span>
      {v.status === "simulating" ? <span className="pill">Simulating… {v.progress > 0.02 ? `${Math.round(v.progress * 100)}%` : ""}</span> : null}
      {v.status === "blocked" ? (
        <span className="pill pill-error" title={errors.map((e) => e.message).join("\n")}>
          <Icon name="error" size={14} /> {errors.length} problem{errors.length === 1 ? "" : "s"} to fix
        </span>
      ) : null}
      {v.status === "error" ? <span className="pill pill-error">Simulation failed: {v.error}</span> : null}
      {v.recording?.warnings.map((w) => (
        <span key={w} className="pill pill-warn">
          {w}
        </span>
      ))}
    </div>
  );
}

const TOGGLES: { key: keyof ViewOptions; icon: IconName; label: string }[] = [
  { key: "trails", icon: "trail", label: "Trajectories" },
  { key: "vectors", icon: "vector", label: "Velocity & force arrows" },
  { key: "labels", icon: "label", label: "Labels" },
  { key: "grid", icon: "grid", label: "Grid" },
  { key: "axes", icon: "axes", label: "XYZ axes" },
  { key: "follow", icon: "follow", label: "Follow selected object" },
];

function ViewToolbar() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const requestFrame = useStore((s) => s.requestFrame);
  return (
    <div className="toolbar toolbar-view" role="toolbar" aria-label="View options">
      {TOGGLES.map((t) => (
        <button key={t.key} type="button" className={`tool ${view[t.key] ? "on" : ""}`} aria-pressed={view[t.key]} title={t.label} aria-label={t.label} onClick={() => setView({ [t.key]: !view[t.key] })}>
          <Icon name={t.icon} size={17} />
        </button>
      ))}
      <span className="toolbar-sep" />
      <button type="button" className="tool" title="Zoom in" aria-label="Zoom in" onClick={() => views.forEach((v) => v.zoom(0.8))}>
        <Icon name="zoomIn" size={17} />
      </button>
      <button type="button" className="tool" title="Zoom out" aria-label="Zoom out" onClick={() => views.forEach((v) => v.zoom(1.25))}>
        <Icon name="zoomOut" size={17} />
      </button>
      <button type="button" className="tool" title="Frame everything" aria-label="Frame everything" onClick={requestFrame}>
        <Icon name="frame" size={17} />
      </button>
    </div>
  );
}

const SHAPES: { type: ObjectType; icon: IconName; label: string }[] = [
  { type: "sphere", icon: "sphere", label: "Add sphere" },
  { type: "box", icon: "box", label: "Add box" },
  { type: "cylinder", icon: "cylinder", label: "Add cylinder" },
  { type: "ramp", icon: "ramp", label: "Add ramp" },
  { type: "plate", icon: "plate", label: "Add plate / wall" },
];

function BuilderToolbar() {
  const addObject = useStore((s) => s.addObject);
  const editMode = useStore((s) => s.editMode);
  const setEditMode = useStore((s) => s.setEditMode);
  const selectedId = useStore((s) => s.selectedId);
  const deleteObject = useStore((s) => s.deleteObject);
  return (
    <div className="toolbar toolbar-build" role="toolbar" aria-label="Build">
      {SHAPES.map((s) => (
        <button key={s.type} type="button" className="tool" title={s.label} aria-label={s.label} onClick={() => addObject(s.type)}>
          <Icon name={s.icon} size={17} />
        </button>
      ))}
      <span className="toolbar-sep" />
      <button
        type="button"
        className={`tool ${editMode ? "on" : ""}`}
        aria-pressed={editMode}
        title={selectedId ? "Drag the selected object (rewinds to t = 0)" : "Select an object, then drag it"}
        aria-label="Move mode"
        onClick={() => setEditMode(!editMode)}
      >
        <Icon name="move" size={17} />
      </button>
      <button type="button" className="tool" disabled={!selectedId} title="Delete selected object" aria-label="Delete selected object" onClick={() => selectedId && deleteObject(selectedId)}>
        <Icon name="trash" size={17} />
      </button>
    </div>
  );
}

const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4];

export function PlaybackBar() {
  const playing = useStore((s) => s.playing);
  const togglePlay = useStore((s) => s.togglePlay);
  const reset = useStore((s) => s.reset);
  const seek = useStore((s) => s.seek);
  const speed = useStore((s) => s.speed);
  const setSpeed = useStore((s) => s.setSpeed);
  const loop = useStore((s) => s.loop);
  const setLoop = useStore((s) => s.setLoop);
  const run = useStore((s) => s.run);
  const durA = useStore((s) => s.variants.A?.recording?.duration ?? s.variants.A?.scenario.environment.simulation_duration ?? 0);
  const durB = useStore((s) => (s.compare ? (s.variants.B?.recording?.duration ?? 0) : 0));
  const ready = useStore((s) => !!s.variants.A?.recording);
  const t = useThrottledTime(30);
  const duration = Math.max(durA, durB);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable]")) return;
      if (e.code === "Space") {
        e.preventDefault();
        useStore.getState().togglePlay();
      } else if (e.key === "r" || e.key === "R") useStore.getState().reset();
      else if (e.key === "ArrowRight") useStore.getState().seek(useStore.getState().time + 0.1);
      else if (e.key === "ArrowLeft") useStore.getState().seek(Math.max(0, useStore.getState().time - 0.1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="playback" role="group" aria-label="Playback">
      <button type="button" className="button button-primary icon-button" onClick={t === 0 && !playing ? run : togglePlay} disabled={!ready} aria-label={playing ? "Pause (space)" : "Play (space)"} title={playing ? "Pause (space)" : "Play (space)"}>
        <Icon name={playing ? "pause" : "play"} size={16} />
      </button>
      <button type="button" className="button icon-button" onClick={reset} aria-label="Reset to start (R)" title="Reset to start (R)">
        <Icon name="reset" size={16} />
      </button>
      <input
        className="timeline"
        type="range"
        min={0}
        max={duration || 1}
        step={0.001}
        value={Math.min(t, duration)}
        onChange={(e) => {
          useStore.getState().pause();
          seek(Number(e.target.value));
        }}
        aria-label="Timeline"
        style={{ ["--pct" as string]: `${duration ? (Math.min(t, duration) / duration) * 100 : 0}%` }}
      />
      <span className="time-readout" aria-live="off">
        {fmtTime(t)} <span className="muted">/ {fmt(duration)} s</span>
      </span>
      <select className="speed" value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Playback speed" title="Playback speed (slow motion below 1×)">
        {SPEEDS.map((s) => (
          <option key={s} value={s}>
            {s}×
          </option>
        ))}
      </select>
      <button type="button" className={`button icon-button ${loop ? "on" : ""}`} aria-pressed={loop} onClick={() => setLoop(!loop)} aria-label="Loop" title="Loop">
        <Icon name="loop" size={16} />
      </button>
    </div>
  );
}

function VectorLegend() {
  const vectors = useStore((s) => s.view.vectors);
  if (!vectors) return null;
  return (
    <div className="vector-legend small">
      <span>
        <i style={{ background: "#3fd07f" }} /> velocity
      </span>
      <span>
        <i style={{ background: "#ff9f43" }} /> acceleration (net force ÷ m)
      </span>
      <span>
        <i style={{ background: "#e34948" }} /> applied force
      </span>
    </div>
  );
}

export function Viewport({ theme }: { theme: Theme }) {
  const compare = useStore((s) => s.compare);
  const hasB = useStore((s) => !!s.variants.B);
  return (
    <section className="viewport" aria-label="3D simulation">
      <div className={`scenes ${compare && hasB ? "split" : ""}`}>
        <div className="scene-cell">
          <SceneCanvas variantKey="A" theme={theme} linked={compare} />
          <StatusOverlay variantKey="A" />
        </div>
        {compare && hasB ? (
          <div className="scene-cell">
            <SceneCanvas variantKey="B" theme={theme} linked={compare} />
            <StatusOverlay variantKey="B" />
          </div>
        ) : null}
        <ViewToolbar />
        <BuilderToolbar />
        <VectorLegend />
      </div>
      <PlaybackBar />
    </section>
  );
}
