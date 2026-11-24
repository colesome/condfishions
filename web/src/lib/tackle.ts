import type { TackleKind } from "./types";

/** Starting suggestions; anything you type is remembered and floats to the front. */
const DEFAULTS: Record<TackleKind, string[]> = {
  bait: ["Prawn", "Squid", "Pilchard", "Worm", "Yabby", "Mullet strip", "Live bait"],
  lure: ["Soft plastic", "Hard body", "Metal slug", "Vibe", "Surface lure", "Blade"],
};

const KEY = "tackleRecent";

function recent(): Record<TackleKind, string[]> {
  try { return { bait: [], lure: [], ...JSON.parse(localStorage.getItem(KEY) ?? "{}") }; } catch { return { bait: [], lure: [] }; }
}

/** Suggestions for one kind: recently used first, then the defaults, no duplicates. */
export function tackleChoices(kind: TackleKind, extra: string[] = []): string[] {
  const seen = new Set<string>();
  return [...recent()[kind], ...extra, ...DEFAULTS[kind]].filter((x) => {
    const k = x.trim().toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 10);
}

export function rememberTackle(kind: TackleKind, name: string): void {
  const n = name.trim();
  if (!n) return;
  const r = recent();
  r[kind] = [n, ...r[kind].filter((x) => x.toLowerCase() !== n.toLowerCase())].slice(0, 8);
  try { localStorage.setItem(KEY, JSON.stringify(r)); localStorage.setItem("lastTackleKind", kind); } catch { /* private mode */ }
}

export function lastTackleKind(): TackleKind {
  return localStorage.getItem("lastTackleKind") === "lure" ? "lure" : "bait";
}

export function tackleLabel(method: TackleKind | null | undefined, tackle: string | null | undefined): string | null {
  if (!method && !tackle) return null;
  const icon = method === "lure" ? "🎣" : "🪱";
  return `${icon} ${tackle || (method === "lure" ? "Lure" : "Bait")}`;
}

/** Trip-level "fished with" from the catches' bait/lure, if they agree. */
export function methodFromCatches(kinds: (TackleKind | null | undefined)[]): "bait" | "lure" | "mixed" | null {
  const k = new Set(kinds.filter(Boolean));
  if (!k.size) return null;
  return k.size > 1 ? "mixed" : ([...k][0] as "bait" | "lure");
}
