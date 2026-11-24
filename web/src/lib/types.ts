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

export type PartId = "morning" | "day" | "evening" | "night";

/** A window at a spot: the best few hours of one part of a day. */
export type Comfort = "pleasant" | "breezy" | "windy" | "wet" | "wet_windy";
export interface WindowLite { block_start: string; block_hours: number; score: number; part?: PartId | null; comfort?: Comfort | null }

/** One spot's best window in a date range, with every species' score in that window. */
export interface SpotWindow {
  spot_id: string;
  block_start: string;
  block_hours: number;
  top_score: number;
  p_any: number;
  safety: "ok" | "caution";
  safety_text: string | null;
  species: SpeciesScore[];
  /** Every window at this spot in the range (best per part of each day), earliest first. */
  windows?: WindowLite[] | null;
  /** Older database function: best block on each other day. */
  alt_blocks?: WindowLite[];
}

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
  logged_after?: boolean;
  times_edited_at?: string | null;
  score_at_time?: number | null;
  planned_trip_id?: string | null;
}

export interface Catch {
  id: string;
  client_id: string;
  session_id: string;
  species_id: string;
  count: number;
  max_length_cm: number | null;
  caught_at: string;
  /** "bait" or "lure" */
  method?: TackleKind | null;
  /** which bait or lure, e.g. "Prawn", "Soft plastic" */
  tackle?: string | null;
  released?: number | boolean | null;
}

export type TackleKind = "bait" | "lure";

export interface PhotoRow {
  id: string;
  session_id: string;
  catch_id: string | null;
  storage_path: string;
  taken_at: string;
}

export interface TripCatch {
  id: string; species_id: string; count: number; max_length_cm: number | null; caught_at: string | null;
  method: TackleKind | null; tackle: string | null; released: number | null;
}
export interface TripSummary extends Trip { catches: TripCatch[] }

/** Everything about one finished trip, for the trip page. */
export interface TripDetail extends TripSummary {
  photos: { catch_id: string | null; url: string }[];
  observed: { source: string; vals: Record<string, unknown> }[];
}

/** One fish for the "My catches" page. */
export interface CatchRecord extends TripCatch {
  session_id: string; spot_id: string; start_ts: string; photo_url: string | null;
}

export interface PlanChange { kind: string; severity: 1 | 2; text: string }

/** A booked fishing slot. The scorer re-rates it every run and notes changes for the worse. */
export interface PlannedTrip {
  id: string;
  spot_id: string;
  block_start: string;
  block_hours: number;
  part: string | null;
  score_booked: number | null;
  safety_booked: string | null;
  conditions_booked: Record<string, number | string | null>;
  score_now: number | null;
  safety_now: string | null;
  safety_text_now: string | null;
  conditions_now: Record<string, number | string | null> | null;
  checked_at: string | null;
  changes: PlanChange[];
  alerted_at: string | null;
  seen_at: string | null;
  status: "planned" | "done" | "cancelled" | "past";
  session_id: string | null;
  created_at: string;
}

export interface SpotPhoto { id: string; url: string; taken_at: string; species_id: string | null; length: number | null }
