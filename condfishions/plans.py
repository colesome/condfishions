"""Booked slots: re-rate each one every run and flag changes for the worse.

A booked slot is a fixed spot and time. Every scoring run rates exactly those hours again
from the fresh forecast (the same way the app's window rating is made) and compares it with
what the app showed at booking. Worse changes are saved on the booking for the app to show,
and pushed to the phone when they are new or more serious than anything already sent.
"""
from __future__ import annotations

import pandas as pd

from .config import Config, Spot
from .scoring import _conditions, regulation_flags, score_hour, spot_rating, window_weather

BANDS = [(75, "Tight Lines"), (65, "Pretty Good"), (55, "Worth a Crack"), (45, "Average"), (0, "Wouldn't Bother")]
COMFORT_RANK = {"pleasant": 0, "breezy": 1, "windy": 2, "wet": 2, "wet_windy": 3}
COMFORT_LABEL = {"pleasant": "pleasant", "breezy": "breezy", "windy": "windy", "wet": "wet", "wet_windy": "wet and windy"}


def band(score: float) -> tuple[int, str]:
    for i, (cut, name) in enumerate(BANDS):
        if score >= cut:
            return i, name
    return len(BANDS) - 1, BANDS[-1][1]


def rate_period(cfg: Config, spot: Spot, feats: pd.DataFrame, start: pd.Timestamp,
                end: pd.Timestamp) -> dict | None:
    """Spot rating for the hours [start, end): mean over hours of the mean over open species.

    Returns None when the forecast doesn't cover those hours.
    """
    hours = feats[(feats.index >= start.floor("h")) & (feats.index < end)]
    if hours.empty:
        return None
    sids = list(spot.species)
    per_hour, worst, safety_text = [], "ok", None
    for t, row in hours.iterrows():
        scores = []
        for sid in sids:
            h = score_hour(spot, cfg.species[sid], row)
            if h.safety == "no_go":
                worst = "no_go"
            elif h.safety == "caution" and worst == "ok":
                worst = "caution"
            safety_text = safety_text or h.safety_text
            if not any(r.action == "closed" for r in regulation_flags(cfg, spot, sid, t.date())):
                scores.append(h.score)
        per_hour.append(spot_rating(scores))
    score = round(sum(per_hour) / len(per_hour), 1)
    mid = hours.iloc[len(hours) // 2]
    return {"score": 0.0 if worst == "no_go" else score, "safety": worst, "safety_text": safety_text,
            "conditions": {**_conditions(mid), **window_weather(spot, hours)}}


def _num(c: dict, k: str) -> float | None:
    v = c.get(k)
    try:
        return None if v is None else float(v)
    except (TypeError, ValueError):
        return None


def assess(booked_score: float | None, booked_safety: str | None, booked: dict,
           score: float, safety: str, safety_text: str | None, now: dict) -> list[dict]:
    """Changes for the worse since booking: [{kind, severity (1 notable, 2 serious), text}]."""
    out: list[dict] = []
    if booked_score is not None:
        drop = float(booked_score) - score
        b0, n0 = band(float(booked_score))
        b1, n1 = band(score)
        if drop >= 8:
            out.append({"kind": "score", "severity": 2 if (drop >= 15 or b1 - b0 >= 2) else 1,
                        "text": f"Rating down {round(float(booked_score))} → {round(score)}"
                                + (f" ({n0} → {n1})" if b1 != b0 else "")})
    order = {"ok": 0, "caution": 1, "no_go": 2}
    if order.get(safety, 0) > order.get(booked_safety or "ok", 0):
        out.append({"kind": "safety", "severity": 2 if safety == "no_go" else 1,
                    "text": ("Unsafe now: " if safety == "no_go" else "Caution: ") + (safety_text or "swell or gusts up")})
    c0, c1 = booked.get("comfort"), now.get("comfort")
    if c1 in COMFORT_RANK and COMFORT_RANK[c1] - COMFORT_RANK.get(c0, 0) >= 2:
        out.append({"kind": "comfort", "severity": 2 if COMFORT_RANK[c1] == 3 else 1,
                    "text": f"Now {COMFORT_LABEL[c1]}" + (f" (was {COMFORT_LABEL[c0]})" if c0 in COMFORT_LABEL else "")})
    w0, w1 = _num(booked, "win_wind_kmh"), _num(now, "win_wind_kmh")
    if w1 is not None and (w0 is None or w1 - w0 >= 10) and w1 >= 18:
        side = f" {now.get('win_wind_dir') or ''} {now.get('win_wind_side') or ''}".rstrip()
        out.append({"kind": "wind", "severity": 1,
                    "text": f"Wind {round(w1)} km/h{side}" + (f" (was {round(w0)})" if w0 is not None else "")})
    g0, g1 = _num(booked, "win_gust_kmh"), _num(now, "win_gust_kmh")
    if g1 is not None and g1 >= 45 and (g0 is None or g0 < 45):
        out.append({"kind": "gust", "severity": 1, "text": f"Gusts to {round(g1)} km/h"})
    r0, r1 = _num(booked, "win_rain_mm") or 0.0, _num(now, "win_rain_mm") or 0.0
    if r1 >= 2 and r0 < 2:
        out.append({"kind": "rain", "severity": 2 if r1 >= 10 else 1, "text": f"Rain now forecast: {r1:g} mm"})
    w0h, w1h = _num(booked, "wave_h"), _num(now, "wave_h")
    if w0h is not None and w1h is not None and w1h - w0h >= 0.5:
        out.append({"kind": "sea", "severity": 1, "text": f"Waves up {w0h:g} → {w1h:g} m"})
    return out


def should_alert(changes: list[dict], alert_level: int, alerted_kinds: list[str]) -> bool:
    """Push only when it is worse than anything already sent: higher severity or a new kind."""
    if not changes:
        return False
    sev = max(c["severity"] for c in changes)
    new_kinds = {c["kind"] for c in changes} - set(alerted_kinds or [])
    return sev > alert_level or bool(new_kinds)


def check_plans(cfg: Config, store, feats_by_spot: dict[str, pd.DataFrame], now: pd.Timestamp,
                send=None) -> list[str]:
    """Re-rate upcoming bookings, save what changed, and push when it got worse. Returns notes."""
    notes: list[str] = []
    try:
        plans = store.select("planned_trips", {"select": "*", "status": "eq.planned", "order": "block_start"})
    except RuntimeError as e:  # table arrives with migration 0010
        return [f"booked slots not checked: {str(e)[:100]}"]
    for p in plans:
        start = pd.Timestamp(p["block_start"]).tz_convert(now.tz)
        end = start + pd.Timedelta(hours=int(p.get("block_hours") or 3))
        if end <= now:
            store.update("planned_trips", {"id": f"eq.{p['id']}"}, {"status": "past"})
            continue
        try:
            spot = cfg.spot(p["spot_id"])
        except StopIteration:
            continue
        feats = feats_by_spot.get(spot.id)
        if feats is None:
            continue
        r = rate_period(cfg, spot, feats, max(start, now.floor("h")), end)
        if r is None:  # beyond the forecast
            continue
        changes = assess(p.get("score_booked"), p.get("safety_booked"), p.get("conditions_booked") or {},
                         r["score"], r["safety"], r["safety_text"], r["conditions"])
        patch = {"score_now": r["score"], "safety_now": r["safety"], "safety_text_now": r["safety_text"],
                 "conditions_now": r["conditions"], "checked_at": now.isoformat(), "changes": changes}
        if should_alert(changes, int(p.get("alert_level") or 0), p.get("alerted_kinds") or []):
            title = f"⚠️ {spot.name}: conditions have changed"
            when = start.strftime("%a %-d %b %-I%p").replace("AM", "am").replace("PM", "pm")
            body = f"{when} · " + " · ".join(c["text"] for c in sorted(changes, key=lambda c: -c["severity"])[:3])
            sent = send(store, title, body, f"./?tab=trips&plan={p['id']}", tag=f"plan-{p['id']}") if send else 0
            patch.update({"alert_level": max(c["severity"] for c in changes),
                          "alerted_kinds": sorted({c["kind"] for c in changes} | set(p.get("alerted_kinds") or [])),
                          "alerted_at": now.isoformat(), "seen_at": None})
            notes.append(f"booked slot {spot.id} {start:%a %H:%M}: {len(changes)} change(s), pushed to {sent} device(s)")
        store.update("planned_trips", {"id": f"eq.{p['id']}"}, patch)
    return notes

