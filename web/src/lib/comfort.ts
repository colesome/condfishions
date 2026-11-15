import type { Comfort } from "./types";

/** How pleasant it is to stand there. Shown beside the rating; it never changes the rating. */
export const COMFORT: Record<Comfort, { emoji: string; label: string }> = {
  pleasant: { emoji: "😎", label: "Pleasant" },
  breezy: { emoji: "🌬️", label: "Breezy" },
  windy: { emoji: "💨", label: "Windy" },
  wet: { emoji: "🌧️", label: "Wet" },
  wet_windy: { emoji: "🌧️", label: "Wet and windy" },
};

type Cond = Record<string, number | string | null> | undefined;

export function comfortOf(c: Cond): Comfort | null {
  const k = c?.comfort;
  return typeof k === "string" && k in COMFORT ? (k as Comfort) : null;
}

/** "🌬️ Breezy · 18 km/h NE onshore, gusts 28" — null until the scorer has written window weather. */
export function weatherLine(c: Cond): string | null {
  const k = comfortOf(c);
  if (!k || !c || c.win_wind_kmh == null) return null;
  const wind = `${c.win_wind_kmh} km/h ${c.win_wind_dir ?? ""} ${c.win_wind_side ?? ""}`.replace(/\s+/g, " ").trim();
  const gust = c.win_gust_kmh != null && Number(c.win_gust_kmh) >= Number(c.win_wind_kmh) + 8 ? `, gusts ${c.win_gust_kmh}` : "";
  const rain = Number(c.win_rain_mm ?? 0) >= 2 ? ` · ${c.win_rain_mm} mm rain` : "";
  return `${COMFORT[k].emoji} ${COMFORT[k].label} · ${wind}${gust}${rain}`;
}
