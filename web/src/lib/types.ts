export interface Spot {
  id: string;
  name: string;
  region: string | null;
  state: string | null;
  lat: number;
  lon: number;
  type: string;
  tidal: boolean;
  facing: number | null;
  shelter: number | null;
  swell_max: number | null;
  extra_min: number | null;
  access: string | null;
  permit: string | null;
  species: string[];
  verified: boolean;
  source?: "config" | "user";
}

export interface Species {
  id: string;
  name: string;
  base_rate: number;
  notes: string | null;
}

export interface Reason { factor: string; points: number; text: string }
export interface Reg { id: string; action: "closed" | "catch_and_release" | "permit"; text: string }

export interface Score {
  spot_id: string;
  species_id: string;
  block_start: string;
  block_hours: number;
  best_hour: string | null;
  score: number;
  p_success: number;
  safety: "ok" | "caution" | "no_go";
  safety_text: string | null;
  reasons: Reason[];
  regulations: Reg[];
  conditions: Record<string, number | string | null>;
  model_version: string;
}

export interface Place { name: string; lat: number; lon: number; max_travel_min: number }

export interface Settings {
  home_name: string;
  home_lat: number;
  home_lon: number;
  max_travel_min: number;
  saved_places: Place[];
}

export interface Run { run_id: string; created_at: string; n_scores: number; problems: string[] | null }

export interface Origin { name: string; lat: number; lon: number; max_travel_min: number; gps: boolean }

export interface SpeciesScore {
  species_id: string;
  score: number;
  p_success: number;
  reasons: Reason[];
  regulations: Reg[];
  conditions: Record<string, number | string | null>;
}

/** One spot's best 3-hour block in a window, with every species' score in that block. */
export interface SpotWindow {
  spot_id: string;
  block_start: string;
  block_hours: number;
  top_score: number;
  p_any: number;
  safety: "ok" | "caution";
  safety_text: string | null;
  species: SpeciesScore[];
  alt_blocks?: { block_start: string; block_hours: number; score: number }[];
}

export type Water = "salt" | "fresh";

export interface Tide {
  series: [string, number][];
  extremes: [string, "high" | "low", number][];
}

export interface Trip {
  id: string;
  client_id: string;
  spot_id: string;
  start_ts: string;
  end_ts: string | null;
  targeted_species: string[];
  method: "lure" | "bait" | "fly" | "mixed" | null;
  why_went: string | null;
  score_shown: number | null;
  model_version_shown: string | null;
  checkin_lat: number | null;
  checkin_lon: number | null;
  skunked: boolean | null;
  notes: string | null;
}

export interface Catch {
  id: string;
  client_id: string;
  session_id: string;
  species_id: string;
  count: number;
  max_length_cm: number | null;
  caught_at: string;
}

export interface PhotoRow {
  id: string;
  session_id: string;
  catch_id: string | null;
  storage_path: string;
  taken_at: string;
}

export interface TripSummary extends Trip { catches: { species_id: string; count: number }[] }

export interface SpotPhoto { id: string; url: string; taken_at: string; species_id: string | null; length: number | null }
