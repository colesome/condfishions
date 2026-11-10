/**
 * One ranking that blends conditions/catching with distance.
 * The score already combines conditions and how likely fish are; closer spots get a boost:
 * no penalty for the first 20 min, then 1 point per 4 extra minutes
 * (45 min ≈ −6, 1 h ≈ −10, 2 h ≈ −25). A far spot must be clearly better to rank above a near one.
 */
export function travelPenalty(min: number): number {
  return Math.max(0, min - 20) / 4;
}

export function rankValue(score: number, travelMin: number): number {
  return score - travelPenalty(travelMin);
}
