"""Overnight backfill: attach measured/analysed conditions to finished trips.

For each trip that ended in the last few days and has no 'archive' observation yet, pull
Open-Meteo's recent-past hourly data at the spot and summarise it over the trip.
"""
from __future__ import annotations

import math

import pandas as pd

from .config import Config
from .fetch import FORECAST_URL, MARINE_URL, MARINE_VARS, WEATHER_VARS, _get, to_frame
from .store import Store


def _circ_mean(deg: pd.Series) -> float | None:
    d = deg.dropna()
    if d.empty:
        return None
    s = sum(math.sin(math.radians(x)) for x in d)
    c = sum(math.cos(math.radians(x)) for x in d)
    return round(math.degrees(math.atan2(s, c)) % 360, 0)


def summarise(weather: pd.DataFrame, marine: pd.DataFrame | None, start: pd.Timestamp,
              end: pd.Timestamp) -> dict:
    w = weather[(weather.index >= start.floor("h")) & (weather.index <= end.ceil("h"))]
    out: dict = {}
    if not w.empty:
        out.update({
            "wind_kmh": round(float(w["wind_speed_10m"].mean()), 1),
            "wind_dir": _circ_mean(w["wind_direction_10m"]),
            "gust_kmh": round(float(w["wind_gusts_10m"].max()), 1),
            "rain_mm": round(float(w["precipitation"].sum()), 1),
            "pressure": round(float(w["pressure_msl"].mean()), 1),
            "air_temp": round(float(w["temperature_2m"].mean()), 1),
            "cloud": round(float(w["cloud_cover"].mean()), 0),
        })
    if marine is not None and not marine.empty:
        m = marine[(marine.index >= start.floor("h")) & (marine.index <= end.ceil("h"))]
        if not m.empty:
            for k, src in (("wave_h", "wave_height"), ("swell_h", "swell_wave_height"),
                           ("swell_period", "swell_wave_period"), ("sst", "sea_surface_temperature")):
                if src in m and m[src].notna().any():
                    out[k] = round(float(m[src].mean()), 2)
    return {k: v for k, v in out.items() if v is not None and not (isinstance(v, float) and math.isnan(v))}


def backfill(cfg: Config, store: Store, days: int = 4) -> int:
    sessions = store.sessions_needing_backfill(days)
    n = 0
    for s in sessions:
        try:
            spot = cfg.spot(s["spot_id"])
        except StopIteration:
            continue
        start = pd.Timestamp(s["start_ts"]).tz_convert("Australia/Brisbane")
        end = pd.Timestamp(s["end_ts"]).tz_convert("Australia/Brisbane")
        base = {"latitude": spot.lat, "longitude": spot.lon, "timezone": "Australia/Brisbane",
                "past_days": days + 1, "forecast_days": 1}
        weather = to_frame(_get(FORECAST_URL, {**base, "hourly": ",".join(WEATHER_VARS),
                                               "wind_speed_unit": "kmh"})[0])
        marine = None
        if not spot.fresh:
            mlat, mlon = spot.marine_point
            try:
                marine = to_frame(_get(MARINE_URL, {**base, "latitude": mlat, "longitude": mlon,
                                                    "hourly": ",".join(MARINE_VARS)})[0])
            except RuntimeError:
                marine = None
        vals = summarise(weather, marine, start, end)
        if vals:
            store.insert("observed_conditions", [{"session_id": s["id"], "source": "archive", "vals": vals}])
            n += 1
    return n
