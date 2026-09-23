import { useEffect, useState } from "react";
import { ChartsPanel } from "./components/ChartsPanel";
import { ChatPanel } from "./components/ChatPanel";
import { ComparePanel } from "./components/ComparePanel";
import { Header } from "./components/Header";
import { HistoryPanel } from "./components/HistoryPanel";
import { Icon, type IconName } from "./components/Icon";
import { LibraryDialog } from "./components/LibraryDialog";
import { ParamsPanel } from "./components/ParamsPanel";
import { StatsPanel } from "./components/StatsPanel";
import { Viewport } from "./components/Viewport";
import { usePlaybackClock, useTheme } from "./hooks";
import { useStore, type MobileTab, type RightTab } from "./store";

const RIGHT_TABS: { id: RightTab; label: string; icon: IconName }[] = [
  { id: "params", label: "Parameters", icon: "sliders" },
  { id: "stats", label: "Stats", icon: "stats" },
  { id: "charts", label: "Graphs", icon: "chart" },
  { id: "compare", label: "Compare", icon: "compare" },
  { id: "history", label: "History", icon: "history" },
];

const MOBILE_TABS: { id: MobileTab | RightTab; label: string; icon: IconName }[] = [
  { id: "describe", label: "Describe", icon: "chat" },
  { id: "params", label: "Adjust", icon: "sliders" },
  { id: "stats", label: "Stats", icon: "stats" },
  { id: "charts", label: "Graphs", icon: "chart" },
  { id: "compare", label: "Compare", icon: "compare" },
  { id: "history", label: "History", icon: "history" },
];

function panelFor(id: string) {
  switch (id) {
    case "describe":
      return <ChatPanel />;
    case "params":
      return <ParamsPanel />;
    case "stats":
      return <StatsPanel />;
    case "charts":
      return <ChartsPanel />;
    case "compare":
      return <ComparePanel />;
    case "history":
      return <HistoryPanel />;
    default:
      return null;
  }
}

function useIsWide() {
  const [wide, setWide] = useState(() => window.matchMedia("(min-width: 1100px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1100px)");
    const on = () => setWide(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return wide;
}

function Toast() {
  const toast = useStore((s) => s.toast);
  if (!toast) return null;
  return (
    <div className="toast" role="status" key={toast.id}>
      {toast.text}
    </div>
  );
}

export function App() {
  const [theme, setTheme] = useTheme();
  const wide = useIsWide();
  const rightTab = useStore((s) => s.rightTab);
  const setRightTab = useStore((s) => s.setRightTab);
  const mobileTab = useStore((s) => s.mobileTab);
  const setMobileTab = useStore((s) => s.setMobileTab);
  usePlaybackClock();

  useEffect(() => {
    void useStore.getState().init();
  }, []);

  // On small screens the right-hand tabs and the chat share one tab bar.
  const activeMobile = mobileTab === "scene" ? "describe" : mobileTab;

  return (
    <div className={`app ${wide ? "wide" : "narrow"}`}>
      <Header theme={theme} setTheme={setTheme} />
      {wide ? (
        <main className="layout-wide">
          <aside className="panel panel-left" aria-label="Describe">
            <ChatPanel />
          </aside>
          <Viewport theme={theme} />
          <aside className="panel panel-right" aria-label="Inspect">
            <div className="tabs" role="tablist">
              {RIGHT_TABS.map((t) => (
                <button key={t.id} type="button" role="tab" aria-selected={rightTab === t.id} className={rightTab === t.id ? "on" : ""} onClick={() => setRightTab(t.id)}>
                  <Icon name={t.icon} size={15} />
                  {t.label}
                </button>
              ))}
            </div>
            <div className="tab-body" role="tabpanel">
              {panelFor(rightTab)}
            </div>
          </aside>
        </main>
      ) : (
        <main className="layout-narrow">
          <Viewport theme={theme} />
          <div className="tabs tabs-mobile" role="tablist">
            {MOBILE_TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={activeMobile === t.id}
                className={activeMobile === t.id ? "on" : ""}
                onClick={() => {
                  setMobileTab(t.id as MobileTab);
                  if (t.id !== "describe") setRightTab(t.id as RightTab);
                }}
              >
                <Icon name={t.icon} size={16} />
                <span>{t.label}</span>
              </button>
            ))}
          </div>
          <div className="tab-body mobile-body" role="tabpanel">
            {panelFor(activeMobile === "describe" ? "describe" : activeMobile)}
          </div>
        </main>
      )}
      <LibraryDialog />
      <Toast />
    </div>
  );
}
