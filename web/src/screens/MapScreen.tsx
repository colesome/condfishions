import "leaflet/dist/leaflet.css";
import { useState } from "react";
import { Circle, CircleMarker, MapContainer, TileLayer, Tooltip, useMapEvents } from "react-leaflet";
import type { Origin, Spot, SpotWindow } from "../lib/types";

interface Props {
  origin: Origin;
  spots: Spot[];
  travel: Map<string, number>;
  results: SpotWindow[] | null;
  openSpot: (id: string) => void;
  addSpotAt: (lat: number, lon: number) => void;
}

function colour(score: number | undefined): string {
  if (score === undefined) return "#aeaeb2";
  if (score >= 70) return "#34c759";
  if (score >= 50) return "#8fcf4a";
  if (score >= 30) return "#ff9f0a";
  return "#ff453a";
}

function ClickToAdd({ armed, onPick }: { armed: boolean; onPick: (lat: number, lon: number) => void }) {
  useMapEvents({ click(e) { if (armed) onPick(e.latlng.lat, e.latlng.lng); } });
  return null;
}

export function MapScreen({ origin, spots, travel, results, openSpot, addSpotAt }: Props) {
  const [armed, setArmed] = useState(false);
  const best = new Map<string, number>();
  for (const r of results ?? []) best.set(r.spot_id, r.top_score);
  // rough radius of the travel range for orientation only
  const radiusM = Math.max(5, (origin.max_travel_min - 10) * 0.85) * 1000;

  return (
    <div className="screen map-screen">
      <MapContainer center={[origin.lat, origin.lon]} zoom={9} className={`map ${armed ? "map-armed" : ""}`}
        zoomControl={false} attributionControl>
        <TileLayer url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' />
        <Circle center={[origin.lat, origin.lon]} radius={radiusM}
          pathOptions={{ color: "#007aff", weight: 1, fillOpacity: 0.04, dashArray: "4 6" }} />
        <CircleMarker center={[origin.lat, origin.lon]} radius={7}
          pathOptions={{ color: "#fff", weight: 2, fillColor: "#007aff", fillOpacity: 1 }}>
          <Tooltip>{origin.name}</Tooltip>
        </CircleMarker>
        {spots.map((s) => {
          const inRange = travel.has(s.id);
          const sc = best.get(s.id);
          return (
            <CircleMarker key={s.id} center={[s.lat, s.lon]} radius={inRange ? 9 : 5}
              eventHandlers={{ click: () => !armed && openSpot(s.id) }}
              pathOptions={{ color: "#ffffff", weight: 1.5, fillColor: inRange ? colour(sc) : "#c7c7cc",
                fillOpacity: inRange ? 1 : 0.8 }}>
              <Tooltip direction="top">{s.name}{sc !== undefined ? ` · ${Math.round(sc)}` : ""}</Tooltip>
            </CircleMarker>
          );
        })}
        <ClickToAdd armed={armed} onPick={(lat, lon) => { setArmed(false); addSpotAt(lat, lon); }} />
      </MapContainer>
      <div className="map-ui">
        {armed
          ? <div className="map-hint">Tap the water's edge where you'll fish <button onClick={() => setArmed(false)}>Cancel</button></div>
          : <button className="btn fab" onClick={() => setArmed(true)}>Add spot</button>}
      </div>
      <div className="legend">
        <span><i style={{ background: "#34c759" }} />70+</span>
        <span><i style={{ background: "#8fcf4a" }} />50</span>
        <span><i style={{ background: "#ff9f0a" }} />30</span>
        <span><i style={{ background: "#ff453a" }} />&lt;30</span>
        <span><i style={{ background: "#c7c7cc" }} />not shown</span>
      </div>
    </div>
  );
}
