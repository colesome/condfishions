"""Generate a synthetic Open-Meteo-shaped payload for every spot (offline tests).

Semi-diurnal tide (M2 + S2), diurnal wind cycle, a frontal pressure change and a rain
event — enough structure to exercise every scoring factor.
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from condfishions.config import load_config  # noqa: E402


def make(start: str = "2026-07-08", past_days: int = 3, days: int = 7) -> dict:
    idx = pd.date_range(pd.Timestamp(start) - pd.Timedelta(days=past_days), periods=(past_days + days) * 24, freq="h")
    times = [t.strftime("%Y-%m-%dT%H:%M") for t in idx]
    hrs = [(t - idx[0]).total_seconds() / 3600 for t in idx]
    cfg = load_config()
    weather, marine = {}, {}
    for k, s in enumerate(cfg.spots):
        ph = k * 0.07
        wind = [8 + 7 * math.sin(2 * math.pi * (h % 24 - 9) / 24) + (12 if 100 < h < 130 else 0) for h in hrs]
        wdir = [250 if (h % 24) < 10 else 120 for h in hrs]
        weather[s.id] = {"hourly": {
            "time": times,
            "temperature_2m": [18 + 5 * math.sin(2 * math.pi * (h % 24 - 9) / 24) for h in hrs],
            "precipitation": [6.0 if 30 < h < 36 else 0.0 for h in hrs],
            "pressure_msl": [1018 - (6 * (h - 90) / 30 if 90 < h < 120 else (6 if h >= 120 else 0)) + (h - 120) * 0.15 * (h > 120) for h in hrs],
            "cloud_cover": [40.0] * len(hrs),
            "wind_speed_10m": wind,
            "wind_direction_10m": wdir,
            "wind_gusts_10m": [w * 1.5 for w in wind],
        }}
        if s.fresh:
            continue
        exposure = 1 - s.shelter
        marine[s.id] = {"hourly": {
            "time": times,
            "wave_height": [exposure * (1.0 + 0.8 * math.sin(2 * math.pi * h / 96)) + 0.1 for h in hrs],
            "swell_wave_height": [exposure * (0.9 + 0.7 * math.sin(2 * math.pi * h / 96)) for h in hrs],
            "swell_wave_period": [9 + 4 * math.sin(2 * math.pi * h / 120) for h in hrs],
            "swell_wave_direction": [110.0] * len(hrs),
            "sea_surface_temperature": [20.5] * len(hrs),
            "sea_level_height_msl": [
                0.8 * math.cos(2 * math.pi * h / 12.42 + ph) + 0.25 * math.cos(2 * math.pi * h / 12.0 + ph)
                for h in hrs],
        }}
    return {"weather": weather, "marine": marine}


if __name__ == "__main__":
    out = Path(__file__).parent / "fixtures" / "sample_payload.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(make()))
    print("wrote", out)
