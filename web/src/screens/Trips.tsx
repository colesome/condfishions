import { useEffect, useRef, useState } from "react";
import { toBlocks } from "../lib/aggregate";
import { api } from "../lib/api";
import { bandFor } from "../lib/bands";
import { getBlob } from "../lib/queue";
import { addToCalendar } from "../lib/calendar";
import { cancelPlan, markSeen, planNow, scoreLine, unseen } from "../lib/plans";
import { fmtWhen, hm } from "../lib/time";
import { confirmRemoveSpecies } from "../lib/speciesActions";
import { lastTackleKind, methodFromCatches, tackleChoices, tackleLabel } from "../lib/tackle";
import {
  compressImage, finishTrip, logCatch, prefill, removeLastCatch, type ActiveTrip, type NewCatch, type Review,
} from "../lib/trips";
import type { PlannedTrip, Species, Spot, TackleKind, TripSummary } from "../lib/types";
import { shortName } from "./Suggest";
import { TripEditor, TripPage } from "./TripPage";

// ── Trips tab ─────────────────────────────────────────────────────────────────
interface TripsProps {
  active: ActiveTrip | null;
  setActive: (a: ActiveTrip | null) => void;
  spots: Map<string, Spot>;
  species: Species[];
  pending: number;
  openSpot: (id: string) => void;
  onSpeciesAdded: (sp: Species) => void;
  onSpeciesRemoved: (id: string) => void;
  plans: PlannedTrip[];
  reloadPlans: () => void;
  focusPlan: string | null;
  goFish: (spot: Spot, score: number | null, planId: string | null) => void;
}

export function Trips({ active, setActive, spots, species, pending, openSpot, onSpeciesAdded, onSpeciesRemoved, plans, reloadPlans, focusPlan, goFish }: TripsProps) {
  const [history, setHistory] = useState<TripSummary[] | null>(null);
  const [catching, setCatching] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [openTrip, setOpenTrip] = useState<string | null>(null);
  const [logging, setLogging] = useState<{ spot_id?: string; start?: Date; end?: Date; planId?: string } | null>(null);
  const spName = (id: string) => shortName(species.find((s) => s.id === id), id);

  const reload = () => api.trips().then(setHistory).catch(() => setHistory([]));
  useEffect(() => { void reload(); }, [active]);
  useEffect(() => { // you've now seen any changes the scorer flagged
    const fresh = plans.filter(unseen);
    if (fresh.length) void Promise.all(fresh.map(markSeen)).then(reloadPlans);
  }, [plans]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (focusPlan) document.getElementById(`plan-${focusPlan}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusPlan, plans]);
  const upcoming = plans.filter((p) => p.status === "planned");
  const missed = plans.filter((p) => p.status === "past" && !p.session_id);
  const recentSpots = [...new Set((history ?? []).map((t) => t.spot_id))];

  async function deleteTrip(id: string) {
    if (!confirm("Delete this trip and its photos? This can't be undone.")) return false;
    try {
      await api.deleteTrip(id);
      setHistory((h) => (h ?? []).filter((t) => t.id !== id));
      setToast("Trip deleted");
      return true;
    } catch (e) {
      alert(`Couldn't delete — are you online? (${(e as Error).message})`);
      return false;
    }
  }
  useEffect(() => { if (toast) { const t = setTimeout(() => setToast(null), 2600); return () => clearTimeout(t); } }, [toast]);

  const spot = active ? spots.get(active.trip.spot_id) : undefined;

  return (
    <div className="screen">
      <div className="title-row">
        <h1>Trips</h1>
        <div className="title-actions">
          {pending > 0 && <span className="sync">⟳ {pending} to upload</span>}
          <button className="pill-btn" onClick={() => setLogging({})}>＋ Past trip</button>
        </div>
      </div>

      {active && spot ? (
        <div className="live-card">
          <div className="live-head">
            <span className="pulse" /> Fishing now
          </div>
          <h2>{active.spot_name}</h2>
          <p className="sub">Since {hm(new Date(active.trip.start_ts))} · <Elapsed since={active.trip.start_ts} /></p>

          <button className="btn big-btn" onClick={() => setCatching(true)}>📸 Log a catch</button>

          {active.catches.length > 0 ? (
            <ul className="catch-list">
              {active.catches.map((c) => (
                <li key={c.id}>
                  <Thumb photoKey={c.photo_key} />
                  <div><b>{spName(c.species_id)}</b>{c.max_length_cm ? ` · ${c.max_length_cm} cm` : ""}
                    <small>{hm(new Date(c.caught_at))}{c.released ? " · released" : " · kept"}{tackleLabel(c.method, c.tackle) ? ` · ${tackleLabel(c.method, c.tackle)}` : ""}</small></div>
                </li>
              ))}
            </ul>
          ) : <p className="hint center">No fish yet — keep at it 🤞</p>}
          {active.catches.length > 0 && (
            <button className="link small-link" onClick={async () => setActive(await removeLastCatch(active))}>Undo last catch</button>
          )}

          <button className="btn wide btn-secondary" onClick={() => setReviewing(true)}>
            {active.catches.length ? "Finish trip" : "Finish — caught nothing"}
          </button>
          <button className="link small-link" onClick={() => openSpot(spot.id)}>Spot conditions ›</button>
        </div>
      ) : (
        <div className="empty-card">
          <div className="big-emoji">🎣</div>
          <b>No trip running</b>
          <p>Open a spot on the Fish tab and tap <b>Go fish here</b>. Log every trip — even the empty ones help the app learn.</p>
          <button className="btn btn-secondary wide" onClick={() => setLogging({})}>＋ Log a trip you've done</button>
        </div>
      )}

      {upcoming.length > 0 && <div className="group-title">Booked</div>}
      {upcoming.map((p) => {
        const sp = spots.get(p.spot_id);
        if (!sp) return null;
        const { now: sNow, booked, worse } = scoreLine(p);
        const nowBand = sNow != null ? bandFor(sNow) : booked != null ? bandFor(booked) : null;
        const fishable = !!planNow([p], sp.id) && !active;
        return (
          <div key={p.id} id={`plan-${p.id}`} className={`plan-card ${p.changes.length ? "plan-warn" : ""} ${focusPlan === p.id ? "plan-focus" : ""}`}>
            <div className="card-top">
              <button className="plan-main" onClick={() => openSpot(sp.id)}>
                <b>{sp.name}</b>
                <small>{fmtWhen(p.block_start, p.block_hours)}</small>
              </button>
              {nowBand && (
                <span className="score-chip" style={{ background: nowBand.soft, color: nowBand.color }}>
                  {worse && booked != null ? <s className="was">{booked}</s> : null}{sNow ?? booked}
                </span>
              )}
            </div>
            {p.changes.length > 0 ? (
              <ul className="plan-changes">
                {p.changes.map((c) => <li key={c.kind} className={c.severity === 2 ? "sev2" : ""}>⚠️ {c.text}</li>)}
              </ul>
            ) : (
              <p className="plan-ok">{p.checked_at ? "✅ Still looking as good as when you booked" : "We'll check it every forecast update and tell you if it gets worse."}</p>
            )}
            <div className="plan-actions">
              {fishable && <button className="pick pick-on" onClick={() => goFish(sp, p.score_now ?? p.score_booked, p.id)}>🎣 Go fish</button>}
              <button className="pick" onClick={() => addToCalendar(p, sp, sp.species.map(spName).join(", "))}>📅 Calendar</button>
              <button className="pick" onClick={async () => {
                if (!confirm(`Cancel ${sp.name}, ${fmtWhen(p.block_start, p.block_hours)}? (Remove it from your calendar too.)`)) return;
                try { await cancelPlan(p.id); reloadPlans(); } catch (e) { alert(`Couldn't cancel — are you online? (${(e as Error).message})`); }
              }}>Cancel</button>
            </div>
          </div>
        );
      })}
      {missed.map((p) => {
        const sp = spots.get(p.spot_id);
        if (!sp) return null;
        const start = new Date(p.block_start);
        return (
          <div key={p.id} className="plan-card plan-missed">
            <b>Did you fish {sp.name}?</b>
            <small>{fmtWhen(p.block_start, p.block_hours)}</small>
            <div className="plan-actions">
              <button className="pick pick-on" onClick={() => setLogging({ spot_id: sp.id, start, end: new Date(start.getTime() + p.block_hours * 3600_000), planId: p.id })}>Yes — log it</button>
              <button className="pick" onClick={async () => { await cancelPlan(p.id).catch(() => undefined); reloadPlans(); }}>Didn't go</button>
            </div>
          </div>
        );
      })}

      <div className="group-title">History</div>
      {history === null && <div className="empty">Loading…</div>}
      {history && history.filter((t) => t.end_ts).length === 0 && <p className="hint">Your finished trips will show here.</p>}
      {history && history.filter((t) => t.end_ts).length > 0 && <p className="hint">Swipe a trip left to delete it.</p>}
      {history && history.filter((t) => t.end_ts).length > 0 && (
        <div className="group">
          {history.filter((t) => t.end_ts).map((t) => {
            const fish = t.catches.reduce((n, c) => n + (c.count ?? 0), 0);
            const sp = [...new Set(t.catches.filter((c) => c.count > 0).map((c) => spName(c.species_id)))];
            const shown = t.score_shown ?? t.score_at_time ?? null;
            const band = shown != null ? bandFor(Number(shown)) : null;
            return (
              <SwipeRow key={t.id} onOpen={() => setOpenTrip(t.id)} onDelete={() => deleteTrip(t.id)}>
                <span className="trip-fish">{fish > 0 ? "🐟" : "🫙"}</span>
                <span className="row-main">
                  {spots.get(t.spot_id)?.name ?? t.spot_id}
                  <small>{new Date(t.start_ts).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" })}
                    {" · "}{fish > 0 ? `${fish} fish${sp.length ? ` (${sp.join(", ")})` : ""}` : "no fish"}{t.logged_after ? " · logged after" : ""}</small>
                </span>
                {band && <span className="score-chip" style={{ background: band.soft, color: band.color }}>{Math.round(Number(t.score_shown ?? t.score_at_time))}</span>}
              </SwipeRow>
            );
          })}
        </div>
      )}

      {catching && active && spot && (
        <CatchSheet spot={spot} species={species} onClose={() => setCatching(false)}
          caughtHere={[...new Set((history ?? []).filter((t) => t.spot_id === spot.id).flatMap((t) => t.catches.filter((c) => c.count > 0).map((c) => c.species_id)))]}
          onSpeciesAdded={onSpeciesAdded} onSpeciesRemoved={onSpeciesRemoved}
          onSave={async (c) => {
            setActive(await logCatch(active, c));
            setCatching(false);
            setToast(["Get in! 🎉", "Nice one! 🐟", "Tight lines! 🎣", "Beauty! 🙌"][Math.floor(Math.random() * 4)]);
          }} />
      )}
      {reviewing && active && spot && (
        <ReviewSheet spot={spot} spotName={active.spot_name} fish={active.catches.length} start={active.trip.start_ts} end={null}
          kinds={active.catches.map((c) => c.method)} onClose={() => setReviewing(false)}
          onSave={(r, src) => finishTrip(active, r, src)}
          onSaved={() => {
            setReviewing(false);
            setToast(active.catches.length ? "Trip saved 🎉" : "Saved — blanks count too 👍");
            setActive(null);
          }} />
      )}
      {logging && (
        <TripEditor spots={spots} recentSpots={recentSpots} initial={logging} onClose={() => setLogging(null)}
          onSaved={async (tripId) => {
            if (logging.planId) await api.update("planned_trips", logging.planId, { status: "done", session_id: tripId }).catch(() => undefined);
            setLogging(null); reloadPlans();
            setTimeout(() => { void reload(); setOpenTrip(tripId); }, 300);
          }} />
      )}
      {openTrip && (
        <TripPage tripId={openTrip} spots={spots} species={species} recentSpots={recentSpots}
          onClose={() => { setOpenTrip(null); void reload(); }} openSpot={openSpot}
          onDeleted={() => { setOpenTrip(null); void reload(); setToast("Trip deleted"); }}
          onSpeciesAdded={onSpeciesAdded} onSpeciesRemoved={onSpeciesRemoved} />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function Elapsed({ since }: { since: string }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 60_000); return () => clearInterval(t); }, []);
  const m = Math.max(0, Math.round((Date.now() - new Date(since).getTime()) / 60000));
  return <>{m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`}</>;
}

export function Thumb({ photoKey }: { photoKey: string | null }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let u: string | null = null;
    if (photoKey) getBlob(photoKey).then((b) => { if (b) { u = URL.createObjectURL(b); setUrl(u); } });
    return () => { if (u) URL.revokeObjectURL(u); };
  }, [photoKey]);
  return url ? <img className="thumb" src={url} alt="" /> : <span className="thumb thumb-empty">🐟</span>;
}

// ── Log a catch ───────────────────────────────────────────────────────────────
export function CatchSheet({ spot, species, caughtHere, onSpeciesAdded, onSpeciesRemoved, onClose, onSave, between }: {
  spot: Spot; species: Species[]; caughtHere: string[]; onSpeciesAdded: (sp: Species) => void;
  onSpeciesRemoved: (id: string) => void; onClose: () => void;
  onSave: (c: NewCatch) => Promise<void>;
  /** Logging after the trip: ask what time it was caught (defaults to the middle of the trip). */
  between?: { start: string; end: string };
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const libRef = useRef<HTMLInputElement>(null);
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [sp, setSp] = useState<string>(spot.species[0]);
  const [extra, setExtra] = useState<string[]>([]);
  const [asking, setAsking] = useState(false);
  const [length, setLength] = useState("");
  const [released, setReleased] = useState(true);
  const [kind, setKind] = useState<TackleKind>(lastTackleKind);
  const [tackle, setTackle] = useState("");
  const [time, setTime] = useState(() => between ? localInput(new Date((new Date(between.start).getTime() + new Date(between.end).getTime()) / 2)) : "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    try {
      await onSave({
        species_id: sp, length: length ? Number(length) : null, released, photo,
        method: kind, tackle: tackle.trim() || null, caught_at: between && time ? new Date(time).toISOString() : undefined,
      });
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  const spName = (id: string) => shortName(species.find((s) => s.id === id), id);
  const choices = [...new Set([...spot.species, ...caughtHere, ...extra])]
    .filter((id) => !id.startsWith("user_") || species.some((s) => s.id === id));
  const nameOf = (id: string) => species.find((s) => s.id === id)?.name ?? spName(id);

  async function pick(f: File | undefined) {
    if (!f) return;
    try {
      const b = await compressImage(f);
      setPhoto(b);
      if (preview) URL.revokeObjectURL(preview);
      setPreview(URL.createObjectURL(b));
    } catch (e) { setErr((e as Error).message); }
  }

  return (
    <div className="sheet">
      <div className="navbar">
        <button className="back" onClick={onClose}><span>‹</span>Cancel</button>
        <button className="link" style={{ fontWeight: 600 }} disabled={busy} onClick={save}>Save</button>
      </div>
      <h1>Log a catch</h1>

      {/* camera: capture opens the camera directly; library: no capture → Photos picker */}
      <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden
        onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
      <input ref={libRef} type="file" accept="image/*" hidden
        onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
      <div className="photo-drop">
        {preview ? <img src={preview} alt="" /> : <span>📸<br />Add a photo<small>optional</small></span>}
      </div>
      <div className="photo-actions">
        <button className="btn photo-btn" onClick={() => fileRef.current?.click()}>📷 Take photo</button>
        <button className="btn photo-btn photo-btn-alt" onClick={() => libRef.current?.click()}>🖼️ From library</button>
      </div>
      {preview && <button className="link small-link" onClick={() => { setPhoto(null); if (preview) URL.revokeObjectURL(preview); setPreview(null); }}>Remove photo</button>}

      <div className="group-title">Species</div>
      <div className="pick-grid">
        {choices.map((id) => (
          <button key={id} className={`pick ${sp === id ? "pick-on" : ""}`} onClick={() => setSp(id)}>{id.startsWith("user_") ? nameOf(id) : spName(id)}</button>
        ))}
        <button className="pick pick-other" onClick={() => setAsking(true)}>＋ Other…</button>
      </div>

      <div className="group-title">Caught on</div>
      <div className="seg tackle-seg">
        <button className={kind === "bait" ? "on" : ""} onClick={() => { setKind("bait"); setTackle(""); }}>🪱 Bait</button>
        <button className={kind === "lure" ? "on" : ""} onClick={() => { setKind("lure"); setTackle(""); }}>🎣 Lure</button>
      </div>
      <TacklePicker kind={kind} value={tackle} onChange={setTackle} />

      <div className="group-title">Details</div>
      <div className="group">
        {between && (
          <label className="row">
            <span className="row-main">Time caught</span>
            <input className="inline-input wide-input" type="datetime-local" value={time}
              min={localInput(new Date(between.start))} max={localInput(new Date(between.end))}
              onChange={(e) => setTime(e.target.value)} />
          </label>
        )}
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
      {err && <p className="hint err">{err}</p>}
      <button className="btn wide" disabled={busy} onClick={save}>Save catch</button>
      {asking && (
        <SpeciesPrompt species={species} exclude={choices.filter((id) => !id.startsWith("user_"))} onClose={() => setAsking(false)}
          onRemove={async (s) => {
            if (!(await confirmRemoveSpecies(s))) return;
            onSpeciesRemoved(s.id);
            setExtra((x) => x.filter((i) => i !== s.id));
            if (sp === s.id) setSp(spot.species[0]);
          }}
          onPick={async (picked) => {
            setAsking(false);
            setErr(null);
            try {
              const s = typeof picked === "string" ? await api.addSpecies(picked) : picked;
              if (typeof picked === "string") onSpeciesAdded(s);
              setExtra((x) => [...new Set([...x, s.id])]);
              setSp(s.id);
            } catch (e) {
              setErr(`Couldn't add that species — are you online? (${(e as Error).message})`);
            }
          }} />
      )}
    </div>
  );
}

/** Which bait or lure: tap a recent/common one or type your own. */
export function TacklePicker({ kind, value, onChange }: { kind: TackleKind; value: string; onChange: (v: string) => void }) {
  const choices = tackleChoices(kind);
  return (
    <>
      <div className="pick-grid">
        {choices.map((t) => (
          <button key={t} className={`pick ${value.toLowerCase() === t.toLowerCase() ? "pick-on" : ""}`} onClick={() => onChange(value === t ? "" : t)}>{t}</button>
        ))}
      </div>
      <input className="modal-input tackle-input" value={value} onChange={(e) => onChange(e.target.value)}
        placeholder={kind === "bait" ? "Which bait? e.g. Prawn, Mullet strip" : "Which lure? e.g. 3\" Z-Man, Halco Roosta"} />
    </>
  );
}

/** Date for an <input type="datetime-local"> in the phone's time zone. */
export function localInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** "What did you catch?" pop-up: pick a known species or type a new one. */
export function SpeciesPrompt({ species, exclude, onPick, onRemove, onClose }: {
  species: Species[]; exclude: string[]; onPick: (s: Species | string) => void;
  onRemove: (s: Species) => void; onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  const term = q.trim().toLowerCase();
  const matches = species
    .filter((s) => !exclude.includes(s.id))
    .filter((s) => !term || s.name.toLowerCase().includes(term))
    .slice(0, 8);
  const exact = species.some((s) => s.name.toLowerCase() === term);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>What did you catch?</h2>
        <input ref={inputRef} className="modal-input" placeholder="e.g. Whiting, Mangrove jack" value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && term) onPick(matches[0] && !exact && matches.length === 1 ? matches[0] : (species.find((s) => s.name.toLowerCase() === term) ?? q)); }} />
        <div className="modal-list">
          {matches.map((s) => (
            <div key={s.id} className="row">
              <button className="row-main row-pick" onClick={() => onPick(s)}>{s.name}{s.id.startsWith("user_") && <small>added by you</small>}</button>
              {s.id.startsWith("user_") && <button className="x" onClick={() => onRemove(s)}>Remove</button>}
            </div>
          ))}
          {term && !exact && <button className="row accent" onClick={() => onPick(q)}>＋ Add “{q.trim()}”</button>}
        </div>
        <button className="link" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

/** List row you can swipe left to reveal Delete (tap still opens). */
export function SwipeRow({ children, onOpen, onDelete }: { children: React.ReactNode; onOpen: () => void; onDelete: () => Promise<boolean> }) {
  const [dx, setDx] = useState(0);
  const [open, setOpen] = useState(false);
  const start = useRef<{ x: number; y: number; base: number } | null>(null);
  const moved = useRef(false);
  const W = 92;
  return (
    <div className="swipe">
      <button className="swipe-delete" style={{ width: W }} onClick={async () => { if (!(await onDelete())) { setDx(0); setOpen(false); } }}>Delete</button>
      <div className="row swipe-front" style={{ transform: `translateX(${dx}px)`, transition: start.current ? "none" : "transform .2s" }}
        onPointerDown={(e) => { start.current = { x: e.clientX, y: e.clientY, base: open ? -W : 0 }; moved.current = false; }}
        onPointerMove={(e) => {
          if (!start.current) return;
          const ddx = e.clientX - start.current.x;
          if (!moved.current && Math.abs(ddx) < 8) return;
          if (!moved.current && Math.abs(e.clientY - start.current.y) > Math.abs(ddx)) { start.current = null; return; }
          moved.current = true;
          setDx(Math.max(-W - 30, Math.min(0, start.current.base + ddx)));
        }}
        onPointerUp={() => {
          if (!start.current) return;
          start.current = null;
          if (!moved.current) { if (open) { setDx(0); setOpen(false); } else onOpen(); return; }
          const o = dx < -W / 2;
          setOpen(o); setDx(o ? -W : 0);
        }}
        onPointerCancel={() => { start.current = null; setDx(open ? -W : 0); }}>
        {children}
      </div>
    </div>
  );
}

// ── Finish & review (pre-filled from the forecast) ───────────────────────────
export function ReviewSheet({ spot, spotName, fish, start: startTs, end: endTs, kinds, onClose, onSave, onSaved }: {
  spot: Spot; spotName: string; fish: number; start: string; end: string | null;
  kinds: (TackleKind | null | undefined)[]; onClose: () => void;
  onSave: (r: Review, src: Record<string, number | string | null> | null) => Promise<void>; onSaved: () => void;
}) {
  const fromCatches = methodFromCatches(kinds);
  const [r, setR] = useState<Review>(() => ({ ...prefill(null, spot), ...(fromCatches ? { method: fromCatches } : {}) }));
  const [src, setSrc] = useState<Record<string, number | string | null> | null>(null);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const fresh = spot.type.startsWith("fresh");

  useEffect(() => { // pre-fill from the forecast for the middle of the trip (if it's still on hand)
    const start = new Date(startTs);
    const mid = new Date((start.getTime() + (endTs ? new Date(endTs).getTime() : Date.now())) / 2);
    api.spotScores(spot.id, new Date(start.getTime() - 3 * 3600_000)).then((rows) => {
      const blocks = toBlocks(rows);
      const b = blocks.find((x) => {
        const t = new Date(x.block_start).getTime();
        return mid.getTime() >= t - 3600_000 && mid.getTime() < t + (x.block_hours + 1) * 3600_000;
      }) ?? (endTs ? undefined : blocks[0]); // a trip logged later only uses a forecast for its own time
      const c = b?.species[0]?.conditions ?? null;
      if (!c) return;
      setSrc(c);
      if (!touched) setR({ ...prefill(c, spot), ...(fromCatches ? { method: fromCatches } : {}) });
    }).catch(() => undefined);
  }, [startTs, endTs, spot, touched]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = <K extends keyof Review>(k: K, v: Review[K]) => { setTouched(true); setR((x) => ({ ...x, [k]: v })); };
  const opt = <K extends keyof Review>(k: K, label: string, options: [Review[K], string][]) => (
    <div className="review-row">
      <span>{label}</span>
      <div className="seg">
        {options.map(([v, l]) => (
          <button key={String(v)} className={r[k] === v ? "on" : ""} onClick={() => set(k, v)}>{l}</button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="sheet">
      <div className="navbar">
        <button className="back" onClick={onClose}><span>‹</span>Back</button>
        <button className="link" style={{ fontWeight: 600 }} disabled={busy}
          onClick={async () => { setBusy(true); await onSave(r, src); onSaved(); }}>Save</button>
      </div>
      <h1>How was it?</h1>
      <p className="sub">{spotName} · {fish ? `${fish} fish 🎉` : "no fish — still useful data 👍"}</p>
      <p className="hint">{src ? "Filled in from the forecast — just fix anything that was different." : "Tap what it was like."}</p>

      <div className="review">
        {opt("wind", "💨 Wind", [["calm", "Calm"], ["light", "Light"], ["strong", "Strong"]])}
        {!fresh && opt("wind_dir", "🧭 Wind was", [["offshore", "Offshore"], ["cross", "Cross"], ["onshore", "Onshore"]])}
        {!fresh && opt("sea", "🌊 Sea", [["flat", "Flat"], ["some_wash", "Some wash"], ["rough", "Rough"]])}
        {opt("water", "💧 Water", [["clear", "Clear"], ["bit_dirty", "Bit dirty"], ["dirty", "Dirty"]])}
        {opt("bait", "🐠 Bait around", [["yes", "Yes"], ["no", "No"], ["unsure", "Not sure"]])}
        {opt("method", "🪝 Fished with", [["lure", "Lures"], ["bait", "Bait"], ["mixed", "Both"]])}
        <div className="review-row">
          <span>⭐ Overall</span>
          <div className="stars">
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} className={n <= r.overall ? "star on" : "star"} onClick={() => set("overall", n)}>★</button>
            ))}
          </div>
        </div>
        <textarea className="notes" placeholder="Notes (optional) — e.g. birds working, lost a big one…"
          value={r.notes} onChange={(e) => set("notes", e.target.value)} />
      </div>

      <button className="btn wide" disabled={busy}
        onClick={async () => { setBusy(true); await onSave(r, src); onSaved(); }}>
        Save trip
      </button>
    </div>
  );
}
