"""Score all spots for the next N days and persist.

  python -m condfishions.run                 # live fetch, write to Supabase (or ./out)
  python -m condfishions.run --archive       # also archive raw payloads + daily snapshot
  python -m condfishions.run --fixture tests/fixtures/sample_payload.json --print
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import subprocess
import sys

import pandas as pd

from .astro import TZ
from .config import Home, Spot, load_config, spots_in_range
from .features import FEATURE_VERSION, build_features
from .fetch import fetch_all
from .observed import backfill
from .scoring import MODEL_VERSION, score_spot
from .store import Store
from .verify import circ_mean, run_checks


def _git_sha() -> str:
    sha = os.environ.get("GITHUB_SHA")
    if sha:
        return sha[:12]
    try:
        return subprocess.check_output(["git", "rev-parse", "--short=12", "HEAD"], text=True).strip()
    except Exception:
        return "unknown"


def _spot_rows(cfg) -> list[dict]:
    return [{
        "id": s.id, "name": s.name, "region": s.region, "state": s.state, "lat": s.lat, "lon": s.lon,
        "type": s.type, "tidal": s.tidal, "facing": s.facing, "shelter": s.shelter,
        "swell_max": s.swell_max, "extra_min": s.extra_min, "access": s.access, "permit": s.permit,
        "species": s.species, "verified": s.verified, "source": "config",
    } for s in cfg.spots if s.id not in _USER_SPOT_IDS]


_USER_SPOT_IDS: set[str] = set()

_SPOT_FIELDS = {"id", "name", "region", "state", "lat", "lon", "type", "tidal", "facing", "shelter",
                "species", "swell_max", "extra_min", "access", "permit", "verified"}


def merge_user_spots(cfg, rows: list[dict]) -> list[str]:
    """Add app-created spots to the config. Returns warnings."""
    warns, known = [], {s.id for s in cfg.spots}
    for r in rows:
        if r["id"] in known:
            continue
        kw = {k: r.get(k) for k in _SPOT_FIELDS if r.get(k) is not None}
        kw.setdefault("region", "My spots")
        kw.setdefault("state", "")
        if not cfg.freshwater and str(r.get("type", "")).startswith("fresh"):
            continue
        kw["species"] = [x for x in (r.get("species") or []) if x in cfg.species]
        if not kw["species"]:
            warns.append(f"user spot {r['id']}: no known species")
            continue
        try:
            cfg.spots.append(Spot(**kw))
            _USER_SPOT_IDS.add(r["id"])
        except TypeError as e:
            warns.append(f"user spot {r['id']}: {e}")
    return warns


def _species_rows(cfg) -> list[dict]:
    return [{"id": sp.id, "name": sp.name, "base_rate": sp.base_rate, "notes": sp.notes,
             "rules": cfg.raw_species_yaml["species"][sp.id]} for sp in cfg.species.values()]


def _archive_rows(run_id: str, today: dt.date, feats_by_spot: dict[str, pd.DataFrame]) -> list[dict]:
    """One compact row per spot: 3-hourly conditions for the next 24 h, as forecast today."""
    rows = []
    for sid, f in feats_by_spot.items():
        nxt = f.iloc[:24]
        if nxt.empty:
            continue
        blocks = []
        for start, g in nxt.groupby(nxt.index.floor("3h")):
            num = g.select_dtypes("number").mean().round(2).to_dict()
            for col in ("wind_dir", "swell_dir"):  # a plain average of 350° and 10° would say south
                if col in g:
                    m = circ_mean([float(v) for v in g[col].dropna()])
                    num[col] = None if m is None else round(m, 0)
            mid = g.iloc[len(g) // 2]
            blocks.append({"block_start": start.isoformat(), **{k: (None if pd.isna(v) else v) for k, v in num.items()},
                           "tide_phase": mid.get("tide_phase"), "light": mid.get("light")})
        rows.append({"run_date": today.isoformat(), "spot_id": sid, "run_id": run_id,
                     "feature_version": FEATURE_VERSION, "blocks": blocks,
                     "tide_extremes": f.attrs.get("tide_extremes", [])})
    return rows


def _tide_rows(run_id: str, feats_by_spot: dict[str, pd.DataFrame], spots) -> list[dict]:
    rows = []
    tidal = {s.id: s.tide_offset_min for s in spots if s.tidal}
    for sid, f in feats_by_spot.items():
        if sid not in tidal or "sea_level" not in f or f["sea_level"].notna().sum() < 12:
            continue
        sl = f["sea_level"].dropna()
        # Shift the curve by the spot's calibration offset so the Tide tab agrees with the
        # tide phases used for scoring.
        shift = pd.Timedelta(minutes=tidal[sid])
        rows.append({"spot_id": sid, "run_id": run_id,
                     "series": [[(t + shift).isoformat(), round(float(v), 3)] for t, v in sl.items()],
                     "extremes": [[(pd.Timestamp(t) + shift).isoformat(), k, h]
                                  for t, k, h in f.attrs.get("tide_extremes", [])]})
    return rows


def _archive_due(store: Store, now: pd.Timestamp) -> bool:
    """True when no run has archived yet today (local time), so this run should catch up.

    The archive normally rides on the 04:47 run. If that run fails, the day's forecast
    snapshot, trip backfill and forecast check would otherwise be lost.
    """
    if not store.enabled or now.hour < 4:
        return False
    try:
        done = store.select("runs", {"select": "run_id", "archived": "eq.true", "limit": "1",
                                     "created_at": f"gte.{now.normalize().isoformat()}"})
    except RuntimeError as e:
        print(f"warn: could not check today's archive ({e})")
        return False
    return not done


def _remove_freshwater(store: Store) -> list[str]:
    """Freshwater is switched off: clear dams, rivers and bass out of the database.

    Anything you have logged a trip or a catch against is kept (the database refuses the
    delete), and the app hides it.
    """
    notes = []
    for table, params in (("spots", {"type": "like.fresh*", "source": "eq.config"}),
                          ("species", {"id": "eq.bass"})):
        try:
            store.delete_where(table, params)
        except RuntimeError as e:
            if "23503" not in str(e):  # foreign key: still referenced by a trip — expected, keep it
                notes.append(f"freshwater cleanup ({table}): {str(e)[:100]}")
    return notes


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--archive", action="store_true")
    ap.add_argument("--fixture", help="load raw payload JSON instead of calling Open-Meteo")
    ap.add_argument("--print", dest="do_print", action="store_true")
    ap.add_argument("--now", help="override 'now' (ISO, local) — for fixtures/tests")
    args = ap.parse_args(argv)

    cfg = load_config()
    store = Store()
    settings = store.get_settings()
    if settings:  # home/range set from the app wins over home.yaml
        cfg.home = Home(name=settings["home_name"], lat=settings["home_lat"], lon=settings["home_lon"],
                        max_travel_min=settings["max_travel_min"])
    user_warns = merge_user_spots(cfg, store.get_user_spots())
    now = pd.Timestamp(args.now).tz_localize(TZ) if args.now else pd.Timestamp.now(tz=TZ)
    run_id = now.strftime("%Y%m%dT%H%M")

    if args.fixture:
        with open(args.fixture, encoding="utf-8") as f:
            raw = json.load(f)
    else:
        raw = fetch_all(cfg.spots, forecast_days=args.days, store=store)

    feats_by_spot, rows, problems = {}, [], list(user_warns) + list(raw.get("notes", []))
    for spot in cfg.spots:
        w = raw["weather"].get(spot.id)
        if w is None:
            problems.append(f"{spot.id}: no weather")
            continue
        try:
            feats = build_features(spot, w, raw["marine"].get(spot.id), now)
        except Exception as e:  # keep the run alive; report at the end
            problems.append(f"{spot.id}: {e}")
            continue
        if spot.tidal and feats["tide_phase"].isna().all():
            problems.append(f"{spot.id}: no tide signal from marine model")
        feats_by_spot[spot.id] = feats
        for r in score_spot(cfg, spot, feats):
            r["run_id"] = run_id
            rows.append(r)

    archive = args.archive or _archive_due(store, now)
    if archive and not args.archive:
        print("today's archive is missing (the early-morning run failed or was skipped): catching up")

    def save_run(archived: bool) -> None:
        store.upsert("runs", [{"run_id": run_id, "created_at": now.isoformat(), "model_version": MODEL_VERSION,
                               "feature_version": FEATURE_VERSION, "git_sha": _git_sha(),
                               "n_scores": len(rows), "problems": problems, "archived": archived}],
                     on_conflict="run_id")

    store.upsert("spots", _spot_rows(cfg), on_conflict="id")
    store.upsert("species", _species_rows(cfg), on_conflict="id")
    # The run row must exist before scores/archive rows reference it (foreign key). It is only
    # marked archived once the archive below has actually been written.
    save_run(False)
    store.upsert("forecast_scores", rows, on_conflict="spot_id,species_id,block_start")
    # Windows move from run to run, so anything this run didn't write is out of date.
    if rows:  # never wipe the table on a run that scored nothing
        store.delete_where("forecast_scores", {"run_id": f"neq.{run_id}"})
        store.delete_where("forecast_scores", {"run_id": "is.null"})
    if not cfg.freshwater:
        problems.extend(_remove_freshwater(store))
    try:
        store.upsert("tides", _tide_rows(run_id, feats_by_spot, cfg.spots), on_conflict="spot_id")
    except RuntimeError as e:  # tides table arrives with migration 0006
        problems.append(f"tides not saved: {str(e)[:120]}")
    if archive:
        try:
            n = backfill(cfg, store)
            print(f"backfilled measured conditions for {n} trips")
        except Exception as e:  # never let backfill break scoring
            print(f"warn: backfill failed: {e}")
        try:  # compares yesterday's archive with measurements, so it runs before today's is written
            checks, notes = run_checks(cfg, store, feats_by_spot, now)
            store.upsert("forecast_checks", checks, on_conflict="check_date,kind,station")
            print(f"forecast check: {len(checks)} station comparisons saved")
            problems.extend(notes)
        except Exception as e:  # table arrives with migration 0009; never let the check break scoring
            problems.append(f"forecast check not saved: {str(e)[:120]}")
        store.upsert("forecast_archive", _archive_rows(run_id, now.date(), feats_by_spot),
                     on_conflict="run_date,spot_id")
        store.upload_gz("raw", f"{now:%Y/%m/%d}/{run_id}.json.gz", raw)
    save_run(archive)

    print(f"run {run_id}: {len(rows)} scores across {len(feats_by_spot)} spots "
          f"({'supabase' if store.enabled else 'local ./out'})")
    for p in problems:
        print("  warn:", p)
    if args.do_print:
        print_top(cfg, rows, now)
    return 0


def print_top(cfg, rows: list[dict], now: pd.Timestamp, hours: int = 48, n: int = 12) -> None:
    in_range = {s.id: t for s, t in spots_in_range(cfg)}
    horizon = now + pd.Timedelta(hours=hours)
    cand = [r for r in rows if r["spot_id"] in in_range and r["safety"] != "no_go"
            and pd.Timestamp(r["block_start"]) <= horizon]
    best: dict[tuple, dict] = {}
    for r in cand:  # best block per (spot, species)
        k = (r["spot_id"], r["species_id"])
        if k not in best or r["score"] > best[k]["score"]:
            best[k] = r
    picks, per_spot = [], {}
    for r in sorted(best.values(), key=lambda r: -r["score"]):
        if per_spot.get(r["spot_id"], 0) >= 2:
            continue
        per_spot[r["spot_id"]] = per_spot.get(r["spot_id"], 0) + 1
        picks.append(r)
    print(f"\nTop {n} in the next {hours} h within {cfg.home.max_travel_min} min of {cfg.home.name}:")
    for r in picks[:n]:
        t = pd.Timestamp(r["block_start"])
        why = "; ".join(f"{x['text']} ({x['points']:+.0f})" for x in r["reasons"])
        flag = " ⚠" if r["safety"] == "caution" else ""
        print(f"  {r['score']:5.1f}  p={r['p_success']:.2f}  {t:%a %H:%M}  "
              f"{cfg.spot(r['spot_id']).name} · {cfg.species[r['species_id']].name}{flag}"
              f"  [{in_range[r['spot_id']]} min]\n         {why}")


if __name__ == "__main__":
    sys.exit(main())
