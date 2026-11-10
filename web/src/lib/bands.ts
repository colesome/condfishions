export interface Band { id: string; name: string; emoji: string; min: number; color: string; soft: string }

/** Five bands on the conditions rating (50 = average conditions). */
export const BANDS: Band[] = [
  { id: "tight", name: "Tight Lines", emoji: "🔥", min: 75, color: "#00b386", soft: "#dcf7ee" },
  { id: "good", name: "Pretty Good", emoji: "🎣", min: 65, color: "#34c759", soft: "#e3f8e8" },
  { id: "crack", name: "Worth a Crack", emoji: "🤞", min: 55, color: "#f5b400", soft: "#fff6d6" },
  { id: "avg", name: "Average", emoji: "😐", min: 45, color: "#ff9500", soft: "#ffefd9" },
  { id: "nah", name: "Wouldn't Bother", emoji: "💤", min: -1, color: "#8e8e93", soft: "#ececf0" },
];

export function bandFor(score: number): Band {
  return BANDS.find((b) => score >= b.min) ?? BANDS[BANDS.length - 1];
}
