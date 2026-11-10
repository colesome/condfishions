"""Sun, moon and solunar calculations — computed locally with ephem, no API."""
from __future__ import annotations

import datetime as dt
import math
from functools import lru_cache
from zoneinfo import ZoneInfo

import ephem

TZ = ZoneInfo("Australia/Brisbane")
SYNODIC_DAYS = 29.530588


def _obs(lat: float, lon: float, when_utc: dt.datetime) -> ephem.Observer:
    o = ephem.Observer()
    o.lat, o.lon = str(lat), str(lon)
    o.elev, o.pressure = 0, 0
    o.horizon = "-0:34"
    o.date = when_utc.strftime("%Y/%m/%d %H:%M:%S")
    return o


def _to_local(edate) -> dt.datetime:
    return ephem.Date(edate).datetime().replace(tzinfo=dt.timezone.utc).astimezone(TZ)


@lru_cache(maxsize=4096)
def sun_times(lat: float, lon: float, date: dt.date) -> tuple[dt.datetime, dt.datetime]:
    """(sunrise, sunset) local for the given local date. Coordinates rounded by caller."""
    start = dt.datetime.combine(date, dt.time(0), TZ).astimezone(dt.timezone.utc)
    o = _obs(lat, lon, start)
    rise = _to_local(o.next_rising(ephem.Sun()))
    o.date = start.strftime("%Y/%m/%d %H:%M:%S")
    sset = _to_local(o.next_setting(ephem.Sun()))
    return rise, sset


def light_period(when: dt.datetime, lat: float, lon: float) -> str:
    """dawn / day / dusk / night. Dawn & dusk = 75 min either side of sunrise/sunset."""
    rise, sset = sun_times(round(lat, 2), round(lon, 2), when.astimezone(TZ).date())
    win = dt.timedelta(minutes=75)
    if abs(when - rise) <= win:
        return "dawn"
    if abs(when - sset) <= win:
        return "dusk"
    return "day" if rise < when < sset else "night"


@lru_cache(maxsize=4096)
def moon_age_days(when_hour: dt.datetime) -> float:
    """Days since last new moon."""
    utc = when_hour.astimezone(dt.timezone.utc)
    d = ephem.Date(utc.strftime("%Y/%m/%d %H:%M:%S"))
    return float(d - ephem.previous_new_moon(d))


def moon_phase_name(age: float) -> str:
    frac = age / SYNODIC_DAYS
    names = ["New", "Waxing crescent", "First quarter", "Waxing gibbous",
             "Full", "Waning gibbous", "Last quarter", "Waning crescent"]
    return names[int((frac * 8) + 0.5) % 8]


def springness(age: float) -> float:
    """-1 (neap) .. +1 (spring). Spring tides lag new/full moon by ~1.5 days."""
    return math.cos(4 * math.pi * (age - 1.5) / SYNODIC_DAYS)


@lru_cache(maxsize=1024)
def solunar_windows(lat: float, lon: float, date: dt.date) -> list[tuple[dt.datetime, dt.datetime, str]]:
    """Major (moon over/underfoot ±60 min) and minor (moonrise/set ±45 min) windows."""
    start = dt.datetime.combine(date, dt.time(0), TZ).astimezone(dt.timezone.utc)
    out = []
    for fn, kind, half in (("next_transit", "major", 60), ("next_antitransit", "major", 60),
                           ("next_rising", "minor", 45), ("next_setting", "minor", 45)):
        o = _obs(lat, lon, start)
        try:
            t = _to_local(getattr(o, fn)(ephem.Moon()))
        except (ephem.AlwaysUpError, ephem.NeverUpError):
            continue
        if t.date() == date:
            out.append((t - dt.timedelta(minutes=half), t + dt.timedelta(minutes=half), kind))
    return out


def solunar_strength(when: dt.datetime, lat: float, lon: float) -> float:
    best = 0.0
    for a, b, kind in solunar_windows(round(lat, 1), round(lon, 1), when.astimezone(TZ).date()):
        if a <= when <= b:
            best = max(best, 1.0 if kind == "major" else 0.5)
    return best
