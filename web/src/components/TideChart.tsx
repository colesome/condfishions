import { hm, sameDay } from "../lib/time";
import type { Tide } from "../lib/types";

interface Props {
  tide: Tide;
  day: Date;               // which local day to draw (midnight → midnight)
  highlight?: { start: string; hours: number } | null;
  now: Date;
}

const W = 360, H = 170, PAD_L = 8, PAD_R = 8, TOP = 26, BOTTOM = 24;

/** One day's tide curve with high/low labels, the selected 3-hour window and "now". */
export function TideChart({ tide, day, highlight, now }: Props) {
  const d0 = new Date(day); d0.setHours(0, 0, 0, 0);
  const d1 = new Date(d0); d1.setDate(d0.getDate() + 1);
  // Curve from consecutive high/low extremes with cosine interpolation (how tide tables are
  // drawn) — covers the whole day even before "now"; falls back to the hourly series.
  const ex = tide.extremes.map(([t, kind, h]) => ({ t: new Date(t), kind, h })).sort((a, b) => a.t.getTime() - b.t.getTime());
  const pts: { t: Date; h: number }[] = [];
  for (let m = 0; m <= 24 * 60; m += 10) {
    const t = new Date(d0.getTime() + m * 60_000);
    const i = ex.findIndex((e) => e.t > t);
    if (i > 0) {
      const a = ex[i - 1], b = ex[i];
      const f = (t.getTime() - a.t.getTime()) / (b.t.getTime() - a.t.getTime());
      pts.push({ t, h: a.h + (b.h - a.h) * (1 - Math.cos(Math.PI * f)) / 2 });
    }
  }
  if (pts.length < 20) {
    pts.length = 0;
    for (const [t, h] of tide.series) {
      const tt = new Date(t);
      if (tt >= new Date(d0.getTime() - 3600_000) && tt <= new Date(d1.getTime() + 3600_000)) pts.push({ t: tt, h });
    }
  }
  if (pts.length < 4) return <div className="empty">No tide data for this day.</div>;

  // consistent vertical scale across the whole forecast so days are comparable
  const all = ex.length ? ex.map((e) => e.h) : tide.series.map(([, h]) => h);
  const lo = Math.min(...all), hi = Math.max(...all);
  const x = (t: Date) => PAD_L + ((t.getTime() - d0.getTime()) / 86400_000) * (W - PAD_L - PAD_R);
  const y = (h: number) => TOP + (1 - (h - lo) / (hi - lo || 1)) * (H - TOP - BOTTOM);

  // smooth path (Catmull-Rom → cubic Bézier)
  const P = pts.map((p) => [x(p.t), y(p.h)] as const);
  let d = `M${P[0][0]},${P[0][1]}`;
  for (let i = 0; i < P.length - 1; i++) {
    const p0 = P[i - 1] ?? P[i], p1 = P[i], p2 = P[i + 1], p3 = P[i + 2] ?? p2;
    d += ` C${p1[0] + (p2[0] - p0[0]) / 6},${p1[1] + (p2[1] - p0[1]) / 6} ${p2[0] - (p3[0] - p1[0]) / 6},${p2[1] - (p3[1] - p1[1]) / 6} ${p2[0]},${p2[1]}`;
  }
  const area = `${d} L${P[P.length - 1][0]},${H - BOTTOM} L${P[0][0]},${H - BOTTOM} Z`;

  const extremes = ex.filter((e) => e.t >= d0 && e.t < d1);

  const hl = highlight ? { a: new Date(highlight.start), b: new Date(new Date(highlight.start).getTime() + highlight.hours * 3600_000) } : null;
  const showHl = hl && hl.b > d0 && hl.a < d1;

  return (
    <svg className="tide" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Tide height through the day">
      <defs>
        <linearGradient id="tideFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#4fb3ff" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#4fb3ff" stopOpacity="0.05" />
        </linearGradient>
        <clipPath id="dayClip"><rect x={PAD_L} y={0} width={W - PAD_L - PAD_R} height={H} /></clipPath>
      </defs>
      {[0, 6, 12, 18, 24].map((h) => {
        const xx = PAD_L + (h / 24) * (W - PAD_L - PAD_R);
        return (
          <g key={h}>
            <line x1={xx} x2={xx} y1={TOP - 6} y2={H - BOTTOM} stroke="#e5e5ea" strokeWidth="1" />
            {h < 24 && <text x={xx + 3} y={H - 8} className="tide-axis">{h === 0 ? "12am" : h === 12 ? "12pm" : h < 12 ? `${h}am` : `${h - 12}pm`}</text>}
          </g>
        );
      })}
      {showHl && (
        <rect x={Math.max(PAD_L, x(hl!.a))} y={TOP - 8} width={Math.min(x(hl!.b), W - PAD_R) - Math.max(PAD_L, x(hl!.a))}
          height={H - BOTTOM - TOP + 8} rx="6" fill="#ffcc00" opacity="0.28" />
      )}
      <g clipPath="url(#dayClip)">
        <path d={area} fill="url(#tideFill)" />
        <path d={d} fill="none" stroke="#0a84ff" strokeWidth="2.5" strokeLinecap="round" />
      </g>
      {extremes.map((e) => (
        <g key={e.t.toISOString()}>
          <circle cx={x(e.t)} cy={y(e.h)} r="4" fill="#fff" stroke="#0a84ff" strokeWidth="2" />
          <text x={x(e.t)} y={e.kind === "high" ? y(e.h) - 9 : y(e.h) + 16} textAnchor="middle" className="tide-label">
            {e.kind === "high" ? "High" : "Low"} {hm(e.t)}
          </text>
        </g>
      ))}
      {sameDay(now, d0) && (
        <g>
          <line x1={x(now)} x2={x(now)} y1={TOP - 8} y2={H - BOTTOM} stroke="#ff3b30" strokeWidth="1.5" strokeDasharray="3 3" />
          <text x={x(now)} y={TOP - 12} textAnchor="middle" className="tide-now">now</text>
        </g>
      )}
    </svg>
  );
}
