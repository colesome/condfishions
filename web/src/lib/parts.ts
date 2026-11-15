import type { PartId, WindowLite } from "./types";

/** Parts of the day (same hours as the scorer). Night runs past midnight and belongs to the evening before. */
export const PARTS: { id: PartId; label: string; from: number }[] = [
  { id: "morning", label: "Morning", from: 4 },
  { id: "day", label: "Day", from: 10 },
  { id: "evening", label: "Evening", from: 16 },
  { id: "night", label: "Night", from: 22 },
];

const H = 3600_000;

export function partOf(iso: string): (typeof PARTS)[number] {
  const h = (new Date(iso).getHours() - 4 + 24) % 24;
  return PARTS[Math.floor(h / 6)];
}

/** The day a window belongs to: hours before 4 am count as the night before. */
export function fishDay(iso: string): string {
  return new Date(new Date(iso).getTime() - 4 * H).toDateString();
}

/** Split a spot's windows into the other parts of the best window's day, and the best window on each other day. */
export function splitWindows(best: { block_start: string }, windows: WindowLite[] | null | undefined, maxDays = 3) {
  const all = windows ?? [];
  const day = fishDay(best.block_start);
  const sameDay = all.filter((w) => fishDay(w.block_start) === day)
    .sort((a, b) => a.block_start.localeCompare(b.block_start));
  const perDay = new Map<string, WindowLite>();
  for (const w of all) {
    const k = fishDay(w.block_start);
    if (k === day) continue;
    const cur = perDay.get(k);
    if (!cur || w.score > cur.score) perDay.set(k, w);
  }
  const otherDays = [...perDay.values()].sort((a, b) => b.score - a.score).slice(0, maxDays)
    .sort((a, b) => a.block_start.localeCompare(b.block_start));
  return { sameDay, otherDays };
}
