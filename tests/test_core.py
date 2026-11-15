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
def cfg_fresh():
    return load_config(freshwater=True)


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
            "spanish_mackerel", "sharks"} <= set(cfg.species)
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
    assert f_sst(sm, 25)[0] == 0        # ideal water is the norm: no bonus
    assert -1 < f_sst(sm, 22.5)[0] < 0


def test_regulations(cfg, cfg_fresh):
    fingal = cfg.spot("fingal_head")
    snapper = cfg.spot("snapper_rocks")
    feb = dt.date(2027, 2, 10)
    assert any(r.action == "closed" for r in regulation_flags(cfg, snapper, "spanish_mackerel", feb))
    assert not regulation_flags(cfg, fingal, "spanish_mackerel", feb)  # QLD rule, NSW spot
    assert any(r.action == "permit" for r in regulation_flags(cfg_fresh, cfg_fresh.spot("somerset_dam"), "bass", feb))


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


def test_dam_spot_has_no_tide_or_marine(cfg_fresh, payload):
    now = pd.Timestamp("2026-07-08T04:00", tz=TZ)
    spot = cfg_fresh.spot("somerset_dam")
    feats = build_features(spot, payload["weather"][spot.id], None, now)
    rows = score_spot(cfg_fresh, spot, feats)
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


def test_store_output_is_strict_json(cfg_fresh, payload, tmp_path, monkeypatch):
    from condfishions.store import dumps
    now = pd.Timestamp("2026-07-08T04:00", tz=TZ)
    spot = cfg_fresh.spot("somerset_dam")  # no tide -> NaN-prone columns
    rows = score_spot(cfg_fresh, spot, build_features(spot, payload["weather"][spot.id], None, now))
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


# ── fetch: Open-Meteo outage falls back to the last good payload ──────────────

class _MemStore:
    def __init__(self):
        self.objs = {}

    def upload_gz(self, bucket, path, obj):
        self.objs[(bucket, path)] = json.loads(json.dumps(obj))

    def download_gz(self, bucket, path):
        return self.objs[(bucket, path)]


def _fake_get(fail_host=None):
    def get(url, params):
        if fail_host and fail_host in url:
            raise RuntimeError("Open-Meteo request failed: Read timed out.")
        n = len(params["latitude"].split(","))
        return [{"hourly": {"time": [], "src": url}} for _ in range(n)]
    return get


def test_fetch_uses_cache_when_weather_api_is_down(monkeypatch):
    from condfishions import fetch
    cfg, store = load_config(), _MemStore()
    monkeypatch.setattr(fetch, "_get", _fake_get())
    live = fetch.fetch_all(cfg.spots, store=store)
    assert live["notes"] == [] and len(live["weather"]) == len(cfg.spots)

    monkeypatch.setattr(fetch, "_get", _fake_get(fail_host="api.open-meteo.com/v1/forecast"))
    out = fetch.fetch_all(cfg.spots, store=store)
    assert out["weather"] == live["weather"]          # served from cache
    assert out["marine"] == live["marine"]            # marine still live
    assert len(out["notes"]) == 1 and "weather forecast is 0 h old" in out["notes"][0]


def test_fetch_fails_when_cache_missing_or_stale(monkeypatch):
    import datetime as dt
    from condfishions import fetch
    cfg, store = load_config(), _MemStore()
    monkeypatch.setattr(fetch, "_get", _fake_get(fail_host="api.open-meteo.com/v1/forecast"))
    with pytest.raises(RuntimeError):
        fetch.fetch_all(cfg.spots, store=store)       # nothing cached yet
    old = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=fetch.CACHE_MAX_AGE_H + 1)).isoformat()
    store.upload_gz("raw", "latest/weather.json.gz", {"fetched_at": old, "data": {"x": {}}})
    with pytest.raises(RuntimeError):
        fetch.fetch_all(cfg.spots, store=store)       # too old to trust


# ── v3: freshwater off, centred factors, one sliding window per part of the day ──

def test_freshwater_is_switched_off(cfg, cfg_fresh):
    assert not any(s.fresh for s in cfg.spots) and "bass" not in cfg.species
    assert not any("bass" in r.species for r in cfg.regulations)
    assert any(s.fresh for s in cfg_fresh.spots) and "bass" in cfg_fresh.species


def test_light_tide_and_season_are_centred(cfg):
    from condfishions.config import LIGHT_PERIODS, TIDE_PHASES
    from condfishions.scoring import LIGHT_HOURS, f_light, f_season, f_tide
    spot = cfg.spot("shorncliffe_pier")
    for sp in cfg.species.values():
        light = sum(f_light(sp, k)[0] * LIGHT_HOURS[k] for k in LIGHT_PERIODS)
        tide = sum(f_tide(sp, spot, ph)[0] for ph in TIDE_PHASES)
        season = sum(f_season(sp, pd.Timestamp(2026, m, 15))[0] for m in range(1, 13))
        assert abs(light) < 1e-9 and abs(tide) < 1e-9 and abs(season) < 1e-9, sp.id


def test_one_window_per_part_of_day(cfg, payload):
    from condfishions.scoring import PARTS, part_of
    now = pd.Timestamp("2026-07-08T04:00", tz=TZ)
    spot = cfg.spot("shorncliffe_pier")
    feats = build_features(spot, payload["weather"][spot.id], payload["marine"][spot.id], now)
    rows = score_spot(cfg, spot, feats)
    starts = sorted({r["block_start"] for r in rows})
    # every species shares the same windows, so the app can group them
    assert all(sum(r["block_start"] == s for r in rows) == len(spot.species) for s in starts)
    seen = set()
    for s in starts:
        t = pd.Timestamp(s)
        day, part = part_of(t)
        assert (day, part) not in seen
        seen.add((day, part))
        lo, hi = next((a, b) for name, a, b in PARTS if name == part)
        hours = next(r["block_hours"] for r in rows if r["block_start"] == s)
        start_h = t.hour + (24 if t.hour < 4 else 0)
        assert lo <= start_h and start_h + hours <= hi and 1 <= hours <= 3
    assert len([1 for d, p in seen if d == dt.date(2026, 7, 9)]) == 4   # a full day has all four parts
    assert not all(pd.Timestamp(s).hour % 3 == 0 for s in starts)      # not stuck on a 3-hour grid


def test_window_is_the_best_three_hours_of_its_part(cfg, payload):
    from condfishions.scoring import part_of, spot_rating
    now = pd.Timestamp("2026-07-08T04:00", tz=TZ)
    spot = cfg.spot("shorncliffe_pier")
    feats = build_features(spot, payload["weather"][spot.id], payload["marine"][spot.id], now)
    rows = score_spot(cfg, spot, feats)
    hourly = {t: spot_rating([score_hour(spot, cfg.species[s], feats.loc[t]).score for s in spot.species])
              for t in feats.index}
    for start in sorted({r["block_start"] for r in rows})[4:12]:
        t0 = pd.Timestamp(start)
        chosen = sum(hourly[t0 + pd.Timedelta(hours=k)] for k in range(3))
        for t in feats.index:
            trio = [t + pd.Timedelta(hours=k) for k in range(3)]
            if all(x in hourly and part_of(x) == part_of(t0) for x in trio):
                assert sum(hourly[x] for x in trio) <= chosen + 1e-6


# ── daily forecast check + archive catch-up ──────────────────────────────────

def test_forecast_check_parsers_and_comparisons():
    from condfishions import verify
    obs = verify.parse_bom_obs({"observations": {"data": [
        {"local_date_time_full": f"202611150{h}{m}00", "wind_dir": "NNE", "wind_spd_kmh": 30 + h, "gust_kmh": 37,
         "press_msl": 1009.4} for h in (6, 7, 8) for m in ("00", "30")] + [
        {"local_date_time_full": "20261115090000", "wind_dir": "CALM", "wind_spd_kmh": 0, "gust_kmh": None, "press_msl": None}]}})
    assert len(obs) == 7 and obs["wind_dir"].iloc[0] == 22.5 and pd.isna(obs["wind_dir"].iloc[-1])
    summary, pairs = verify.compare_wind(
        [{"block_start": "2026-11-15T06:00:00+10:00", "wind_kmh": 25.0, "gust_kmh": 40.0, "wind_dir": 10.0},
         {"block_start": "2026-11-15T12:00:00+10:00", "wind_kmh": 20.0, "gust_kmh": 30.0, "wind_dir": 10.0}], obs)
    assert len(pairs) == 1                                   # the midday block has no observations
    assert summary["wind_kmh"] == {"n": 1, "bias": -12.0, "mae": 12.0}   # forecast 25 vs measured 37
    assert summary["gust_kmh"]["bias"] == 3.0 and summary["dir_mae_deg"] == 12

    csv_text = ("Wave Data provided @ 12:30hrs on 15-11-2026\n"
                "Site, SiteNumber, Seconds, DateTime, Latitude, Longitude, Hs, Hmax, Tp, Tz, SST, Direction, Current Speed, Current Direction\n"
                "Gold Coast Mk4,52,1,2026-11-15T06:00:00,-27.97,153.44,0.600,1.1,11.1,4.5,20.90,94.2,-99.90,-99.90\n"
                "Gold Coast Mk4,52,2,2026-11-15T06:30:00,-27.97,153.44,0.700,1.2,11.1,4.5,-99.90,94.2,-99.90,-99.90\n")
    buoys = verify.parse_wave_csv(csv_text)
    summary, pairs = verify.compare_wave([{"block_start": "2026-11-15T06:00:00+10:00", "wave_h": 0.58, "sst": 23.1}],
                                         buoys["Gold Coast Mk4"])
    assert summary["wave_h"]["bias"] == -0.07 and summary["sst"]["bias"] == 2.2

    html = ('<th rowspan="2" class="instance low-tide">Low</th> <td data-time-utc="2026-11-13T19:31:00Z" '
            'data-time-local="2026-11-14T05:31:00+10:00" class="localtime low-tide">5:31 am</td> </tr> <tr> '
            '<td class="height low-tide">0.56 m</td> </tr> <tr> <th rowspan="2" class="instance high-tide">High</th> '
            '<td data-time-utc="2026-11-14T02:19:00Z" data-time-local="2026-11-14T12:19:00+10:00" '
            'class="localtime high-tide">12:19 pm</td> </tr> <tr> <td class="height high-tide">2.21 m</td>')
    real = verify.parse_bom_tides(html)
    assert [(k, h) for _, k, h in real] == [("low", 0.56), ("high", 2.21)]
    model = [(pd.Timestamp("2026-11-14T04:15", tz=TZ), "low", -0.3), (pd.Timestamp("2026-11-14T11:10", tz=TZ), "high", 1.0)]
    summary, _ = verify.compare_tides(model, 0, real)
    assert summary["mean_diff_min"] == -72                   # model alone: 72 min early
    assert abs(verify.compare_tides(model, 75, real)[0]["mean_diff_min"]) <= 3   # with the bay offset

    assert verify.circ_mean([350, 10]) in (0.0, 360.0) or abs(verify.circ_mean([350, 10])) < 1e-6


def test_archive_catches_up_when_the_morning_run_failed():
    from condfishions.run import _archive_due

    class S:
        enabled = True

        def __init__(self, done):
            self.done, self.params = done, None

        def select(self, table, params):
            self.params = params
            return self.done

    midday = pd.Timestamp("2026-11-15T10:47", tz=TZ)
    s = S([])
    assert _archive_due(s, midday) is True                    # nothing archived today -> catch up
    assert s.params["created_at"] == "gte.2026-11-15T00:00:00+10:00" and s.params["archived"] == "eq.true"
    assert _archive_due(S([{"run_id": "20261115T0447"}]), midday) is False
    assert _archive_due(S([]), pd.Timestamp("2026-11-15T00:47", tz=TZ)) is False   # before the daily run is due


def test_window_weather_is_shown_but_never_scored(cfg, payload):
    from condfishions.scoring import window_weather
    idx = pd.date_range("2026-11-15 06:00", periods=3, freq="h", tz=TZ)
    def hours(speed, direction, gust, rain):
        return pd.DataFrame({"wind_kmh": speed, "wind_dir": direction, "gust_kmh": gust, "rain_mm": rain}, index=idx)
    pier = cfg.spot("shorncliffe_pier")      # faces east, shelter 0.6
    rock = cfg.spot("point_lookout")         # open ocean, faces north-east
    assert window_weather(pier, hours(8, 90, 12, 0))["comfort"] == "pleasant"
    assert window_weather(rock, hours(18, 60, 26, 0))["comfort"] == "breezy"
    assert window_weather(pier, hours(18, 60, 26, 0))["comfort"] == "pleasant"   # same wind, sheltered spot
    assert window_weather(rock, hours(32, 60, 40, 0))["comfort"] == "windy"
    assert window_weather(pier, hours(10, 90, 50, 0))["comfort"] == "windy"      # gusts alone
    assert window_weather(pier, hours(8, 90, 12, 1.0))["comfort"] == "wet"       # 3 mm over the window
    w = window_weather(rock, hours(32, [350, 10, 0], 40, 2.0))
    assert w["comfort"] == "wet_windy" and w["win_wind_dir"] == "N" and w["win_wind_kmh"] == 32

    # every row carries it, and identical conditions with different comfort keep the same rating
    now = pd.Timestamp("2026-07-08T04:00", tz=TZ)
    feats = build_features(pier, payload["weather"][pier.id], payload["marine"][pier.id], now)
    rows = score_spot(cfg, pier, feats)
    assert all(r["conditions"].get("comfort") for r in rows)
    wet = feats.copy(); wet["rain_mm"] = 5.0
    assert [r["score"] for r in score_spot(cfg, pier, wet)] == [r["score"] for r in rows]
