import { useEffect, useMemo, useState } from "react";
import { diffScenarios, getPath, MATERIALS } from "@physicslab/shared";
import { fmt } from "../lib/format";
import { fromSlider, paramGroups, toSlider, type ParamSpec } from "../lib/params";
import { suggestMass, useStore } from "../store";
import { Icon } from "./Icon";

function NumberField({ spec, onCommit }: { spec: ParamSpec; onCommit: (v: number) => void }) {
  const [text, setText] = useState(fmtInput(spec.value as number));
  useEffect(() => setText(fmtInput(spec.value as number)), [spec.value]);
  const commit = () => {
    const v = Number.parseFloat(text.replace("−", "-"));
    if (Number.isFinite(v) && v !== spec.value) onCommit(v);
    else setText(fmtInput(spec.value as number));
  };
  return (
    <input
      className="num-input"
      inputMode="decimal"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
      aria-label={`${spec.label} value`}
    />
  );
}

function fmtInput(v: number) {
  if (!Number.isFinite(v)) return "";
  const a = Math.abs(v);
  return a !== 0 && (a >= 1e6 || a < 1e-3) ? v.toExponential(3) : String(Number.parseFloat(v.toPrecision(5)));
}

function ParamRow({ spec }: { spec: ParamSpec }) {
  const update = useStore((s) => s.updateScenario);
  const set = (v: number | boolean) => update([{ path: spec.path, value: v }]);
  if (spec.kind === "boolean") {
    return (
      <label className="param param-bool">
        <span>{spec.label}</span>
        <input type="checkbox" className="switch" checked={spec.value as boolean} onChange={(e) => set(e.target.checked)} />
      </label>
    );
  }
  const v = spec.value as number;
  const isLog = spec.scale === "log";
  return (
    <div className="param">
      <div className="param-head">
        <label htmlFor={`p-${spec.path}`}>{spec.label}</label>
        <span className="param-value">
          <NumberField spec={spec} onCommit={set} />
          <span className="unit">{spec.unit}</span>
        </span>
      </div>
      <input
        id={`p-${spec.path}`}
        type="range"
        min={isLog ? 0 : spec.min}
        max={isLog ? 1000 : spec.max}
        step={isLog ? 1 : spec.step}
        value={isLog ? toSlider(spec, v) : v}
        onChange={(e) => set(isLog ? fromSlider(spec, Number(e.target.value)) : Number(e.target.value))}
        style={{ ["--pct" as string]: `${isLog ? toSlider(spec, v) / 10 : ((v - spec.min) / (spec.max - spec.min || 1)) * 100}%` }}
      />
    </div>
  );
}

function MaterialPicker({ objectId, current }: { objectId: string; current: string }) {
  const setMaterial = useStore((s) => s.setMaterial);
  return (
    <label className="param param-select">
      <span>Material</span>
      <select value={MATERIALS[current] ? current : ""} onChange={(e) => e.target.value && setMaterial(objectId, e.target.value)}>
        <option value="">{MATERIALS[current] ? current : current || "custom"}</option>
        {Object.values(MATERIALS).map((m) => (
          <option key={m.name} value={m.name}>
            {m.name.replace("_", " ")} (μ {m.friction}, e {m.restitution})
          </option>
        ))}
      </select>
    </label>
  );
}

function SuggestedMass({ objectId }: { objectId: string }) {
  const v = useStore((s) => s.variants[s.editing]);
  const update = useStore((s) => s.updateScenario);
  const o = v?.scenario.objects.find((x) => x.id === objectId);
  const r = v?.validation.resolved.objects.find((x) => x.id === objectId);
  const density = o?.material.density ?? (o ? MATERIALS[o.material.name]?.density : undefined);
  if (!o || !r?.dynamic || !density) return null;
  const m = suggestMass(o.type, r.dims, density, r.hollow);
  if (Math.abs(m - r.mass) / r.mass < 0.02) return null;
  return (
    <div className="suggest small">
      A {r.hollow ? "hollow" : "solid"} {o.material.name.replace("_", " ")} {o.type} this size weighs ≈ {fmt(m)} kg.
      <button type="button" className="chip" onClick={() => update([{ path: `objects.${objectId}.mass`, value: Number(m.toPrecision(3)) }])}>
        Use {fmt(m)} kg
      </button>
    </div>
  );
}

function ChangeBanner() {
  const baseline = useStore((s) => s.baseline);
  const a = useStore((s) => s.variants.A);
  const editing = useStore((s) => s.editing);
  const request = useStore((s) => s.requestExplanation);
  const setTab = useStore((s) => s.setRightTab);
  const setMobileTab = useStore((s) => s.setMobileTab);
  const diffs = useMemo(() => {
    if (!baseline || !a) return [];
    // Only meaningful when the current scenario is an edit of the baseline (same set of objects).
    const ids = (s: typeof a.scenario) => s.objects.map((o) => o.id).sort().join("|");
    if (ids(baseline.scenario) !== ids(a.scenario)) return [];
    return diffScenarios(baseline.scenario, a.scenario);
  }, [baseline, a?.scenario]);
  if (editing !== "A" || !diffs.length) return null;
  return (
    <div className="change-banner">
      <span>
        {diffs.length} change{diffs.length === 1 ? "" : "s"} since the last run
      </span>
      <button
        type="button"
        className="chip chip-accent"
        onClick={() => {
          void request();
          setTab("stats");
          setMobileTab("stats");
        }}
      >
        <Icon name="sparkle" size={12} /> Explain the effect
      </button>
    </div>
  );
}

export function ParamsPanel() {
  const editing = useStore((s) => s.editing);
  const v = useStore((s) => s.variants[s.editing]);
  const compare = useStore((s) => s.compare);
  const setEditing = useStore((s) => s.setEditing);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const addForce = useStore((s) => s.addForce);
  const removeForce = useStore((s) => s.removeForce);
  const colors = useMemo(() => Object.fromEntries((v?.validation.resolved.objects ?? []).map((o) => [o.id, o.color])), [v?.validation.resolved]);
  const groups = useMemo(() => (v ? paramGroups(v.scenario, colors) : []), [v?.scenario, colors]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (!v) return <p className="muted">Nothing loaded yet.</p>;

  const isOpen = (id: string, i: number) => open[id] ?? (selectedId ? id === selectedId : i <= 2);

  return (
    <div className="params">
      {compare ? (
        <div className="segmented" role="radiogroup" aria-label="Variant being edited">
          {(["A", "B"] as const).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={editing === k} className={editing === k ? "on" : ""} onClick={() => setEditing(k)}>
              Editing {k}
            </button>
          ))}
        </div>
      ) : null}
      <ChangeBanner />
      <p className="muted small">Drag a slider and the simulation re-runs instantly. Click an object in the scene to jump to it.</p>
      {groups.map((g, i) => (
        <details
          key={g.id}
          className={`param-group ${selectedId === g.id ? "selected" : ""}`}
          open={isOpen(g.id, i)}
          onToggle={(e) => {
            const o = (e.target as HTMLDetailsElement).open;
            if (o !== isOpen(g.id, i)) setOpen((s) => ({ ...s, [g.id]: o }));
          }}
        >
          <summary onClick={() => g.id !== "environment" && v.scenario.objects.some((o) => o.id === g.id) && select(g.id)}>
            <Icon name="chevron" size={14} />
            {g.color ? <span className="swatch" style={{ background: g.color }} /> : null}
            <span className="group-title">{g.title}</span>
            {g.subtitle ? <span className="muted small">{g.subtitle}</span> : null}
          </summary>
          <div className="param-list">
            {v.scenario.objects.some((o) => o.id === g.id) ? (
              <>
                <MaterialPicker objectId={g.id} current={String(getPath(v.scenario, `objects.${g.id}.material.name`) ?? "")} />
                <SuggestedMass objectId={g.id} />
              </>
            ) : null}
            {g.params.map((p) => (
              <ParamRow key={p.path} spec={p} />
            ))}
            {v.validation.resolved.objects.some((o) => o.id === g.id && o.dynamic) ? (
              <div className="chips">
                <button type="button" className="chip" onClick={() => addForce(g.id, "applied_force")}>
                  <Icon name="plus" size={12} /> Add force
                </button>
                <button type="button" className="chip" onClick={() => addForce(g.id, "impulse")}>
                  <Icon name="plus" size={12} /> Add impulse
                </button>
              </div>
            ) : null}
            {v.scenario.forces.some((f) => f.id === g.id) ? (
              <button type="button" className="link-button small" onClick={() => removeForce(g.id)}>
                Remove this force
              </button>
            ) : null}
          </div>
        </details>
      ))}
    </div>
  );
}
