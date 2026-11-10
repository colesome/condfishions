"""Turn raw Open-Meteo payloads into one hourly feature frame per spot."""
from __future__ import annotations

import pandas as pd

from . import astro, tides
from .config import Spot
from .fetch import to_frame

FEATURE_VERSION = "f1"


def build_features(spot: Spot, weather_payload: dict, marine_payload: dict | None,
                   now: pd.Timestamp) -> pd.DataFrame:
    w = to_frame(weather_payload)
    df = pd.DataFrame(index=w.index)
    df["wind_kmh"] = w.get("wind_speed_10m")
    df["wind_dir"] = w.get("wind_direction_10m")
    df["gust_kmh"] = w.get("wind_gusts_10m")
    df["air_temp"] = w.get("temperature_2m")
    df["cloud"] = w.get("cloud_cover")
    df["pressure"] = w.get("pressure_msl")
    df["pressure_trend_24h"] = df["pressure"] - df["pressure"].shift(24)
    df["rain_72h"] = w.get("precipitation").fillna(0).rolling(72, min_periods=1).sum()

    extremes: list[tides.Extreme] = []
    if marine_payload is not None:
        m = to_frame(marine_payload).reindex(df.index)
        for col, src in (("wave_h", "wave_height"), ("swell_h", "swell_wave_height"),
                         ("swell_period", "swell_wave_period"), ("swell_dir", "swell_wave_direction"),
                         ("sst", "sea_surface_temperature"), ("sea_level", "sea_level_height_msl")):
            df[col] = m.get(src)
        df["sst"] = df["sst"].ffill().bfill()
        if spot.tidal and df["sea_level"].notna().sum() > 12:
            extremes = tides.find_extremes(df["sea_level"])

    df = df[df.index >= now.floor("h")].copy()

    phases, ranges, light, age, spring, sol = [], [], [], [], [], []
    for t in df.index:
        if spot.tidal and extremes:
            p, r = tides.phase_at(t, extremes, spot.tide_offset_min)
        else:
            p, r = None, None
        phases.append(p)
        ranges.append(r)
        light.append(astro.light_period(t.to_pydatetime(), spot.lat, spot.lon))
        a = astro.moon_age_days(t.to_pydatetime().replace(minute=0, second=0, microsecond=0))
        age.append(a)
        spring.append(astro.springness(a))
        sol.append(astro.solunar_strength(t.to_pydatetime(), spot.lat, spot.lon))
    df["tide_phase"] = phases
    df["tide_range"] = ranges
    df["light"] = light
    df["moon_age"] = age
    df["springness"] = spring
    df["solunar"] = sol
    df.attrs["tide_extremes"] = [(e.time.isoformat(), e.kind, round(e.height, 2)) for e in extremes]
    return df
