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
