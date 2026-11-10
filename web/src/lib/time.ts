export type WindowId = "next6" | "today" | "tonight" | "tomorrow" | "next3" | "weekend" | "week";

/** Next 3 days is the default: wind and swell forecasts are solid out to ~3 days and get
 *  noticeably less reliable after that (tides and sun/moon stay exact). */
export const WINDOWS: { id: WindowId; label: string }[] = [
  { id: "next3", label: "Next 3 days" },
  { id: "today", label: "Today" },
  { id: "tomorrow", label: "Tomorrow" },
  { id: "weekend", label: "Weekend" },
  { id: "week", label: "7 days" },
];

const H = 3600_000;

function midnight(d: Date, addDays = 0): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() + addDays);
  return x;
}

/** [from, to) for a window. `from` is floored to the current 3-hour block. */
export function windowRange(id: WindowId, now: Date): [Date, Date] {
  const blockStart = new Date(now);
  blockStart.setMinutes(0, 0, 0);
  blockStart.setHours(blockStart.getHours() - (blockStart.getHours() % 3));
  switch (id) {
    case "next6":
      return [blockStart, new Date(now.getTime() + 6 * H)];
    case "today":
      return [blockStart, midnight(now, 1)];
    case "tonight": {
      const from = new Date(midnight(now).getTime() + 15 * H);
      return [from < blockStart ? blockStart : from, new Date(midnight(now, 1).getTime() + 6 * H)];
    }
    case "tomorrow":
      return [midnight(now, 1), midnight(now, 2)];
    case "next3":
      return [blockStart, new Date(now.getTime() + 72 * H)];
    case "week":
      return [blockStart, new Date(now.getTime() + 7 * 24 * H)];
    case "weekend": {
      const dow = now.getDay(); // 0 Sun .. 6 Sat
      if (dow === 6 || dow === 0) return [blockStart, midnight(now, dow === 6 ? 2 : 1)];
      const sat = midnight(now, 6 - dow);
      return [sat, midnight(sat, 2)];
    }
  }
}

export function fmtBlock(iso: string, hours = 3, now = new Date()): string {
  const d = new Date(iso);
  const end = new Date(d.getTime() + hours * H);
  const day = sameDay(d, now) ? "Today" : sameDay(d, midnight(now, 1)) ? "Tomorrow"
    : d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });
  return `${day} ${hm(d)}–${hm(end)}`;
}

export function hm(d: Date): string {
  const h = d.getHours();
  const ampm = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return d.getMinutes() ? `${h12}:${String(d.getMinutes()).padStart(2, "0")}${ampm}` : `${h12}${ampm}`;
}

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function ago(iso: string, now = new Date()): string {
  const m = Math.round((now.getTime() - new Date(iso).getTime()) / 60000);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

function hShort(d: Date): string {
  const h = d.getHours();
  if (h === 0 && d.getMinutes() === 0) return "midnight";
  if (h === 12 && d.getMinutes() === 0) return "midday";
  return hm(d);
}

/** "Today, Wed 11 Nov · 6am – 9am" — always shows the date so it's unambiguous. */
export function fmtWhen(iso: string, hours = 3, now = new Date()): string {
  const d = new Date(iso);
  const end = new Date(d.getTime() + hours * H);
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const date = `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  const rel = sameDay(d, now) ? "Today, " : sameDay(d, tomorrow) ? "Tomorrow, " : "";
  return `${rel}${date} · ${hShort(d)} – ${hShort(end)}`;
}

/** Short form for small pills: "Fri 6am". */
export function fmtShort(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  const day = sameDay(d, now) ? "Today" : sameDay(d, tomorrow) ? "Tmrw"
    : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
  return `${day} ${hm(d)}`;
}
