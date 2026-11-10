import { useCallback, useEffect, useMemo, useState } from "react";
import { api, configError } from "./lib/api";
import { windowRange, type WindowId } from "./lib/time";
import { travelMin } from "./lib/travel";
import type { Origin, Run, Settings, Species, Spot, SpotWindow, Water } from "./lib/types";
import { AddSpot } from "./screens/AddSpot";
import { Login } from "./screens/Login";
import { MapScreen } from "./screens/MapScreen";
import { Places } from "./screens/Places";
import { SpotSheet } from "./screens/SpotSheet";
import { Suggest } from "./screens/Suggest";
import { IconFish, IconGear, IconTrips } from "./components/icons";
import { getPosition } from "./lib/geo";
import { flush, onPending, pendingCount } from "./lib/queue";
import { loadActive, startTrip, type ActiveTrip } from "./lib/trips";
import { Trips } from "./screens/Trips";

type Tab = "suggest" | "trips" | "places";

const ls = {
  get: <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set: (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [tab, setTab] = useState<Tab>("suggest");
  const [spots, setSpots] = useState<Spot[]>([]);
  const [species, setSpecies] = useState<Species[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [lastRun, setLastRun] = useState<Run | null>(null);
  const [useGps, setUseGpsState] = useState<boolean>(ls.get("useGps", false));
  const [gps, setGps] = useState<{ lat: number; lon: number } | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [windowId, setWindowId] = useState<WindowId>(ls.get("windowId3", "next3"));
  const [water, setWater] = useState<Water>(ls.get("water", "salt"));
  const [results, setResults] = useState<SpotWindow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [openSpot, setOpenSpot] = useState<{ id: string; block?: string } | null>(null);
  const [showMap, setShowMap] = useState(false);
  const [active, setActive] = useState<ActiveTrip | null>(() => loadActive());
  const [pending, setPending] = useState(0);
  const [adding, setAdding] = useState<{ lat: number; lon: number } | null>(null);
  const [now, setNow] = useState<Date>(() => api.now());

  useEffect(() => { api.session().then(setAuthed); }, []);
  useEffect(() => {
    pendingCount().then(setPending).catch(() => undefined);
    const off = onPending(setPending);
    void flush();
    return () => { off(); };
  }, []);

  const loadBase = useCallback(async () => {
    try {
      const [sp, spc, st, run] = await Promise.all([api.spots(), api.species(), api.settings(), api.lastRun()]);
      setSpots(sp); setSpecies(spc); setSettings(st); setLastRun(run);
      ls.set("base", { sp, spc, st, run });
    } catch (e) {
      const cached = ls.get<{ sp: Spot[]; spc: Species[]; st: Settings; run: Run | null } | null>("base", null);
      if (cached) { setSpots(cached.sp); setSpecies(cached.spc); setSettings(cached.st); setLastRun(cached.run); setStale(true); }
      else setError(String((e as Error).message ?? e));
    }
  }, []);
  useEffect(() => { if (authed) loadBase(); }, [authed, loadBase]);

  const setUseGps = (v: boolean) => { setUseGpsState(v); ls.set("useGps", v); };
  useEffect(() => {
    if (!useGps) { setGps(null); return; }
    getPosition()
      .then((g) => { setGps(g); setGpsError(null); })
      .catch((e: Error) => setGpsError(`${e.message} Using your saved place for now.`));
  }, [useGps]);

  const origin: Origin | null = settings && (gps
    ? { name: "Near you", lat: gps.lat, lon: gps.lon, max_travel_min: settings.max_travel_min, gps: true }
    : { name: settings.home_name, lat: settings.home_lat, lon: settings.home_lon, max_travel_min: settings.max_travel_min, gps: false });

  const travel = useMemo(() => {
    const m = new Map<string, number>();
    if (!origin) return m;
    for (const s of spots) {
      if ((water === "fresh") !== s.type.startsWith("fresh")) continue;
      const t = travelMin(origin.lat, origin.lon, s);
      if (t <= origin.max_travel_min) m.set(s.id, t);
    }
    return m;
  }, [spots, water, origin?.lat, origin?.lon, origin?.max_travel_min]); // eslint-disable-line react-hooks/exhaustive-deps

  const spotMap = useMemo(() => new Map(spots.map((s) => [s.id, s])), [spots]);

  useEffect(() => {
    if (!authed || !origin) return;
    ls.set("windowId3", windowId); ls.set("water", water);
    const ids = [...travel.keys()];
    const key = `res2|${windowId}|${water}|${ids.length}|${origin.lat.toFixed(2)},${origin.lon.toFixed(2)}`;
    if (!ids.length) { setResults([]); return; }
    const t = api.now();
    setNow(t);
    const [from, to] = windowRange(windowId, t);
    setLoading(true); setError(null);
    api.spotWindows(ids, from, to)
      .then((r) => { setResults(r); setStale(false); ls.set(key, r); })
      .catch((e) => {
        const cached = ls.get<SpotWindow[] | null>(key, null);
        if (cached) { setResults(cached); setStale(true); } else setError(String(e.message ?? e));
      })
      .finally(() => setLoading(false));
  }, [authed, travel, windowId]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveSettings = async (s: Settings) => {
    setSettings(s);
    try { await api.saveSettings(s); } catch (e) { setError(`Couldn't save: ${(e as Error).message}`); }
  };

  if (configError) return <div className="empty">{configError}</div>;
  if (authed === null) return <div className="empty">Loading…</div>;
  if (!authed) return <Login onDone={() => setAuthed(true)} />;
  if (!settings || !origin) return <div className="empty">{error ?? "Loading…"}</div>;

  const sheetSpot = openSpot ? spotMap.get(openSpot.id) : undefined;

  async function goFish(spot: Spot, scoreShown: number | null) {
    if (active && active.trip.spot_id !== spot.id && !confirm(`You're already fishing at ${active.spot_name}. Start a new trip here instead? (The other one won't be saved.)`)) return;
    setActive(await startTrip(spot, scoreShown));
    setOpenSpot(null); setShowMap(false); setTab("trips");
  }

  return (
    <div className="app">
      {api.demo && <div className="demo-tag">DEMO DATA</div>}
      <main>
        {tab === "suggest" && (
          <Suggest origin={origin} now={now} spots={spotMap} species={species} travel={travel}
            results={results} loading={loading} error={error} stale={stale}
            windowId={windowId} setWindowId={setWindowId} water={water} setWater={setWater}
            openSpot={(id, block) => setOpenSpot({ id, block })} openPlaces={() => setTab("places")}
            openMap={() => setShowMap(true)} activeTripSpot={active?.trip.spot_id ?? null} />
        )}
        {tab === "trips" && (
          <Trips active={active} setActive={setActive} spots={spotMap} species={species} pending={pending}
            openSpot={(id) => setOpenSpot({ id })}
            onSpeciesAdded={(sp) => setSpecies((xs) => xs.some((x) => x.id === sp.id) ? xs : [...xs, sp])} />
        )}
        {tab === "places" && (
          <Places settings={settings} saveSettings={saveSettings} useGps={useGps} setUseGps={setUseGps}
            gpsError={gpsError} lastRun={lastRun} now={now} inRangeCount={travel.size}
            onSignOut={async () => { await api.signOut(); setAuthed(false); }} />
        )}
      </main>

      <nav className="tabs">
        <button className={tab === "suggest" ? "on" : ""} onClick={() => setTab("suggest")}><IconFish />Fish</button>
        <button className={tab === "trips" ? "on" : ""} onClick={() => setTab("trips")}>
          <span className="tab-icon"><IconTrips />{active && <i className="tab-dot" />}</span>Trips
        </button>
        <button className={tab === "places" ? "on" : ""} onClick={() => setTab("places")}><IconGear />Settings</button>
      </nav>

      {showMap && (
        <div className="sheet sheet-map">
          <div className="map-back"><button className="back" onClick={() => setShowMap(false)}><span>‹</span>Back</button></div>
          <MapScreen origin={origin} spots={spots} travel={travel} results={results}
            openSpot={(id) => setOpenSpot({ id })} addSpotAt={(lat, lon) => setAdding({ lat, lon })} />
        </div>
      )}
      {sheetSpot && (
        <SpotSheet spot={sheetSpot} species={species} initialBlock={openSpot?.block}
          travelMin={travel.get(sheetSpot.id) ?? travelMin(origin.lat, origin.lon, sheetSpot)} now={now}
          fishingHere={active?.trip.spot_id === sheetSpot.id}
          onGoFish={(score) => goFish(sheetSpot, score)}
          onClose={() => { if (active?.trip.spot_id === sheetSpot.id && tab !== "trips") setTab("trips"); setOpenSpot(null); }}
          onDeleted={() => { setOpenSpot(null); loadBase(); }} />
      )}
      {adding && (
        <AddSpot lat={adding.lat} lon={adding.lon} species={species} onClose={() => setAdding(null)}
          onSaved={() => { setAdding(null); loadBase(); }} />
      )}
    </div>
  );
}
