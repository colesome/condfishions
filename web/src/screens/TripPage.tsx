import { useEffect, useMemo, useState } from "react";
import { toBlocks } from "../lib/aggregate";
import { api } from "../lib/api";
import { bandFor } from "../lib/bands";
import { tackleLabel } from "../lib/tackle";
import { fmtWhen, hm } from "../lib/time";
import {
  addCatch, createPastTrip, deleteCatch, editTrip, saveReview, setSkunked, updateCatch,
} from "../lib/trips";
import type { Species, Spot, TackleKind, TripCatch, TripDetail } from "../lib/types";
import { shortName } from "./Suggest";
import { CatchSheet, localInput, ReviewSheet, TacklePicker } from "./Trips";

const PHASE: Record<string, string> = {
  low_slack: "Low tide change", high_slack: "High tide change", rising_early: "Early run-in",
  rising_mid: "Mid run-in", rising_late: "Late run-in", falling_early: "Early run-out",
  falling_mid: "Mid run-out", falling_late: "Last of the run-out",
};

// ── One finished trip ─────────────────────────────────────────────────────────
export function TripPage({ tripId, spots, species, recentSpots, onClose, onDeleted, openSpot, onSpeciesAdded, onSpeciesRemoved }: {
  tripId: string; spots: Map<string, Spot>; species: Species[]; recentSpots: string[];
  onClose: () => void; onDeleted: () => void; openSpot: (id: string) => void;
  onSpeciesAdded: (sp: Species) => void; onSpeciesRemoved: (id: string) => void;
}) {
  const [t, setT] = useState<TripDetail | null | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [editCatch, setEditCatch] = useState<TripCatch | null>(null);
  const [forecastNow, setForecastNow] = useState<number | null>(null);
  const spName = (id: string) => shortName(species.find((s) => s.id === id), id);

  const load = () => api.tripDetail(tripId).then(setT).catch(() => setT(null));
  // writes go through the offline queue first, so give it a moment before re-reading
  const reloadSoon = () => setTimeout(() => void load(), 700);
  useEffect(() => { void load(); }, [tripId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { // until the overnight rating exists, use the forecast for that time if it's still on hand
    if (!t || t.score_at_time != null || !t.end_ts) { setForecastNow(null); return; }
    const s = new Date(t.start_ts).getTime(), e = new Date(t.end_ts).getTime();
    api.spotScores(t.spot_id, new Date(s - 4 * 3600_000)).then((rows) => {
      const hit = toBlocks(rows).filter((b) => {
        const bs = new Date(b.block_start).getTime();
        return bs < e && bs + b.block_hours * 3600_000 > s && !b.no_go;
      });
      setForecastNow(hit.length ? hit.reduce((n, b) => n + b.top_score, 0) / hit.length : null);
    }).catch(() => setForecastNow(null));
  }, [t]);

  if (t === undefined) return <div className="sheet"><div className="empty">Loading…</div></div>;
  if (t === null) {
    return (
      <div className="sheet">
        <div className="navbar"><button className="back" onClick={onClose}><span>‹</span>Back</button></div>
        <div className="empty">Couldn't load this trip — are you online? (New trips appear once they've uploaded.)</div>
      </div>
    );
  }

  const spot = spots.get(t.spot_id);
  const start = new Date(t.start_ts), end = t.end_ts ? new Date(t.end_ts) : null;
  const mins = end ? Math.round((end.getTime() - start.getTime()) / 60000) : 0;
  const archive = t.observed.find((o) => o.source === "archive")?.vals as Record<string, number | string | null> | undefined;
  const review = t.observed.find((o) => o.source === "angler")?.vals as Record<string, unknown> | undefined;
  const photoFor = (id: string) => t.photos.find((p) => p.catch_id === id)?.url;
  const fish = t.catches.reduce((n, c) => n + c.count, 0);

  async function del() {
    if (!confirm("Delete this trip and its photos? This can't be undone.")) return;
    try { await api.deleteTrip(t!.id); onDeleted(); } catch (e) { alert(`Couldn't delete — are you online? (${(e as Error).message})`); }
  }

  const rating = (label: string, v: number | null | undefined, note?: string) => {
    if (v == null) return null;
    const b = bandFor(Number(v));
    return (
      <div className="rating-row">
        <span>{label}{note && <small>{note}</small>}</span>
        <span className="score-chip" style={{ background: b.soft, color: b.color }}>{Math.round(Number(v))}</span>
      </div>
    );
  };

  return (
    <div className="sheet">
      <div className="navbar">
        <button className="back" onClick={onClose}><span>‹</span>Trips</button>
        <button className="link" onClick={() => setEditing(true)}>Edit</button>
      </div>
      <h1>{spot?.name ?? t.spot_id}</h1>
      <p className="sub">
        {start.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long" })} · {hm(start)}{end ? `–${hm(end)}` : ""}
        {mins > 0 ? ` · ${mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h${mins % 60 ? ` ${mins % 60} min` : ""}`}` : ""}
      </p>
      {(t.logged_after || t.times_edited_at) && (
        <p className="tags">{t.logged_after && <span className="tag">Logged afterwards</span>}{t.times_edited_at && <span className="tag">Times edited</span>}</p>
      )}

      <div className="detail">
        {rating("Rating before you went", t.score_shown)}
        {rating("Rating for the time you fished", t.score_at_time, "from measured conditions")}
        {t.score_at_time == null && rating("Forecast for that time", forecastNow, "measured rating comes overnight")}
        {t.score_at_time == null && forecastNow == null && (
          <p className="hint" style={{ margin: 0 }}>The rating for the hours you fished is worked out from measured conditions on the next early-morning update{t.times_edited_at ? " (for the new time)" : ""}.</p>
        )}
      </div>

      <div className="group-title">Catches</div>
      <div className="group">
        {t.catches.length === 0 && <div className="row muted">No fish this time 🫙</div>}
        {t.catches.map((c) => (
          <button key={c.id} className="row" onClick={() => setEditCatch(c)}>
            {photoFor(c.id) ? <img className="thumb" src={photoFor(c.id)} alt="" /> : <span className="thumb thumb-empty">🐟</span>}
            <span className="row-main">
              <b>{spName(c.species_id)}</b>{c.max_length_cm ? ` · ${c.max_length_cm} cm` : ""}
              <small>{[tackleLabel(c.method, c.tackle) ?? "Bait/lure not set — tap to add", c.caught_at ? hm(new Date(c.caught_at)) : null, c.released ? "released" : "kept"].filter(Boolean).join(" · ")}</small>
            </span>
            <span className="chev">›</span>
          </button>
        ))}
        <button className="row accent" onClick={() => setAdding(true)}>＋ Add a catch</button>
      </div>

      {archive && (
        <>
          <div className="group-title">Measured conditions</div>
          <dl className="conds detail">
            {([
              ["💨 Wind", archive.wind_kmh != null ? `${archive.wind_kmh} km/h${archive.gust_kmh ? ` (gust ${archive.gust_kmh})` : ""}` : null],
              ["🌊 Waves", archive.wave_h != null ? `${archive.wave_h} m` : null],
              ["↕️ Tide", archive.tide_phase ? PHASE[String(archive.tide_phase)] ?? String(archive.tide_phase) : null],
              ["🌡️ Water", archive.sst != null ? `${archive.sst}°C` : null],
              ["🌧️ Rain", archive.rain_mm != null ? `${archive.rain_mm} mm` : null],
              ["⏱️ Pressure", archive.pressure != null ? `${archive.pressure} hPa` : null],
            ] as [string, string | null][]).filter(([, v]) => v).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
          </dl>
        </>
      )}

      <div className="group-title">Your review</div>
      {review ? (
        <div className="detail">
          <p style={{ margin: 0 }}>{"★".repeat(Number(review.overall ?? 0))}{"☆".repeat(5 - Number(review.overall ?? 0))}
            {" · "}{String(review.water ?? "").replace("_", " ")} water · wind {String(review.wind ?? "")}
            {review.method ? ` · ${review.method === "mixed" ? "bait & lures" : review.method === "lure" ? "lures" : "bait"}` : ""}</p>
          {t.notes && <p className="hint">{t.notes}</p>}
        </div>
      ) : (
        <button className="btn btn-secondary wide" onClick={() => setReviewing(true)}>How was it? ⭐</button>
      )}

      <div className="group" style={{ marginTop: 20 }}>
        {spot && <button className="row accent" onClick={() => openSpot(spot.id)}>Spot conditions ›</button>}
        <button className="row" style={{ color: "var(--poor)", justifyContent: "center" }} onClick={del}>Delete trip</button>
      </div>

      {editing && (
        <TripEditor spots={spots} recentSpots={recentSpots} existing={t} onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); reloadSoon(); }} />
      )}
      {adding && spot && (
        <CatchSheet spot={spot} species={species} caughtHere={[]} onClose={() => setAdding(false)}
          between={end ? { start: t.start_ts, end: t.end_ts! } : undefined}
          onSpeciesAdded={onSpeciesAdded} onSpeciesRemoved={onSpeciesRemoved}
          onSave={async (c) => {
            await addCatch(t.id, c);
            await setSkunked(t.id, fish + 1);
            setAdding(false); reloadSoon();
          }} />
      )}
      {reviewing && spot && (
        <ReviewSheet spot={spot} spotName={spot.name} fish={fish} start={t.start_ts} end={t.end_ts}
          kinds={t.catches.map((c) => c.method)} onClose={() => setReviewing(false)}
          onSave={(r, src) => saveReview(t.id, fish, r, src)}
          onSaved={() => { setReviewing(false); reloadSoon(); }} />
      )}
      {editCatch && (
        <CatchEdit c={editCatch} name={spName(editCatch.species_id)} onClose={() => setEditCatch(null)}
          onSaved={() => { setEditCatch(null); reloadSoon(); }}
          onDelete={async () => {
            if (!confirm("Remove this catch from the trip?")) return;
            await deleteCatch(editCatch.id);
            await setSkunked(t.id, Math.max(0, fish - editCatch.count));
            setEditCatch(null); reloadSoon();
          }} />
      )}
    </div>
  );
}

// ── Fix a saved catch: bait/lure, length, kept or released ───────────────────
function CatchEdit({ c, name, onClose, onSaved, onDelete }: {
  c: TripCatch; name: string; onClose: () => void; onSaved: () => void; onDelete: () => void;
}) {
  const [kind, setKind] = useState<TackleKind>(c.method ?? "bait");
  const [tackle, setTackle] = useState(c.tackle ?? "");
  const [length, setLength] = useState(c.max_length_cm != null ? String(c.max_length_cm) : "");
  const [released, setReleased] = useState(!!c.released);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    await updateCatch(c.id, { method: kind, tackle: tackle.trim() || null, max_length_cm: length ? Number(length) : null, released });
    onSaved();
  };
  return (
    <div className="sheet">
      <div className="navbar">
        <button className="back" onClick={onClose}><span>‹</span>Cancel</button>
        <button className="link" style={{ fontWeight: 600 }} disabled={busy} onClick={save}>Save</button>
      </div>
      <h1>{name}</h1>
      <div className="group-title">Caught on</div>
      <div className="seg tackle-seg">
        <button className={kind === "bait" ? "on" : ""} onClick={() => { setKind("bait"); if (c.method !== "bait") setTackle(""); }}>🪱 Bait</button>
        <button className={kind === "lure" ? "on" : ""} onClick={() => { setKind("lure"); if (c.method !== "lure") setTackle(""); }}>🎣 Lure</button>
      </div>
      <TacklePicker kind={kind} value={tackle} onChange={setTackle} />
      <div className="group-title">Details</div>
      <div className="group">
        <label className="row">
          <span className="row-main">Length (cm)</span>
          <input className="inline-input" inputMode="decimal" placeholder="optional" value={length}
            onChange={(e) => setLength(e.target.value.replace(/[^0-9.]/g, ""))} />
        </label>
        <div className="row">
          <span className="row-main">Kept or released</span>
          <div className="seg mini">
            <button className={released ? "on" : ""} onClick={() => setReleased(true)}>Released</button>
            <button className={!released ? "on" : ""} onClick={() => setReleased(false)}>Kept</button>
          </div>
        </div>
      </div>
      <button className="btn wide" disabled={busy} onClick={save}>Save</button>
      <button className="link link-danger small-link" onClick={onDelete}>Remove this catch</button>
    </div>
  );
}

// ── Log a trip afterwards, or change a finished trip's spot and times ─────────
export function TripEditor({ spots, recentSpots, existing, initial, onClose, onSaved }: {
  spots: Map<string, Spot>; recentSpots: string[];
  existing?: TripDetail; initial?: { spot_id?: string; start?: Date; end?: Date };
  onClose: () => void; onSaved: (tripId: string) => void;
}) {
  const now = new Date();
  const defStart = existing ? new Date(existing.start_ts) : initial?.start ?? new Date(now.getTime() - 3 * 3600_000);
  const defEnd = existing?.end_ts ? new Date(existing.end_ts) : initial?.end ?? new Date(Math.min(now.getTime(), defStart.getTime() + 3 * 3600_000));
  const [spotId, setSpotId] = useState<string | null>(existing?.spot_id ?? initial?.spot_id ?? recentSpots.find((id) => spots.has(id)) ?? null);
  const [date, setDate] = useState(localInput(defStart).slice(0, 10));
  const [from, setFrom] = useState(localInput(defStart).slice(11));
  const [to, setTo] = useState(localInput(defEnd).slice(11));
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const start = new Date(`${date}T${from}`);
  let end = new Date(`${date}T${to}`);
  if (end <= start) end = new Date(end.getTime() + 24 * 3600_000); // went past midnight
  const hours = (end.getTime() - start.getTime()) / 3600_000;
  const spot = spotId ? spots.get(spotId) : undefined;
  const changed = existing && (existing.spot_id !== spotId || new Date(existing.start_ts).getTime() !== start.getTime()
    || new Date(existing.end_ts ?? 0).getTime() !== end.getTime());

  async function save() {
    setErr(null);
    if (!spot) return setErr("Pick the spot you fished.");
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return setErr("Check the date and times.");
    if (start.getTime() > Date.now()) return setErr("That's in the future — book it from the spot page instead.");
    if (hours > 16) return setErr("That's over 16 hours — check the times.");
    setBusy(true);
    try {
      if (existing) {
        if (changed) await editTrip(existing.id, { spot_id: spot.id, start, end }, existing.catches);
        onSaved(existing.id);
      } else {
        const t = await createPastTrip(spot, start, end);
        onSaved(t.id);
      }
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  return (
    <div className="sheet">
      <div className="navbar">
        <button className="back" onClick={onClose}><span>‹</span>Cancel</button>
        <button className="link" style={{ fontWeight: 600 }} disabled={busy} onClick={save}>{existing ? "Save" : "Next"}</button>
      </div>
      <h1>{existing ? "Edit trip" : "Log a past trip"}</h1>
      {!existing && <p className="sub">Where and when — you'll add your catches next.</p>}

      <div className="group-title">Spot</div>
      <div className="group">
        <button className="row" onClick={() => setPicking(true)}>
          <span className="row-main">{spot ? spot.name : <span className="muted">Choose a spot</span>}{spot?.region && <small>{spot.region}</small>}</span>
          <span className="chev">›</span>
        </button>
      </div>

      <div className="group-title">When</div>
      <div className="group">
        <label className="row"><span className="row-main">Date</span>
          <input className="inline-input wide-input" type="date" value={date} max={localInput(now).slice(0, 10)} onChange={(e) => setDate(e.target.value)} /></label>
        <label className="row"><span className="row-main">Started</span>
          <input className="inline-input time-input" type="time" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="row"><span className="row-main">Finished</span>
          <input className="inline-input time-input" type="time" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      {!Number.isNaN(hours) && hours > 0 && (
        <p className="hint">{fmtWhen(start.toISOString(), hours, now)}{end.getDate() !== start.getDate() ? " (finished after midnight)" : ""}</p>
      )}
      {existing && changed && (
        <p className="banner">The measured conditions and rating for this trip will be worked out again for the new {existing.spot_id !== spotId ? "spot and " : ""}time on the next early-morning update. The rating you saw before going stays as it was.</p>
      )}
      {err && <p className="hint err">{err}</p>}
      <button className="btn wide" disabled={busy} onClick={save}>{existing ? "Save changes" : "Next: add catches"}</button>

      {picking && <SpotPicker spots={spots} recent={recentSpots} onClose={() => setPicking(false)} onPick={(id) => { setSpotId(id); setPicking(false); }} />}
    </div>
  );
}

function SpotPicker({ spots, recent, onPick, onClose }: {
  spots: Map<string, Spot>; recent: string[]; onPick: (id: string) => void; onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const term = q.trim().toLowerCase();
  const list = useMemo(() => {
    const all = [...spots.values()];
    if (term) return all.filter((s) => `${s.name} ${s.region ?? ""}`.toLowerCase().includes(term)).slice(0, 40);
    const rec = recent.map((id) => spots.get(id)).filter((s): s is Spot => !!s);
    return [...rec, ...all.filter((s) => !recent.includes(s.id)).sort((a, b) => a.name.localeCompare(b.name))];
  }, [spots, recent, term]);
  return (
    <div className="sheet">
      <div className="navbar"><button className="back" onClick={onClose}><span>‹</span>Back</button></div>
      <h1>Which spot?</h1>
      <input className="modal-input" placeholder="Search spots" value={q} autoFocus onChange={(e) => setQ(e.target.value)} />
      <div className="group" style={{ marginTop: 10 }}>
        {list.map((s, i) => (
          <button key={s.id} className="row" onClick={() => onPick(s.id)}>
            <span className="row-main">{s.name}<small>{!term && i < recent.length ? "Fished before · " : ""}{s.region}</small></span>
          </button>
        ))}
        {list.length === 0 && <div className="row muted">No spots match. Add new spots from the map on the Fish tab.</div>}
      </div>
    </div>
  );
}
