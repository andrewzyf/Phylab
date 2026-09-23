import { useEffect, useRef, useState } from "react";
import { parseScenario, PRESETS, presetScenario, type Preset } from "@physicslab/shared";
import { useStore } from "../store";
import { Icon } from "./Icon";

const CATEGORIES: Preset["category"][] = ["Mechanics", "Energy", "Oscillations", "Collisions", "Gravity", "Fun"];

export function LibraryDialog() {
  const open = useStore((s) => s.libraryOpen);
  const setOpen = useStore((s) => s.setLibraryOpen);
  const open_ = useStore((s) => s.openScenario);
  const saved = useStore((s) => s.saved);
  const saveCurrent = useStore((s) => s.saveCurrent);
  const deleteSaved = useStore((s) => s.deleteSaved);
  const showToast = useStore((s) => s.showToast);
  const current = useStore((s) => s.variants[s.editing]?.scenario.metadata.name ?? "");
  const [name, setName] = useState("");
  const ref = useRef<HTMLDialogElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  useEffect(() => setName(current), [current, open]);

  const pick = (fn: () => void) => {
    fn();
    setOpen(false);
  };

  return (
    <dialog ref={ref} className="dialog library" onClose={() => setOpen(false)} onClick={(e) => e.target === ref.current && setOpen(false)}>
      <div className="dialog-inner">
        <header className="dialog-head">
          <h2>Scenario library</h2>
          <button type="button" className="icon-link" aria-label="Close" onClick={() => setOpen(false)}>
            <Icon name="close" size={18} />
          </button>
        </header>
        <section>
          <h3 className="panel-title">Your scenarios</h3>
          <form
            className="save-row"
            onSubmit={(e) => {
              e.preventDefault();
              saveCurrent(name.trim() || undefined);
            }}
          >
            <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Name for the current scenario" placeholder="Name" />
            <button type="submit" className="button button-primary">
              <Icon name="save" size={14} /> Save current
            </button>
            <button type="button" className="button" onClick={() => fileRef.current?.click()}>
              <Icon name="upload" size={14} /> Import JSON
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (!f) return;
                try {
                  const parsed = parseScenario(JSON.parse(await f.text()));
                  if (!parsed.ok) throw new Error(parsed.errors.slice(0, 2).join("; "));
                  pick(() => open_(parsed.scenario, "from your file"));
                } catch (err) {
                  showToast(`That file isn't a valid scenario: ${(err as Error).message}`);
                }
              }}
            />
          </form>
          {saved.length ? (
            <ul className="saved-list">
              {saved.map((s) => (
                <li key={s.id}>
                  <button type="button" className="link-button" onClick={() => pick(() => open_(s.scenario, "from your saved scenarios"))}>
                    {s.name}
                  </button>
                  <span className="muted small">{new Date(s.at).toLocaleDateString()}</span>
                  <button type="button" className="icon-link" aria-label={`Delete ${s.name}`} onClick={() => deleteSaved(s.id)}>
                    <Icon name="trash" size={14} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">Saved scenarios are stored in this browser.</p>
          )}
        </section>
        {CATEGORIES.map((cat) => {
          const items = PRESETS.filter((p) => p.category === cat);
          if (!items.length) return null;
          return (
            <section key={cat}>
              <h3 className="panel-title">{cat}</h3>
              <div className="preset-grid">
                {items.map((p) => (
                  <button key={p.id} type="button" className="preset-card" onClick={() => pick(() => open_(presetScenario(p.id), "from the library"))}>
                    <strong>{p.title}</strong>
                    <span className="muted small">{p.summary}</span>
                  </button>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </dialog>
  );
}
