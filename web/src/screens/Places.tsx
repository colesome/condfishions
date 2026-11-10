import { useState } from "react";
import { api } from "../lib/api";
import { getPosition } from "../lib/geo";
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
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);

  const isActive = (pl: Place) => pl.name === s.home_name && pl.lat === s.home_lat && pl.lon === s.home_lon;

  const activate = (pl: Place) =>
    p.saveSettings({ ...s, home_name: pl.name, home_lat: pl.lat, home_lon: pl.lon, max_travel_min: pl.max_travel_min });

  const setRange = (min: number) => p.saveSettings({
    ...s, max_travel_min: min,
    saved_places: s.saved_places.map((pl) => (isActive(pl) ? { ...pl, max_travel_min: min } : pl)),
  });

  const addPlace = (pl: Place) => p.saveSettings({
    ...s, saved_places: [...s.saved_places.filter((x) => x.name !== pl.name), pl],
    home_name: pl.name, home_lat: pl.lat, home_lon: pl.lon, max_travel_min: pl.max_travel_min,
  });

  const removePlace = (name: string) =>
    p.saveSettings({ ...s, saved_places: s.saved_places.filter((x) => x.name !== name) });

  async function search() {
    if (!q.trim()) return;
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=5&countrycodes=au&q=${encodeURIComponent(q)}`);
      const res: Hit[] = await r.json();
      setHits(res);
      if (!res.length) setMsg("No matches — try a town or suburb name.");
    } catch {
      setMsg("Search failed — check your connection.");
    } finally {
      setBusy(false);
    }
  }

  async function saveHere() {
    setMsg("Finding your location…");
    try {
      const g = await getPosition();
      const name = prompt("Name this place", "Holiday");
      setMsg(null);
      if (name) addPlace({ name, lat: g.lat, lon: g.lon, max_travel_min: s.max_travel_min });
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  async function refresh() {
    setRefreshMsg("Requesting an update…");
    const r = await api.rescore();
    setRefreshMsg(r === "requested" ? "Update started — new scores in about 2 minutes. Reopen the app then."
      : r === "not_configured" ? "Refresh isn't set up yet (see README → Refresh button). Scores still update 4 times a day."
      : "Couldn't request an update. Scores still update 4 times a day.");
  }

  return (
    <div className="screen">
      <div className="title-row"><h1>Settings</h1></div>

      <div className="group">
        <label className="row">
          <div className="row-main">Use my current location<small>For travelling — not saved</small></div>
          <input className="switch" type="checkbox" checked={p.useGps} onChange={(e) => p.setUseGps(e.target.checked)} />
        </label>
      </div>
      {p.gpsError && <p className="hint err">{p.gpsError}</p>}

      <div className="group-title">Travel range</div>
      <div className="group">
        <div className="row" style={{ display: "block" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <p className="big">{fmtTravel(s.max_travel_min)}</p>
            <span className="muted">{p.inRangeCount} spots</span>
          </div>
          <input type="range" min={0} max={RANGES.length - 1} step={1}
            value={Math.max(0, RANGES.findIndex((r) => r >= s.max_travel_min))}
            onChange={(e) => setRange(RANGES[Number(e.target.value)])} />
          <div className="range-labels"><span>30 min</span><span>7 h</span></div>
        </div>
      </div>

      <div className="group-title">Home</div>
      <div className="group">
        {s.saved_places.map((pl) => (
          <div key={pl.name} className="row">
            <button className="row-main" style={{ border: 0, background: "none", padding: 0, textAlign: "left" }}
              onClick={() => activate(pl)}>
              {pl.name}<small>{fmtTravel(pl.max_travel_min)} range</small>
            </button>
            {isActive(pl) ? <span className="check-mark">✓</span>
              : <button className="x" onClick={() => removePlace(pl.name)}>Remove</button>}
          </div>
        ))}
        <button className="row accent" onClick={saveHere}>Add where I am now</button>
        <div className="search">
          <input placeholder="Add a town or suburb" value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && search()} />
          <button className="link" onClick={search} disabled={busy}>{busy ? "…" : "Search"}</button>
        </div>
        {hits.map((h) => (
          <button key={`${h.lat},${h.lon}`} className="row" onClick={() => {
            const name = h.display_name.split(",").slice(0, 2).join(",").trim();
            addPlace({ name, lat: Number(h.lat), lon: Number(h.lon), max_travel_min: s.max_travel_min });
            setHits([]); setQ("");
          }}><span className="row-main">{h.display_name}</span></button>
        ))}
      </div>
      {msg && <p className="hint">{msg}</p>}
      <p className="hint">Tap a place to fish from there. Somewhere new? Add your own spots from the Map tab.</p>

      <div className="group-title">Scores</div>
      <div className="group">
        <div className="row">
          <div className="row-main">Last updated</div>
          <span className="row-value">{p.lastRun ? ago(p.lastRun.created_at, p.now) : "never"}</span>
        </div>
        <button className="row accent" onClick={refresh}>Refresh now</button>
      </div>
      {refreshMsg && <p className="hint">{refreshMsg}</p>}

      <div className="group" style={{ marginTop: 24 }}>
        <button className="row" style={{ color: "var(--poor)", justifyContent: "center" }} onClick={p.onSignOut}>Sign out</button>
      </div>
      {api.demo && <p className="hint">Demo mode — sample data.</p>}
    </div>
  );
}
