import { Chip } from "../components/ui";
import { BANDS, bandFor } from "../lib/bands";
import { WINDOWS, fmtShort, fmtWhen, type WindowId } from "../lib/time";
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
  openSpot: (id: string, blockStart?: string) => void;
  openPlaces: () => void;
  openMap: () => void;
  activeTripSpot: string | null;
}

export function shortName(sp: Species | undefined, id: string): string {
  const n = (sp?.name ?? id).replace(/\s*\(.*\)$/, "").replace(/^(Yellowfin|Dusky|Yellowtail|Australian) /, "");
  return n.charAt(0).toUpperCase() + n.slice(1);
}

export function Suggest(p: Props) {
  const results = p.results ?? [];
  const grouped = BANDS.map((band) => ({
    band,
    items: results
      .filter((r) => bandFor(r.top_score).id === band.id)
      .sort((a, b) => (p.travel.get(a.spot_id) ?? 999) - (p.travel.get(b.spot_id) ?? 999)),
  })).filter((g) => g.items.length);
  const hasGood = grouped.some((g) => g.band.min >= 55);

  return (
    <div className="screen">
      <div className="title-row">
        <h1 className="brand">Cond<span>Fish</span>ions</h1>
        <div className="title-actions">
          <button className="pill-btn" onClick={p.openMap}>Map</button>
          <button className="from" onClick={p.openPlaces}>
            {p.origin.gps ? "Near you" : p.origin.name} ›
            <small>within {fmtTravel(p.origin.max_travel_min)}</small>
          </button>
        </div>
      </div>

      <div className="seg">
        <button className={p.water === "salt" ? "on" : ""} onClick={() => p.setWater("salt")}>🌊 Saltwater</button>
        <button className={p.water === "fresh" ? "on" : ""} onClick={() => p.setWater("fresh")}>🏞️ Freshwater</button>
      </div>

      <div className="chips">
        {WINDOWS.map((w) => (
          <Chip key={w.id} active={p.windowId === w.id} onClick={() => p.setWindowId(w.id)}>{w.label}</Chip>
        ))}
      </div>
      {p.windowId === "week" && <p className="caption">Days 4–7 rely on longer-range wind and swell forecasts — treat them as a heads-up.</p>}

      {p.stale && <div className="banner">Offline — showing your last update.</div>}
      {p.error && !p.stale && <div className="banner banner-err">{p.error}</div>}
      {p.loading && !p.results && <div className="empty">Checking the water… 🎣</div>}
      {p.results && results.length === 0 && !p.error && (
        <div className="empty">Nothing fishable in this window 🌊 Try a longer window or more range — rock spots hide when the swell makes them unsafe.</div>
      )}
      {p.results && results.length > 0 && !hasGood && (
        <div className="banner">Slim pickings this time — the best on offer is below.</div>
      )}

      {grouped.map(({ band, items }) => (
        <section key={band.id} className="band">
          <h2 className="band-title" style={{ color: band.color }}>
            <span className="band-emoji">{band.emoji}</span>{band.name}
            <span className="band-count">{items.length}</span>
          </h2>
          <ol className="cards">
            {items.map((r) => {
              const spot = p.spots.get(r.spot_id);
              if (!spot) return null;
              const why = topReasons(r);
              const regs = [...new Map(r.species.flatMap((s) => s.regulations ?? []).map((g) => [g.id, g])).values()];
              return (
                <li key={r.spot_id} className="card" style={{ borderLeftColor: band.color }}
                  onClick={() => p.openSpot(r.spot_id, r.block_start)}>
                  <div className="card-body">
                    <div className="card-top">
                      <span className="card-name">{spot.name}</span>
                      <span className="score-chip" style={{ background: band.soft, color: band.color }}>{Math.round(r.top_score)}</span>
                    </div>
                    <div className="card-when">{fmtWhen(r.block_start, r.block_hours, p.now)}</div>
                    <div className="card-meta">
                      🚗 {fmtTravel(p.travel.get(r.spot_id) ?? 0)}
                      {p.activeTripSpot === r.spot_id && <span className="live-dot"> · Fishing now</span>}
                    </div>
                    {why.length > 0 && <div className="card-why">{capitalise(why.join(", "))}</div>}
                    {r.alt_blocks && r.alt_blocks.length > 0 && (
                      <div className="alts">
                        <span>Also</span>
                        {r.alt_blocks.map((a) => {
                          const b = bandFor(a.score);
                          return (
                            <button key={a.block_start} className="alt" style={{ background: b.soft, color: b.color }}
                              onClick={(e) => { e.stopPropagation(); p.openSpot(r.spot_id, a.block_start); }}>
                              {fmtShort(a.block_start, p.now)} · {Math.round(a.score)}
                            </button>
                          );
                        })}
                      </div>
                    )}
                    {r.safety === "caution" && <span className="flag flag-warn">⚠️ {r.safety_text ?? "Caution"}</span>}
                    {regs.filter((g) => g.action !== "permit").map((g) => (
                      <span key={g.id} className="flag flag-warn">{g.text}</span>
                    ))}
                    {regs.some((g) => g.action === "permit") && <span className="flag flag-info">🎫 Permit needed (SIP)</span>}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
      {results.length > 0 && <p className="caption center">Rated on conditions for catching fish (50 = average) · closest first in each group</p>}
    </div>
  );
}

/** Reasons shared by the most species at this spot (spot-level "why"), strongest first. */
function topReasons(r: SpotWindow): string[] {
  const tally = new Map<string, { text: string; pts: number }>();
  for (const sp of r.species) {
    for (const x of sp.reasons) {
      if (x.points <= 0 || x.factor === "season") continue;
      const t = tally.get(x.factor) ?? { text: x.text, pts: 0 };
      t.pts += x.points;
      tally.set(x.factor, t);
    }
  }
  return [...tally.values()].sort((a, b) => b.pts - a.pts).slice(0, 3).map((t) => t.text);
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
