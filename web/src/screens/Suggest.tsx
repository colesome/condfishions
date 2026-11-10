import { Chip, ScoreBadge } from "../components/ui";
import { WINDOWS, fmtWhen, type WindowId } from "../lib/time";
import { fmtTravel } from "../lib/travel";
import type { Origin, Species, Spot, SpotWindow, Water } from "../lib/types";

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
    .sort((a, b) => b.top_score - a.top_score)
    .slice(0, 25);
  const spName = (id: string) => shortName(p.species.find((s) => s.id === id), id);

  return (
    <div className="screen">
      <div className="title-row">
        <h1>Fish</h1>
        <button className="from" onClick={p.openPlaces}>
          {p.origin.gps ? "Near you" : p.origin.name} ›
          <small>within {fmtTravel(p.origin.max_travel_min)}</small>
        </button>
      </div>

      <div className="seg">
        <button className={p.water === "salt" ? "on" : ""} onClick={() => p.setWater("salt")}>Saltwater</button>
        <button className={p.water === "fresh" ? "on" : ""} onClick={() => p.setWater("fresh")}>Freshwater</button>
      </div>

      <div className="chips">
        {WINDOWS.map((w) => (
          <Chip key={w.id} active={p.windowId === w.id} onClick={() => p.setWindowId(w.id)}>{w.label}</Chip>
        ))}
      </div>

      <p className="caption">Best time at each spot. Rating = how likely you are to catch a fish (0–100).</p>

      {p.stale && <div className="banner">Offline — showing your last update.</div>}
      {p.error && !p.stale && <div className="banner banner-err">{p.error}</div>}
      {p.loading && !p.results && <div className="empty">Loading…</div>}
      {p.results && ranked.length === 0 && !p.error && (
        <div className="empty">
          Nothing fishable in this window. Try a longer window or more range — rock spots are hidden
          when the swell makes them unsafe.
        </div>
      )}

      <ol className="cards">
        {ranked.map((r) => {
          const spot = p.spots.get(r.spot_id);
          if (!spot) return null;
          const why = (r.species[0]?.reasons ?? []).filter((x) => x.points > 0).slice(0, 3).map((x) => x.text);
          const regs = [...new Map(r.species.flatMap((s) => s.regulations ?? []).map((g) => [g.id, g])).values()];
          return (
            <li key={r.spot_id} className="card" onClick={() => p.openSpot(r.spot_id)}>
              <ScoreBadge score={r.top_score} />
              <div className="card-body">
                <div className="card-name">{spot.name}</div>
                <div className="card-when">{fmtWhen(r.block_start, r.block_hours, p.now)}</div>
                <div className="card-meta">
                  {fmtTravel(p.travel.get(r.spot_id) ?? 0)} away · {r.species.slice(0, 3).map((s) => spName(s.species_id)).join(", ")}
                </div>
                {why.length > 0 && <div className="card-why">{capitalise(why.join(", "))}</div>}
                {r.safety === "caution" && <span className="flag flag-warn">{r.safety_text ?? "Caution"}</span>}
                {regs.filter((g) => g.action !== "permit").map((g) => (
                  <span key={g.id} className="flag flag-warn">{g.text}</span>
                ))}
                {regs.some((g) => g.action === "permit") && <span className="flag flag-info">Permit needed (SIP)</span>}
              </div>
              <span className="chev">›</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
