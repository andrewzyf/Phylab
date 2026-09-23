import { fmtUnit } from "../lib/format";
import { useStore } from "../store";
import { Icon } from "./Icon";

export function HistoryPanel() {
  const history = useStore((s) => s.history);
  const overlays = useStore((s) => s.overlays);
  const toggleOverlay = useStore((s) => s.toggleOverlay);
  const restore = useStore((s) => s.restoreRun);
  const remove = useStore((s) => s.removeRun);
  if (!history.length) return <p className="muted">Every time you press Run, the run is saved here with its key results so you can compare and overlay them on the graphs.</p>;
  return (
    <ol className="history">
      {history.map((r, i) => (
        <li key={r.id} className="history-item">
          <div className="history-head">
            <span className="history-num">#{history.length - i}</span>
            <strong>{r.name}</strong>
            <span className="muted small">{new Date(r.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
          </div>
          <ul className="history-metrics small">
            {r.headline.map((h) => (
              <li key={h.label}>
                <span className="muted">{h.label}</span> <strong>{fmtUnit(h.value, h.unit)}</strong>
              </li>
            ))}
          </ul>
          <div className="row-buttons">
            <label className="check">
              <input type="checkbox" checked={overlays.includes(r.id)} onChange={() => toggleOverlay(r.id)} /> Overlay on graphs
            </label>
            <button type="button" className="link-button" onClick={() => restore(r.id)}>
              Restore
            </button>
            <button type="button" className="icon-link" aria-label={`Delete run ${history.length - i}`} onClick={() => remove(r.id)}>
              <Icon name="trash" size={14} />
            </button>
          </div>
        </li>
      ))}
    </ol>
  );
}
