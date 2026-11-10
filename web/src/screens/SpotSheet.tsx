import { useEffect, useMemo, useState } from "react";
import { Chip, Flags, Reasons, ScoreBadge, pct, scoreClass } from "../components/ui";
import { api } from "../lib/api";
import { hm, sameDay } from "../lib/time";
import { fmtTravel } from "../lib/travel";
import type { Score, Species, Spot } from "../lib/types";

interface Props {
  spot: Spot;
  species: Species[];
  initialSpecies?: string;
  travelMin: number;
  now: Date;
  onClose: () => void;
  onDeleted: () => void;
}

const TYPE_LABEL: Record<string, string> = {
  rock: "Rock platform", rockwall: "Rock wall", beach: "Beach", estuary: "Estuary", jetty: "Jetty",
  fresh_dam: "Dam", fresh_river: "River",
};

export function SpotSheet({ spot, species, initialSpecies, travelMin, now, onClose, onDeleted }: Props) {
  const [rows, setRows] = useState<Score[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<string>(initialSpecies ?? spot.species[0]);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    const from = new Date(now.getTime() - 3 * 3600_000);
    api.spotScores(spot.id, from).then(setRows).catch((e) => setErr(String(e.message ?? e)));
  }, [spot.id, now]);

  const days = useMemo(() => {
    const mine = (rows ?? []).filter((r) => r.species_id === sel);
    const out: { day: Date; blocks: Score[] }[] = [];
    for (const r of mine) {
      const d = new Date(r.block_start);
      const last = out[out.length - 1];
      if (last && sameDay(last.day, d)) last.blocks.push(r);
      else out.push({ day: d, blocks: [r] });
    }
    return out;
  }, [rows, sel]);

  const spName = (id: string) => species.find((s) => s.id === id)?.name ?? id;
  const directions = `https://maps.apple.com/?daddr=${spot.lat},${spot.lon}&dirflg=d`;

  async function del() {
    if (!confirm(`Delete "${spot.name}"?`)) return;
    await api.deleteSpot(spot.id);
    onDeleted();
  }

  return (
    <div className="sheet">
      <div className="sheet-head">
        <button className="back" onClick={onClose} aria-label="Back">‹</button>
        <div>
          <h2>{spot.name}</h2>
          <small className="muted">
            {TYPE_LABEL[spot.type] ?? spot.type} · {spot.region} · {fmtTravel(travelMin)}
            {spot.access && spot.access !== "car" ? ` · ${spot.access}` : ""}
          </small>
        </div>
      </div>

      <div className="sheet-actions">
        <a className="btn" href={directions} target="_blank" rel="noreferrer">Directions</a>
        {spot.source === "user" && <button className="btn btn-ghost" onClick={del}>Delete spot</button>}
      </div>
      {!spot.verified && <p className="hint">Pin location is approximate — check it when you're there.</p>}

      <div className="chips">
        {spot.species.map((id) => (
          <Chip key={id} active={sel === id} onClick={() => setSel(id)}>{spName(id)}</Chip>
        ))}
      </div>

      {err && <div className="banner banner-err">{err}</div>}
      {!rows && !err && <div className="empty">Loading…</div>}
      {rows && days.length === 0 && (
        <div className="empty">No scores yet — new spots are scored on the next run (Places → Refresh now).</div>
      )}

      {days.map(({ day, blocks }) => (
        <section key={day.toISOString()} className="day">
          <h3>{day.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "short" })}</h3>
          <div className="strip">
            {blocks.map((b) => (
              <button key={b.block_start}
                className={`blk ${b.safety === "no_go" ? "blk-nogo" : scoreClass(b.score)} ${open === b.block_start ? "blk-open" : ""}`}
                onClick={() => setOpen(open === b.block_start ? null : b.block_start)}>
                <span>{hm(new Date(b.block_start))}</span>
                <b>{b.safety === "no_go" ? "✕" : Math.round(b.score)}</b>
              </button>
            ))}
          </div>
          {blocks.filter((b) => b.block_start === open).map((b) => (
            <div key={b.block_start} className="detail">
              <div className="detail-head">
                <ScoreBadge score={b.score} size="sm" />
                <span>{pct(b.p_success)} chance of at least one {spName(b.species_id).toLowerCase()}</span>
              </div>
              {b.safety === "no_go" && <div className="banner banner-err">{b.safety_text}</div>}
              <Reasons s={b} />
              <Flags s={b} />
              <Conditions c={b.conditions} />
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

const PHASE: Record<string, string> = {
  low_slack: "Low tide change", high_slack: "High tide change", rising_early: "Early run-in",
  rising_mid: "Mid run-in", rising_late: "Late run-in", falling_early: "Early run-out",
  falling_mid: "Mid run-out", falling_late: "Last of the run-out",
};

function Conditions({ c }: { c: Score["conditions"] }) {
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
