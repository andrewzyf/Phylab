import { diffScenarios } from "@physicslab/shared";
import { fmt, fmtUnit, signed } from "../lib/format";
import { objectLabels, useStore } from "../store";
import { Icon } from "./Icon";

function pct(a: number, b: number) {
  if (Math.abs(a) < 1e-12) return "";
  return `${signed(((b - a) / Math.abs(a)) * 100, 2)}%`;
}

export function ComparePanel() {
  const compare = useStore((s) => s.compare);
  const toggle = useStore((s) => s.toggleCompare);
  const copyAToB = useStore((s) => s.copyAToB);
  const a = useStore((s) => s.variants.A);
  const b = useStore((s) => s.variants.B);
  const editing = useStore((s) => s.editing);
  const setEditing = useStore((s) => s.setEditing);

  if (!compare || !b || !a) {
    return (
      <div className="compare-empty">
        <p>
          Run two versions of the scenario side by side — for example the same ramp with and without friction — and compare their results.
        </p>
        <button type="button" className="button button-primary" onClick={() => toggle(true)}>
          <Icon name="compare" size={16} /> Start side-by-side comparison
        </button>
      </div>
    );
  }
  const diffs = diffScenarios(a.scenario, b.scenario);
  const labels = objectLabels(a.scenario);
  const rows: { label: string; a: number | null; b: number | null; unit: string }[] = [];
  for (const oa of a.metrics?.objects ?? []) {
    const ob = b.metrics?.objects.find((x) => x.id === oa.id);
    const name = labels[oa.id] ?? oa.id;
    rows.push({ label: `${name}: max speed`, a: oa.maxSpeed, b: ob?.maxSpeed ?? null, unit: "m/s" });
    rows.push({ label: `${name}: final speed`, a: oa.finalSpeed, b: ob?.finalSpeed ?? null, unit: "m/s" });
    rows.push({ label: `${name}: distance travelled`, a: oa.pathLength, b: ob?.pathLength ?? null, unit: "m" });
    rows.push({ label: `${name}: max height`, a: oa.maxHeight, b: ob?.maxHeight ?? null, unit: "m" });
    rows.push({ label: `${name}: comes to rest at`, a: oa.timeToRest, b: ob?.timeToRest ?? null, unit: "s" });
  }
  for (const ca of a.checks) {
    const cb = b.checks.find((x) => x.prediction.id === ca.prediction.id);
    if (ca.prediction.unit === "%") continue;
    rows.push({ label: ca.prediction.label, a: ca.measured ?? ca.prediction.value, b: cb ? (cb.measured ?? cb.prediction.value) : null, unit: ca.prediction.unit });
  }
  if (a.metrics && b.metrics) rows.push({ label: "Energy lost", a: a.metrics.energyLostPercent, b: b.metrics.energyLostPercent, unit: "%" });

  return (
    <div className="compare-panel">
      <div className="segmented" role="radiogroup" aria-label="Variant being edited">
        {(["A", "B"] as const).map((k) => (
          <button key={k} type="button" role="radio" aria-checked={editing === k} className={editing === k ? "on" : ""} onClick={() => setEditing(k)}>
            Edit {k}
          </button>
        ))}
      </div>
      <p className="muted small">
        {diffs.length === 0 ? "B is identical to A — change B's parameters in the Parameters tab." : `B differs from A in ${diffs.length} parameter${diffs.length === 1 ? "" : "s"}:`}
      </p>
      {diffs.length ? (
        <ul className="diff-list small">
          {diffs.slice(0, 8).map((d) => (
            <li key={d.path}>
              <code>{d.path}</code>: {typeof d.from === "number" ? fmt(d.from) : String(d.from)} → <strong>{typeof d.to === "number" ? fmt(d.to) : String(d.to)}</strong>
            </li>
          ))}
        </ul>
      ) : null}
      <table className="compare-table">
        <thead>
          <tr>
            <th>Result</th>
            <th>A</th>
            <th>B</th>
            <th>Δ</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <td>{r.label}</td>
              <td>{r.a === null ? "—" : fmtUnit(r.a, r.unit)}</td>
              <td>{r.b === null ? "—" : fmtUnit(r.b, r.unit)}</td>
              <td className="muted">{r.a !== null && r.b !== null ? (r.unit === "%" ? `${signed(r.b - r.a, 2)} pts` : pct(r.a, r.b)) : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row-buttons">
        <button type="button" className="button" onClick={copyAToB}>
          Reset B to A
        </button>
        <button type="button" className="button" onClick={() => toggle(false)}>
          <Icon name="close" size={14} /> End comparison
        </button>
      </div>
    </div>
  );
}
