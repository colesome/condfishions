"""List spots within travel range of home (or any location).

  python -m condfishions.spots                         # uses config/home.yaml
  python -m condfishions.spots --at -27.30,153.05 --max 90
"""
from __future__ import annotations

import argparse

from .config import load_config, spots_in_range


def main(argv=None) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--at", help="lat,lon (default: home.yaml)")
    ap.add_argument("--max", type=int, help="max travel minutes (default: home.yaml)")
    a = ap.parse_args(argv)
    cfg = load_config()
    lat = lon = None
    if a.at:
        lat, lon = (float(x) for x in a.at.split(","))
    res = spots_in_range(cfg, lat, lon, a.max)
    print(f"{len(res)} of {len(cfg.spots)} spots in range")
    for s, t in res:
        print(f"  {t:4d} min  {s.name:<45} {s.type:<11} {', '.join(s.species)}")


if __name__ == "__main__":
    main()
