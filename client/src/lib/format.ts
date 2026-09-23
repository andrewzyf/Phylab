import { SPEED_OF_LIGHT } from "@physicslab/shared";

/** Compact, human-friendly number formatting (3 significant figures, no scientific notation for normal magnitudes). */
export function fmt(x: number | null | undefined, digits = 3, zeroBelow = 0): string {
  if (x === null || x === undefined || Number.isNaN(x)) return "—";
  if (!Number.isFinite(x)) return x > 0 ? "∞" : "−∞";
  const a = Math.abs(x);
  if (a < zeroBelow) return "0";
  if (a !== 0 && (a >= 1e6 || a < 1e-3)) return x.toExponential(Math.max(0, digits - 1)).replace("e+", "e");
  const s = Number.parseFloat(x.toPrecision(digits)).toString();
  return s === "-0" ? "0" : s.replace("-", "−");
}

/** Kinematic quantities below this are floating-point noise from the solver, shown as 0. */
const NOISE = 1e-6;

export function fmtUnit(x: number | null | undefined, unit: string, digits = 3): string {
  if (unit === "m/s" && x !== null && x !== undefined && Math.abs(x) >= 0.01 * SPEED_OF_LIGHT) return `${fmt(x / SPEED_OF_LIGHT)}c`;
  const v = fmt(x, digits, /^(m|m\/s|m\/s²|J|s)$/.test(unit) ? NOISE : 0);
  return unit ? `${v} ${unit}` : v;
}

export function fmtVec(v: readonly number[], digits = 3): string {
  const scale = Math.max(...v.map(Math.abs));
  return `(${v.map((c) => fmt(c, digits, Math.max(NOISE, scale * 1e-6))).join(", ")})`;
}

/** Relative difference as a percentage with two decimals (no scientific notation). */
export function pctDiff(x: number): string {
  const p = x * 100;
  if (Math.abs(p) < 0.005) return "0.00%";
  return `${p > 0 ? "+" : "−"}${Math.abs(p) < 100 ? Math.abs(p).toFixed(2) : fmt(Math.abs(p))}%`;
}

export function fmtTime(t: number): string {
  return `${t.toFixed(t < 10 ? 2 : 1)} s`;
}

export function signed(x: number, digits = 3): string {
  const s = fmt(Math.abs(x), digits);
  return x > 0 ? `+${s}` : x < 0 ? `−${s}` : s;
}
