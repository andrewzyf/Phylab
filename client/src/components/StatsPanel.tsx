import { useState } from "react";
import { accelerationAt, bodyStateAt, energyAt, vec, type PredictionCheck } from "@physicslab/shared";
import { useThrottledTime } from "../hooks";
import { fmt, fmtUnit, fmtVec, signed } from "../lib/format";
import { objectLabels, useStore } from "../store";
import { Icon } from "./Icon";

function LiveStats() {
  const v = useStore((s) => s.variants[s.editing]);
  const t = useThrottledTime(12);
  const [showAll, setShowAll] = useState(false);
  const rec = v?.recording;
  if (!v) return null;
  if (!rec) return <p className="muted">{v.status === "blocked" ? "Fix the scenario's errors to simulate it." : "Simulating…"}</p>;
  const labels = objectLabels(v.scenario);
  const colors = Object.fromEntries(v.validation.resolved.objects.map((o) => [o.id, o.color]));
  const dyn = rec.bodyOrder.filter((id) => rec.bodies[id].dynamic);
  const shown = showAll ? dyn : dyn.slice(0, 4);
  const e = energyAt(rec, t);
  const e0 = rec.energy.total[0];
  return (
    <div className="live-stats">
      <div className="stat-tiles">
        <div className="stat-tile">
          <div className="stat-label">Time</div>
          <div className="stat-value">{fmt(t)} s</div>
        </div>
        <div className="stat-tile">
          <div className="stat-label">Kinetic energy</div>
          <div className="stat-value">{fmt(e.kinetic)} J</div>
        </div>
        <div className="stat-tile">
          <div className="stat-label">Potential energy</div>
          <div className="stat-value">{fmt(e.gravitational + e.elastic)} J</div>
        </div>
        <div className="stat-tile">
          <div className="stat-label">Total energy</div>
          <div className="stat-value">{fmt(e.total)} J</div>
          <div className="stat-delta muted">{signed(e.total - e0)} J since t = 0</div>
        </div>
      </div>
      <table className="stats-table">
        <thead>
          <tr>
            <th>Object</th>
            <th>Speed</th>
            <th>Accel.</th>
            <th>Height</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((id) => {
            const s = bodyStateAt(rec, id, t)!;
            const a = accelerationAt(rec, id, t);
            return (
              <tr key={id}>
                <td>
                  <span className="swatch" style={{ background: colors[id] }} />
                  {labels[id] ?? id}
                </td>
                <td>{fmtUnit(vec.len(s.velocity), "m/s")}</td>
                <td>{fmtUnit(vec.len(a), "m/s²")}</td>
                <td>{fmtUnit(s.position[1], "m")}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {dyn.length > 4 ? (
        <button type="button" className="link-button" onClick={() => setShowAll((x) => !x)}>
          {showAll ? "Show fewer" : `Show all ${dyn.length} objects`}
        </button>
      ) : null}
      {shown.slice(0, 2).map((id) => {
        const s = bodyStateAt(rec, id, t)!;
        const a = accelerationAt(rec, id, t);
        return (
          <dl key={id} className="vec-list small">
            <dt>{labels[id]}</dt>
            <dd>
              position {fmtVec(s.position)} m · velocity {fmtVec(s.velocity)} m/s · acceleration {fmtVec(a)} m/s² · KE {fmt(s.kinetic)} J
            </dd>
          </dl>
        );
      })}
    </div>
  );
}

function checkIcon(c: PredictionCheck) {
  if (c.agrees === true) return <span className="ok" title="Simulation agrees with theory"><Icon name="check" size={14} /></span>;
  if (c.agrees === false) return <span className="warn" title="Differs from the closed-form prediction"><Icon name="warning" size={14} /></span>;
  return <span className="muted">…</span>;
}

export function PredictionsTable() {
  const v = useStore((s) => s.variants[s.editing]);
  const [open, setOpen] = useState<string | null>(null);
  if (!v) return null;
  if (!v.checks.length)
    return <p className="muted small">No closed-form prediction applies to this setup (e.g. many interacting objects), so there's nothing to check against — the simulation is the answer.</p>;
  return (
    <div className="predictions">
      <table className="pred-table">
        <thead>
          <tr>
            <th>Quantity</th>
            <th>Theory</th>
            <th>Simulated</th>
            <th aria-label="Agreement" />
          </tr>
        </thead>
        <tbody>
          {v.checks.map((c) => {
            const p = c.prediction;
            const diff = c.error === null ? null : p.unit === "%" ? `${signed(c.error, 2)} pts` : `${signed(c.error * 100, 2)}%`;
            return (
              <tr key={p.id} onClick={() => setOpen(open === p.id ? null : p.id)} className={open === p.id ? "open" : ""}>
                <td>
                  {p.label}
                  {open === p.id ? <div className="formula">{p.formula}</div> : null}
                </td>
                <td>{fmtUnit(p.value, p.unit)}</td>
                <td>
                  {p.measure ? (c.measured === null ? (v.status === "ready" ? "didn't happen" : "…") : fmtUnit(c.measured, p.unit)) : "—"}
                  {diff ? <div className="muted small">{diff}</div> : null}
                </td>
                <td>{p.measure ? checkIcon(c) : null}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="muted small">Theory comes from PhysicsLab's closed-form solver; "Simulated" is measured from the 3D run. Click a row for the formula.</p>
    </div>
  );
}

function Insights() {
  const explanation = useStore((s) => s.explanation);
  const request = useStore((s) => s.requestExplanation);
  const applyVariation = useStore((s) => s.applyVariation);
  const ai = useStore((s) => s.health?.ai.enabled);
  const ready = useStore((s) => s.variants.A?.status === "ready");
  const [q, setQ] = useState("");
  const r = explanation.result;
  return (
    <div className="insights">
      {explanation.status === "loading" ? (
        <div className="thinking" role="status">
          <span className="dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          {ai ? "Asking the physics tutor…" : "Analysing…"}
        </div>
      ) : r ? (
        <div className="insight-card">
          <div className="interp-source">
            {r.source === "ai" ? (
              <span className="badge badge-ai">
                <Icon name="sparkle" size={12} /> {r.model}
              </span>
            ) : (
              <span className="badge">Rule-based analysis</span>
            )}
          </div>
          {explanation.question ? <p className="muted small">Q: {explanation.question}</p> : null}
          <p>{r.explanation}</p>
          {r.key_points.length ? (
            <ul>
              {r.key_points.map((k) => (
                <li key={k}>{k}</li>
              ))}
            </ul>
          ) : null}
          {r.suggestions.length ? (
            <div className="chips">
              {r.suggestions.map((s) => (
                <button key={s.label} type="button" className="chip chip-accent" title={s.description} onClick={() => applyVariation(s)}>
                  {s.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      <form
        className="ask-row"
        onSubmit={(e) => {
          e.preventDefault();
          void request(q.trim() || undefined);
          setQ("");
        }}
      >
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask about the results (optional)…" aria-label="Question about the results" />
        <button type="submit" className="button" disabled={!ready || explanation.status === "loading"}>
          <Icon name="sparkle" size={14} /> {q.trim() ? "Ask" : "Explain results"}
        </button>
      </form>
    </div>
  );
}

export function StatsPanel() {
  return (
    <div className="stats-panel">
      <h3 className="panel-title">Live values</h3>
      <LiveStats />
      <h3 className="panel-title">Theory vs simulation</h3>
      <PredictionsTable />
      <h3 className="panel-title">Insights</h3>
      <Insights />
    </div>
  );
}
