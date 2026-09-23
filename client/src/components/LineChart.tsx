import { useEffect, useId, useMemo, useRef, useState } from "react";
import { fmt } from "../lib/format";

export interface ChartSeries {
  id: string;
  label: string;
  /** CSS colour (usually var(--series-n)). */
  color: string;
  times: ArrayLike<number>;
  values: ArrayLike<number>;
  dashed?: boolean;
}

interface Props {
  title: string;
  unit: string;
  series: ChartSeries[];
  cursorTime?: number;
  onSeek?: (t: number) => void;
  height?: number;
}

const PAD = { l: 48, r: 12, t: 10, b: 26 };

function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0];
  if (max - min < 1e-12) {
    const d = Math.abs(max) > 1e-9 ? Math.abs(max) * 0.1 : 1;
    min -= d;
    max += d;
  }
  const raw = (max - min) / count;
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  const step = (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

/** Downsample with per-bucket min/max so peaks (bounces, collisions) survive. */
function decimate(times: ArrayLike<number>, values: ArrayLike<number>, buckets: number): [number, number][] {
  const n = Math.min(times.length, values.length);
  if (n <= buckets * 2) return Array.from({ length: n }, (_, i) => [times[i], values[i]]);
  const out: [number, number][] = [];
  const size = n / buckets;
  for (let b = 0; b < buckets; b++) {
    const lo = Math.floor(b * size);
    const hi = Math.min(n, Math.floor((b + 1) * size));
    let iMin = lo;
    let iMax = lo;
    for (let i = lo; i < hi; i++) {
      if (values[i] < values[iMin]) iMin = i;
      if (values[i] > values[iMax]) iMax = i;
    }
    for (const i of iMin < iMax ? [iMin, iMax] : [iMax, iMin]) out.push([times[i], values[i]]);
  }
  out.push([times[n - 1], values[n - 1]]);
  return out;
}

function nearestIndex(times: ArrayLike<number>, t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid;
    else hi = mid;
  }
  return Math.abs(times[lo] - t) <= Math.abs(times[hi] - t) ? lo : hi;
}

export function LineChart({ title, unit, series, cursorTime, onSeek, height = 180 }: Props) {
  const [hoverT, setHoverT] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [WIDTH, setWidth] = useState(560);
  const id = useId();
  const H = height;
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(200, Math.round(el.clientWidth))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [table]);

  const { xMax, yTicks, yMin, yMax, paths } = useMemo(() => {
    let xMax = 0;
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const s of series) {
      const n = Math.min(s.times.length, s.values.length);
      if (n) xMax = Math.max(xMax, s.times[n - 1]);
      for (let i = 0; i < n; i++) {
        const v = s.values[i];
        if (Number.isFinite(v)) {
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
    }
    if (!Number.isFinite(lo)) {
      lo = 0;
      hi = 1;
    }
    // Include zero when the data sits close to it, so magnitudes aren't exaggerated.
    if (lo > 0 && lo < (hi - lo) * 0.6) lo = 0;
    if (hi < 0 && -hi < (hi - lo) * 0.6) hi = 0;
    const yTicks = niceTicks(lo, hi, 4);
    const yMin = Math.min(lo, yTicks[0]);
    const yMax = Math.max(hi, yTicks[yTicks.length - 1]);
    const sx = (t: number) => PAD.l + (t / (xMax || 1)) * (WIDTH - PAD.l - PAD.r);
    const sy = (v: number) => PAD.t + (1 - (v - yMin) / (yMax - yMin || 1)) * (H - PAD.t - PAD.b);
    const paths = series.map((s) => {
      const pts = decimate(s.times, s.values, 300).filter(([, v]) => Number.isFinite(v));
      return pts.map(([t, v], i) => `${i ? "L" : "M"}${sx(t).toFixed(1)},${sy(v).toFixed(1)}`).join("");
    });
    return { xMax, yTicks, yMin, yMax, paths };
  }, [series, H, WIDTH]);

  const sx = (t: number) => PAD.l + (t / (xMax || 1)) * (WIDTH - PAD.l - PAD.r);
  const sy = (v: number) => PAD.t + (1 - (v - yMin) / (yMax - yMin || 1)) * (H - PAD.t - PAD.b);
  const xTicks = niceTicks(0, xMax, 5).filter((t) => t >= 0 && t <= xMax + 1e-9);

  const toTime = (clientX: number) => {
    const r = svgRef.current!.getBoundingClientRect();
    const x = ((clientX - r.left) / r.width) * WIDTH;
    return Math.min(xMax, Math.max(0, ((x - PAD.l) / (WIDTH - PAD.l - PAD.r)) * xMax));
  };

  const hoverRows =
    hoverT === null
      ? []
      : series.map((s) => {
          const i = nearestIndex(s.times, hoverT);
          return { s, v: s.values[i] };
        });
  const tipLeft = hoverT === null ? 0 : (sx(hoverT) / WIDTH) * 100;

  const tableRows = useMemo(() => {
    if (!table || !series.length) return [];
    const base = series[0];
    const n = base.times.length;
    const step = Math.max(1, Math.floor(n / 24));
    const rows: { t: number; vals: number[] }[] = [];
    for (let i = 0; i < n; i += step) rows.push({ t: base.times[i], vals: series.map((s) => s.values[nearestIndex(s.times, base.times[i])]) });
    return rows;
  }, [table, series]);

  return (
    <figure className="chart" aria-labelledby={`${id}-title`}>
      <figcaption className="chart-head">
        <span id={`${id}-title`} className="chart-title">
          {title} <span className="muted">({unit})</span>
        </span>
        <button type="button" className="link-button" onClick={() => setTable((x) => !x)} aria-pressed={table}>
          {table ? "Chart" : "Table"}
        </button>
      </figcaption>
      {series.length > 1 ? (
        <ul className="chart-legend">
          {series.map((s) => (
            <li key={s.id}>
              <svg width="16" height="8" aria-hidden="true">
                <line x1="1" y1="4" x2="15" y2="4" stroke={s.color} strokeWidth="2" strokeLinecap="round" strokeDasharray={s.dashed ? "3 3" : undefined} />
              </svg>
              {s.label}
            </li>
          ))}
        </ul>
      ) : null}
      {table ? (
        <div className="chart-table-wrap">
          <table className="chart-table">
            <thead>
              <tr>
                <th>t (s)</th>
                {series.map((s) => (
                  <th key={s.id}>{s.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tableRows.map((r) => (
                <tr key={r.t}>
                  <td>{fmt(r.t)}</td>
                  {r.vals.map((v, i) => (
                    <td key={i}>{fmt(v)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="chart-plot" ref={wrapRef}>
          <svg
            ref={svgRef}
            width={WIDTH}
            height={H}
            viewBox={`0 0 ${WIDTH} ${H}`}
            role="img"
            aria-label={`${title} over time`}
            onPointerMove={(e) => setHoverT(toTime(e.clientX))}
            onPointerLeave={() => setHoverT(null)}
            onClick={(e) => onSeek?.(toTime(e.clientX))}
          >
            {yTicks.map((v) => (
              <g key={`y${v}`}>
                <line x1={PAD.l} x2={WIDTH - PAD.r} y1={sy(v)} y2={sy(v)} className={v === 0 ? "chart-baseline" : "chart-grid"} />
                <text x={PAD.l - 6} y={sy(v)} className="chart-tick" textAnchor="end" dominantBaseline="middle">
                  {fmt(v)}
                </text>
              </g>
            ))}
            {xTicks.map((t) => (
              <text key={`x${t}`} x={sx(t)} y={H - 8} className="chart-tick" textAnchor="middle">
                {fmt(t)}s
              </text>
            ))}
            {paths.map((d, i) => (
              <path key={series[i].id} d={d} fill="none" stroke={series[i].color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={series[i].dashed ? "5 4" : undefined} />
            ))}
            {cursorTime !== undefined && cursorTime > 0 ? <line x1={sx(cursorTime)} x2={sx(cursorTime)} y1={PAD.t} y2={H - PAD.b} className="chart-cursor" /> : null}
            {hoverT !== null ? (
              <g>
                <line x1={sx(hoverT)} x2={sx(hoverT)} y1={PAD.t} y2={H - PAD.b} className="chart-crosshair" />
                {hoverRows.map(({ s, v }) =>
                  Number.isFinite(v) ? <circle key={s.id} cx={sx(hoverT)} cy={sy(v)} r={4} fill={s.color} className="chart-dot" /> : null,
                )}
              </g>
            ) : null}
          </svg>
          {hoverT !== null ? (
            <div className="chart-tooltip" style={{ left: `${tipLeft}%`, transform: `translateX(${tipLeft > 60 ? "-105%" : "8px"})` }}>
              <div className="chart-tooltip-time">t = {fmt(hoverT)} s</div>
              {hoverRows.map(({ s, v }) => (
                <div key={s.id} className="chart-tooltip-row">
                  <svg width="12" height="8" aria-hidden="true">
                    <line x1="1" y1="4" x2="11" y2="4" stroke={s.color} strokeWidth="2" strokeLinecap="round" />
                  </svg>
                  <strong>{fmt(v)}</strong>
                  <span className="muted">{s.label}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </figure>
  );
}
