import { useEffect, useMemo, useState } from "react";
import { TideChart } from "../components/TideChart";
import { bandFor } from "../lib/bands";
import { toBlocks } from "../lib/aggregate";
import { api } from "../lib/api";
import { fmtWhen, hm, sameDay } from "../lib/time";
import { fmtTravel } from "../lib/travel";
import type { Score, Species, Spot, SpotPhoto, Tide, TripSummary } from "../lib/types";
import { shortName } from "./Suggest";

interface Props {
  spot: Spot;
  species: Species[];
  travelMin: number;
  now: Date;
  initialBlock?: string;
  fishingHere: boolean;
  onGoFish: (scoreShown: number | null) => void;
  onClose: () => void;
  onDeleted: () => void;
}

type Tab = "times" | "tide" | "photos";

const TYPE_LABEL: Record<string, string> = {
  rock: "Rock platform", rockwall: "Rock wall", beach: "Beach", estuary: "Estuary", jetty: "Jetty",
  fresh_dam: "Dam", fresh_river: "River",
};

export function SpotSheet({ spot, species, travelMin, now, initialBlock, fishingHere, onGoFish, onClose, onDeleted }: Props) {
  const [tab, setTab] = useState<Tab>("times");
  const [rows, setRows] = useState<Score[] | null>(null);
  const [tide, setTide] = useState<Tide | null | undefined>(undefined);
  const [photos, setPhotos] = useState<SpotPhoto[] | null>(null);
  const [trips, setTrips] = useState<TripSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(initialBlock ?? null);

  useEffect(() => {
    const from = new Date(now.getTime() - 3 * 3600_000);
    api.spotScores(spot.id, from).then(setRows).catch((e) => setErr(String(e.message ?? e)));
    api.trips(spot.id).then(setTrips).catch(() => setTrips([]));
    if (spot.tidal) api.tide(spot.id).then(setTide).catch(() => setTide(null));
  }, [spot.id, spot.tidal, now]);

  useEffect(() => {
    if (tab === "photos" && photos === null) api.spotPhotos(spot.id).then(setPhotos).catch(() => setPhotos([]));
  }, [tab, photos, spot.id]);

  const blocks = useMemo(() => toBlocks(rows ?? []), [rows]);
  const days = useMemo(() => {
    const out: { day: Date; blocks: typeof blocks }[] = [];
    for (const b of blocks) {
      const d = new Date(b.block_start);
      const last = out[out.length - 1];
      if (last && sameDay(last.day, d)) last.blocks.push(b);
      else out.push({ day: d, blocks: [b] });
    }
    return out;
  }, [blocks]);

  useEffect(() => { // default selection: the block we came from, else the best in the next 24 h
    if (open || !blocks.length) return;
    const best = blocks.filter((b) => !b.no_go).slice(0, 8).sort((a, b) => b.top_score - a.top_score)[0];
    if (best) setOpen(best.block_start);
  }, [blocks, open]);

  const sel = blocks.find((b) => b.block_start === open) ?? null;
  const current = blocks.find((b) => {
    const t = new Date(b.block_start).getTime();
    return now.getTime() >= t && now.getTime() < t + b.block_hours * 3600_000;
  });
  const tideDay = sel ? new Date(sel.block_start) : now;

  const spName = (id: string) => shortName(species.find((s) => s.id === id), id);
  const directions = `https://maps.apple.com/?daddr=${spot.lat},${spot.lon}&dirflg=d`;
  const finished = (trips ?? []).filter((t) => t.end_ts);
  const withFish = finished.filter((t) => t.catches.some((c) => c.count > 0)).length;

  async function del() {
    if (!confirm(`Delete "${spot.name}"?`)) return;
    await api.deleteSpot(spot.id);
    onDeleted();
  }

  function pickTideDay(d: Date) {
    const sameDayBlocks = blocks.filter((b) => sameDay(new Date(b.block_start), d) && !b.no_go)
      .sort((a, b) => b.top_score - a.top_score);
    setOpen(sameDayBlocks[0]?.block_start ?? null);
  }

  return (
    <div className="sheet has-cta">
      <div className="navbar">
        <button className="back" onClick={onClose}><span>‹</span>Back</button>
        <a className="link" href={directions} target="_blank" rel="noreferrer">Directions</a>
      </div>
      <h1>{spot.name}</h1>
      <p className="sub">{TYPE_LABEL[spot.type] ?? spot.type} · 🚗 {fmtTravel(travelMin)}{spot.access && spot.access !== "car" ? ` · ${spot.access}` : ""}</p>
      <p className="sub">🐟 {spot.species.map(spName).join(", ")}</p>
      {finished.length > 0 && (
        <p className="record">Your record here: {finished.length} trip{finished.length === 1 ? "" : "s"} · fish on {withFish}</p>
      )}

      <div className="seg" style={{ marginTop: 14 }}>
        <button className={tab === "times" ? "on" : ""} onClick={() => setTab("times")}>Times</button>
        {spot.tidal && <button className={tab === "tide" ? "on" : ""} onClick={() => setTab("tide")}>Tide</button>}
        <button className={tab === "photos" ? "on" : ""} onClick={() => setTab("photos")}>Photos</button>
      </div>

      {err && <div className="banner banner-err">{err}</div>}

      {tab === "times" && (
        <>
          {!rows && !err && <div className="empty">Loading…</div>}
          {rows && days.length === 0 && <div className="empty">No scores yet — new spots are scored on the next update.</div>}
          {days.map(({ day, blocks: bl }) => (
            <section key={day.toISOString()} className="day">
              <h3>{day.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long" })}</h3>
              <div className="strip">
                {bl.map((b) => {
                  const band = bandFor(b.top_score);
                  return (
                    <button key={b.block_start}
                      className={`blk ${b.no_go ? "blk-nogo" : ""} ${open === b.block_start ? "blk-open" : ""}`}
                      style={b.no_go ? undefined : { background: band.color }}
                      onClick={() => setOpen(open === b.block_start ? null : b.block_start)}>
                      <span>{hm(new Date(b.block_start))}</span>
                      <b>{b.no_go ? "✕" : Math.round(b.top_score)}</b>
                    </button>
                  );
                })}
              </div>
              {sel && bl.includes(sel) && (
                <BlockDetail b={sel} spName={spName} now={now} onTide={spot.tidal ? () => setTab("tide") : undefined} />
              )}
            </section>
          ))}
        </>
      )}

      {tab === "tide" && (
        <div className="detail" style={{ marginTop: 14 }}>
          {tide === undefined && <div className="empty">Loading…</div>}
          {tide === null && <div className="empty">No tide data yet — it appears after the next update.</div>}
          {tide && (
            <>
              <div className="tide-days">
                {[...new Set(tide.series.map(([t]) => new Date(t).toDateString()))].slice(0, 7).map((ds) => {
                  const d = new Date(ds);
                  return (
                    <button key={ds} className={`chip ${sameDay(d, tideDay) ? "chip-on" : ""}`} onClick={() => pickTideDay(d)}>
                      {sameDay(d, now) ? "Today" : d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric" })}
                    </button>
                  );
                })}
              </div>
              <TideChart tide={tide} day={tideDay} now={now}
                highlight={sel ? { start: sel.block_start, hours: sel.block_hours } : null} />
              {sel && (
                <p className="tide-caption"><span className="hl-swatch" /> {fmtWhen(sel.block_start, sel.block_hours, now)} · {Math.round(sel.top_score)} {bandFor(sel.top_score).name}</p>
              )}
              <p className="hint">Tap a time on the Times tab to move the highlight. Modelled tide: times are a good guide, heights are relative.</p>
            </>
          )}
        </div>
      )}

      {tab === "photos" && (
        <>
          {photos === null && <div className="empty">Loading…</div>}
          {photos && photos.length === 0 && (
            <div className="empty">No catches photographed here yet 📸<br />Tap “Go fish here” and log your first one.</div>
          )}
          {photos && photos.length > 0 && (
            <div className="photo-grid">
              {photos.map((ph) => (
                <figure key={ph.id}>
                  <img src={ph.url} alt="" loading="lazy" />
                  <figcaption>{ph.species_id ? spName(ph.species_id) : "Catch"}{ph.length ? ` · ${ph.length} cm` : ""}<br />
                    <small>{new Date(ph.taken_at).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" })}</small>
                  </figcaption>
                </figure>
              ))}
            </div>
          )}
        </>
      )}

      {!spot.verified && <p className="hint">Pin location is approximate — check it when you're there.</p>}
      {spot.source === "user" && (
        <div className="group" style={{ marginTop: 20 }}>
          <button className="row" style={{ color: "var(--poor)", justifyContent: "center" }} onClick={del}>Delete spot</button>
        </div>
      )}

      <div className="cta">
        {fishingHere
          ? <button className="btn wide cta-live" onClick={onClose}>🎣 You're fishing here — open trip</button>
          : <button className="btn wide" onClick={() => onGoFish(current && !current.no_go ? current.top_score : null)}>🎣 Go fish here</button>}
      </div>
    </div>
  );
}

function BlockDetail({ b, spName, now, onTide }: {
  b: ReturnType<typeof toBlocks>[number]; spName: (id: string) => string; now: Date; onTide?: () => void;
}) {
  const band = bandFor(b.top_score);
  return (
    <div className="detail">
      <div className="detail-when">{fmtWhen(b.block_start, b.block_hours, now)}</div>
      {b.no_go ? (
        <div className="banner banner-err">{b.safety_text ?? "Unsafe in this window"}</div>
      ) : (
        <>
          <div className="band-line" style={{ color: band.color }}>{band.emoji} {band.name} · {Math.round(b.top_score)}</div>
          {b.safety === "caution" && <span className="flag flag-warn">⚠️ {b.safety_text}</span>}
          <ul className="sp-list">
            {b.species.map((s) => {
              const sb = bandFor(s.score);
              return (
                <li key={s.species_id}>
                  <div className="sp-line">
                    <span className="dot" style={{ background: sb.color }} />
                    <span>{spName(s.species_id)}</span>
                    <span className="num" style={{ color: sb.color }}>{Math.round(s.score)}</span>
                  </div>
                  <small>{s.reasons.slice(0, 3).map((x) => x.text).join(" · ")}</small>
                  {s.regulations?.map((g) => (
                    <span key={g.id} className={`flag ${g.action === "permit" ? "flag-info" : "flag-warn"}`}>{g.text}</span>
                  ))}
                </li>
              );
            })}
          </ul>
          {b.species[0] && <Conditions c={b.species[0].conditions} />}
          {onTide && <button className="link small-link" onClick={onTide}>See this time on the tide chart ›</button>}
        </>
      )}
    </div>
  );
}

const PHASE: Record<string, string> = {
  low_slack: "Low tide change", high_slack: "High tide change", rising_early: "Early run-in",
  rising_mid: "Mid run-in", rising_late: "Late run-in", falling_early: "Early run-out",
  falling_mid: "Mid run-out", falling_late: "Last of the run-out",
};

function Conditions({ c }: { c: Record<string, number | string | null> }) {
  const items: [string, string | null][] = [
    ["💨 Wind", c.wind_kmh != null ? `${c.wind_kmh} km/h ${c.wind_dir ?? ""}${c.gust_kmh ? ` (gust ${c.gust_kmh})` : ""}` : null],
    ["🌊 Sea", c.wave_h != null ? `${c.wave_h} m${c.swell_period ? ` @ ${c.swell_period}s` : ""}` : null],
    ["↕️ Tide", c.tide_phase ? PHASE[String(c.tide_phase)] ?? String(c.tide_phase) : null],
    ["🌡️ Water", c.sst != null ? `${c.sst}°C` : null],
    ["☀️ Air", c.air_temp != null ? `${c.air_temp}°C` : null],
    ["🌧️ Rain 72 h", c.rain_72h != null ? `${c.rain_72h} mm` : null],
    ["⏱️ Pressure", c.pressure != null ? `${c.pressure} hPa` : null],
  ];
  return (
    <dl className="conds">
      {items.filter(([, v]) => v).map(([k, v]) => (
        <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
      ))}
    </dl>
  );
}
