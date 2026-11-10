import datetime as dt
import json
import math
from pathlib import Path

import pandas as pd
import pytest

from condfishions import astro, tides
from condfishions.config import Spot, load_config, spots_in_range
from condfishions.features import build_features
from condfishions.scoring import (f_sst, f_wind, p_success, regulation_flags, safety_gate,
                                  score_hour, score_spot)

TZ = "Australia/Brisbane"
FIXTURE = Path(__file__).parent / "fixtures" / "sample_payload.json"


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


def _tide_series(hours=72, period=12.42):
    idx = pd.date_range("2026-07-08", periods=hours, freq="h", tz=TZ)
    return pd.Series([math.cos(2 * math.pi * i / period) for i in range(hours)], index=idx)


def test_config_loads_and_validates(cfg):
    assert len(cfg.spots) >= 40
    assert {"bream", "flathead", "tailor", "trevally", "jewfish", "kingfish",
            "spanish_mackerel", "sharks", "bass"} <= set(cfg.species)
    for s in cfg.spots:
        assert -29.5 < s.lat < -26 and 152 < s.lon < 154, s.id


def test_tide_extremes_from_sinusoid():
    ex = tides.find_extremes(_tide_series())
    kinds = [e.kind for e in ex]
    assert all(a != b for a, b in zip(kinds, kinds[1:])), "extremes must alternate"
    highs = [e for e in ex if e.kind == "high"]
    gaps = [(b.time - a.time).total_seconds() / 3600 for a, b in zip(highs, highs[1:])]
    assert all(abs(g - 12.42) < 0.5 for g in gaps)


def test_tide_phases_cover_cycle():
    s = _tide_series()
    ex = tides.find_extremes(s)
    phases = {tides.phase_at(t, ex)[0] for t in s.index[13:60]}
    assert {"falling_late", "low_slack", "rising_mid", "high_slack"} <= phases


def test_travel_filter_expands_with_range(cfg):
    near = spots_in_range(cfg, max_min=45)
    far = spots_in_range(cfg, max_min=200)
    assert 0 < len(near) < len(far)
    assert any(s.id == "shorncliffe_pier" for s, _ in near)
    assert all(s.id != "fingal_head" for s, _ in near)


def test_safety_gate():
    rock = Spot(id="r", name="r", region="", state="QLD", lat=-28, lon=153.5, type="rock", tidal=True,
                facing=90, shelter=0, species=["tailor"], swell_max=1.5)
    assert safety_gate(rock, 2.0, 9, 20)[0] == "no_go"
    assert safety_gate(rock, 1.3, 13, 20)[0] == "no_go"   # long-period swell lowers the limit
    assert safety_gate(rock, 1.2, 9, 20)[0] == "caution"
    assert safety_gate(rock, 0.6, 9, 20)[0] == "ok"


def test_wind_onshore_worse_than_offshore():
    beach = Spot(id="b", name="b", region="", state="QLD", lat=-28, lon=153.5, type="beach", tidal=True,
                 facing=90, shelter=0, species=["tailor"], swell_max=2.5)
    onshore = f_wind(beach, 20, 90, 25)[0]
    assert onshore < 0
    assert f_wind(beach, 20, 270, 25) is None      # offshore breeze: no effect
    assert f_wind(beach, 5, 90, 8) is None         # calm weather earns nothing


def test_rating_is_conditions_not_species_commonness(cfg, payload):
    now = pd.Timestamp("2026-07-08T04:00", tz=TZ)
    spot = cfg.spot("shorncliffe_pier")
    rows = score_spot(cfg, spot, build_features(spot, payload["weather"][spot.id], payload["marine"][spot.id], now))
    for r in rows:
        if r["safety"] != "no_go" and not any(g["action"] == "closed" for g in r["regulations"]):
            assert r["score"] == r["conditions"]["cond_score"]
    # a rare species in the same conditions isn't rated lower just for being rare
    by = {(r["species_id"], r["block_start"]): r for r in rows}
    assert any(by[("jewfish", b)]["score"] > by[("bream", b)]["score"] for (s_, b) in by if s_ == "jewfish")


def test_sst_trapezoid(cfg):
    sm = cfg.species["spanish_mackerel"]
    assert f_sst(sm, 19)[0] == -1
    assert f_sst(sm, 25)[0] == 1
    assert f_sst(sm, 22.5)[0] < 1


def test_regulations(cfg):
    fingal = cfg.spot("fingal_head")
    snapper = cfg.spot("snapper_rocks")
    feb = dt.date(2027, 2, 10)
    assert any(r.action == "closed" for r in regulation_flags(cfg, snapper, "spanish_mackerel", feb))
    assert not regulation_flags(cfg, fingal, "spanish_mackerel", feb)  # QLD rule, NSW spot
    assert any(r.action == "permit" for r in regulation_flags(cfg, cfg.spot("somerset_dam"), "bass", feb))


def test_p_success_monotonic():
    ps = [p_success(s, 0.3) for s in (10, 30, 50, 70, 90)]
    assert ps == sorted(ps)
    assert abs(p_success(50, 0.3) - 0.3) < 1e-3
    assert p_success(0, 0.3) == 0


def test_end_to_end_scores_are_bounded_and_explained(cfg, payload):
    now = pd.Timestamp("2026-07-08T04:00", tz=TZ)
    spot = cfg.spot("point_lookout")
    feats = build_features(spot, payload["weather"][spot.id], payload["marine"][spot.id], now)
    assert feats["tide_phase"].notna().mean() > 0.9
    rows = score_spot(cfg, spot, feats)
    assert rows
    for r in rows:
        assert 0 <= r["score"] <= 100
        assert 0 <= r["p_success"] <= 1
        if r["safety"] == "no_go":
            assert r["score"] == 0
        elif r["score"] > 0:
            assert r["reasons"]


def test_reasons_add_up_to_score(cfg, payload):
    now = pd.Timestamp("2026-07-08T04:00", tz=TZ)
    spot = cfg.spot("shorncliffe_pier")
    feats = build_features(spot, payload["weather"][spot.id], payload["marine"][spot.id], now)
    h = score_hour(spot, cfg.species["flathead"], feats.iloc[5])
    assert abs(50 + sum(c[1] for c in h.contributions) - h.score) < 1.0


def test_dam_spot_has_no_tide_or_marine(cfg, payload):
    now = pd.Timestamp("2026-07-08T04:00", tz=TZ)
    spot = cfg.spot("somerset_dam")
    feats = build_features(spot, payload["weather"][spot.id], None, now)
    rows = score_spot(cfg, spot, feats)
    assert rows and all("tide" not in [x["factor"] for x in r["reasons"]] for r in rows)


def test_light_periods():
    lat, lon = -27.47, 153.02
    rise, sset = astro.sun_times(lat, lon, dt.date(2026, 7, 8))
    assert 6 <= rise.hour <= 7 and 17 <= sset.hour <= 18
    assert astro.light_period(rise, lat, lon) == "dawn"
    assert astro.light_period(rise + dt.timedelta(hours=5), lat, lon) == "day"


def test_user_spots_merge():
    from condfishions.run import merge_user_spots
    c = load_config()
    n = len(c.spots)
    warns = merge_user_spots(c, [
        {"id": "user_byron_wall", "name": "Holiday wall", "lat": -28.64, "lon": 153.62, "type": "rockwall",
         "tidal": True, "facing": 90, "shelter": 0.3, "swell_max": 2.0, "species": ["tailor", "dory"],
         "source": "user"},
        {"id": "user_bad", "name": "x", "lat": -28, "lon": 153, "type": "beach", "tidal": True,
         "facing": 90, "shelter": 0.2, "species": ["dory"]},
    ])
    assert len(c.spots) == n + 1 and c.spot("user_byron_wall").species == ["tailor"]
    assert any("user_bad" in w for w in warns)


def test_store_output_is_strict_json(cfg, payload, tmp_path, monkeypatch):
    from condfishions.store import dumps
    now = pd.Timestamp("2026-07-08T04:00", tz=TZ)
    spot = cfg.spot("somerset_dam")  # no tide -> NaN-prone columns
    rows = score_spot(cfg, spot, build_features(spot, payload["weather"][spot.id], None, now))
    json.loads(dumps(rows))  # raises on NaN
    assert dumps({"x": float("nan")}) == '{"x": null}'


def test_tide_rows_and_backfill_summary(cfg, payload):
    from condfishions.run import _tide_rows
    from condfishions.observed import summarise
    from condfishions.fetch import to_frame
    now = pd.Timestamp("2026-07-08T04:00", tz=TZ)
    spot = cfg.spot("shorncliffe_pier")
    feats = build_features(spot, payload["weather"][spot.id], payload["marine"][spot.id], now)
    rows = _tide_rows("r1", {spot.id: feats}, cfg.spots)
    assert rows and len(rows[0]["series"]) > 100 and rows[0]["extremes"]
    w = to_frame(payload["weather"][spot.id]); m = to_frame(payload["marine"][spot.id])
    v = summarise(w, m, now, now + pd.Timedelta(hours=3))
    assert {"wind_kmh", "wind_dir", "rain_mm", "wave_h", "sst"} <= set(v)
