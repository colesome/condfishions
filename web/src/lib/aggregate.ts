import type { Score, SpotWindow } from "./types";

/** Group per-species rows into per-spot blocks (same logic as SQL best_spot_windows). */
export function toBlocks(rows: Score[]): (SpotWindow & { no_go: boolean })[] {
  const by = new Map<string, Score[]>();
  for (const r of rows) {
    const k = `${r.spot_id}|${r.block_start}`;
    (by.get(k) ?? by.set(k, []).get(k)!).push(r);
  }
  return [...by.values()].map((g) => {
    const ok = g.filter((r) => r.safety !== "no_go");
    const use = ok.length ? ok : g;
    const sorted = [...use].sort((a, b) => b.score - a.score);
    return {
      spot_id: g[0].spot_id,
      block_start: g[0].block_start,
      block_hours: g[0].block_hours,
      top_score: ok.length ? Math.round((ok.reduce((a, r) => a + r.score, 0) / ok.length) * 10) / 10 : 0,
      p_any: ok.length ? Math.max(...use.map((r) => r.p_success)) : 0,
      safety: (use.some((r) => r.safety === "caution") ? "caution" : "ok") as "caution" | "ok",
      safety_text: g.find((r) => r.safety_text)?.safety_text ?? null,
      no_go: ok.length === 0,
      species: sorted.map((r) => ({
        species_id: r.species_id, score: r.score, p_success: r.p_success,
        reasons: r.reasons, regulations: r.regulations, conditions: r.conditions,
      })),
    };
  }).sort((a, b) => a.block_start.localeCompare(b.block_start));
}

/** Best block per spot, plus the best block on each other day (same as SQL best_spot_windows). */
export function bestPerSpot(rows: Score[]): SpotWindow[] {
  const bySpot = new Map<string, SpotWindow[]>();
  for (const b of toBlocks(rows)) {
    if (b.no_go) continue;
    (bySpot.get(b.spot_id) ?? bySpot.set(b.spot_id, []).get(b.spot_id)!).push(b);
  }
  const dayKey = (iso: string) => new Date(iso).toDateString();
  return [...bySpot.values()].map((blocks) => {
    const sorted = [...blocks].sort((a, b) => b.top_score - a.top_score);
    const best = sorted[0];
    const perDay = new Map<string, SpotWindow>();
    for (const b of sorted) if (!perDay.has(dayKey(b.block_start))) perDay.set(dayKey(b.block_start), b);
    const alt = [...perDay.values()].filter((b) => dayKey(b.block_start) !== dayKey(best.block_start)).slice(0, 3)
      .map((b) => ({ block_start: b.block_start, block_hours: b.block_hours, score: b.top_score }));
    return { ...best, alt_blocks: alt };
  });
}
