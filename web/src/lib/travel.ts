import type { Spot } from "./types";

// Same estimate as condfishions/config.py so the app and the scorer agree.
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dp = toRad(lat2 - lat1);
  const dl = toRad(lon2 - lon1);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dl / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

export function travelMin(lat: number, lon: number, spot: Spot): number {
  const km = haversineKm(lat, lon, spot.lat, spot.lon) * 1.25;
  const speed = km < 25 ? 40 : km > 60 ? 80 : 60;
  return Math.round((km / speed) * 60 + 5 + (spot.extra_min ?? 0));
}

export function fmtTravel(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}
