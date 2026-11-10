import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { bestPerSpot } from "./aggregate";
import type { Run, Score, Settings, Species, Spot, SpotPhoto, SpotWindow, Tide, TripSummary } from "./types";

const URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export interface Api {
  demo: boolean;
  now(): Date;
  session(): Promise<boolean>;
  signIn(email: string, password: string): Promise<string | null>;
  signOut(): Promise<void>;
  spots(): Promise<Spot[]>;
  species(): Promise<Species[]>;
  settings(): Promise<Settings>;
  saveSettings(s: Settings): Promise<void>;
  spotWindows(spotIds: string[], from: Date, to: Date): Promise<SpotWindow[]>;
  spotScores(spotId: string, from: Date): Promise<Score[]>;
  addSpot(s: Spot): Promise<void>;
  deleteSpot(id: string): Promise<void>;
  lastRun(): Promise<Run | null>;
  rescore(): Promise<"requested" | "not_configured" | "error">;
  tide(spotId: string): Promise<Tide | null>;
  trips(spotId?: string): Promise<TripSummary[]>;
  spotPhotos(spotId: string): Promise<SpotPhoto[]>;
  upsert(table: string, row: Record<string, unknown>): Promise<void>;
  update(table: string, id: string, patch: Record<string, unknown>): Promise<void>;
  uploadPhoto(path: string, blob: Blob): Promise<void>;
}

const DEFAULT_SETTINGS: Settings = {
  home_name: "Brisbane CBD", home_lat: -27.4698, home_lon: 153.0251, max_travel_min: 120,
  saved_places: [{ name: "Brisbane CBD", lat: -27.4698, lon: 153.0251, max_travel_min: 120 }],
};

// ── Supabase ─────────────────────────────────────────────────────────────────
class SupabaseApi implements Api {
  demo = false;
  private sb: SupabaseClient;
  constructor(url: string, key: string) {
    this.sb = createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true } });
  }
  now() { return new Date(); }
  async session() { return !!(await this.sb.auth.getSession()).data.session; }
  async signIn(email: string, password: string) {
    const { error } = await this.sb.auth.signInWithPassword({ email, password });
    return error ? error.message : null;
  }
  async signOut() { await this.sb.auth.signOut(); }
  private async q<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> {
    const { data, error } = await p;
    if (error) throw new Error(error.message);
    return data as T;
  }
  spots() { return this.q<Spot[]>(this.sb.from("spots").select("*").order("name")); }
  species() { return this.q<Species[]>(this.sb.from("species").select("id,name,base_rate,notes")); }
  async settings() {
    const rows = await this.q<Settings[]>(this.sb.from("settings").select("*").eq("id", 1));
    return rows[0] ?? DEFAULT_SETTINGS;
  }
  async saveSettings(s: Settings) {
    await this.q(this.sb.from("settings").upsert({ id: 1, ...s, updated_at: new Date().toISOString() }));
  }
  async spotWindows(spotIds: string[], from: Date, to: Date) {
    const rows = await this.q<SpotWindow[]>(this.sb.rpc("best_spot_windows", {
      p_spots: spotIds, p_from: from.toISOString(), p_to: to.toISOString(),
    }));
    return rows.map((r) => ({ ...r, top_score: Number(r.top_score), p_any: Number(r.p_any) }));
  }
  spotScores(spotId: string, from: Date) {
    return this.q<Score[]>(this.sb.from("forecast_scores").select("*").eq("spot_id", spotId)
      .gte("block_start", from.toISOString()).order("block_start"));
  }
  async addSpot(s: Spot) { await this.q(this.sb.from("spots").insert({ ...s, source: "user" })); }
  async deleteSpot(id: string) { await this.q(this.sb.from("spots").delete().eq("id", id).eq("source", "user")); }
  async lastRun() {
    const rows = await this.q<Run[]>(this.sb.from("runs").select("run_id,created_at,n_scores,problems")
      .order("created_at", { ascending: false }).limit(1));
    return rows[0] ?? null;
  }
  async rescore() {
    const { data, error } = await this.sb.rpc("request_rescore");
    if (error) return error.message.includes("request_rescore") ? "not_configured" as const : "error" as const;
    return data === "requested" ? "requested" as const : "not_configured" as const;
  }
  async tide(spotId: string) {
    const rows = await this.q<Tide[]>(this.sb.from("tides").select("series,extremes").eq("spot_id", spotId));
    return rows[0] ?? null;
  }
  async trips(spotId?: string) {
    let q = this.sb.from("sessions").select("*, catches(species_id,count)").order("start_ts", { ascending: false }).limit(60);
    if (spotId) q = q.eq("spot_id", spotId);
    return this.q<TripSummary[]>(q);
  }
  async spotPhotos(spotId: string) {
    type C = { species_id: string; max_length_cm: number | null };
    type Row = { id: string; storage_path: string; taken_at: string; catches: C | C[] | null };
    const { data: raw, error } = await this.sb.from("photos")
      .select("id,storage_path,taken_at,catches(species_id,max_length_cm),sessions!inner(spot_id)")
      .eq("sessions.spot_id", spotId).order("taken_at", { ascending: false }).limit(30);
    if (error) throw new Error(error.message);
    const rows = ((raw ?? []) as unknown as Row[]).map((r) => ({
      ...r, catches: Array.isArray(r.catches) ? r.catches[0] ?? null : r.catches,
    }));
    if (!rows.length) return [];
    const { data } = await this.sb.storage.from("photos").createSignedUrls(rows.map((r) => r.storage_path), 3600);
    const urls = new Map((data ?? []).map((d) => [d.path, d.signedUrl]));
    return rows.filter((r) => urls.get(r.storage_path)).map((r) => ({
      id: r.id, url: urls.get(r.storage_path)!, taken_at: r.taken_at,
      species_id: r.catches?.species_id ?? null, length: r.catches?.max_length_cm ?? null,
    }));
  }
  async upsert(table: string, row: Record<string, unknown>) {
    await this.q(this.sb.from(table).upsert(row, { onConflict: "id" }));
  }
  async update(table: string, id: string, patch: Record<string, unknown>) {
    await this.q(this.sb.from(table).update(patch).eq("id", id));
  }
  async uploadPhoto(path: string, blob: Blob) {
    const { error } = await this.sb.storage.from("photos").upload(path, blob, { upsert: true, contentType: "image/jpeg" });
    if (error) throw new Error(error.message);
  }
}

// ── Demo (no Supabase configured): reads ./demo/*.json made from a fixture run ──
class DemoApi implements Api {
  demo = true;
  private cache: Record<string, unknown> = {};
  private nowTs = new Date("2026-07-08T04:30:00+10:00");
  now() { return this.nowTs; }
  async session() { return true; }
  async signIn() { return null; }
  async signOut() {}
  private async load<T>(name: string): Promise<T> {
    if (!this.cache[name]) {
      const r = await fetch(`${import.meta.env.BASE_URL}demo/${name}.json`);
      if (!r.ok) throw new Error(`demo data missing: ${name}.json (run web/scripts/make_demo.py)`);
      this.cache[name] = await r.json();
    }
    return this.cache[name] as T;
  }
  private userSpots(): Spot[] { return JSON.parse(localStorage.getItem("demo_spots") ?? "[]"); }
  async spots() { return [...(await this.load<Spot[]>("spots")), ...this.userSpots()]; }
  async species() { return this.load<Species[]>("species"); }
  async settings() {
    const s = localStorage.getItem("demo_settings");
    return s ? (JSON.parse(s) as Settings) : DEFAULT_SETTINGS;
  }
  async saveSettings(s: Settings) { localStorage.setItem("demo_settings", JSON.stringify(s)); }
  async spotWindows(spotIds: string[], from: Date, to: Date) {
    const all = await this.load<Score[]>("forecast_scores");
    const ids = new Set(spotIds);
    return bestPerSpot(all.filter((r) => {
      const t = new Date(r.block_start);
      return ids.has(r.spot_id) && t >= from && t < to;
    }));
  }
  async spotScores(spotId: string, from: Date) {
    const all = await this.load<Score[]>("forecast_scores");
    return all.filter((r) => r.spot_id === spotId && new Date(r.block_start) >= from)
      .sort((a, b) => a.block_start.localeCompare(b.block_start));
  }
  async addSpot(s: Spot) { localStorage.setItem("demo_spots", JSON.stringify([...this.userSpots(), { ...s, source: "user" }])); }
  async deleteSpot(id: string) { localStorage.setItem("demo_spots", JSON.stringify(this.userSpots().filter((s) => s.id !== id))); }
  async lastRun() { return { run_id: "demo", created_at: this.nowTs.toISOString(), n_scores: 0, problems: [] }; }
  async rescore() { return "not_configured" as const; }
  async tide(spotId: string) {
    const all = await this.load<Record<string, Tide>>("tides").catch(() => ({} as Record<string, Tide>));
    return all[spotId] ?? null;
  }
  private table<T>(name: string): T[] { return JSON.parse(localStorage.getItem(`demo_db_${name}`) ?? "[]"); }
  async trips(spotId?: string) {
    const catches = this.table<{ session_id: string; species_id: string; count: number }>("catches");
    return this.table<TripSummary>("sessions")
      .filter((t) => !spotId || t.spot_id === spotId)
      .map((t) => ({ ...t, catches: catches.filter((c) => c.session_id === t.id) }))
      .sort((a, b) => b.start_ts.localeCompare(a.start_ts));
  }
  async spotPhotos(spotId: string) {
    const { getBlob } = await import("./queue");
    const sessions = new Set(this.table<{ id: string; spot_id: string }>("sessions").filter((s) => s.spot_id === spotId).map((s) => s.id));
    const catches = this.table<{ id: string; species_id: string; max_length_cm: number | null }>("catches");
    const out: SpotPhoto[] = [];
    for (const ph of this.table<{ id: string; session_id: string; catch_id: string | null; storage_path: string; taken_at: string }>("photos")) {
      if (!sessions.has(ph.session_id)) continue;
      const blob = await getBlob(ph.storage_path);
      if (!blob) continue;
      const c = catches.find((x) => x.id === ph.catch_id);
      out.push({ id: ph.id, url: URL_.createObjectURL(blob), taken_at: ph.taken_at, species_id: c?.species_id ?? null, length: c?.max_length_cm ?? null });
    }
    return out.reverse();
  }
  async upsert(table: string, row: Record<string, unknown>) {
    const rows = this.table<Record<string, unknown>>(table).filter((r) => r.id !== row.id);
    const prev = this.table<Record<string, unknown>>(table).find((r) => r.id === row.id) ?? {};
    localStorage.setItem(`demo_db_${table}`, JSON.stringify([...rows, { ...prev, ...row }]));
  }
  async update(table: string, id: string, patch: Record<string, unknown>) {
    await this.upsert(table, { id, ...patch });
  }
  async uploadPhoto() { /* blobs stay in IndexedDB in demo mode */ }
}

const URL_ = globalThis.URL;

/** Set when a production build is missing its Supabase settings (instead of silently using demo data). */
export const configError: string | null = URL && KEY ? null : import.meta.env.DEV ? null
  : "This build isn't connected to your database. Add the SUPABASE_ANON_KEY (and SUPABASE_URL) repository "
    + "secrets in GitHub, then run Actions → Deploy phone app.";

export const api: Api = URL && KEY ? new SupabaseApi(URL, KEY) : new DemoApi();
