"""Booked slots (re-rating and change alerts) and the hindsight rating for logged trips."""
import json
from pathlib import Path

import pandas as pd
import pytest

from condfishions.config import load_config
from condfishions.features import build_features
from condfishions.plans import assess, check_plans, rate_period, should_alert
from condfishions.scoring import score_spot

TZ = "Australia/Brisbane"
FIXTURE = Path(__file__).parent / "fixtures" / "sample_payload.json"
NOW = pd.Timestamp("2026-07-08T04:00", tz=TZ)


@pytest.fixture(scope="module")
def cfg():
    return load_config()


@pytest.fixture(scope="module")
def payload():
    if not FIXTURE.exists():
        from tests.make_fixture import make
        FIXTURE.parent.mkdir(exist_ok=True)
        FIXTURE.write_text(json.dumps(make()))
    return json.loads(FIXTURE.read_text())


@pytest.fixture(scope="module")
def feats(cfg, payload):
    spot = cfg.spot("shorncliffe_pier")
    return spot, build_features(spot, payload["weather"][spot.id], payload["marine"][spot.id], NOW)


def test_rate_period_matches_the_window_rating_the_app_shows(cfg, feats):
    spot, f = feats
    rows = score_spot(cfg, spot, f)
    for start in sorted({r["block_start"] for r in rows})[:6]:
        win = [r for r in rows if r["block_start"] == start]
        if any(r["safety"] == "no_go" for r in win):
            continue
        open_rows = [r for r in win if not any(g["action"] == "closed" for g in r["regulations"])]
        shown = sum(r["score"] for r in open_rows) / len(open_rows)
        t = pd.Timestamp(start)
        got = rate_period(cfg, spot, f, t, t + pd.Timedelta(hours=win[0]["block_hours"]))
        assert got is not None and abs(got["score"] - shown) <= 0.2
        assert "comfort" in got["conditions"] and "tide_phase" in got["conditions"]


def test_rate_period_outside_forecast_is_none(cfg, feats):
    spot, f = feats
    far = NOW + pd.Timedelta(days=30)
    assert rate_period(cfg, spot, f, far, far + pd.Timedelta(hours=3)) is None


def test_assess_flags_only_changes_for_the_worse():
    calm = {"comfort": "pleasant", "win_wind_kmh": 8, "win_gust_kmh": 15, "win_rain_mm": 0, "wave_h": 0.4}
    assert assess(70, "ok", calm, 72, "ok", None, dict(calm)) == []           # better: nothing
    assert assess(70, "ok", calm, 64, "ok", None, dict(calm)) == []           # small dip: nothing
    ch = assess(70, "ok", calm, 52, "caution", "Swell 2.1 m", {**calm, "comfort": "windy", "win_wind_kmh": 28,
                                                                "win_wind_dir": "NE", "win_wind_side": "onshore",
                                                                "win_rain_mm": 4, "wave_h": 1.1})
    kinds = {c["kind"]: c for c in ch}
    assert {"score", "safety", "comfort", "wind", "rain", "sea"} <= set(kinds)
    assert kinds["score"]["severity"] == 2 and "Pretty Good" in kinds["score"]["text"]
    assert "28 km/h NE onshore (was 8)" in kinds["wind"]["text"]
    assert assess(70, "ok", calm, 0, "no_go", "Unsafe swell", calm)[-1]["severity"] == 2


def test_alerts_are_not_repeated_unless_it_gets_worse():
    one = [{"kind": "wind", "severity": 1, "text": ""}]
    assert should_alert(one, 0, [])
    assert not should_alert(one, 1, ["wind"])                                  # same news again: quiet
    assert should_alert(one + [{"kind": "rain", "severity": 1, "text": ""}], 1, ["wind"])   # something new
    assert should_alert([{"kind": "wind", "severity": 2, "text": ""}], 1, ["wind"])         # more serious
    assert not should_alert([], 0, [])


class _PlanStore:
    enabled = True

    def __init__(self, plans):
        self.plans = plans
        self.patches = []

    def select(self, table, params):
        assert table == "planned_trips"
        return self.plans

    def update(self, table, params, patch):
        self.patches.append((params["id"].removeprefix("eq."), patch))


def test_check_plans_saves_changes_and_pushes_once(cfg, feats):
    spot, f = feats
    start = (NOW + pd.Timedelta(hours=26)).isoformat()
    plan = {"id": "p1", "spot_id": spot.id, "block_start": start, "block_hours": 3, "score_booked": 99,
            "safety_booked": "ok", "conditions_booked": {"comfort": "pleasant"}, "alert_level": 0, "alerted_kinds": []}
    past = {**plan, "id": "p0", "block_start": (NOW - pd.Timedelta(hours=6)).isoformat()}
    sent = []
    store = _PlanStore([past, plan])
    notes = check_plans(cfg, store, {spot.id: f}, NOW,
                        send=lambda st, title, body, url, tag=None: sent.append((title, body, url)) or 1)
    patches = dict(store.patches)
    assert patches["p0"] == {"status": "past"}
    p = patches["p1"]
    assert p["score_now"] < 99 and any(c["kind"] == "score" for c in p["changes"])
    assert p["alert_level"] == 2 and "score" in p["alerted_kinds"]
    assert len(sent) == 1 and spot.name in sent[0][0] and "plan=p1" in sent[0][2] and notes
    # next run, same news: saved but not pushed again
    store2 = _PlanStore([{**plan, "alert_level": p["alert_level"], "alerted_kinds": p["alerted_kinds"]}])
    check_plans(cfg, store2, {spot.id: f}, NOW, send=lambda *a, **k: sent.append(a) or 1)
    assert len(sent) == 1 and "alert_level" not in store2.patches[0][1]


def test_logged_trip_is_rated_for_the_hours_fished(cfg, payload):
    from condfishions.observed import rate_trip
    spot = cfg.spot("shorncliffe_pier")
    start = NOW + pd.Timedelta(hours=2)
    r = rate_trip(cfg, spot, payload["weather"][spot.id], payload["marine"][spot.id], start, start + pd.Timedelta(hours=3))
    assert r is not None and 0 <= r["score"] <= 100 and r["safety"] in ("ok", "caution", "no_go")
    # a different time gives that time's rating (what "edit times" relies on)
    later = start + pd.Timedelta(hours=12)
    r2 = rate_trip(cfg, spot, payload["weather"][spot.id], payload["marine"][spot.id], later, later + pd.Timedelta(hours=3))
    assert r2 is not None and r2["conditions"]["light"] != r["conditions"]["light"] or r2["score"] != r["score"]
