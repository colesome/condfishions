"""Open-Meteo weather + marine fetchers (free, no key, non-commercial use)."""
from __future__ import annotations

import datetime as dt
import time
from typing import Iterable

import pandas as pd
import requests

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
MARINE_URL = "https://marine-api.open-meteo.com/v1/marine"

WEATHER_VARS = ["temperature_2m", "precipitation", "pressure_msl", "cloud_cover",
                "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m"]
MARINE_VARS = ["wave_height", "swell_wave_height", "swell_wave_period",
               "swell_wave_direction", "sea_surface_temperature", "sea_level_height_msl"]

BATCH = 20  # locations per request
TIMEOUT = (10, 45)  # seconds: connect, read
BACKOFF = (5, 15, 30)  # waits between attempts → 4 attempts per request
CACHE_BUCKET = "raw"
CACHE_MAX_AGE_H = 36  # older than this and a cached forecast is no longer worth scoring


def _get(url: str, params: dict) -> list[dict]:
    last = None
    for attempt in range(len(BACKOFF) + 1):
        try:
            r = requests.get(url, params=params, timeout=TIMEOUT)
            r.raise_for_status()
            data = r.json()
            return data if isinstance(data, list) else [data]
        except (requests.RequestException, ValueError) as e:
            last = e
            if attempt < len(BACKOFF):
                time.sleep(BACKOFF[attempt])
    raise RuntimeError(f"Open-Meteo request failed: {last}")


def _fetch(url: str, points: list[tuple[float, float]], hourly: list[str],
           past_days: int, forecast_days: int) -> list[dict]:
    out: list[dict] = []
    for i in range(0, len(points), BATCH):
        chunk = points[i:i + BATCH]
        params = {
            "latitude": ",".join(f"{p[0]:.4f}" for p in chunk),
            "longitude": ",".join(f"{p[1]:.4f}" for p in chunk),
            "hourly": ",".join(hourly),
            "timezone": "Australia/Brisbane",
            "past_days": past_days,
            "forecast_days": forecast_days,
        }
        if url == FORECAST_URL:
            params["wind_speed_unit"] = "kmh"
        out.extend(_get(url, params))
    return out


def to_frame(payload: dict) -> pd.DataFrame:
    h = payload.get("hourly", {})
    df = pd.DataFrame(h)
    if df.empty:
        return df
    df["time"] = pd.to_datetime(df["time"]).dt.tz_localize("Australia/Brisbane")
    return df.set_index("time")


def _save_cache(store, kind: str, data: dict, now: dt.datetime) -> None:
    try:
        store.upload_gz(CACHE_BUCKET, f"latest/{kind}.json.gz", {"fetched_at": now.isoformat(), "data": data})
    except Exception as e:  # the cache is a safety net; never let it break a good run
        print(f"warn: could not save {kind} cache ({e})")


def _load_cache(store, kind: str, now: dt.datetime) -> tuple[dict, float] | None:
    """Last successful payload and its age in hours, or None if missing / too old."""
    try:
        obj = store.download_gz(CACHE_BUCKET, f"latest/{kind}.json.gz")
        age_h = (now - dt.datetime.fromisoformat(obj["fetched_at"])).total_seconds() / 3600
        data = obj["data"]
    except Exception:
        return None
    if not data or not 0 <= age_h <= CACHE_MAX_AGE_H:
        return None
    return data, age_h


def fetch_all(spots: Iterable, forecast_days: int = 7, store=None) -> dict:
    """Returns {"weather": {spot_id: payload}, "marine": {spot_id: payload}, "notes": [...]}.

    Open-Meteo's free API has outages where requests hang. With a `store`, every good
    fetch is cached, and when a live fetch fails the last good payload (up to
    CACHE_MAX_AGE_H old) is scored instead — a few-hours-old forecast beats no update.
    `notes` says when that happened.
    """
    spots = list(spots)
    now = dt.datetime.now(dt.timezone.utc)
    notes: list[str] = []
    w_pts = sorted({(round(s.lat, 2), round(s.lon, 2)) for s in spots})
    m_pts = sorted({tuple(round(x, 2) for x in s.marine_point) for s in spots if not s.fresh})

    def live_weather() -> dict:
        w_raw = dict(zip(w_pts, _fetch(FORECAST_URL, w_pts, WEATHER_VARS, 3, forecast_days)))
        return {s.id: w_raw[(round(s.lat, 2), round(s.lon, 2))] for s in spots}

    def live_marine(variables: list[str]) -> dict:
        m_raw = dict(zip(m_pts, _fetch(MARINE_URL, m_pts, variables, 2, forecast_days)))
        return {s.id: m_raw[tuple(round(x, 2) for x in s.marine_point)] for s in spots if not s.fresh}

    def cached(kind: str, err: Exception) -> dict | None:
        hit = _load_cache(store, kind, now) if store is not None else None
        if hit is None:
            return None
        notes.append(f"{kind} forecast is {hit[1]:.0f} h old: Open-Meteo did not respond ({str(err)[:80]})")
        print(f"warn: {notes[-1]}")
        return hit[0]

    try:
        weather = live_weather()
        if store is not None:
            _save_cache(store, "weather", weather, now)
    except RuntimeError as e:
        weather = cached("weather", e)
        if weather is None:
            raise

    marine: dict = {}
    if m_pts:
        try:
            marine = live_marine(MARINE_VARS)
            if store is not None:
                _save_cache(store, "marine", marine, now)
        except RuntimeError as e:
            marine = cached("marine", e)
            if marine is None:  # degrade gracefully: no tides beats no forecast
                print(f"warn: marine fetch failed ({e}); retrying without sea level")
                marine = live_marine([v for v in MARINE_VARS if v != "sea_level_height_msl"])
                notes.append("no tide data this run: marine model sea level unavailable")
    return {"weather": weather, "marine": marine, "notes": notes}
