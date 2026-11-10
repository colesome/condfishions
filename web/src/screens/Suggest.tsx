import { Chip, ScoreBadge, pct, scoreClass } from "../components/ui";
import { WINDOWS, fmtBlock, type WindowId } from "../lib/time";
import { fmtTravel } from "../lib/travel";
import type { Origin, Species, Spot, SpotWindow, Water } from "../lib/types";

export type SortBy = "score" | "chance";

interface Props {
  origin: Origin;
  now: Date;
  spots: Map<string, Spot>;
  species: Species[];
  travel: Map<string, number>;
  results: SpotWindow[] | null;
  loading: boolean;
  error: string | null;
  stale: boolean;
  windowId: WindowId;
  setWindowId: (w: WindowId) => void;
  water: Water;
  setWater: (w: Water) => void;
  sortBy: SortBy;
  setSortBy: (s: SortBy) => void;
  openSpot: (id: string) => void;
  openPlaces: () => void;
}

export function shortName(sp: Species | undefined, id: string): string {
  const n = (sp?.name ?? id).replace(/\s*\(.*\)$/, "").replace(/^(Yellowfin|Dusky|Yellowtail|Australian) /, "");
  return n.charAt(0).toUpperCase() + n.slice(1);
}

export function Suggest(p: Props) {
  const ranked = (p.results ?? [])
    .slice()
    .sort((a, b) => p.sortBy === "score" ? b.top_score - a.top_score : b.p_any - a.p_any)
    .slice(0, 30);
  const spName = (id: string) => shortName(p.species.find((s) => s.id === id), id);

  return (
    <div className="screen">
      <header className="top">
        <button className="origin" onClick={p.openPlaces}>
          <span className="origin-pin">{p.origin.gps ? "📍" : "🏠"}</span>
          <span>
            <b>{p.origin.name}</b>
            <small>within {fmtTravel(p.origin.max_travel_min)} · {p.travel.size} {p.water === "salt" ? "saltwater" : "freshwater"} spots</small>
          </span>
          <span className="origin-edit">Change</span>
        </button>
      </header>

      <div className="seg seg-full">
        <button className={p.water === "salt" ? "on" : ""} onClick={() => p.setWater("salt")}>🌊 Saltwater</button>
        <button className={p.water === "fresh" ? "on" : ""} onClick={() => p.setWater("fresh")}>🏞️ Freshwater</button>
      </div>

      <div className="chips">
        {WINDOWS.map((w) => (
          <Chip key={w.id} active={p.windowId === w.id} onClick={() => p.setWindowId(w.id)}>{w.label}</Chip>
        ))}
      </div>
      <div className="sortrow">
        <span>{ranked.length ? `${ranked.length} spots, best time at each` : ""}</span>
        <div className="seg">
          <button className={p.sortBy === "score" ? "on" : ""} onClick={() => p.setSortBy("score")}>Conditions</button>
          <button className={p.sortBy === "chance" ? "on" : ""} onClick={() => p.setSortBy("chance")}>Catch chance</button>
        </div>
      </div>

      {p.stale && <div className="banner">Offline — showing your last update.</div>}
      {p.error && !p.stale && <div className="banner banner-err">{p.error}</div>}
      {p.loading && !p.results && <div className="empty">Loading…</div>}
      {p.results && ranked.length === 0 && !p.error && (
        <div className="empty">
          No fishable spots in this window. Try a longer window or more range — rock spots are hidden
          when the swell makes them unsafe.
        </div>
      )}

      <ol className="cards">
        {ranked.map((r) => {
          const spot = p.spots.get(r.spot_id);
          if (!spot) return null;
          const top = r.species[0];
          const regs = r.species.flatMap((s) => s.regulations ?? []);
          const uniqRegs = [...new Map(regs.map((g) => [g.id, g])).values()];
          return (
            <li key={r.spot_id} className="card" onClick={() => p.openSpot(r.spot_id)}>
              <ScoreBadge score={r.top_score} />
              <div className="card-body">
                <div className="card-title">
                  <b>{spot.name}</b>
                  <span className="muted">{fmtTravel(p.travel.get(r.spot_id) ?? 0)}</span>
                </div>
                <div className="card-sub">
                  {fmtBlock(r.block_start, r.block_hours, p.now)} · {pct(r.p_any)} chance of{" "}
                  {spName([...r.species].sort((a, b) => b.p_success - a.p_success)[0]?.species_id ?? "").toLowerCase()}
                </div>
                <div className="species-row">
                  {r.species.slice(0, 5).map((s) => (
                    <span key={s.species_id} className={`sp-pill ${scoreClass(s.score)}`}>
                      {spName(s.species_id)} <b>{Math.round(s.score)}</b>
                    </span>
                  ))}
                </div>
                {top && (
                  <ul className="reasons">
                    {top.reasons.filter((x) => x.points > 0).slice(0, 3).map((x) => (
                      <li key={x.factor} className="pos"><span>{x.text}</span><b>+{Math.round(x.points)}</b></li>
                    ))}
                    {top.reasons.filter((x) => x.points < 0).slice(0, 1).map((x) => (
                      <li key={x.factor} className="neg"><span>{x.text}</span><b>{Math.round(x.points)}</b></li>
                    ))}
                  </ul>
                )}
                {r.safety === "caution" && <span className="flag flag-warn">⚠ {r.safety_text ?? "Caution"}</span>}
                {uniqRegs.map((g) => (
                  <span key={g.id} className={`flag ${g.action === "permit" ? "flag-info" : "flag-warn"}`}>
                    {g.action === "permit" ? "🎫" : "⛔"} {g.text}
                  </span>
                ))}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
