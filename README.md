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

## What's here

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

## Phone app (`web/`)

An installable web app (PWA) hosted free on GitHub Pages. You add it to your iPhone home
screen and it opens full-screen like any other app. Only your login can see data.

- **Fish:** spots ranked by their best 3-hour window, with the date and time, how far away, the
  species likely there and why. One ranking: conditions first, with closer spots winning a close
  call. Saltwater by default, Freshwater toggle.
- **Spot page:** a 7-day strip of 3-hour scores. Tap a block for each species' score, chance and
  reasons, plus wind, sea, tide, water temp and rain. Directions link.
- **Location:** if "Use my current location" fails on iPhone, allow it under Settings → Privacy &
  Security → Location Services → Safari Websites → *While Using the App*.
- **Map:** spots coloured by score; out-of-range spots greyed. **＋ Add a spot** lets you tap a
  location and describe it (type, which way you cast, exposure, species). Scored from the next run.
- **Places:** change home and travel range (30 min – 7 h), save places (Home, Holiday…),
  search a town, save where you are, or **Use my current location** while travelling.
  **Refresh now** triggers a scoring run straight away.
- Works offline with your last results (handy on Moreton or Straddie).

## Setup (one-off, about 20 minutes)

1. **Supabase:** create a free project. In the SQL editor run
   `0001_init.sql`, `0002_places_user_spots.sql` and `0003_spot_windows.sql` from `supabase/migrations/`, in that order.
   Create your user under *Authentication → Users*, then **turn off sign-ups**.
2. **GitHub secrets** (*Settings → Secrets and variables → Actions*):
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_KEY` — service-role key, scoring job only. Never put it in the app.
   - `SUPABASE_ANON_KEY` — public anon key for the app (safe with row-level security).
3. **GitHub Pages:** *Settings → Pages → Source: GitHub Actions*.
4. Merge to `main`. *Deploy phone app* publishes to `https://<you>.github.io/condfishions/`.
   Run *Score fishing conditions* once by hand (tick *archive*).
5. **iPhone:** open the URL in Safari → Share → **Add to Home Screen** → open it from the
   icon and sign in.
6. *(Optional) "Refresh now" button:* run `supabase/migrations/0004_refresh_button.sql` in the
   SQL editor. Then create a GitHub fine-grained token (*Settings → Developer settings →
   Fine-grained tokens*; only this repo; permission *Actions: Read and write*) and store it by
   running `select vault.create_secret('<your token>', 'github_token');` in the SQL editor.

The scheduled scoring runs four times a day, which also keeps the free Supabase project from
pausing.

## Local use

```bash
pip install -r requirements.txt
python -m condfishions.spots                         # spots within range of home
python -m condfishions.spots --at -27.32,153.08 --max 60
python -m condfishions.run --print                   # live (needs internet); writes ./out if no Supabase env
python tests/make_fixture.py && python -m condfishions.run \
    --fixture tests/fixtures/sample_payload.json --now 2026-07-08T04:00 --print   # offline
python -m pytest -q

# app with demo data (no Supabase needed)
python web/scripts/make_demo.py      # after the offline run above
cd web && npm install && npm run dev
```

## Roadmap

| Phase | Delivers |
|---|---|
| 0 ✅ | Scoring engine, spot catalogue, schema, scheduled job |
| 1 ✅ | Phone app: suggestions, spot pages, map, editable home/range/places, add-your-own spots |
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
