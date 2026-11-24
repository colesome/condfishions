import { api } from "./api";
import { bandFor } from "./bands";
import type { PlannedTrip, SpeciesScore, Spot } from "./types";

/** A window the user can book: what the spot page shows for it. */
export interface BookableWindow {
  block_start: string;
  block_hours: number;
  top_score: number;
  safety: string;
  part?: string | null;
  species: SpeciesScore[];
}

/** Save a booking with what the app shows right now, so the scorer can compare later. */
export async function bookSlot(spot: Spot, b: BookableWindow): Promise<PlannedTrip> {
  const plan: PlannedTrip = {
    id: crypto.randomUUID(),
    spot_id: spot.id,
    block_start: new Date(b.block_start).toISOString(),
    block_hours: b.block_hours,
    part: b.part ?? null,
    score_booked: Math.round(b.top_score * 10) / 10,
    safety_booked: b.safety,
    conditions_booked: b.species[0]?.conditions ?? {},
    score_now: null, safety_now: null, safety_text_now: null, conditions_now: null, checked_at: null,
    changes: [], alerted_at: null, seen_at: null, status: "planned", session_id: null,
    created_at: new Date().toISOString(),
  };
  await api.upsert("planned_trips", { ...plan });
  return plan;
}

export async function cancelPlan(id: string): Promise<void> {
  await api.update("planned_trips", id, { status: "cancelled" });
}

export async function markSeen(p: PlannedTrip): Promise<void> {
  await api.update("planned_trips", p.id, { seen_at: new Date().toISOString() }).catch(() => undefined);
}

/** True when the scorer has flagged something the user hasn't looked at yet. */
export function unseen(p: PlannedTrip): boolean {
  return p.status === "planned" && p.changes.length > 0 && !!p.alerted_at && (!p.seen_at || p.seen_at < p.alerted_at);
}

export function planFor(plans: PlannedTrip[], spotId: string, blockStart: string, hours = 3): PlannedTrip | undefined {
  const t = new Date(blockStart).getTime();
  return plans.find((p) => p.status === "planned" && p.spot_id === spotId
    && Math.abs(new Date(p.block_start).getTime() - t) < hours * 3600_000);
}

/** The booking you're fishing in now (from 1 h before to the end of the slot), if any. */
export function planNow(plans: PlannedTrip[], spotId: string, now = new Date()): PlannedTrip | undefined {
  return plans.find((p) => {
    const s = new Date(p.block_start).getTime();
    return p.status === "planned" && p.spot_id === spotId
      && now.getTime() >= s - 3600_000 && now.getTime() <= s + p.block_hours * 3600_000;
  });
}

export function scoreLine(p: PlannedTrip): { now: number | null; booked: number | null; worse: boolean } {
  const booked = p.score_booked != null ? Math.round(p.score_booked) : null;
  const now = p.score_now != null ? Math.round(p.score_now) : null;
  const worse = booked != null && now != null && (booked - now >= 8 || bandFor(now).name !== bandFor(booked).name && now < booked);
  return { now, booked, worse };
}
