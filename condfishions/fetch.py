"""Open-Meteo weather + marine fetchers (free, no key, non-commercial use)."""
from __future__ import annotations

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


def _get(url: str, params: dict, retries: int = 3) -> list[dict]:
    last = None
    for attempt in range(retries):
        try:
            r = requests.get(url, params=params, timeout=60)
            r.raise_for_status()
            data = r.json()
            return data if isinstance(data, list) else [data]
        except (requests.RequestException, ValueError) as e:
            last = e
            time.sleep(5 * (attempt + 1))
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


def fetch_all(spots: Iterable, forecast_days: int = 7) -> dict:
    """Returns {"weather": {spot_id: payload}, "marine": {spot_id: payload}} (raw JSON)."""
    spots = list(spots)
    w_pts = sorted({(round(s.lat, 2), round(s.lon, 2)) for s in spots})
    m_pts = sorted({tuple(round(x, 2) for x in s.marine_point) for s in spots if not s.fresh})

    w_raw = dict(zip(w_pts, _fetch(FORECAST_URL, w_pts, WEATHER_VARS, 3, forecast_days)))
    m_raw = {}
    if m_pts:
        try:
            m_raw = dict(zip(m_pts, _fetch(MARINE_URL, m_pts, MARINE_VARS, 2, forecast_days)))
        except RuntimeError as e:  # degrade gracefully: no tides beats no forecast
            print(f"warn: marine fetch failed ({e}); retrying without sea level")
            reduced = [v for v in MARINE_VARS if v != "sea_level_height_msl"]
            m_raw = dict(zip(m_pts, _fetch(MARINE_URL, m_pts, reduced, 2, forecast_days)))

    weather = {s.id: w_raw[(round(s.lat, 2), round(s.lon, 2))] for s in spots}
    marine = {s.id: m_raw[tuple(round(x, 2) for x in s.marine_point)]
              for s in spots if not s.fresh}
    return {"weather": weather, "marine": marine}
