"""Build web/public/demo/*.json from a local fixture run (for UI work without Supabase).

  python tests/make_fixture.py
  python -m condfishions.run --fixture tests/fixtures/sample_payload.json --now 2026-07-08T04:00
  python web/scripts/make_demo.py
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
src, dst = ROOT / "out", ROOT / "web" / "public" / "demo"
dst.mkdir(parents=True, exist_ok=True)
for name in ("spots", "species", "forecast_scores"):
    rows = json.loads((src / f"{name}.json").read_text())
    if name == "species":
        rows = [{k: r[k] for k in ("id", "name", "base_rate", "notes")} for r in rows]
    (dst / f"{name}.json").write_text(json.dumps(rows, separators=(",", ":")))
    print(name, len(rows))
tides = src / "tides.json"
if tides.exists():
    rows = json.loads(tides.read_text())
    (dst / "tides.json").write_text(json.dumps({r["spot_id"]: {"series": r["series"], "extremes": r["extremes"]} for r in rows}))
    print("tides", len(rows))
