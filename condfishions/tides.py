"""Tide extremes and phases from an hourly sea-level series.

Phase 0 source: Open-Meteo marine `sea_level_height_msl` (modelled, includes tides).
It is coarse inside Moreton Bay, so each spot has `tide_offset_min` to calibrate
against MSQ gauges (Phase 1 adds the MSQ predicted/observed series directly).
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass

import numpy as np
import pandas as pd

SLACK = dt.timedelta(minutes=45)


@dataclass
class Extreme:
    time: pd.Timestamp
    kind: str  # "high" | "low"
    height: float


def find_extremes(series: pd.Series, min_sep_h: float = 3.0, min_range_m: float = 0.08) -> list[Extreme]:
    s = series.dropna()
    if len(s) < 5:
        return []
    t = s.index
    y = s.to_numpy(dtype=float)
    out: list[Extreme] = []
    for i in range(1, len(y) - 1):
        is_hi = y[i] >= y[i - 1] and y[i] > y[i + 1]
        is_lo = y[i] <= y[i - 1] and y[i] < y[i + 1]
        if not (is_hi or is_lo):
            continue
        # parabolic refinement of the turning point (hourly samples)
        denom = y[i - 1] - 2 * y[i] + y[i + 1]
        off = 0.5 * (y[i - 1] - y[i + 1]) / denom if denom else 0.0
        off = float(np.clip(off, -0.5, 0.5))
        h = y[i] - 0.25 * (y[i - 1] - y[i + 1]) * off
        step = (t[i + 1] - t[i])
        out.append(Extreme(t[i] + off * step, "high" if is_hi else "low", float(h)))

    # drop wiggles: alternate kinds, enforce separation and minimum range
    cleaned: list[Extreme] = []
    for e in out:
        if cleaned and cleaned[-1].kind == e.kind:
            keep_new = (e.height > cleaned[-1].height) if e.kind == "high" else (e.height < cleaned[-1].height)
            if keep_new:
                cleaned[-1] = e
            continue
        if cleaned and (abs(e.height - cleaned[-1].height) < min_range_m
                        or (e.time - cleaned[-1].time) < pd.Timedelta(hours=min_sep_h)):
            continue
        cleaned.append(e)
    return cleaned


def phase_at(when: pd.Timestamp, extremes: list[Extreme], offset_min: int = 0) -> tuple[str | None, float | None]:
    """Return (phase, cycle_range_m) at `when`. Phase is one of config.TIDE_PHASES."""
    if not extremes:
        return None, None
    shift = pd.Timedelta(minutes=offset_min)
    times = [e.time + shift for e in extremes]
    prev = next_ = None
    for i, tt in enumerate(times):
        if tt <= when:
            prev = i
        elif next_ is None:
            next_ = i
    if prev is None or next_ is None:
        return None, None
    e0, e1 = extremes[prev], extremes[next_]
    t0, t1 = times[prev], times[next_]
    rng = abs(e1.height - e0.height)
    if when - t0 <= SLACK:
        return f"{e0.kind}_slack", rng
    if t1 - when <= SLACK:
        return f"{e1.kind}_slack", rng
    frac = (when - t0) / (t1 - t0)
    stage = "early" if frac < 1 / 3 else "mid" if frac < 2 / 3 else "late"
    direction = "rising" if e0.kind == "low" else "falling"
    return f"{direction}_{stage}", rng


def describe_phase(phase: str | None) -> str:
    if not phase:
        return "tide unknown"
    return {
        "low_slack": "low tide change", "high_slack": "high tide change",
        "rising_early": "start of the run-in", "rising_mid": "middle of the run-in",
        "rising_late": "top of the run-in", "falling_early": "start of the run-out",
        "falling_mid": "middle of the run-out", "falling_late": "last of the run-out",
    }[phase]
