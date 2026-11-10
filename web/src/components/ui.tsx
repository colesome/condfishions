import type { ReactNode } from "react";
import type { Reg, Score } from "../lib/types";

export function scoreClass(score: number): string {
  // score is the catch rating (100 × chance of catching at least one)
  if (score >= 70) return "s-great";
  if (score >= 50) return "s-good";
  if (score >= 30) return "s-fair";
  return "s-poor";
}

export function ScoreBadge({ score, size = "md" }: { score: number; size?: "sm" | "md" | "lg" }) {
  return <div className={`score ${scoreClass(score)} score-${size}`}>{Math.round(score)}</div>;
}

export function Chip({ active, onClick, children }: { active?: boolean; onClick?: () => void; children: ReactNode }) {
  return (
    <button type="button" className={`chip ${active ? "chip-on" : ""}`} onClick={onClick}>
      {children}
    </button>
  );
}

export function Flags({ s }: { s: Score }) {
  return (
    <>
      {s.safety === "caution" && <span className="flag flag-warn">⚠ {s.safety_text ?? "Caution"}</span>}
      {s.regulations?.map((r: Reg) => (
        <span key={r.id} className={`flag ${r.action === "permit" ? "flag-info" : "flag-warn"}`}>
          {r.action === "permit" ? "🎫" : "⛔"} {r.text}
        </span>
      ))}
    </>
  );
}

export function Reasons({ s, max = 5 }: { s: Score; max?: number }) {
  return (
    <ul className="reasons">
      {s.reasons.slice(0, max).map((r) => (
        <li key={r.factor} className={r.points >= 0 ? "pos" : "neg"}>
          <span>{r.text}</span>
          <b>{r.points >= 0 ? "+" : ""}{Math.round(r.points)}</b>
        </li>
      ))}
    </ul>
  );
}

export function pct(p: number): string {
  return `${Math.round(p * 100)}%`;
}
