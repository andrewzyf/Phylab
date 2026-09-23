import { useMemo, useState } from "react";
import { accelerationAtIndex, type Recording } from "@physicslab/shared";
import { SERIES, useThrottledTime } from "../hooks";
import { objectLabels, useStore } from "../store";
import { LineChart, type ChartSeries } from "./LineChart";

type Quantity = "speed" | "height" | "distance" | "position" | "velocity" | "acceleration" | "kinetic";

const QUANTITIES: { id: Quantity; label: string; unit: string; multi: boolean }[] = [
  { id: "speed", label: "Speed", unit: "m/s", multi: false },
  { id: "height", label: "Height (y)", unit: "m", multi: false },
  { id: "distance", label: "Distance from start", unit: "m", multi: false },
  { id: "acceleration", label: "Acceleration magnitude", unit: "m/s²", multi: false },
  { id: "kinetic", label: "Kinetic energy", unit: "J", multi: false },
  { id: "position", label: "Position components", unit: "m", multi: true },
  { id: "velocity", label: "Velocity components", unit: "m/s", multi: true },
];

function extract(rec: Recording, id: string, q: Quantity): { label: string; values: Float64Array }[] {
  const tr = rec.bodies[id];
  if (!tr?.dynamic) return [];
  const n = rec.sampleCount;
  const one = (f: (i: number) => number) => {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = f(i);
    return out;
  };
  const p = tr.pos;
  const v = tr.vel;
  switch (q) {
    case "speed":
      return [{ label: "speed", values: one((i) => Math.hypot(v[i * 3], v[i * 3 + 1], v[i * 3 + 2])) }];
    case "height":
      return [{ label: "y", values: one((i) => p[i * 3 + 1]) }];
    case "distance":
      return [{ label: "distance", values: one((i) => Math.hypot(p[i * 3] - p[0], p[i * 3 + 1] - p[1], p[i * 3 + 2] - p[2])) }];
    case "acceleration":
      return [{ label: "|a|", values: one((i) => Math.hypot(...accelerationAtIndex(rec, id, i))) }];
    case "kinetic":
      return [{ label: "KE", values: one((i) => tr.kinetic[i]) }];
    case "position":
      return ["x", "y", "z"].map((c, k) => ({ label: c, values: one((i) => p[i * 3 + k]) }));
    case "velocity":
      return ["vx", "vy", "vz"].map((c, k) => ({ label: c, values: one((i) => v[i * 3 + k]) }));
  }
}

export function ChartsPanel() {
  const a = useStore((s) => s.variants.A);
  const b = useStore((s) => (s.compare ? s.variants.B : undefined));
  const history = useStore((s) => s.history);
  const overlays = useStore((s) => s.overlays);
  const overlayRecordings = useStore((s) => s.overlayRecordings);
  const seek = useStore((s) => s.seek);
  const pause = useStore((s) => s.pause);
  const setTab = useStore((s) => s.setRightTab);
  const t = useThrottledTime(15);
  const [quantity, setQuantity] = useState<Quantity>("speed");
  const [objectSel, setObjectSel] = useState<string>("auto");

  const rec = a?.recording ?? null;
  const labels = objectLabels(a?.scenario);
  const dyn = rec ? rec.bodyOrder.filter((id) => rec.bodies[id].dynamic) : [];
  const q = QUANTITIES.find((x) => x.id === quantity)!;
  const hasOverlays = !!b?.recording || overlays.length > 0;
  const objectId = objectSel === "auto" ? (hasOverlays || q.multi || dyn.length > 4 ? dyn[0] : "all") : objectSel;

  const series = useMemo<ChartSeries[]>(() => {
    if (!rec) return [];
    const out: ChartSeries[] = [];
    const push = (id: string, label: string, times: Float64Array, values: Float64Array, dashed = false) => out.push({ id, label, color: SERIES[out.length % SERIES.length], times, values, dashed });
    if (objectId === "all") {
      for (const id of dyn.slice(0, 8)) for (const s of extract(rec, id, quantity)) push(`A-${id}`, labels[id] ?? id, rec.times, s.values);
      return out;
    }
    if (!objectId) return out;
    for (const s of extract(rec, objectId, quantity)) push(`A-${s.label}`, q.multi ? s.label : `${b ? "A: " : ""}${labels[objectId] ?? objectId}`, rec.times, s.values);
    if (b?.recording && b.recording.bodies[objectId]) {
      for (const s of extract(b.recording, objectId, quantity).slice(0, q.multi ? 3 : 1)) push(`B-${s.label}`, q.multi ? `B: ${s.label}` : `B: ${objectLabels(b.scenario)[objectId] ?? objectId}`, b.recording.times, s.values, true);
    }
    if (!q.multi) {
      for (const runId of overlays) {
        const r = overlayRecordings[runId];
        const run = history.find((h) => h.id === runId);
        if (!r || !run || !r.bodies[objectId]) continue;
        const idx = history.indexOf(run);
        for (const s of extract(r, objectId, quantity).slice(0, 1)) push(`R-${runId}`, `Run #${history.length - idx}: ${run.name}`, r.times, s.values, true);
      }
    }
    return out.slice(0, 8);
  }, [rec, b?.recording, objectId, quantity, overlays, overlayRecordings, history]);

  const energySeries = useMemo<ChartSeries[]>(() => {
    if (!rec) return [];
    const base: ChartSeries[] = [
      { id: "ke", label: "Kinetic", color: SERIES[0], times: rec.times, values: rec.energy.kinetic },
      { id: "pe", label: "Potential (gravity)", color: SERIES[1], times: rec.times, values: rec.energy.gravitational },
      { id: "tot", label: "Total", color: SERIES[2], times: rec.times, values: rec.energy.total },
    ];
    const hasElastic = rec.energy.elastic.some((x) => Math.abs(x) > 1e-9);
    if (hasElastic) base.splice(2, 0, { id: "el", label: "Elastic (springs)", color: SERIES[3], times: rec.times, values: rec.energy.elastic });
    if (b?.recording) base.push({ id: "b-tot", label: "B: total", color: SERIES[hasElastic ? 4 : 3], times: b.recording.times, values: b.recording.energy.total, dashed: true });
    return base;
  }, [rec, b?.recording]);

  if (!rec) return <p className="muted">Run a simulation to see graphs.</p>;
  const onSeek = (x: number) => {
    pause();
    seek(x);
  };
  return (
    <div className="charts-panel">
      <div className="chart-controls">
        <label>
          <span className="sr-only">Quantity</span>
          <select value={quantity} onChange={(e) => setQuantity(e.target.value as Quantity)}>
            {QUANTITIES.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">Object</span>
          <select value={objectSel} onChange={(e) => setObjectSel(e.target.value)}>
            <option value="auto">{q.multi || hasOverlays || dyn.length > 4 ? `${labels[dyn[0]] ?? "First object"}` : "All objects"}</option>
            {!q.multi && !hasOverlays && dyn.length > 1 && dyn.length <= 8 ? <option value="all">All objects</option> : null}
            {dyn.map((id) => (
              <option key={id} value={id}>
                {labels[id] ?? id}
              </option>
            ))}
          </select>
        </label>
      </div>
      {dyn.length ? (
        <LineChart title={q.label} unit={q.unit} series={series} cursorTime={t} onSeek={onSeek} />
      ) : (
        <p className="muted">No moving objects.</p>
      )}
      <LineChart title="System energy" unit="J" series={energySeries} cursorTime={t} onSeek={onSeek} height={170} />
      <p className="muted small">
        Click a graph to jump to that moment. Overlay earlier runs from{" "}
        <button type="button" className="link-button" onClick={() => setTab("history")}>
          History
        </button>
        .
      </p>
    </div>
  );
}
