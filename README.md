# CondFishions

Personal fishing-conditions app for land-based fishing in SEQ and far-northern NSW.
It scores spot × species × 3-hour windows for the next 7 days, explains each score,
and (in later phases) learns from your own session logs.

**Running cost: $0.** GitHub Actions + Supabase free tier + Open-Meteo.

```
GitHub Actions (every 6 h)            Supabase (free)                 Phone app (Phase 1)
fetch Open-Meteo weather + marine ─►  forecast_scores (latest)   ◄──  suggestions, check-in,
compute tide / sun / moon locally     forecast_archive (daily)        catches, photos, skunks
score with config/species.yaml        sessions, catches, photos  ──►  learning layer (Phase 4)
```

## Status — Phase 0 (scoring engine)

- `config/spots.yaml` — 52 land-based spots (Noosa → Brunswick Heads, Moreton/Straddie, bass dams).
  Coordinates are approximate (`verified: false`); fix as you visit them.
- `config/species.yaml` — transparent baseline rules for bream, flathead, tailor, trevally,
  jewfish, kingfish, Spanish mackerel, sharks and Australian bass, plus closed-season / permit flags.
- `config/home.yaml` — home location and max travel minutes. Change it to widen or narrow the range.
- `condfishions/` — fetch → features → score → store.
- `supabase/migrations/0001_init.sql` — full schema, including session logging tables for Phase 2.
- `legacy/condfishions_agent.py` — the old WhatsApp agent, kept for reference.

## How a score works

`score = 50 + Σ factor contributions`, clipped 0–100, normalised by the factors that apply.

| Factor | Source | Example |
|---|---|---|
| Season | species month table | tailor peak Jun–Sep |
| Light | sunrise/sunset (ephem) | dawn/dusk, night for jewfish |
| Tide phase | Open-Meteo sea level → extremes | flathead: last of the run-out |
| Spring/neap | moon age | bigger tides help jewfish |
| Water temp | Open-Meteo marine SST | Spanish mackerel >23 °C |
| Wind | speed × onshore component × spot shelter | 25 km/h onshore at a beach = bad |
| Swell | wave height vs spot limit | tailor like some wash |
| Rain (72 h) | Open-Meteo | jewfish/bass/sharks like a fresh |
| Pressure trend | Open-Meteo | slow fall = slight plus |
| Solunar | moon transit/rise/set | small weight, kept testable |

**Safety gate:** rock, rock wall and beach spots go *no-go* when the sea reaches the spot's
`swell_max` (lowered 20 % for long-period swell ≥12 s) or gusts reach 60 km/h on rocks.
A no-go always scores 0, and no model may override it.

`p_success` maps the score to a chance of catching ≥1 of that species. A score of 50 equals
the species' `base_rate`. Phase 4 recalibrates this from your real sessions.

## Setup (one-off, about 15 minutes)

1. **Supabase:** create a free project, open the SQL editor and run
   `supabase/migrations/0001_init.sql`. Create your user under *Authentication → Users*,
   then **turn off sign-ups**.
2. **GitHub secrets** (*Settings → Secrets → Actions*): `SUPABASE_URL` and
   `SUPABASE_SERVICE_KEY` (service-role key — never put it in the phone app).
3. **Actions:** run *Score fishing conditions* manually once (tick *archive*). After that it
   runs four times a day, which also keeps the free Supabase project from pausing.

## Local use

```bash
pip install -r requirements.txt
python -m condfishions.spots                         # spots within range of home
python -m condfishions.spots --at -27.32,153.08 --max 60
python -m condfishions.run --print                   # live (needs internet); writes ./out if no Supabase env
python tests/make_fixture.py && python -m condfishions.run \
    --fixture tests/fixtures/sample_payload.json --now 2026-07-08T04:00 --print   # offline
python -m pytest -q
```

## Roadmap

| Phase | Delivers |
|---|---|
| 0 ✅ | Scoring engine, spot catalogue, schema, scheduled job |
| 1 | Phone app (installable PWA): suggestions, reasons, safety, map, range setting |
| 2 | Check-in, catch + skunk logging, photos, offline sync, observed-conditions backfill (MSQ gauges) |
| 3 | Push alerts, forecast-vs-actual and baseline-calibration pages |
| 4 | Learning layer (hierarchical recalibration of the baseline), champion/challenger, wildcard picks |

## Data sources

- [Open-Meteo](https://open-meteo.com) forecast + marine APIs (free, non-commercial).
- [MSQ tide open data](https://www.msq.qld.gov.au/tides/open-data) — predicted and observed
  gauges (Phase 1–2, used to calibrate `tide_offset_min` and backfill actual conditions).
- Sun, moon and solunar are computed locally with `ephem`.
- Regulations: QLD DAF closed seasons, NSW DPI bass closure, QLD SIP permits. **Verify them
  each season.**
