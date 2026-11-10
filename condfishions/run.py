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
from .config import load_config, spots_in_range
from .features import FEATURE_VERSION, build_features
from .fetch import fetch_all
from .scoring import MODEL_VERSION, score_spot
from .store import Store


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
        "species": s.species, "verified": s.verified,
    } for s in cfg.spots]


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
            mid = g.iloc[len(g) // 2]
            blocks.append({"block_start": start.isoformat(), **{k: (None if pd.isna(v) else v) for k, v in num.items()},
                           "tide_phase": mid.get("tide_phase"), "light": mid.get("light")})
        rows.append({"run_date": today.isoformat(), "spot_id": sid, "run_id": run_id,
                     "feature_version": FEATURE_VERSION, "blocks": blocks,
                     "tide_extremes": f.attrs.get("tide_extremes", [])})
    return rows


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
    now = pd.Timestamp(args.now).tz_localize(TZ) if args.now else pd.Timestamp.now(tz=TZ)
    run_id = now.strftime("%Y%m%dT%H%M")

    if args.fixture:
        with open(args.fixture, encoding="utf-8") as f:
            raw = json.load(f)
    else:
        raw = fetch_all(cfg.spots, forecast_days=args.days)

    feats_by_spot, rows, problems = {}, [], []
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

    store.upsert("spots", _spot_rows(cfg), on_conflict="id")
    store.upsert("species", _species_rows(cfg), on_conflict="id")
    store.upsert("forecast_scores", rows, on_conflict="spot_id,species_id,block_start")
    store.delete_before("forecast_scores", "block_start", (now - pd.Timedelta(hours=6)).isoformat())
    store.insert("runs", [{"run_id": run_id, "created_at": now.isoformat(), "model_version": MODEL_VERSION,
                           "feature_version": FEATURE_VERSION, "git_sha": _git_sha(),
                           "n_scores": len(rows), "problems": problems, "archived": args.archive}])
    if args.archive:
        store.upsert("forecast_archive", _archive_rows(run_id, now.date(), feats_by_spot),
                     on_conflict="run_date,spot_id")
        store.upload_gz("raw", f"{now:%Y/%m/%d}/{run_id}.json.gz", raw)

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
