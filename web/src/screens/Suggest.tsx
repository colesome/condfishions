import { Chip, Flags, Reasons, ScoreBadge, pct } from "../components/ui";
import { WINDOWS, fmtBlock, type WindowId } from "../lib/time";
import { fmtTravel } from "../lib/travel";
import type { Origin, Score, Species, Spot } from "../lib/types";

export type SortBy = "score" | "chance";

interface Props {
  origin: Origin;
  now: Date;
  spots: Map<string, Spot>;
  species: Species[];
  travel: Map<string, number>;
  results: Score[] | null;
  loading: boolean;
  error: string | null;
  stale: boolean;
  windowId: WindowId;
  setWindowId: (w: WindowId) => void;
  speciesSel: string | null;
  setSpeciesSel: (s: string | null) => void;
  sortBy: SortBy;
  setSortBy: (s: SortBy) => void;
  openSpot: (id: string, species?: string) => void;
  openPlaces: () => void;
}

const PER_SPOT = 2;

export function Suggest(p: Props) {
  const availableSpecies = p.species.filter((sp) =>
    [...p.travel.keys()].some((id) => p.spots.get(id)?.species.includes(sp.id)));

  const ranked = (p.results ?? [])
    .slice()
    .sort((a, b) => p.sortBy === "score" ? b.score - a.score : b.p_success - a.p_success);
  const perSpot = new Map<string, number>();
  const picks = ranked.filter((r) => {
    const n = perSpot.get(r.spot_id) ?? 0;
    if (n >= PER_SPOT) return false;
    perSpot.set(r.spot_id, n + 1);
    return true;
  }).slice(0, 25);

  const spName = (id: string) => p.species.find((s) => s.id === id)?.name ?? id;

  return (
    <div className="screen">
      <header className="top">
        <button className="origin" onClick={p.openPlaces}>
          <span className="origin-pin">{p.origin.gps ? "📍" : "🏠"}</span>
          <span>
            <b>{p.origin.name}</b>
            <small>within {fmtTravel(p.origin.max_travel_min)} · {p.travel.size} spots</small>
          </span>
          <span className="origin-edit">Change</span>
        </button>
      </header>

      <div className="chips">
        {WINDOWS.map((w) => (
          <Chip key={w.id} active={p.windowId === w.id} onClick={() => p.setWindowId(w.id)}>{w.label}</Chip>
        ))}
      </div>
      <div className="chips">
        <Chip active={p.speciesSel === null} onClick={() => p.setSpeciesSel(null)}>All species</Chip>
        {availableSpecies.map((s) => (
          <Chip key={s.id} active={p.speciesSel === s.id} onClick={() => p.setSpeciesSel(s.id)}>{s.name}</Chip>
        ))}
      </div>
      <div className="sortrow">
        <span>{picks.length ? `${picks.length} best windows` : ""}</span>
        <div className="seg">
          <button className={p.sortBy === "score" ? "on" : ""} onClick={() => p.setSortBy("score")}>Conditions</button>
          <button className={p.sortBy === "chance" ? "on" : ""} onClick={() => p.setSortBy("chance")}>Catch chance</button>
        </div>
      </div>

      {p.stale && <div className="banner">Offline — showing your last update.</div>}
      {p.error && !p.stale && <div className="banner banner-err">{p.error}</div>}
      {p.loading && !p.results && <div className="empty">Loading…</div>}
      {p.results && picks.length === 0 && (
        <div className="empty">
          No fishable windows here. Try a longer window, more range, or check the swell — rock spots
          are hidden when they're unsafe.
        </div>
      )}

      <ol className="cards">
        {picks.map((r) => {
          const spot = p.spots.get(r.spot_id);
          if (!spot) return null;
          return (
            <li key={`${r.spot_id}|${r.species_id}`} className="card" onClick={() => p.openSpot(r.spot_id, r.species_id)}>
              <ScoreBadge score={r.score} />
              <div className="card-body">
                <div className="card-title">
                  <b>{spot.name}</b>
                  <span className="muted">{fmtTravel(p.travel.get(r.spot_id) ?? 0)}</span>
                </div>
                <div className="card-sub">
                  {spName(r.species_id)} · {fmtBlock(r.block_start, r.block_hours, p.now)} ·{" "}
                  <span title="Chance of catching at least one">{pct(r.p_success)} chance</span>
                </div>
                <Reasons s={r} max={3} />
                <Flags s={r} />
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
