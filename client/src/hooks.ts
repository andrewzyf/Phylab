import { useEffect, useState } from "react";
import { useStore } from "./store";

/** Drives the shared playback clock from requestAnimationFrame. Mount once. */
export function usePlaybackClock() {
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      useStore.getState().tick(dt);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
}

/** Current playback time, re-rendering at most `hz` times per second. */
export function useThrottledTime(hz = 12): number {
  const [t, setT] = useState(() => useStore.getState().time);
  useEffect(() => {
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = useStore.subscribe((s, prev) => {
      if (s.time === prev.time) return;
      const now = performance.now();
      if (now - last >= 1000 / hz) {
        last = now;
        setT(s.time);
      } else if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          last = performance.now();
          setT(useStore.getState().time);
        }, 1000 / hz);
      }
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, [hz]);
  return t;
}

export type Theme = "light" | "dark";

function systemTheme(): Theme {
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** Theme follows the OS unless the user picked one (stored per browser). */
export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>(() => {
    try {
      const saved = localStorage.getItem("physicslab.theme");
      if (saved === "light" || saved === "dark") return saved;
    } catch {
      // storage unavailable
    }
    return systemTheme();
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#0f1115" : "#f7f7f5");
  }, [theme]);
  const setTheme = (t: Theme) => {
    setThemeState(t);
    try {
      localStorage.setItem("physicslab.theme", t);
    } catch {
      // storage unavailable
    }
  };
  return [theme, setTheme];
}

export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export const SERIES = Array.from({ length: 8 }, (_, i) => `var(--series-${i + 1})`);
