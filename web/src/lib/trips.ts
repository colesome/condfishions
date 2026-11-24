import { enqueue, putBlob } from "./queue";
import { getPosition } from "./geo";
import type { Catch, Spot, TackleKind, Trip, TripCatch } from "./types";
import { rememberTackle } from "./tackle";

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

export async function startTrip(spot: Spot, scoreShown: number | null, plannedTripId: string | null = null,
  modelVersion = "baseline_v3"): Promise<ActiveTrip> {
  const id = uuid();
  const trip: Trip = {
    id, client_id: id, spot_id: spot.id, start_ts: new Date().toISOString(), end_ts: null,
    targeted_species: spot.species, method: null, why_went: "suggested",
    score_shown: scoreShown, model_version_shown: modelVersion,
    checkin_lat: null, checkin_lon: null, skunked: null, notes: null,
    ...(plannedTripId ? { planned_trip_id: plannedTripId } : {}),
  };
  const active: ActiveTrip = { trip, spot_name: spot.name, catches: [] };
  saveActive(active);
  await enqueue({ kind: "upsert", table: "sessions", row: { ...trip } });
  if (plannedTripId) await enqueue({ kind: "update", table: "planned_trips", id: plannedTripId, patch: { status: "done", session_id: id } });
  getPosition().then(async (g) => { // best effort GPS check-in
    const a = loadActive();
    if (!a || a.trip.id !== id) return;
    a.trip.checkin_lat = g.lat; a.trip.checkin_lon = g.lon;
    saveActive(a);
    await enqueue({ kind: "update", table: "sessions", id, patch: { checkin_lat: g.lat, checkin_lon: g.lon } });
  }).catch(() => undefined);
  return active;
}

export interface NewCatch {
  species_id: string; length: number | null; released: boolean; photo: Blob | null;
  method: TackleKind | null; tackle: string | null; caught_at?: string;
}

/** Save one catch against any trip (running or finished). Works offline. */
export async function addCatch(sessionId: string, c: NewCatch): Promise<LocalCatch> {
  const id = uuid();
  const at = c.caught_at ?? new Date().toISOString();
  const row: Catch = {
    id, client_id: id, session_id: sessionId, species_id: c.species_id, count: 1,
    max_length_cm: c.length, caught_at: at, method: c.method, tackle: c.tackle?.trim() || null,
  };
  let photo_key: string | null = null;
  await enqueue({ kind: "upsert", table: "catches", row: { ...row, kept: c.released ? 0 : 1, released: c.released ? 1 : 0 } });
  if (c.photo) {
    photo_key = `${sessionId}/${id}.jpg`;
    await putBlob(photo_key, c.photo);
    await enqueue({ kind: "photo", path: photo_key });
    await enqueue({ kind: "upsert", table: "photos", row: {
      id: uuid(), session_id: sessionId, catch_id: id, storage_path: photo_key, taken_at: at,
    } });
  }
  if (c.method && c.tackle) rememberTackle(c.method, c.tackle);
  return { ...row, photo_key, released: c.released };
}

export async function logCatch(a: ActiveTrip, c: NewCatch): Promise<ActiveTrip> {
  const saved = await addCatch(a.trip.id, c);
  const next = { ...a, catches: [...a.catches, saved] };
  saveActive(next);
  return next;
}

/** Change bait/lure, length or kept/released on a saved catch. */
export async function updateCatch(id: string, patch: { method?: TackleKind | null; tackle?: string | null; max_length_cm?: number | null; released?: boolean; species_id?: string }) {
  const p: Record<string, unknown> = { ...patch };
  if (patch.released !== undefined) { p.released = patch.released ? 1 : 0; p.kept = patch.released ? 0 : 1; }
  if (patch.method && patch.tackle) rememberTackle(patch.method, patch.tackle);
  await enqueue({ kind: "update", table: "catches", id, patch: p });
}

/** Remove a catch from a finished trip (kept as count 0, like "Undo last catch"). */
export async function deleteCatch(id: string) {
  await enqueue({ kind: "update", table: "catches", id, patch: { count: 0 } });
}

export async function setSkunked(sessionId: string, fish: number) {
  await enqueue({ kind: "update", table: "sessions", id: sessionId, patch: { skunked: fish === 0, updated_at: new Date().toISOString() } });
}

/**
 * Log a trip after you're home. No rating is recorded as "shown" (you didn't see one before
 * going); the scorer works out the rating for those hours overnight from measured conditions.
 */
export async function createPastTrip(spot: Spot, start: Date, end: Date): Promise<Trip> {
  const id = uuid();
  const trip: Trip = {
    id, client_id: id, spot_id: spot.id, start_ts: start.toISOString(), end_ts: end.toISOString(),
    targeted_species: spot.species, method: null, why_went: null, score_shown: null, model_version_shown: null,
    checkin_lat: null, checkin_lon: null, skunked: true, notes: null, logged_after: true,
  };
  await enqueue({ kind: "upsert", table: "sessions", row: { ...trip } });
  return trip;
}

/**
 * Change a finished trip's spot or times. Its measured conditions and hindsight rating are
 * cleared so the scorer works them out again for the new time (on the next early-morning run).
 */
export async function editTrip(id: string, e: { spot_id: string; start: Date; end: Date }, catches: TripCatch[]) {
  const now = new Date().toISOString();
  await enqueue({ kind: "update", table: "sessions", id, patch: {
    spot_id: e.spot_id, start_ts: e.start.toISOString(), end_ts: e.end.toISOString(),
    times_edited_at: now, score_at_time: null, score_at_time_version: null, updated_at: now,
  } });
  await enqueue({ kind: "delete", table: "observed_conditions", match: { session_id: id, source: "archive" } });
  for (const c of catches) { // keep catch times inside the trip
    if (!c.caught_at) continue;
    const t = new Date(c.caught_at).getTime();
    const clamped = Math.min(Math.max(t, e.start.getTime()), e.end.getTime());
    if (clamped !== t) await enqueue({ kind: "update", table: "catches", id: c.id, patch: { caught_at: new Date(clamped).toISOString() } });
  }
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
  await enqueue({ kind: "update", table: "sessions", id: a.trip.id, patch: { end_ts: end } });
  await saveReview(a.trip.id, a.catches.length, r, prefilledFrom);
  saveActive(null);
}

/** The "How was it?" answers, for a trip just finished or one logged afterwards. */
export async function saveReview(sessionId: string, fish: number, r: Review, prefilledFrom: Record<string, unknown> | null): Promise<void> {
  const now = new Date().toISOString();
  await enqueue({ kind: "update", table: "sessions", id: sessionId, patch: {
    skunked: fish === 0, method: r.method, notes: r.notes || null, updated_at: now,
  } });
  await enqueue({ kind: "upsert", table: "observed_conditions", row: {
    id: uuid(), session_id: sessionId, source: "angler",
    vals: { ...r, notes: undefined, forecast_used_for_prefill: prefilledFrom },
  } });
  localStorage.setItem("lastMethod", r.method);
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
