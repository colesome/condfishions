import { enqueue, putBlob } from "./queue";
import { getPosition } from "./geo";
import type { Catch, Spot, Trip } from "./types";

/** The trip in progress lives on the phone (works offline) and is mirrored to the server. */
export interface LocalCatch extends Catch { photo_key: string | null; released: boolean }
export interface ActiveTrip { trip: Trip; spot_name: string; catches: LocalCatch[] }

const KEY = "activeTrip";
const uuid = () => crypto.randomUUID();

export function loadActive(): ActiveTrip | null {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "null"); } catch { return null; }
}
function saveActive(a: ActiveTrip | null) {
  if (a) localStorage.setItem(KEY, JSON.stringify(a)); else localStorage.removeItem(KEY);
}

export async function startTrip(spot: Spot, scoreShown: number | null, modelVersion = "baseline_v2"): Promise<ActiveTrip> {
  const id = uuid();
  const trip: Trip = {
    id, client_id: id, spot_id: spot.id, start_ts: new Date().toISOString(), end_ts: null,
    targeted_species: spot.species, method: null, why_went: "suggested",
    score_shown: scoreShown, model_version_shown: modelVersion,
    checkin_lat: null, checkin_lon: null, skunked: null, notes: null,
  };
  const active: ActiveTrip = { trip, spot_name: spot.name, catches: [] };
  saveActive(active);
  await enqueue({ kind: "upsert", table: "sessions", row: { ...trip } });
  getPosition().then(async (g) => { // best effort GPS check-in
    const a = loadActive();
    if (!a || a.trip.id !== id) return;
    a.trip.checkin_lat = g.lat; a.trip.checkin_lon = g.lon;
    saveActive(a);
    await enqueue({ kind: "update", table: "sessions", id, patch: { checkin_lat: g.lat, checkin_lon: g.lon } });
  }).catch(() => undefined);
  return active;
}

export async function logCatch(a: ActiveTrip, c: { species_id: string; length: number | null; released: boolean; photo: Blob | null }): Promise<ActiveTrip> {
  const id = uuid();
  const now = new Date().toISOString();
  const row: Catch = {
    id, client_id: id, session_id: a.trip.id, species_id: c.species_id, count: 1,
    max_length_cm: c.length, caught_at: now,
  };
  let photo_key: string | null = null;
  await enqueue({ kind: "upsert", table: "catches", row: { ...row, kept: c.released ? 0 : 1, released: c.released ? 1 : 0 } });
  if (c.photo) {
    photo_key = `${a.trip.id}/${id}.jpg`;
    await putBlob(photo_key, c.photo);
    await enqueue({ kind: "photo", path: photo_key });
    await enqueue({ kind: "upsert", table: "photos", row: {
      id: uuid(), session_id: a.trip.id, catch_id: id, storage_path: photo_key, taken_at: now,
    } });
  }
  const next = { ...a, catches: [...a.catches, { ...row, photo_key, released: c.released }] };
  saveActive(next);
  return next;
}

export async function removeLastCatch(a: ActiveTrip): Promise<ActiveTrip> {
  const last = a.catches[a.catches.length - 1];
  if (!last) return a;
  // mark as zero rather than deleting, so offline ordering stays simple
  await enqueue({ kind: "update", table: "catches", id: last.id, patch: { count: 0 } });
  const next = { ...a, catches: a.catches.slice(0, -1) };
  saveActive(next);
  return next;
}

export interface Review {
  wind: "calm" | "light" | "strong";
  wind_dir: "onshore" | "cross" | "offshore" | null;
  sea: "flat" | "some_wash" | "rough" | null;
  water: "clear" | "bit_dirty" | "dirty";
  bait: "yes" | "no" | "unsure";
  method: "lure" | "bait" | "mixed";
  overall: number;
  notes: string;
}

export async function finishTrip(a: ActiveTrip, r: Review, prefilledFrom: Record<string, unknown> | null): Promise<void> {
  const end = new Date().toISOString();
  await enqueue({ kind: "update", table: "sessions", id: a.trip.id, patch: {
    end_ts: end, skunked: a.catches.length === 0, method: r.method, notes: r.notes || null, updated_at: end,
  } });
  await enqueue({ kind: "upsert", table: "observed_conditions", row: {
    id: uuid(), session_id: a.trip.id, source: "angler",
    vals: { ...r, notes: undefined, forecast_used_for_prefill: prefilledFrom },
  } });
  localStorage.setItem("lastMethod", r.method);
  saveActive(null);
}

export function cancelTrip(): void {
  saveActive(null);
}

const DIRS: Record<string, number> = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };

/** Pre-fill the review from the forecast for this trip, so you only fix what was different. */
export function prefill(c: Record<string, number | string | null> | null, spot: Spot): Review {
  const wind = Number(c?.wind_kmh ?? 10);
  const dir = typeof c?.wind_dir === "string" ? DIRS[c.wind_dir] : undefined;
  let wind_dir: Review["wind_dir"] = null;
  if (!spot.type.startsWith("fresh") && dir !== undefined && spot.facing != null) {
    const on = Math.cos(((dir - spot.facing) * Math.PI) / 180);
    wind_dir = on > 0.5 ? "onshore" : on < -0.5 ? "offshore" : "cross";
  }
  const wave = Number(c?.wave_h ?? NaN);
  const rain = Number(c?.rain_72h ?? 0);
  return {
    wind: wind < 8 ? "calm" : wind < 20 ? "light" : "strong",
    wind_dir,
    sea: spot.type.startsWith("fresh") || Number.isNaN(wave) ? null : wave < 0.5 ? "flat" : wave < 1.3 ? "some_wash" : "rough",
    water: rain < 15 ? "clear" : rain < 50 ? "bit_dirty" : "dirty",
    bait: "unsure",
    method: (localStorage.getItem("lastMethod") as Review["method"]) || "bait",
    overall: 3,
    notes: "",
  };
}

/** Shrink a camera photo to ~1600 px JPEG (~300 KB) before storing/uploading. */
export function compressImage(file: File, max = 1600, quality = 0.75): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't process photo"))), "image/jpeg", quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Couldn't read photo")); };
    img.src = url;
  });
}
