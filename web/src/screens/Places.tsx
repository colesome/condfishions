import { useState } from "react";
import { api } from "../lib/api";
import { ago } from "../lib/time";
import { fmtTravel } from "../lib/travel";
import type { Place, Run, Settings } from "../lib/types";

interface Props {
  settings: Settings;
  saveSettings: (s: Settings) => Promise<void>;
  useGps: boolean;
  setUseGps: (v: boolean) => void;
  gpsError: string | null;
  lastRun: Run | null;
  now: Date;
  inRangeCount: number;
  onSignOut: () => void;
}

interface Hit { display_name: string; lat: string; lon: string }

const RANGES = [30, 45, 60, 90, 120, 150, 180, 240, 300, 420];

export function Places(p: Props) {
  const s = p.settings;
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const activate = (pl: Place) =>
    p.saveSettings({ ...s, home_name: pl.name, home_lat: pl.lat, home_lon: pl.lon, max_travel_min: pl.max_travel_min });

  const setRange = (min: number) => {
    const saved = s.saved_places.map((pl) =>
      pl.name === s.home_name && pl.lat === s.home_lat && pl.lon === s.home_lon ? { ...pl, max_travel_min: min } : pl);
    return p.saveSettings({ ...s, max_travel_min: min, saved_places: saved });
  };

  const addPlace = (pl: Place) => {
    const saved = [...s.saved_places.filter((x) => x.name !== pl.name), pl];
    return p.saveSettings({ ...s, saved_places: saved, home_name: pl.name, home_lat: pl.lat, home_lon: pl.lon,
      max_travel_min: pl.max_travel_min });
  };

  const removePlace = (name: string) =>
    p.saveSettings({ ...s, saved_places: s.saved_places.filter((x) => x.name !== name) });

  async function search() {
    if (!q.trim()) return;
    setBusy(true);
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=5&countrycodes=au&q=${encodeURIComponent(q)}`,
        { headers: { "Accept-Language": "en-AU" } });
      setHits(await r.json());
    } catch {
      setMsg("Search failed — check your connection.");
    } finally {
      setBusy(false);
    }
  }

  function hereAsPlace() {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const name = prompt("Name this place (e.g. Holiday house)", "Holiday");
        if (name) addPlace({ name, lat: pos.coords.latitude, lon: pos.coords.longitude, max_travel_min: s.max_travel_min });
      },
      () => setMsg("Couldn't get your location — allow location access for this app in Settings."),
      { enableHighAccuracy: false, timeout: 15000 },
    );
  }

  async function refresh() {
    setMsg("Asking for a fresh scoring run…");
    const ok = await api.rescore();
    setMsg(ok ? "Run started — new scores in about 2 minutes." : "Couldn't trigger a run (is the rescore function set up?). Scores refresh 4× a day anyway.");
  }

  const isActive = (pl: Place) => pl.name === s.home_name && pl.lat === s.home_lat && pl.lon === s.home_lon;

  return (
    <div className="screen">
      <header className="top"><h1>Places &amp; range</h1></header>

      <section className="panel">
        <label className="toggle">
          <input type="checkbox" checked={p.useGps} onChange={(e) => p.setUseGps(e.target.checked)} />
          <span>
            <b>Use my current location</b>
            <small>Range is measured from wherever you are — handy when travelling. Not saved.</small>
          </span>
        </label>
        {p.gpsError && <p className="hint err">{p.gpsError}</p>}
      </section>

      <section className="panel">
        <h3>Travel range</h3>
        <p className="big">{fmtTravel(s.max_travel_min)} <small className="muted">· {p.inRangeCount} spots</small></p>
        <input type="range" min={0} max={RANGES.length - 1} step={1}
          value={Math.max(0, RANGES.findIndex((r) => r >= s.max_travel_min))}
          onChange={(e) => setRange(RANGES[Number(e.target.value)])} />
        <div className="range-labels"><span>30 min</span><span>7 h</span></div>
      </section>

      <section className="panel">
        <h3>Saved places</h3>
        <ul className="places">
          {s.saved_places.map((pl) => (
            <li key={pl.name} className={isActive(pl) ? "active" : ""}>
              <button className="place-main" onClick={() => activate(pl)}>
                <span>{isActive(pl) && !p.useGps ? "🏠 " : ""}{pl.name}</span>
                <small className="muted">{fmtTravel(pl.max_travel_min)} range</small>
              </button>
              {!isActive(pl) && <button className="x" onClick={() => removePlace(pl.name)} aria-label="Remove">×</button>}
            </li>
          ))}
        </ul>
        <button className="btn btn-ghost wide" onClick={hereAsPlace}>📍 Save where I am now</button>
        <div className="search">
          <input placeholder="Search a town or suburb…" value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && search()} />
          <button className="btn" onClick={search} disabled={busy}>{busy ? "…" : "Search"}</button>
        </div>
        {hits.length > 0 && (
          <ul className="hits">
            {hits.map((h) => (
              <li key={`${h.lat},${h.lon}`}>
                <button onClick={() => {
                  const name = h.display_name.split(",").slice(0, 2).join(",").trim();
                  addPlace({ name, lat: Number(h.lat), lon: Number(h.lon), max_travel_min: s.max_travel_min });
                  setHits([]); setQ("");
                }}>{h.display_name}</button>
              </li>
            ))}
          </ul>
        )}
        <p className="hint">On holiday somewhere new? Save it here, then add your spots from the Map tab.</p>
      </section>

      <section className="panel">
        <h3>Scores</h3>
        <p className="muted">{p.lastRun ? `Last updated ${ago(p.lastRun.created_at, p.now)}` : "No runs yet"}</p>
        {p.lastRun?.problems?.length ? <p className="hint">{p.lastRun.problems.length} spots had data warnings.</p> : null}
        <button className="btn wide" onClick={refresh}>Refresh now</button>
        {msg && <p className="hint">{msg}</p>}
      </section>

      <section className="panel">
        <button className="btn btn-ghost wide" onClick={p.onSignOut}>Sign out</button>
        <p className="hint">{api.demo ? "Demo mode — sample data, nothing is saved to the cloud." : ""}</p>
      </section>
    </div>
  );
}
