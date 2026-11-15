"""Daily forecast check: how close was the forecast the app scored on to what was measured?

Runs once a day with the archive. Three independent comparisons, each saved as one row per
station in `forecast_checks` (migration 0009) with the paired values, so the learning layer
can later correct for systematic errors:

  wind  yesterday's archived forecast at a spot vs Bureau of Meteorology station observations
  wave  yesterday's archived wave height and water temperature vs Queensland Government buoys
  tide  today's modelled tide turns (plus the spot's tide_offset_min) vs BOM tide predictions

Each source is fetched separately and a failure only skips that source.
"""
from __future__ import annotations

import csv
import datetime as dt
import io
import math
import re

import pandas as pd
import requests

from .astro import TZ
from .config import Config

UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/126.0 Safari/537.36 condfishions-forecast-check"}
BOM_OBS_URL = "https://www.bom.gov.au/fwo/IDQ60901/IDQ60901.{wmo}.json"
BOM_TIDE_URL = ("https://www.bom.gov.au/australia/tides/print.php?aac={aac}&type=tide&date={date:%d-%m-%Y}"
                "&region=QLD&tz=Australia/Brisbane&tz_js=AEST&days=1")
WAVE_URL = "https://apps.des.qld.gov.au/data-sets/waves/wave-7dayopdata.csv"

# (station name, BOM station number, spot the forecast is taken from)
WIND_STATIONS = [
    ("Inner Beacon", 94590, "shorncliffe_pier"),
    ("Brisbane Airport", 94578, "nudgee_beach"),
    ("Cape Moreton", 94594, "cape_moreton"),
    ("Gold Coast Seaway", 94580, "gc_seaway"),
    ("Coolangatta", 94592, "snapper_rocks"),
    ("Sunshine Coast Airport", 94569, "maroochy_river_mouth"),
]
# (buoy name starts with, spot)
WAVE_BUOYS = [
    ("Gold Coast", "gc_seaway"),
    ("Tweed Heads", "tweed_river_walls"),
    ("North Moreton Bay", "north_point_moreton"),
    ("Mooloolaba", "point_cartwright"),
    ("Caloundra", "moffat_headland"),
    ("Brisbane", "point_lookout"),
]
# (station name, BOM tide code, spot)
TIDE_STATIONS = [
    ("Brisbane Bar", "QLD_TP003", "shorncliffe_pier"),
    ("Gold Coast Seaway", "QLD_TP011", "gc_seaway"),
]
COMPASS16 = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]


def _num(x) -> float | None:
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(v) or v <= -99 else v


def _mean(xs) -> float | None:
    xs = [x for x in xs if x is not None and not math.isnan(x)]
    return sum(xs) / len(xs) if xs else None


def circ_mean(degs) -> float | None:
    degs = [d for d in degs if d is not None and not math.isnan(d)]
    if not degs:
        return None
    s = sum(math.sin(math.radians(d)) for d in degs)
    c = sum(math.cos(math.radians(d)) for d in degs)
    return math.degrees(math.atan2(s, c)) % 360


def circ_diff(a: float, b: float) -> float:
    """Smallest signed angle a - b, in degrees."""
    return (a - b + 180) % 360 - 180


def _stats(pairs: list[tuple[float, float]]) -> dict | None:
    """pairs of (forecast, observed) -> bias (forecast minus observed) and mean absolute error."""
    if not pairs:
        return None
    d = [f - o for f, o in pairs]
    return {"n": len(d), "bias": round(sum(d) / len(d), 2), "mae": round(sum(abs(x) for x in d) / len(d), 2)}


# ── parsers (pure functions; tested offline) ─────────────────────────────────

def parse_bom_obs(payload: dict) -> pd.DataFrame:
    """BOM station JSON -> frame indexed by local time: wind_kmh, gust_kmh, wind_dir (deg), pressure."""
    rows = []
    for o in payload["observations"]["data"]:
        t = pd.Timestamp(dt.datetime.strptime(o["local_date_time_full"], "%Y%m%d%H%M%S"), tz=TZ)
        d = o.get("wind_dir")
        rows.append({"time": t, "wind_kmh": _num(o.get("wind_spd_kmh")), "gust_kmh": _num(o.get("gust_kmh")),
                     "wind_dir": COMPASS16.index(d) * 22.5 if d in COMPASS16 else None,
                     "pressure": _num(o.get("press_msl"))})
    return pd.DataFrame(rows).set_index("time").sort_index()


def parse_wave_csv(text: str) -> dict[str, pd.DataFrame]:
    """Queensland wave-buoy CSV -> {site: frame indexed by local time with wave_h, sst}."""
    lines = text.splitlines()
    start = next(i for i, ln in enumerate(lines) if ln.startswith("Site"))
    out: dict[str, list] = {}
    for r in csv.DictReader(io.StringIO("\n".join(lines[start:])), skipinitialspace=True):
        try:
            t = pd.Timestamp(r["DateTime"].strip().replace(" ", "T"), tz=TZ)
        except (ValueError, KeyError, AttributeError):
            continue
        out.setdefault(r["Site"].strip(), []).append({"time": t, "wave_h": _num(r.get("Hs")), "sst": _num(r.get("SST"))})
    return {k: pd.DataFrame(v).set_index("time").sort_index() for k, v in out.items()}


_TIDE_RE = re.compile(r'data-time-local="([^"]+)"\s+class="localtime (low|high)-tide">.*?'
                      r'class="height (?:low|high)-tide">\s*([\d.]+)\s*m', re.S)


def parse_bom_tides(html: str) -> list[tuple[pd.Timestamp, str, float]]:
    return [(pd.Timestamp(t).tz_convert(TZ), kind, float(h)) for t, kind, h in _TIDE_RE.findall(html)]


# ── comparisons ───────────────────────────────────────────────────────────────

def _block_obs(obs: pd.DataFrame, start: pd.Timestamp, hours: int = 3) -> pd.DataFrame:
    return obs[(obs.index >= start) & (obs.index < start + pd.Timedelta(hours=hours))]


def compare_wind(blocks: list[dict], obs: pd.DataFrame) -> tuple[dict, list[dict]]:
    """Archived 3-hour forecast blocks vs station observations averaged over the same hours."""
    pairs = []
    for b in blocks:
        start = pd.Timestamp(b["block_start"])
        o = _block_obs(obs, start)
        if len(o) < 3 or b.get("wind_kmh") is None or _mean(o["wind_kmh"].tolist()) is None:
            continue
        pairs.append({
            "t": start.isoformat(),
            "f_wind": b.get("wind_kmh"), "o_wind": _mean(o["wind_kmh"].tolist()),
            "f_gust": b.get("gust_kmh"), "o_gust": _num(o["gust_kmh"].max()),
            "f_dir": b.get("wind_dir"), "o_dir": circ_mean(o["wind_dir"].tolist()),
        })
    dirs = [abs(circ_diff(p["f_dir"], p["o_dir"])) for p in pairs
            if p["f_dir"] is not None and p["o_dir"] is not None and p["o_wind"] >= 8]
    summary = {
        "wind_kmh": _stats([(p["f_wind"], p["o_wind"]) for p in pairs]),
        "gust_kmh": _stats([(p["f_gust"], p["o_gust"]) for p in pairs if p["f_gust"] is not None and p["o_gust"] is not None]),
        "dir_mae_deg": round(sum(dirs) / len(dirs), 0) if dirs else None,
    }
    return summary, pairs


def compare_wave(blocks: list[dict], buoy: pd.DataFrame) -> tuple[dict, list[dict]]:
    pairs = []
    for b in blocks:
        start = pd.Timestamp(b["block_start"])
        o = _block_obs(buoy, start)
        if o.empty or b.get("wave_h") is None:
            continue
        pairs.append({"t": start.isoformat(), "f_wave": b.get("wave_h"), "o_wave": _mean(o["wave_h"].tolist()),
                      "f_sst": b.get("sst"), "o_sst": _mean(o["sst"].tolist())})
    summary = {
        "wave_h": _stats([(p["f_wave"], p["o_wave"]) for p in pairs if p["o_wave"] is not None]),
        "sst": _stats([(p["f_sst"], p["o_sst"]) for p in pairs if p["f_sst"] is not None and p["o_sst"] is not None]),
    }
    return summary, pairs


def compare_tides(model: list[tuple[pd.Timestamp, str, float]], offset_min: int,
                  real: list[tuple[pd.Timestamp, str, float]]) -> tuple[dict, list[dict]]:
    """Minutes the app's tide turns (model + offset) differ from BOM's. Positive = app is late."""
    shift = pd.Timedelta(minutes=offset_min)
    pairs = []
    for rt, kind, rh in real:
        cands = [(abs((mt + shift) - rt), mt + shift) for mt, mk, _ in model if mk == kind]
        if not cands:
            continue
        gap, mt = min(cands)
        if gap <= pd.Timedelta(hours=3):
            pairs.append({"kind": kind, "bom": rt.isoformat(), "app": mt.isoformat(), "bom_height": rh,
                          "diff_min": round((mt - rt).total_seconds() / 60)})
    d = [p["diff_min"] for p in pairs]
    summary = {"n": len(d), "offset_min": offset_min,
               "mean_diff_min": round(sum(d) / len(d)) if d else None,
               "mae_min": round(sum(abs(x) for x in d) / len(d)) if d else None}
    return summary, pairs


# ── orchestration ─────────────────────────────────────────────────────────────

def _http(url: str) -> requests.Response:
    r = requests.get(url, headers=UA, timeout=(10, 40))
    r.raise_for_status()
    return r


def run_checks(cfg: Config, store, feats_by_spot: dict[str, pd.DataFrame], now: pd.Timestamp) -> tuple[list[dict], list[str]]:
    """Returns (rows for forecast_checks, notes about sources that could not be checked)."""
    rows: list[dict] = []
    notes: list[str] = []
    yesterday = (now - pd.Timedelta(days=1)).date()
    spot_ids = {s for _, _, s in WIND_STATIONS} | {s for _, s in WAVE_BUOYS}
    archive = {}
    try:
        got = store.select("forecast_archive", {"run_date": f"eq.{yesterday.isoformat()}",
                                                "spot_id": f"in.({','.join(sorted(spot_ids))})",
                                                "select": "spot_id,blocks"})
        archive = {r["spot_id"]: r["blocks"] for r in got}
    except Exception as e:
        notes.append(f"forecast check: no archived forecast for {yesterday} ({str(e)[:80]})")

    def add(kind, station, spot, date, summary, pairs):
        rows.append({"check_date": date.isoformat(), "kind": kind, "station": station, "spot_id": spot,
                     "n": len(pairs), "summary": summary, "pairs": pairs})

    for name, wmo, spot in WIND_STATIONS:
        if spot not in archive:
            continue
        try:
            obs = parse_bom_obs(_http(BOM_OBS_URL.format(wmo=wmo)).json())
            summary, pairs = compare_wind(archive[spot], obs)
            if pairs:
                add("wind", name, spot, yesterday, summary, pairs)
        except Exception as e:
            notes.append(f"forecast check: wind at {name} skipped ({str(e)[:80]})")

    if any(spot in archive for _, spot in WAVE_BUOYS):
        try:
            buoys = parse_wave_csv(_http(WAVE_URL).text)
            for prefix, spot in WAVE_BUOYS:
                site = next((k for k in buoys if k.startswith(prefix)), None)
                if site is None or spot not in archive:
                    continue
                summary, pairs = compare_wave(archive[spot], buoys[site])
                if pairs:
                    add("wave", site, spot, yesterday, summary, pairs)
        except Exception as e:
            notes.append(f"forecast check: wave buoys skipped ({str(e)[:80]})")

    for name, aac, spot_id in TIDE_STATIONS:
        f = feats_by_spot.get(spot_id)
        if f is None or not f.attrs.get("tide_extremes"):
            continue
        try:
            real = parse_bom_tides(_http(BOM_TIDE_URL.format(aac=aac, date=now.date())).text)
            model = [(pd.Timestamp(t), k, h) for t, k, h in f.attrs["tide_extremes"]]
            summary, pairs = compare_tides(model, cfg.spot(spot_id).tide_offset_min, real)
            if pairs:
                add("tide", name, spot_id, now.date(), summary, pairs)
        except Exception as e:
            notes.append(f"forecast check: tides at {name} skipped ({str(e)[:80]})")
    return rows, notes
