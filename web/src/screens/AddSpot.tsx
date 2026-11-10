import { useState } from "react";
import { api } from "../lib/api";
import type { Species, Spot } from "../lib/types";

interface Props {
  lat: number;
  lon: number;
  species: Species[];
  onClose: () => void;
  onSaved: () => void;
}

const TYPES: [string, string][] = [
  ["rock", "Rock platform / headland"], ["rockwall", "Rock wall / breakwall"], ["beach", "Surf beach"],
  ["estuary", "Estuary / river mouth"], ["jetty", "Jetty / pier"], ["fresh_dam", "Dam"], ["fresh_river", "Freshwater river"],
];
const DIRS: [string, number][] = [["N", 0], ["NE", 45], ["E", 90], ["SE", 135], ["S", 180], ["SW", 225], ["W", 270], ["NW", 315]];
const SHELTER: [string, number][] = [["Open ocean", 0.1], ["Partly sheltered", 0.4], ["Sheltered", 0.8]];
const SWELL_DEFAULT: Record<string, number | null> = { rock: 1.5, rockwall: 2.0, beach: 2.5 };

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 30);
}

export function AddSpot({ lat, lon, species, onClose, onSaved }: Props) {
  const [name, setName] = useState("");
  const [type, setType] = useState("estuary");
  const [facing, setFacing] = useState(90);
  const [shelter, setShelter] = useState(0.4);
  const [sp, setSp] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const fresh = type.startsWith("fresh");
  const choices = species.filter((s) => (fresh ? s.id === "bass" : s.id !== "bass"));

  async function save() {
    if (!name.trim() || sp.length === 0) { setErr("Give it a name and pick at least one species."); return; }
    const spot: Spot = {
      id: `user_${slug(name)}_${Math.random().toString(36).slice(2, 6)}`,
      name: name.trim(), region: "My spots", state: lat > -28.164 ? "QLD" : "NSW", lat, lon, type,
      tidal: !fresh, facing, shelter, swell_max: SWELL_DEFAULT[type] ?? null, extra_min: 0, access: "car",
      permit: null, species: sp, verified: true, source: "user",
    };
    try {
      await api.addSpot(spot);
      onSaved();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    }
  }

  return (
    <div className="sheet">
      <div className="sheet-head">
        <button className="back" onClick={onClose} aria-label="Back">‹</button>
        <div><h2>New spot</h2><small className="muted">{lat.toFixed(4)}, {lon.toFixed(4)}</small></div>
      </div>
      <div className="form">
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Caravan park rock wall" /></label>
        <label>Type
          <select value={type} onChange={(e) => setType(e.target.value)}>
            {TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        {!fresh && (
          <>
            <label>Which way do you cast?
              <div className="seg seg-wrap">
                {DIRS.map(([l, d]) => <button key={l} className={facing === d ? "on" : ""} onClick={() => setFacing(d)}>{l}</button>)}
              </div>
            </label>
            <label>Exposure
              <div className="seg">
                {SHELTER.map(([l, v]) => <button key={l} className={shelter === v ? "on" : ""} onClick={() => setShelter(v)}>{l}</button>)}
              </div>
            </label>
          </>
        )}
        <label>Common species here
          <div className="checks">
            {choices.map((s) => (
              <label key={s.id} className="check">
                <input type="checkbox" checked={sp.includes(s.id)}
                  onChange={(e) => setSp(e.target.checked ? [...sp, s.id] : sp.filter((x) => x !== s.id))} />
                {s.name}
              </label>
            ))}
          </div>
        </label>
        {SWELL_DEFAULT[type] && (
          <p className="hint">Safety: marked no-go when the sea reaches {SWELL_DEFAULT[type]} m (less for long-period swell).</p>
        )}
        {err && <p className="hint err">{err}</p>}
        <button className="btn wide" onClick={save}>Save spot</button>
        <p className="hint">It gets scored on the next run — use Places → Refresh now to do it straight away.</p>
      </div>
    </div>
  );
}
