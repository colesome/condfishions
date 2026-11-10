import "leaflet/dist/leaflet.css";
import { useState } from "react";
import { Circle, CircleMarker, MapContainer, TileLayer, Tooltip, useMapEvents } from "react-leaflet";
import type { Origin, Score, Spot } from "../lib/types";

interface Props {
  origin: Origin;
  spots: Spot[];
  travel: Map<string, number>;
  results: Score[] | null;
  openSpot: (id: string) => void;
  addSpotAt: (lat: number, lon: number) => void;
}

function colour(score: number | undefined): string {
  if (score === undefined) return "#5b6b78";
  if (score >= 75) return "#2ecc8f";
  if (score >= 60) return "#9bd25b";
  if (score >= 45) return "#e8b84a";
  return "#e0664f";
}

function ClickToAdd({ armed, onPick }: { armed: boolean; onPick: (lat: number, lon: number) => void }) {
  useMapEvents({ click(e) { if (armed) onPick(e.latlng.lat, e.latlng.lng); } });
  return null;
}

export function MapScreen({ origin, spots, travel, results, openSpot, addSpotAt }: Props) {
  const [armed, setArmed] = useState(false);
  const best = new Map<string, number>();
  for (const r of results ?? []) best.set(r.spot_id, Math.max(best.get(r.spot_id) ?? 0, r.score));
  // rough radius of the travel range for orientation only
  const radiusM = Math.max(5, (origin.max_travel_min - 10) * 0.85) * 1000;

  return (
    <div className="screen map-screen">
      <MapContainer center={[origin.lat, origin.lon]} zoom={9} className={`map ${armed ? "map-armed" : ""}`}
        zoomControl={false} attributionControl>
        <TileLayer url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' />
        <Circle center={[origin.lat, origin.lon]} radius={radiusM}
          pathOptions={{ color: "#5fb3c9", weight: 1, fillOpacity: 0.04, dashArray: "4 6" }} />
        <CircleMarker center={[origin.lat, origin.lon]} radius={7}
          pathOptions={{ color: "#fff", weight: 2, fillColor: "#5fb3c9", fillOpacity: 1 }}>
          <Tooltip>{origin.name}</Tooltip>
        </CircleMarker>
        {spots.map((s) => {
          const inRange = travel.has(s.id);
          const sc = best.get(s.id);
          return (
            <CircleMarker key={s.id} center={[s.lat, s.lon]} radius={inRange ? 9 : 5}
              eventHandlers={{ click: () => !armed && openSpot(s.id) }}
              pathOptions={{ color: "#0b1620", weight: 1.5, fillColor: inRange ? colour(sc) : "#3a4752",
                fillOpacity: inRange ? 0.95 : 0.6 }}>
              <Tooltip direction="top">{s.name}{sc !== undefined ? ` · ${Math.round(sc)}` : ""}</Tooltip>
            </CircleMarker>
          );
        })}
        <ClickToAdd armed={armed} onPick={(lat, lon) => { setArmed(false); addSpotAt(lat, lon); }} />
      </MapContainer>
      <div className="map-ui">
        {armed
          ? <div className="map-hint">Tap the water's edge where you'll fish <button onClick={() => setArmed(false)}>Cancel</button></div>
          : <button className="btn fab" onClick={() => setArmed(true)}>＋ Add a spot</button>}
      </div>
      <div className="legend">
        <span><i style={{ background: "#2ecc8f" }} />75+</span>
        <span><i style={{ background: "#9bd25b" }} />60</span>
        <span><i style={{ background: "#e8b84a" }} />45</span>
        <span><i style={{ background: "#e0664f" }} />&lt;45</span>
        <span><i style={{ background: "#3a4752" }} />out of range</span>
      </div>
    </div>
  );
}
