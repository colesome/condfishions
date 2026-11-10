import { useEffect, useMemo, useState } from "react";
import { scoreClass } from "../components/ui";
import { toBlocks } from "../lib/aggregate";
import { api } from "../lib/api";
import { fmtWhen, hm, sameDay } from "../lib/time";
import { fmtTravel } from "../lib/travel";
import type { Score, Species, Spot } from "../lib/types";
import { shortName } from "./Suggest";

interface Props {
  spot: Spot;
  species: Species[];
  travelMin: number;
  now: Date;
  onClose: () => void;
  onDeleted: () => void;
}

const TYPE_LABEL: Record<string, string> = {
  rock: "Rock platform", rockwall: "Rock wall", beach: "Beach", estuary: "Estuary", jetty: "Jetty",
  fresh_dam: "Dam", fresh_river: "River",
};

export function SpotSheet({ spot, species, travelMin, now, onClose, onDeleted }: Props) {
  const [rows, setRows] = useState<Score[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    const from = new Date(now.getTime() - 3 * 3600_000);
    api.spotScores(spot.id, from).then(setRows).catch((e) => setErr(String(e.message ?? e)));
  }, [spot.id, now]);

  const days = useMemo(() => {
    const out: { day: Date; blocks: ReturnType<typeof toBlocks> }[] = [];
    for (const b of toBlocks(rows ?? [])) {
      const d = new Date(b.block_start);
      const last = out[out.length - 1];
      if (last && sameDay(last.day, d)) last.blocks.push(b);
      else out.push({ day: d, blocks: [b] });
    }
    return out;
  }, [rows]);

  useEffect(() => { // open the best upcoming block by default
    if (open || !days.length) return;
    const all = days.flatMap((d) => d.blocks).filter((b) => !b.no_go).slice(0, 8);
    const best = all.sort((a, b) => b.top_score - a.top_score)[0];
    if (best) setOpen(best.block_start);
  }, [days, open]);

  const spName = (id: string) => shortName(species.find((s) => s.id === id), id);
  const directions = `https://maps.apple.com/?daddr=${spot.lat},${spot.lon}&dirflg=d`;

  async function del() {
    if (!confirm(`Delete "${spot.name}"?`)) return;
    await api.deleteSpot(spot.id);
    onDeleted();
  }

  return (
    <div className="sheet">
      <div className="navbar">
        <button className="back" onClick={onClose}><span>‹</span>Back</button>
        <a className="link" href={directions} target="_blank" rel="noreferrer">Directions</a>
      </div>
      <h1>{spot.name}</h1>
      <p className="sub">
        {TYPE_LABEL[spot.type] ?? spot.type} · {fmtTravel(travelMin)} away
        {spot.access && spot.access !== "car" ? ` · ${spot.access}` : ""}
      </p>
      <p className="sub">Common here: {spot.species.map(spName).join(", ")}</p>

      {err && <div className="banner banner-err">{err}</div>}
      {!rows && !err && <div className="empty">Loading…</div>}
      {rows && days.length === 0 && (
        <div className="empty">No scores yet — new spots are scored on the next update.</div>
      )}

      {days.map(({ day, blocks }) => (
        <section key={day.toISOString()} className="day">
          <h3>{day.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long" })}</h3>
          <div className="strip">
            {blocks.map((b) => (
              <button key={b.block_start}
                className={`blk ${b.no_go ? "blk-nogo" : scoreClass(b.top_score)} ${open === b.block_start ? "blk-open" : ""}`}
                onClick={() => setOpen(open === b.block_start ? null : b.block_start)}>
                <span>{hm(new Date(b.block_start))}</span>
                <b>{b.no_go ? "✕" : Math.round(b.top_score)}</b>
              </button>
            ))}
          </div>
          {blocks.filter((b) => b.block_start === open).map((b) => (
            <div key={b.block_start} className="detail">
              <div className="detail-when">{fmtWhen(b.block_start, b.block_hours, now)}</div>
              {b.no_go ? (
                <div className="banner banner-err">{b.safety_text ?? "Unsafe in this window"}</div>
              ) : (
                <>
                  {b.safety === "caution" && <span className="flag flag-warn">{b.safety_text}</span>}
                  <ul className="sp-list">
                    {b.species.map((s) => (
                      <li key={s.species_id}>
                        <div className="sp-line">
                          <span className={`dot ${scoreClass(s.score)}`} />
                          <span>{spName(s.species_id)}</span>
                          <span className="num">{Math.round(s.score)}</span>
                        </div>
                        <small>{s.reasons.slice(0, 3).map((x) => x.text).join(" · ")}</small>
                        {s.regulations?.map((g) => (
                          <span key={g.id} className={`flag ${g.action === "permit" ? "flag-info" : "flag-warn"}`}>{g.text}</span>
                        ))}
                      </li>
                    ))}
                  </ul>
                  {b.species[0] && <Conditions c={b.species[0].conditions} />}
                </>
              )}
            </div>
          ))}
        </section>
      ))}

      {!spot.verified && <p className="hint">Pin location is approximate — check it when you're there.</p>}
      {spot.source === "user" && (
        <div className="group" style={{ marginTop: 24 }}>
          <button className="row" style={{ color: "var(--poor)", justifyContent: "center" }} onClick={del}>Delete spot</button>
        </div>
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
    ["Wind", c.wind_kmh != null ? `${c.wind_kmh} km/h ${c.wind_dir ?? ""}${c.gust_kmh ? ` (gust ${c.gust_kmh})` : ""}` : null],
    ["Sea", c.wave_h != null ? `${c.wave_h} m${c.swell_period ? ` @ ${c.swell_period}s` : ""}` : null],
    ["Tide", c.tide_phase ? PHASE[String(c.tide_phase)] ?? String(c.tide_phase) : null],
    ["Water", c.sst != null ? `${c.sst}°C` : null],
    ["Air", c.air_temp != null ? `${c.air_temp}°C` : null],
    ["Rain 72 h", c.rain_72h != null ? `${c.rain_72h} mm` : null],
    ["Pressure", c.pressure != null ? `${c.pressure} hPa` : null],
  ];
  return (
    <dl className="conds">
      {items.filter(([, v]) => v).map(([k, v]) => (
        <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
      ))}
    </dl>
  );
}
