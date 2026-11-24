"""Overnight backfill: attach measured/analysed conditions to finished trips.

For each trip that ended in the last few days and has no 'archive' observation yet, pull
Open-Meteo's recent-past hourly data at the spot and summarise it over the trip.
"""
from __future__ import annotations

import math

import pandas as pd

from .config import Config
from .fetch import FORECAST_URL, MARINE_URL, MARINE_VARS, WEATHER_VARS, _get, to_frame
from .features import build_features
from .plans import rate_period
from .scoring import MODEL_VERSION
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


MAX_PAST_DAYS = 90  # Open-Meteo keeps about three months of recent past at the forecast endpoint


def backfill(cfg: Config, store: Store, days: int = MAX_PAST_DAYS, now: pd.Timestamp | None = None) -> int:
    """Measured conditions and the hindsight rating for finished trips that don't have them yet.

    Covers trips logged after the fact and trips whose times were edited (the app removes the
    old 'archive' observation), as long as the trip is within the last ~3 months.
    """
    now = now or pd.Timestamp.now(tz="Australia/Brisbane")
    sessions = store.sessions_needing_backfill(days)
    n = 0
    for s in sessions:
        try:
            spot = cfg.spot(s["spot_id"])
        except StopIteration:
            continue
        start = pd.Timestamp(s["start_ts"]).tz_convert("Australia/Brisbane")
        end = pd.Timestamp(s["end_ts"]).tz_convert("Australia/Brisbane")
        if end > now or end <= start:
            continue
        past = min(92, int((now - start).total_seconds() // 86400) + 4)  # +3 days for 72 h rain, pressure trend
        base = {"latitude": spot.lat, "longitude": spot.lon, "timezone": "Australia/Brisbane",
                "past_days": past, "forecast_days": 1}
        try:
            wpay = _get(FORECAST_URL, {**base, "hourly": ",".join(WEATHER_VARS), "wind_speed_unit": "kmh"})[0]
            mpay = None
            if not spot.fresh:
                mlat, mlon = spot.marine_point
                try:
                    mpay = _get(MARINE_URL, {**base, "latitude": mlat, "longitude": mlon,
                                             "hourly": ",".join(MARINE_VARS)})[0]
                except RuntimeError:
                    mpay = None
        except RuntimeError as e:
            print(f"warn: backfill {s['id']}: {e}")
            continue
        weather, marine = to_frame(wpay), (to_frame(mpay) if mpay else None)
        vals = summarise(weather, marine, start, end)
        if not vals:
            continue
        rated = rate_trip(cfg, spot, wpay, mpay, start, end)
        if rated:
            vals.update({"score_at_time": rated["score"], "safety_at_time": rated["safety"],
                         "tide_phase": rated["conditions"].get("tide_phase"),
                         "light": rated["conditions"].get("light"), "comfort": rated["conditions"].get("comfort")})
        store.insert("observed_conditions", [{"session_id": s["id"], "source": "archive", "vals": vals}])
        if rated:
            try:
                store.update("sessions", {"id": f"eq.{s['id']}"},
                             {"score_at_time": rated["score"], "score_at_time_version": MODEL_VERSION})
            except RuntimeError as e:  # columns arrive with migration 0010
                print(f"warn: score_at_time not saved ({str(e)[:100]})")
        n += 1
    return n


def rate_trip(cfg: Config, spot, weather_payload: dict, marine_payload: dict | None,
              start: pd.Timestamp, end: pd.Timestamp) -> dict | None:
    """The app's rating for the hours actually fished, from measured (analysed) conditions."""
    try:
        feats = build_features(spot, weather_payload, marine_payload, start)
        return rate_period(cfg, spot, feats, start, max(end, start + pd.Timedelta(hours=1)))
    except Exception as e:  # never let rating break the backfill
        print(f"warn: could not rate trip at {spot.id}: {e}")
        return None
