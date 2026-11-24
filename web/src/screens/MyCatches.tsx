import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { tackleLabel } from "../lib/tackle";
import type { CatchRecord, Species, Spot, TackleKind } from "../lib/types";
import { shortName } from "./Suggest";

/** Profile → My catches: every fish, where it came from and what it took. */
export function MyCatches({ spots, species, onClose, openSpot, openTrip }: {
  spots: Map<string, Spot>; species: Species[]; onClose: () => void;
  openSpot: (id: string) => void; openTrip: (sessionId: string) => void;
}) {
  const [rows, setRows] = useState<CatchRecord[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sp, setSp] = useState<string | null>(null);
  const [kind, setKind] = useState<TackleKind | null>(null);
  const [view, setView] = useState<"list" | "spots" | "tackle">("list");
  const spName = (id: string) => shortName(species.find((s) => s.id === id), id);
  const spotName = (id: string) => spots.get(id)?.name ?? id;

  useEffect(() => { api.allCatches().then(setRows).catch((e) => setErr((e as Error).message)); }, []);

  const filtered = useMemo(() => (rows ?? []).filter((c) => (!sp || c.species_id === sp) && (!kind || c.method === kind)), [rows, sp, kind]);
  const total = filtered.reduce((n, c) => n + c.count, 0);
  const speciesCaught = [...new Set((rows ?? []).map((c) => c.species_id))];

  const bySpot = useMemo(() => group(filtered, (c) => c.spot_id), [filtered]);
  const byTackle = useMemo(() => group(filtered.filter((c) => c.method || c.tackle),
    (c) => `${c.method ?? ""}|${(c.tackle ?? "").trim().toLowerCase()}`), [filtered]);

  return (
    <div className="sheet">
      <div className="navbar"><button className="back" onClick={onClose}><span>‹</span>Settings</button></div>
      <h1>My catches</h1>
      {err && <div className="banner banner-err">Couldn't load your catches — are you online? ({err})</div>}
      {rows === null && !err && <div className="empty">Loading…</div>}
      {rows && rows.length === 0 && (
        <div className="empty-card" style={{ marginTop: 16 }}>
          <div className="big-emoji">🐟</div><b>No fish logged yet</b>
          <p>Catches you log on a trip show up here with the spot and the bait or lure they took.</p>
        </div>
      )}
      {rows && rows.length > 0 && (
        <>
          <div className="stats">
            <div><b>{total}</b><small>fish</small></div>
            <div><b>{new Set(filtered.map((c) => c.species_id)).size}</b><small>species</small></div>
            <div><b>{bySpot.length}</b><small>spots</small></div>
          </div>

          <div className="chips-row">
            <button className={`chip ${!sp ? "chip-on" : ""}`} onClick={() => setSp(null)}>All fish</button>
            {speciesCaught.map((id) => (
              <button key={id} className={`chip ${sp === id ? "chip-on" : ""}`} onClick={() => setSp(sp === id ? null : id)}>{spName(id)}</button>
            ))}
          </div>
          <div className="seg" style={{ marginTop: 8 }}>
            <button className={!kind ? "on" : ""} onClick={() => setKind(null)}>Bait & lure</button>
            <button className={kind === "bait" ? "on" : ""} onClick={() => setKind("bait")}>🪱 Bait</button>
            <button className={kind === "lure" ? "on" : ""} onClick={() => setKind("lure")}>🎣 Lure</button>
          </div>
          <div className="seg" style={{ marginTop: 8 }}>
            <button className={view === "list" ? "on" : ""} onClick={() => setView("list")}>Every fish</button>
            <button className={view === "spots" ? "on" : ""} onClick={() => setView("spots")}>By spot</button>
            <button className={view === "tackle" ? "on" : ""} onClick={() => setView("tackle")}>By bait/lure</button>
          </div>

          {view === "list" && (
            <div className="group" style={{ marginTop: 12 }}>
              {filtered.map((c) => (
                <button key={c.id} className="row" onClick={() => openTrip(c.session_id)}>
                  {c.photo_url ? <img className="thumb" src={c.photo_url} alt="" loading="lazy" /> : <span className="thumb thumb-empty">🐟</span>}
                  <span className="row-main">
                    <b>{spName(c.species_id)}</b>{c.max_length_cm ? ` · ${c.max_length_cm} cm` : ""}{c.count > 1 ? ` ×${c.count}` : ""}
                    <small>{tackleLabel(c.method, c.tackle) ?? "Bait/lure not recorded"}</small>
                    <small>📍 {spotName(c.spot_id)} · {new Date(c.caught_at ?? c.start_ts).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" })}</small>
                  </span>
                  <span className="chev">›</span>
                </button>
              ))}
              {filtered.length === 0 && <div className="row muted">Nothing matches those filters.</div>}
            </div>
          )}

          {view === "spots" && (
            <div className="group" style={{ marginTop: 12 }}>
              {bySpot.map(([id, cs]) => (
                <button key={id} className="row" onClick={() => openSpot(id)}>
                  <span className="row-main">
                    <b>{spotName(id)}</b>
                    <small>{summary(cs, (c) => spName(c.species_id))}</small>
                    <small>{summary(cs.filter((c) => c.tackle || c.method), (c) => tackleLabel(c.method, c.tackle) ?? "") || "Bait/lure not recorded"}</small>
                  </span>
                  <span className="count-pill">{cs.reduce((n, c) => n + c.count, 0)}</span>
                </button>
              ))}
            </div>
          )}

          {view === "tackle" && (
            <div className="group" style={{ marginTop: 12 }}>
              {byTackle.map(([k, cs]) => (
                <div key={k} className="row">
                  <span className="row-main">
                    <b>{tackleLabel(cs[0].method, cs[0].tackle)}</b>
                    <small>{summary(cs, (c) => spName(c.species_id))}</small>
                    <small>📍 {summary(cs, (c) => spotName(c.spot_id))}</small>
                  </span>
                  <span className="count-pill">{cs.reduce((n, c) => n + c.count, 0)}</span>
                </div>
              ))}
              {byTackle.length === 0 && <div className="row muted">No bait or lure recorded yet — add it when you log a catch, or tap an old catch to fill it in.</div>}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function group<T extends { count: number }>(xs: T[], key: (x: T) => string): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
  return [...m.entries()].sort((a, b) => b[1].reduce((n, c) => n + c.count, 0) - a[1].reduce((n, c) => n + c.count, 0));
}

/** "Bream ×3 · Flathead ×1" */
function summary<T extends { count: number }>(xs: T[], label: (x: T) => string): string {
  return group(xs, label).slice(0, 4).map(([k, cs]) => {
    const n = cs.reduce((s, c) => s + c.count, 0);
    return n > 1 ? `${k} ×${n}` : k;
  }).filter(Boolean).join(" · ");
}
