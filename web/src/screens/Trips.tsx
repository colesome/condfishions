import { useEffect, useRef, useState } from "react";
import { toBlocks } from "../lib/aggregate";
import { api } from "../lib/api";
import { bandFor } from "../lib/bands";
import { getBlob } from "../lib/queue";
import { hm } from "../lib/time";
import { compressImage, finishTrip, logCatch, prefill, removeLastCatch, type ActiveTrip, type Review } from "../lib/trips";
import type { Species, Spot, TripSummary } from "../lib/types";
import { shortName } from "./Suggest";

// ── Trips tab ─────────────────────────────────────────────────────────────────
interface TripsProps {
  active: ActiveTrip | null;
  setActive: (a: ActiveTrip | null) => void;
  spots: Map<string, Spot>;
  species: Species[];
  pending: number;
  openSpot: (id: string) => void;
  onSpeciesAdded: (sp: Species) => void;
}

export function Trips({ active, setActive, spots, species, pending, openSpot, onSpeciesAdded }: TripsProps) {
  const [history, setHistory] = useState<TripSummary[] | null>(null);
  const [catching, setCatching] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const spName = (id: string) => shortName(species.find((s) => s.id === id), id);

  const reload = () => api.trips().then(setHistory).catch(() => setHistory([]));
  useEffect(() => { void reload(); }, [active]);

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
      <div className="title-row"><h1>Trips</h1>{pending > 0 && <span className="sync">⟳ {pending} to upload</span>}</div>

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
                    <small>{hm(new Date(c.caught_at))}{c.released ? " · released" : " · kept"}</small></div>
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
        </div>
      )}

      <div className="group-title">History</div>
      {history === null && <div className="empty">Loading…</div>}
      {history && history.filter((t) => t.end_ts).length === 0 && <p className="hint">Your finished trips will show here.</p>}
      {history && history.filter((t) => t.end_ts).length > 0 && <p className="hint">Swipe a trip left to delete it.</p>}
      {history && history.filter((t) => t.end_ts).length > 0 && (
        <div className="group">
          {history.filter((t) => t.end_ts).map((t) => {
            const fish = t.catches.reduce((n, c) => n + (c.count ?? 0), 0);
            const sp = [...new Set(t.catches.filter((c) => c.count > 0).map((c) => spName(c.species_id)))];
            const band = t.score_shown != null ? bandFor(Number(t.score_shown)) : null;
            return (
              <SwipeRow key={t.id} onOpen={() => openSpot(t.spot_id)} onDelete={() => deleteTrip(t.id)}>
                <span className="trip-fish">{fish > 0 ? "🐟" : "🫙"}</span>
                <span className="row-main">
                  {spots.get(t.spot_id)?.name ?? t.spot_id}
                  <small>{new Date(t.start_ts).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" })}
                    {" · "}{fish > 0 ? `${fish} fish${sp.length ? ` (${sp.join(", ")})` : ""}` : "no fish"}</small>
                </span>
                {band && <span className="score-chip" style={{ background: band.soft, color: band.color }}>{Math.round(Number(t.score_shown))}</span>}
              </SwipeRow>
            );
          })}
        </div>
      )}

      {catching && active && spot && (
        <CatchSheet spot={spot} species={species} onClose={() => setCatching(false)}
          caughtHere={[...new Set((history ?? []).filter((t) => t.spot_id === spot.id).flatMap((t) => t.catches.filter((c) => c.count > 0).map((c) => c.species_id)))]}
          onSpeciesAdded={onSpeciesAdded}
          onSave={async (c) => {
            setActive(await logCatch(active, c));
            setCatching(false);
            setToast(["Get in! 🎉", "Nice one! 🐟", "Tight lines! 🎣", "Beauty! 🙌"][Math.floor(Math.random() * 4)]);
          }} />
      )}
      {reviewing && active && spot && (
        <ReviewSheet active={active} spot={spot} onClose={() => setReviewing(false)}
          onSaved={() => {
            setReviewing(false);
            setToast(active.catches.length ? "Trip saved 🎉" : "Saved — blanks count too 👍");
            setActive(null);
          }} />
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

function Thumb({ photoKey }: { photoKey: string | null }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let u: string | null = null;
    if (photoKey) getBlob(photoKey).then((b) => { if (b) { u = URL.createObjectURL(b); setUrl(u); } });
    return () => { if (u) URL.revokeObjectURL(u); };
  }, [photoKey]);
  return url ? <img className="thumb" src={url} alt="" /> : <span className="thumb thumb-empty">🐟</span>;
}

// ── Log a catch ───────────────────────────────────────────────────────────────
function CatchSheet({ spot, species, caughtHere, onSpeciesAdded, onClose, onSave }: {
  spot: Spot; species: Species[]; caughtHere: string[]; onSpeciesAdded: (sp: Species) => void; onClose: () => void;
  onSave: (c: { species_id: string; length: number | null; released: boolean; photo: Blob | null }) => Promise<void>;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [sp, setSp] = useState<string>(spot.species[0]);
  const [extra, setExtra] = useState<string[]>([]);
  const [asking, setAsking] = useState(false);
  const [length, setLength] = useState("");
  const [released, setReleased] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const spName = (id: string) => shortName(species.find((s) => s.id === id), id);
  const choices = [...new Set([...spot.species, ...caughtHere, ...extra])];
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
        <button className="link" style={{ fontWeight: 600 }} disabled={busy}
          onClick={async () => { setBusy(true); await onSave({ species_id: sp, length: length ? Number(length) : null, released, photo }); }}>
          Save
        </button>
      </div>
      <h1>Log a catch</h1>

      <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => pick(e.target.files?.[0])} />
      <button className="photo-drop" onClick={() => fileRef.current?.click()}>
        {preview ? <img src={preview} alt="" /> : <span>📸<br />Take a photo<small>optional</small></span>}
      </button>

      <div className="group-title">Species</div>
      <div className="pick-grid">
        {choices.map((id) => (
          <button key={id} className={`pick ${sp === id ? "pick-on" : ""}`} onClick={() => setSp(id)}>{id.startsWith("user_") ? nameOf(id) : spName(id)}</button>
        ))}
        <button className="pick pick-other" onClick={() => setAsking(true)}>＋ Other…</button>
      </div>

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
      {err && <p className="hint err">{err}</p>}
      <button className="btn wide" disabled={busy}
        onClick={async () => { setBusy(true); await onSave({ species_id: sp, length: length ? Number(length) : null, released, photo }); }}>
        Save catch
      </button>
      {asking && (
        <SpeciesPrompt species={species} exclude={choices} onClose={() => setAsking(false)}
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

/** "What did you catch?" pop-up: pick a known species or type a new one. */
function SpeciesPrompt({ species, exclude, onPick, onClose }: {
  species: Species[]; exclude: string[]; onPick: (s: Species | string) => void; onClose: () => void;
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
          {matches.map((s) => <button key={s.id} className="row" onClick={() => onPick(s)}>{s.name}</button>)}
          {term && !exact && <button className="row accent" onClick={() => onPick(q)}>＋ Add “{q.trim()}”</button>}
        </div>
        <button className="link" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

/** List row you can swipe left to reveal Delete (tap still opens). */
function SwipeRow({ children, onOpen, onDelete }: { children: React.ReactNode; onOpen: () => void; onDelete: () => Promise<boolean> }) {
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
function ReviewSheet({ active, spot, onClose, onSaved }: {
  active: ActiveTrip; spot: Spot; onClose: () => void; onSaved: () => void;
}) {
  const [r, setR] = useState<Review>(() => prefill(null, spot));
  const [src, setSrc] = useState<Record<string, number | string | null> | null>(null);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const fresh = spot.type.startsWith("fresh");

  useEffect(() => { // pre-fill from the forecast for the middle of the trip
    const start = new Date(active.trip.start_ts);
    const mid = new Date((start.getTime() + Date.now()) / 2);
    api.spotScores(spot.id, new Date(start.getTime() - 3 * 3600_000)).then((rows) => {
      const b = toBlocks(rows).find((x) => {
        const t = new Date(x.block_start).getTime();
        return mid.getTime() >= t && mid.getTime() < t + x.block_hours * 3600_000;
      }) ?? toBlocks(rows)[0];
      const c = b?.species[0]?.conditions ?? null;
      setSrc(c);
      if (!touched) setR(prefill(c, spot));
    }).catch(() => undefined);
  }, [active.trip.start_ts, spot, touched]);

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
          onClick={async () => { setBusy(true); await finishTrip(active, r, src); onSaved(); }}>Save</button>
      </div>
      <h1>How was it?</h1>
      <p className="sub">{active.spot_name} · {active.catches.length ? `${active.catches.length} fish 🎉` : "no fish — still useful data 👍"}</p>
      <p className="hint">Filled in from the forecast — just fix anything that was different.</p>

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
        onClick={async () => { setBusy(true); await finishTrip(active, r, src); onSaved(); }}>
        Save trip
      </button>
    </div>
  );
}
