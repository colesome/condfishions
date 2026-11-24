import { api } from "./api";
import { bandFor } from "./bands";
import { weatherLine } from "./comfort";
import type { PlannedTrip, Spot } from "./types";

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/([,;])/g, "\\$1");

/** Fold long lines at 74 octets as the iCalendar format asks (kept simple: by characters). */
const fold = (line: string) => line.match(/.{1,72}/gu)!.join("\r\n ");

export function buildIcs(plan: PlannedTrip, spot: Spot, speciesNames: string): string {
  const start = new Date(plan.block_start);
  const end = new Date(start.getTime() + plan.block_hours * 3600_000);
  const score = plan.score_booked != null ? Math.round(plan.score_booked) : null;
  const band = score != null ? bandFor(score) : null;
  const weather = weatherLine(plan.conditions_booked);
  const app = `${location.origin}${import.meta.env.BASE_URL}?tab=trips&plan=${plan.id}`;
  const desc = [
    score != null && band ? `${band.emoji} ${band.name} · ${score} when booked` : null,
    weather,
    `Fish: ${speciesNames}`,
    "CondFishions will let you know if conditions get worse before you go.",
    app,
  ].filter(Boolean).join("\n");
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//CondFishions//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${plan.id}@condfishions`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(end)}`,
    `SUMMARY:${esc(`🎣 Fishing · ${spot.name}${score != null ? ` (${score})` : ""}`)}`,
    `LOCATION:${esc(spot.name)}`,
    `GEO:${spot.lat};${spot.lon}`,
    `DESCRIPTION:${esc(desc)}`,
    `URL:${app}`,
    "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT90M", `DESCRIPTION:${esc(`Fishing at ${spot.name} soon`)}`, "END:VALARM",
    "END:VEVENT", "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

/**
 * Hand the event to the phone's calendar. A real https link to a text/calendar file is what
 * iPhone reliably turns into "Add to Calendar", so the file is uploaded first; offline (or in
 * demo mode) it falls back to a downloaded file.
 */
export async function addToCalendar(plan: PlannedTrip, spot: Spot, speciesNames: string): Promise<void> {
  const ics = buildIcs(plan, spot, speciesNames);
  const link = await api.calendarLink(`${plan.id}.ics`, ics).catch(() => null);
  if (link) {
    // outside the app's own address, so the home-screen app opens it in a Safari panel with a
    // Done button; iPhone shows the event with "Add to Calendar"
    window.location.assign(link);
    return;
  }
  const url = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `fishing-${spot.id}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
