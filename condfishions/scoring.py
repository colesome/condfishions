"""Transparent rules-based baseline scorer (model_version = baseline_v2).

score = conditions rating = 50 + sum(weight_i * factor_i), clipped 0..100. 50 = average
conditions for that species, regardless of how common the species is. Each factor is in
[-1, 1] (skipped when it doesn't apply). Weather only counts when it changes how fish behave
or makes fishing hard — calm, pleasant weather on its own earns nothing.
p_success (P(catch >= 1) from the rating and the species' base rate) is stored for the
learning layer but not used for ranking.
"""
from __future__ import annotations

import datetime as dt
import math
from dataclasses import dataclass, field

import pandas as pd

from .config import EXPOSED_TYPES, Config, Regulation, Species, Spot
from .tides import describe_phase

MODEL_VERSION = "baseline_v2"
COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]


def compass(deg: float | None) -> str:
    if deg is None or (isinstance(deg, float) and math.isnan(deg)):
        return "?"
    return COMPASS[int((deg % 360) / 45 + 0.5) % 8]


def _ok(x) -> bool:
    return x is not None and not (isinstance(x, float) and math.isnan(x))


def _lerp(x, x0, x1, y0, y1):
    if x1 == x0:
        return y1
    t = min(max((x - x0) / (x1 - x0), 0.0), 1.0)
    return y0 + t * (y1 - y0)


# ── individual factors: each returns (value in [-1,1], reason) or None ─────────

def f_season(sp: Species, when: pd.Timestamp):
    v = sp.season[when.month - 1]
    txt = "peak season" if v >= 0.85 else "off season" if v <= 0.3 else "in season" if v >= 0.6 else "shoulder season"
    return 2 * v - 1, txt


def f_light(sp: Species, period: str):
    if not isinstance(period, str):
        return None
    txt = {"dawn": "dawn", "dusk": "dusk", "night": "night", "day": "middle of the day"}[period]
    return sp.light[period], txt


def f_tide(sp: Species, spot: Spot, phase):
    if sp.tide is None or not spot.tidal or not isinstance(phase, str):
        return None
    return sp.tide[phase], describe_phase(phase)


def f_sst(sp: Species, sst):
    if sp.sst is None or not _ok(sst):
        return None
    a, b, c, d = sp.sst
    if sst < b:
        v = _lerp(sst, a, b, -1, 1)
    elif sst <= c:
        v = 1.0
    else:
        v = _lerp(sst, c, d, 1, -1)
    return v, f"water {sst:.1f}°C"


def f_wind(spot: Spot, speed, direction, gust):
    if not _ok(speed):
        return None
    # Wind only ever subtracts: it can make fishing hard, but calm weather doesn't put fish on.
    if spot.fresh:
        v = 0.0 if speed <= 15 else _lerp(speed, 15, 35, 0.0, -0.7)
        return (v, f"{speed:.0f} km/h {compass(direction)} wind") if v < 0 else None
    exposure = 1 - spot.shelter
    onshore = math.cos(math.radians((direction or 0) - spot.facing)) if _ok(direction) else 0.0
    eff = speed * (0.4 + 0.6 * exposure * max(onshore, 0.0))
    if eff <= 15:
        v = 0.0
    elif eff <= 25:
        v = _lerp(eff, 15, 25, 0.0, -0.7)
    else:
        v = -1.0
    label = "onshore" if onshore > 0.5 else "offshore" if onshore < -0.5 else "cross-shore"
    if _ok(gust) and gust >= 45:
        v = -1.0
    if v >= 0:
        return None
    return v, f"{speed:.0f} km/h {compass(direction)} ({label}) makes it hard"


def f_swell(sp: Species, spot: Spot, hs):
    if spot.fresh or sp.swell_pref == "none" or not _ok(hs) or (1 - spot.shelter) < 0.3:
        return None
    lim = spot.swell_max or 2.5
    r = hs / lim
    if sp.swell_pref == "wash":
        # some whitewater genuinely brings these fish in close (fish behaviour, not comfort)
        v = -0.2 if hs < 0.4 else 0.7 if r < 0.6 else 0.0 if r < 0.85 else -1.0
        txt = f"{hs:.1f} m sea — good wash" if v > 0 else f"{hs:.1f} m sea"
    else:  # calm-water species: rough water hurts, calm water is just normal
        if r < 0.6:
            return None
        v, txt = -0.8, f"{hs:.1f} m sea too rough"
    return v, txt


def f_rain(sp: Species, rain72):
    if not _ok(rain72):
        return None
    r = rain72
    if sp.rain_pref == "likes_fresh":
        v = (-0.2 if r < 5 else 0.3 if r < 20 else 0.8 if r < 100 else 0.2 if r < 200 else -0.6)
    elif sp.rain_pref == "dislikes_fresh":
        v = 0.2 if r < 20 else -0.3 if r < 60 else -0.8
    else:
        v = -0.4 if r > 150 else 0.0
    if abs(v) < 0.05:
        return None
    return v, f"{r:.0f} mm rain in 72 h"


def f_spring(sp: Species, spot: Spot, springness):
    if not spot.tidal or not sp.spring_pref or not _ok(springness):
        return None
    v = springness * sp.spring_pref
    txt = "big spring tides" if springness > 0.5 else "small neap tides" if springness < -0.5 else "mid-size tides"
    return v, txt


def f_pressure(trend):
    if not _ok(trend):
        return None
    if -5 <= trend <= -1:
        v, txt = 0.6, "pressure falling slowly"
    elif trend < -5:
        v, txt = -0.2, "pressure dropping fast"
    elif trend > 4:
        v, txt = -0.7, "pressure rising sharply (post-front)"
    elif trend > 1:
        v, txt = -0.2, "pressure rising"
    else:
        return None
    return v, txt


def f_solunar(strength):
    if not _ok(strength) or strength <= 0:
        return None
    return strength, "major solunar period" if strength >= 1 else "minor solunar period"


# ── safety + regulations ──────────────────────────────────────────────────────

def safety_gate(spot: Spot, hs, period, gust) -> tuple[str, str | None]:
    if spot.type not in EXPOSED_TYPES or spot.swell_max is None:
        return "ok", None
    lim = spot.swell_max * (0.8 if _ok(period) and period >= 12 else 1.0)
    if _ok(hs) and hs >= lim:
        return "no_go", f"UNSAFE: {hs:.1f} m sea (limit {lim:.1f} m)"
    if _ok(gust) and gust >= 60 and spot.type == "rock":
        return "no_go", f"UNSAFE: gusts {gust:.0f} km/h"
    if _ok(hs) and hs >= 0.75 * lim:
        return "caution", f"Caution: {hs:.1f} m sea near the {lim:.1f} m limit"
    return "ok", None


def _in_window(day: dt.date, start: str, end: str) -> bool:
    md = day.strftime("%m-%d")
    return start <= md <= end if start <= end else (md >= start or md <= end)


def regulation_flags(cfg: Config, spot: Spot, species_id: str, day: dt.date) -> list[Regulation]:
    out = []
    for r in cfg.regulations:
        if species_id not in r.species or r.state != spot.state or not _in_window(day, r.start, r.end):
            continue
        applies = {
            "all": True,
            "tidal": spot.tidal,
            "non_impoundment": spot.type != "fresh_dam",
            "permit_SIP": spot.permit == "SIP",
        }.get(r.applies_to, False)
        if applies:
            out.append(r)
    return out


# ── scoring ───────────────────────────────────────────────────────────────────

@dataclass
class HourScore:
    time: pd.Timestamp
    score: float
    safety: str
    contributions: list[tuple[str, float, str]] = field(default_factory=list)  # (factor, points, text)
    safety_text: str | None = None


def score_hour(spot: Spot, sp: Species, row: pd.Series) -> HourScore:
    hs = row.get("wave_h")
    if _ok(row.get("swell_h")):
        hs = max(hs, row["swell_h"]) if _ok(hs) else row["swell_h"]
    factors = {
        "season": f_season(sp, row.name),
        "light": f_light(sp, row["light"]),
        "tide": f_tide(sp, spot, row.get("tide_phase")),
        "sst": f_sst(sp, row.get("sst")),
        "wind": f_wind(spot, row.get("wind_kmh"), row.get("wind_dir"), row.get("gust_kmh")),
        "swell": f_swell(sp, spot, hs),
        "rain": f_rain(sp, row.get("rain_72h")),
        "spring": f_spring(sp, spot, row.get("springness")),
        "pressure": f_pressure(row.get("pressure_trend_24h")),
        "solunar": f_solunar(row.get("solunar")),
    }
    # Normalise by the weight of the factors that actually apply, so a spot isn't
    # rewarded just for having more factors (e.g. tidal vs dam). Points are scaled
    # the same way so the reasons add up to the score.
    applicable = {k: v for k, v in factors.items() if v is not None and sp.weights.get(k, 0)}
    w_total = sum(sp.weights[k] for k in applicable) or 1.0
    scale = 50.0 / w_total
    contribs = []
    total = 50.0
    for name, (v, txt) in applicable.items():
        pts = sp.weights[name] * max(-1.0, min(1.0, v)) * scale
        total += pts
        contribs.append((name, round(pts, 1), txt))
    safety, stxt = safety_gate(spot, hs, row.get("swell_period"), row.get("gust_kmh"))
    score = 0.0 if safety == "no_go" else max(0.0, min(100.0, total))
    return HourScore(row.name, round(score, 1), safety, contribs, stxt)


def p_success(score: float, base_rate: float) -> float:
    """Map a 0–100 score to P(catch >= 1). Score 50 = species base rate."""
    if score <= 0:
        return 0.0
    logit = math.log(base_rate / (1 - base_rate)) + 2.2 * (score - 50) / 50
    return round(1 / (1 + math.exp(-logit)), 3)


def reasons(contribs: list[tuple[str, float, str]], n_pos: int = 3, n_neg: int = 2) -> list[dict]:
    pos = sorted([c for c in contribs if c[1] >= 0.5], key=lambda c: -c[1])[:n_pos]
    neg = sorted([c for c in contribs if c[1] <= -0.5], key=lambda c: c[1])[:n_neg]
    return [{"factor": f, "points": p, "text": t} for f, p, t in pos + neg]


def score_spot(cfg: Config, spot: Spot, feats: pd.DataFrame, block_h: int = 3,
               species_filter: list[str] | None = None) -> list[dict]:
    """Score every species at this spot, aggregated into `block_h`-hour blocks."""
    rows = []
    if feats.empty:
        return rows
    block_key = feats.index.floor(f"{block_h}h")
    for sid in spot.species:
        if species_filter and sid not in species_filter:
            continue
        sp = cfg.species[sid]
        hourly = [score_hour(spot, sp, r) for _, r in feats.iterrows()]
        by_block: dict[pd.Timestamp, list[HourScore]] = {}
        for k, h in zip(block_key, hourly):
            by_block.setdefault(k, []).append(h)
        for start, hrs in by_block.items():
            best = max(hrs, key=lambda h: h.score)
            safety = "no_go" if any(h.safety == "no_go" for h in hrs) else \
                     "caution" if any(h.safety == "caution" for h in hrs) else "ok"
            cond = round(sum(h.score for h in hrs) / len(hrs), 1)
            regs = regulation_flags(cfg, spot, sid, start.date())
            closed = any(r.action == "closed" for r in regs)
            blocked = closed or safety == "no_go"
            p = 0.0 if blocked else p_success(cond, sp.base_rate)
            score = 0.0 if blocked else cond  # conditions rating: what the app shows
            r_best = feats.loc[best.time]
            rows.append({
                "spot_id": spot.id,
                "species_id": sid,
                "block_start": start.isoformat(),
                "block_hours": block_h,
                "best_hour": best.time.isoformat(),
                "score": score,
                "p_success": p,
                "safety": safety,
                "safety_text": next((h.safety_text for h in hrs if h.safety_text), None),
                "reasons": reasons(best.contributions),
                "regulations": [{"id": r.id, "action": r.action, "text": r.text} for r in regs],
                "conditions": {**_conditions(r_best), "cond_score": cond},
                "model_version": MODEL_VERSION,
            })
    return rows


def _conditions(r: pd.Series) -> dict:
    def g(k, nd=1):
        v = r.get(k)
        return round(float(v), nd) if _ok(v) else None
    return {
        "wind_kmh": g("wind_kmh", 0), "wind_dir": compass(r.get("wind_dir")), "gust_kmh": g("gust_kmh", 0),
        "wave_h": g("wave_h"), "swell_h": g("swell_h"), "swell_period": g("swell_period", 0),
        "sst": g("sst"), "air_temp": g("air_temp", 0), "rain_72h": g("rain_72h", 0),
        "pressure": g("pressure", 0),
        "tide_phase": r.get("tide_phase") if isinstance(r.get("tide_phase"), str) else None,
        "light": r.get("light") if isinstance(r.get("light"), str) else None,
        "moon_age": g("moon_age"),
    }
