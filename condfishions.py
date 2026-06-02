#!/usr/bin/env python3
"""
fishing.py — Multi-spot fishing forecast, Fingal Head to Noosa.

Fetches wind/swell (Open-Meteo, free, no key), tide (Stormglass, 2 calls),
and bite times (solunar.org, free, no key). Ranks the 5 best spot+window
combinations over the next 3 days and sends a WhatsApp via CallMeBot.

Required env vars:
  STORMGLASS_API_KEY   free tier, only ~2 calls/day used
  CALLMEBOT_API_KEY    free — activate once at callmebot.com (see README)
"""

import os, sys, json, datetime as dt
from urllib.request import Request, urlopen
from urllib.parse import urlencode
from urllib.error import URLError, HTTPError
from zoneinfo import ZoneInfo

# ═══════════════════════════════════════════════════════════════ config

TZ          = ZoneInfo("Australia/Brisbane")   # UTC+10, no DST
DAYS        = 3
DAY_START   = 4     # evaluate windows between these hours only
DAY_END     = 20

WIND_OK     = 15    # km/h
WIND_BAD    = 25
SWELL_OK    = 1.0   # metres — open/semi spots only
SWELL_BAD   = 2.0

SPOTS = [
    {"name": "Fingal Head",     "lat": -28.1992, "lng": 153.5667, "exp": "open"},
    {"name": "Snapper Rocks",   "lat": -28.1620, "lng": 153.5520, "exp": "open"},
    {"name": "Burleigh Heads",  "lat": -28.0930, "lng": 153.4560, "exp": "open"},
    {"name": "GC Seaway",       "lat": -27.9380, "lng": 153.4290, "exp": "semi"},
    {"name": "Jumpinpin",       "lat": -27.7200, "lng": 153.4300, "exp": "semi"},
    {"name": "Point Lookout",   "lat": -27.4300, "lng": 153.5320, "exp": "open"},
    {"name": "Manly (bay)",     "lat": -27.4540, "lng": 153.1900, "exp": "bay"},
    {"name": "Redcliffe",       "lat": -27.2540, "lng": 153.1080, "exp": "bay"},
    {"name": "Bribie (Woorim)", "lat": -27.0800, "lng": 153.1990, "exp": "semi"},
    {"name": "Caloundra",       "lat": -26.8030, "lng": 153.1430, "exp": "open"},
    {"name": "Mooloolaba",      "lat": -26.6820, "lng": 153.1190, "exp": "open"},
    {"name": "Maroochydore",    "lat": -26.6490, "lng": 153.0990, "exp": "semi"},
    {"name": "Noosa NP",        "lat": -26.3850, "lng": 153.1000, "exp": "open"},
]

# Two Stormglass tide reference points — one open coast, one bay
TIDE_REFS = {
    "coast": {"lat": -27.9380, "lng": 153.4290},   # GC Seaway (open coast)
    "bay":   {"lat": -27.4540, "lng": 153.1900},   # Brisbane / Manly (bay)
}
TIDE_REF_MAP = {"open": "coast", "semi": "coast", "bay": "bay"}

CALLMEBOT_PHONE = "61477282003"

# ═══════════════════════════════════════════════════════════════ fetchers

def _get(url, headers=None):
    req = Request(url, headers=headers or {})
    with urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def fetch_wind():
    """Open-Meteo forecast — wind for all spots, 3 days, local time."""
    lats = ",".join(str(s["lat"]) for s in SPOTS)
    lngs = ",".join(str(s["lng"]) for s in SPOTS)
    url = (
        "https://api.open-meteo.com/v1/forecast"
        f"?latitude={lats}&longitude={lngs}"
        "&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m"
        "&timezone=Australia/Brisbane&forecast_days=3&wind_speed_unit=kmh"
    )
    return _get(url)


def fetch_swell():
    """Open-Meteo marine — wave/swell for all spots, 3 days, local time."""
    lats = ",".join(str(s["lat"]) for s in SPOTS)
    lngs = ",".join(str(s["lng"]) for s in SPOTS)
    url = (
        "https://marine-api.open-meteo.com/v1/marine"
        f"?latitude={lats}&longitude={lngs}"
        "&hourly=swell_wave_height,wave_height"
        "&timezone=Australia/Brisbane&forecast_days=3"
    )
    return _get(url)


def fetch_tides(start_ts, end_ts):
    """Stormglass tide extremes — 2 reference points (2 API calls)."""
    key = os.environ.get("STORMGLASS_API_KEY", "")
    if not key:
        print("WARNING: STORMGLASS_API_KEY not set; tide scoring disabled.")
        return {}
    out = {}
    for ref_name, coords in TIDE_REFS.items():
        url = (
            "https://api.stormglass.io/v2/tide/extremes/point"
            f"?lat={coords['lat']}&lng={coords['lng']}"
            f"&start={start_ts}&end={end_ts}"
        )
        out[ref_name] = _get(url, {"Authorization": key})
    return out


def fetch_solunar(date):
    """solunar.org — bite windows for one central point (per day)."""
    url = f"https://api.solunar.org/solunar/-27.45,153.2,{date:%Y%m%d},10"
    return _get(url)


# ═══════════════════════════════════════════════════════════════ parsers

def parse_hourly(om_response, fields):
    """
    Open-Meteo multi-location response → list of per-spot dicts.
    Each dict maps "YYYY-MM-DDTHH:00" → {field: value}.
    Response is a JSON array when multiple locations requested.
    """
    items = om_response if isinstance(om_response, list) else [om_response]
    result = []
    for item in items:
        h     = item.get("hourly", {})
        times = h.get("time", [])
        n     = len(times)
        slot  = {}
        for i, t_str in enumerate(times):
            slot[t_str] = {f: h.get(f, [None] * n)[i] for f in fields}
        result.append(slot)
    return result


def parse_tide_extremes(sg_resp):
    """Stormglass tide extremes → sorted list of (local_datetime, 'high'/'low')."""
    out = []
    for e in sg_resp.get("data", []):
        t = dt.datetime.fromisoformat(
            e["time"].replace("Z", "+00:00")
        ).astimezone(TZ)
        out.append((t, e.get("type", "")))
    return sorted(out)


def _hhmm(date, s):
    """Parse 'HH:MM' solunar time string → aware datetime on date."""
    if not s or ":" not in str(s):
        return None
    try:
        hh, mm = str(s).split(":")[:2]
        return dt.datetime.combine(date, dt.time(int(hh), int(mm))).replace(tzinfo=TZ)
    except (ValueError, OverflowError):
        return None


def compass(d):
    if d is None:
        return "?"
    return ["N","NE","E","SE","S","SW","W","NW"][int((d % 360) / 45 + 0.5) % 8]


def is_offshore(direction):
    """
    True if wind blows FROM westerly quadrant (202.5–337.5°).
    On this east-facing coast that means offshore, which calms surf.
    """
    if direction is None:
        return False
    return 202.5 <= (direction % 360) <= 337.5


# ═══════════════════════════════════════════════════════════════ scoring

def base_score(hour, date, sol, tides_for_day):
    """
    Regional factors shared across spots:
    solunar periods, dawn/dusk, tide turn proximity.
    Returns (score, reason_list).
    """
    when    = dt.datetime.combine(date, dt.time(hour)).replace(tzinfo=TZ)
    score   = 0
    reasons = []

    # Solunar periods
    for tag, k0, k1, pts in [
        ("major", "major1Start", "major1Stop", 3),
        ("major", "major2Start", "major2Stop", 3),
        ("minor", "minor1Start", "minor1Stop", 2),
        ("minor", "minor2Start", "minor2Stop", 2),
    ]:
        a = _hhmm(date, sol.get(k0))
        b = _hhmm(date, sol.get(k1))
        if a and b and a <= when <= b:
            score   += pts
            reasons.append(f"{tag} bite")

    # Dawn / dusk (±60 min of sunrise/sunset)
    for label, key in [("dawn", "sunRise"), ("dusk", "sunSet")]:
        t = _hhmm(date, sol.get(key))
        if t and abs((when - t).total_seconds()) <= 3600:
            score   += 2
            reasons.append(label)

    # Tide turn (within 90 min)
    for tt, ttype in tides_for_day:
        if abs((when - tt).total_seconds()) <= 5400:
            score   += 1
            reasons.append(f"{ttype} tide")
            break

    return score, reasons


def spot_modifier(spot, hour_key, wind_h, swell_h):
    """
    Per-spot condition modifier for a given hour.
    Returns (modifier, condition_summary, is_unsafe).
    """
    sw = wind_h.get(hour_key, {})
    ss = swell_h.get(hour_key, {})

    mod    = 0
    parts  = []
    unsafe = False

    wind = sw.get("wind_speed_10m")
    wdir = sw.get("wind_direction_10m")
    gust = sw.get("wind_gusts_10m")

    if wind is not None:
        if wind > WIND_BAD:
            mod -= 4
        elif wind > WIND_OK:
            mod -= 2
        if is_offshore(wdir):
            mod += 1
        gust_tag = f"g{int(gust)}" if gust and gust > wind + 5 else ""
        parts.append(f"{int(wind)}km/h {compass(wdir)}" + (f" {gust_tag}" if gust_tag else ""))

    if spot["exp"] == "bay":
        parts.append("sheltered")
    else:
        swell = ss.get("swell_wave_height") or ss.get("wave_height")
        if swell is not None:
            if swell > SWELL_BAD:
                mod    -= 5
                unsafe  = True
            elif swell > SWELL_OK:
                mod -= 2
            parts.append(f"{swell:.1f}m")

    return mod, " | ".join(parts) or "no data", unsafe


# ═══════════════════════════════════════════════════════════════ ranking

def find_best(today, solunar_days, tides_by_ref, wind_spots, swell_spots, top=5):
    """
    Score every spot × day × hour, pick best window per spot per day,
    return top-N across the whole forecast.
    """
    candidates = []

    for d in range(DAYS):
        date = today + dt.timedelta(days=d)
        sol  = solunar_days[d]

        for si, spot in enumerate(SPOTS):
            ref       = TIDE_REF_MAP[spot["exp"]]
            ref_tides = tides_by_ref.get(ref, [])
            day_tides = [(t, k) for (t, k) in ref_tides if t.date() == date]
            wind_h    = wind_spots[si]
            swell_h   = swell_spots[si]

            best = None
            for hour in range(DAY_START, DAY_END + 1):
                bs, reasons = base_score(hour, date, sol, day_tides)
                hk = dt.datetime.combine(date, dt.time(hour)).strftime("%Y-%m-%dT%H:00")
                mod, cond, unsafe = spot_modifier(spot, hk, wind_h, swell_h)
                total = bs + mod
                if best is None or total > best["score"]:
                    best = {
                        "spot":      spot["name"],
                        "date":      date,
                        "hour":      hour,
                        "score":     total,
                        "reasons":   reasons,
                        "cond":      cond,
                        "unsafe":    unsafe,
                    }

            if best and best["score"] >= 3:
                candidates.append(best)

    candidates.sort(key=lambda w: w["score"], reverse=True)
    return candidates[:top]


# ═══════════════════════════════════════════════════════════════ formatting

def format_message(combos, solunar_days):
    lines = ["🎣 *SEQ Fishing — next 3 days*"]
    moon = solunar_days[0].get("moonPhase", "")
    if moon:
        lines.append(f"🌙 {moon}")
    lines.append("")

    if not combos:
        lines.append("No standout windows — conditions marginal everywhere.")
        return "\n".join(lines)

    for i, w in enumerate(combos, 1):
        t_start = f"{w['hour']:02d}:00"
        t_end   = f"{min(w['hour'] + 2, 23):02d}:00"
        day     = w["date"].strftime("%a %-d %b")
        flag    = " ⚠️ HIGH SWELL" if w["unsafe"] else ""
        why     = ", ".join(w["reasons"]) if w["reasons"] else "good combo"

        lines.append(f"*{i}. {w['spot']}* — {day} {t_start}–{t_end}{flag}")
        lines.append(f"   {w['cond']}  ({why})")

    return "\n".join(lines)


# ═══════════════════════════════════════════════════════════════ delivery

def send_whatsapp(message):
    api_key = os.environ.get("CALLMEBOT_API_KEY", "")
    if not api_key:
        print("CALLMEBOT_API_KEY not set — printing message only:\n")
        print(message)
        return

    params = urlencode({
        "phone":  CALLMEBOT_PHONE,
        "text":   message,
        "apikey": api_key,
    })
    url = f"https://api.callmebot.com/whatsapp.php?{params}"
    with urlopen(Request(url), timeout=30) as r:
        print("WhatsApp sent:", r.read().decode()[:200])


# ═══════════════════════════════════════════════════════════════ main

def main():
    today     = dt.datetime.now(TZ).date()
    start     = dt.datetime(today.year, today.month, today.day, 0, 0, tzinfo=TZ)
    end       = start + dt.timedelta(days=DAYS)
    start_ts  = int(start.timestamp())
    end_ts    = int(end.timestamp())

    print(f"Fetching forecast for {today} (+{DAYS} days)...")
    wind_raw    = fetch_wind()
    swell_raw   = fetch_swell()
    tide_raw    = fetch_tides(start_ts, end_ts)
    sol_days    = [fetch_solunar(today + dt.timedelta(days=d)) for d in range(DAYS)]

    wind_spots  = parse_hourly(wind_raw,  ["wind_speed_10m","wind_direction_10m","wind_gusts_10m"])
    swell_spots = parse_hourly(swell_raw, ["swell_wave_height","wave_height"])
    tides_by_ref = {
        ref: parse_tide_extremes(tide_raw[ref])
        for ref in tide_raw
    }

    combos  = find_best(today, sol_days, tides_by_ref, wind_spots, swell_spots)
    message = format_message(combos, sol_days)

    print("\n--- Message ---")
    print(message)
    print("--- Sending ---")
    send_whatsapp(message)


if __name__ == "__main__":
    main()
