import { SPEED_OF_LIGHT } from "@physicslab/shared";

/** Compact, human-friendly number formatting (3 significant figures, no scientific notation for normal magnitudes). */
export function fmt(x: number | null | undefined, digits = 3): string {
  if (x === null || x === undefined || Number.isNaN(x)) return "—";
  if (!Number.isFinite(x)) return x > 0 ? "∞" : "−∞";
  const a = Math.abs(x);
  if (a !== 0 && (a >= 1e6 || a < 1e-3)) return x.toExponential(Math.max(0, digits - 1)).replace("e+", "e");
  const s = Number.parseFloat(x.toPrecision(digits)).toString();
  return s === "-0" ? "0" : s.replace("-", "−");
}

export function fmtUnit(x: number | null | undefined, unit: string, digits = 3): string {
  if (unit === "m/s" && x !== null && x !== undefined && Math.abs(x) >= 0.01 * SPEED_OF_LIGHT) return `${fmt(x / SPEED_OF_LIGHT)}c`;
  const v = fmt(x, digits);
  return unit ? `${v} ${unit}` : v;
}

export function fmtVec(v: readonly number[], digits = 3): string {
  return `(${v.map((c) => fmt(c, digits)).join(", ")})`;
}

export function fmtTime(t: number): string {
  return `${t.toFixed(t < 10 ? 2 : 1)} s`;
}

export function signed(x: number, digits = 3): string {
  const s = fmt(Math.abs(x), digits);
  return x > 0 ? `+${s}` : x < 0 ? `−${s}` : s;
}
