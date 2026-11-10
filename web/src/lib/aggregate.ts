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
      top_score: ok.length ? sorted[0].score : 0,
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

/** Best block per spot. */
export function bestPerSpot(rows: Score[]): SpotWindow[] {
  const best = new Map<string, SpotWindow>();
  for (const b of toBlocks(rows)) {
    if (b.no_go) continue;
    const cur = best.get(b.spot_id);
    if (!cur || b.top_score > cur.top_score) best.set(b.spot_id, b);
  }
  return [...best.values()];
}
