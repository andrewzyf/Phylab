import { useEffect, useRef, useState } from "react";
import type { Theme } from "../hooks";
import { download, markdownReport, recordingToCsv, slug } from "../lib/export";
import { shareUrl } from "../lib/share";
import { objectLabels, useStore } from "../store";
import { Icon } from "./Icon";
import { getSceneView } from "./Viewport";

function ExportMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const showToast = useStore((s) => s.showToast);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  const v = () => {
    const s = useStore.getState();
    return s.variants[s.editing] ?? s.variants.A;
  };
  const items: { label: string; hint: string; run: () => void }[] = [
    {
      label: "Data (CSV)",
      hint: "time series of every object",
      run: () => {
        const x = v();
        if (!x?.recording) return showToast("Run the simulation first.");
        download(`${slug(x.scenario.metadata.name)}.csv`, recordingToCsv(x.recording, objectLabels(x.scenario)), "text/csv");
      },
    },
    {
      label: "Report (Markdown)",
      hint: "interpretation, predictions, results",
      run: () => {
        const x = v();
        if (!x) return;
        const s = useStore.getState();
        download(
          `${slug(x.scenario.metadata.name)}-report.md`,
          markdownReport({ scenario: x.scenario, interpretation: x.key === "A" ? s.interpretation?.interpretation : null, checks: x.checks, metrics: x.metrics, labels: objectLabels(x.scenario) }),
          "text/markdown",
        );
      },
    },
    {
      label: "Scenario (JSON)",
      hint: "re-import or share the setup",
      run: () => {
        const x = v();
        if (x) download(`${slug(x.scenario.metadata.name)}.json`, JSON.stringify(x.scenario, null, 2), "application/json");
      },
    },
    {
      label: "Snapshot (PNG)",
      hint: "the current 3D view",
      run: () => {
        const view = getSceneView(useStore.getState().editing) ?? getSceneView("A");
        if (!view) return;
        const a = document.createElement("a");
        a.href = view.snapshot();
        a.download = `${slug(v()?.scenario.metadata.name ?? "physicslab")}.png`;
        a.click();
      },
    },
  ];
  return (
    <div className="menu" ref={ref}>
      <button type="button" className="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((x) => !x)}>
        <Icon name="download" size={16} />
        <span className="hide-sm">Export</span>
      </button>
      {open ? (
        <div className="menu-popover" role="menu">
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              onClick={() => {
                it.run();
                setOpen(false);
              }}
            >
              <strong>{it.label}</strong>
              <span className="muted small">{it.hint}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function Header({ theme, setTheme }: { theme: Theme; setTheme: (t: Theme) => void }) {
  const setLibraryOpen = useStore((s) => s.setLibraryOpen);
  const health = useStore((s) => s.health);
  const showToast = useStore((s) => s.showToast);
  const compare = useStore((s) => s.compare);
  const toggleCompare = useStore((s) => s.toggleCompare);

  const share = async () => {
    const s = useStore.getState();
    const v = s.variants[s.editing] ?? s.variants.A;
    if (!v) return;
    const url = await shareUrl(v.scenario);
    try {
      await navigator.clipboard.writeText(url);
      showToast("Share link copied — anyone with it can open and modify this scenario.");
    } catch {
      window.prompt("Copy this link to share the scenario:", url);
    }
  };

  return (
    <header className="app-header">
      <div className="brand">
        <svg width="26" height="26" viewBox="0 0 64 64" aria-hidden="true">
          <circle cx="32" cy="32" r="30" fill="var(--series-1)" />
          <ellipse cx="32" cy="32" rx="26" ry="10" fill="none" stroke="#fff" strokeWidth="3" transform="rotate(-30 32 32)" />
          <circle cx="32" cy="32" r="6" fill="#fff" />
        </svg>
        <span className="brand-name">PhysicsLab</span>
        <span className={`badge ${health?.ai.enabled ? "badge-ai" : ""}`} title={health?.ai.enabled ? "Natural language is interpreted by Claude" : "Using the built-in rule-based interpreter"}>
          {health === undefined ? "…" : health?.ai.enabled ? (
            <>
              <Icon name="sparkle" size={12} /> AI
            </>
          ) : (
            "Offline"
          )}
        </span>
      </div>
      <nav className="header-actions">
        <button type="button" className="button" onClick={() => setLibraryOpen(true)}>
          <Icon name="library" size={16} />
          <span className="hide-sm">Library</span>
        </button>
        <button type="button" className={`button ${compare ? "on" : ""}`} aria-pressed={compare} onClick={() => toggleCompare()}>
          <Icon name="compare" size={16} />
          <span className="hide-sm">Compare</span>
        </button>
        <button type="button" className="button" onClick={share}>
          <Icon name="share" size={16} />
          <span className="hide-sm">Share</span>
        </button>
        <ExportMenu />
        <button type="button" className="button icon-button" aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
          <Icon name={theme === "dark" ? "sun" : "moon"} size={16} />
        </button>
      </nav>
    </header>
  );
}
