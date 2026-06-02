# SEQ Fishing Forecast Routine

Daily WhatsApp message with the 5 best spot+window combinations across
13 spots from Fingal Head to Noosa, ranked by solunar bite periods,
dawn/dusk, tide movement, wind, and swell.

**Data sources (all free):**
- Open-Meteo forecast + marine — wind and swell, all spots in one call each
- solunar.org — major/minor bite windows, sunrise/sunset (3 calls/day)
- Stormglass — tide extremes, 2 reference points only (2 calls/day, free tier)
- CallMeBot — free personal WhatsApp delivery

---

## Step 1 — Activate CallMeBot (one-time)

1. Add this number to your WhatsApp contacts: **+34 644 47 95 71**
2. Send it this exact message via WhatsApp:
   `I allow callmebot to send me messages`
3. It will reply with your API key — save it.

---

## Step 2 — Get a Stormglass key

Sign up at https://dashboard.stormglass.io/register — free tier
includes 10 requests/day. This script uses 2/day, so you'll never hit it.

---

## Step 3 — Push to GitHub

Create a repo and push these three files:

```bash
git init && git add fishing.py requirements.txt README.md
git commit -m "fishing routine"
git remote add origin git@github.com:<you>/fishing-routine.git
git push -u origin main
```

---

## Step 4 — Create the Claude Code Routine

Go to https://claude.ai/code/routines → **New routine**

**Name:** `Fishing forecast`

**Prompt:**
```
Run `python fishing.py` from the repo root.
If it exits non-zero, send a WhatsApp via CALLMEBOT_API_KEY to 61477282003:
"Fishing routine failed: <first line of stderr>".
Do not commit or push anything.
```

**Repositories:** select your `fishing-routine` repo

**Environment → click the settings icon → edit:**
- Network access → **Custom**
  - Add allowed domains:
    ```
    api.open-meteo.com
    marine-api.open-meteo.com
    api.solunar.org
    api.stormglass.io
    api.callmebot.com
    ```
  - Tick **"Also include default list of common package managers"**
    (so pip can install tzdata)
- Environment variables:
  - `STORMGLASS_API_KEY` = your token
  - `CALLMEBOT_API_KEY` = your CallMeBot key
- Setup script: `pip install -r requirements.txt`

**Connectors:** remove all (not needed — delivery goes via CallMeBot)

**Trigger → Schedule → Daily** — set your preferred time (e.g. 5:30 AM)

Click **Create**, then **Run now** to test. Open the run transcript
to confirm the WhatsApp went through.

---

## Spots covered

| Spot | Type |
|---|---|
| Fingal Head | Rock — open coast |
| Snapper Rocks | Rock — open coast |
| Burleigh Heads | Rock/headland |
| GC Seaway | Rock walls / estuary |
| Jumpinpin | Bar / estuary |
| Point Lookout (Straddie) | Rock — exposed |
| Manly (Brisbane bay) | Bay — sheltered |
| Redcliffe | Bay — sheltered |
| Bribie (Woorim) | Beach / passage |
| Caloundra | Rock/beach — semi |
| Mooloolaba | Rock/beach |
| Maroochydore | Estuary / beach |
| Noosa NP | Rock/beach — semi |

Bay spots (Manly, Redcliffe) are never penalised for swell — they're sheltered.
Open spots (Fingal through Noosa headlands) get a safety flag if swell > 2.0 m.
Offshore wind (SW–NW) gets a small bonus; onshore (NE–SE) loses points.

---

## Tuning thresholds

Edit the config block at the top of `fishing.py`:

```python
WIND_OK   = 15   # km/h — above this starts penalising
WIND_BAD  = 25   # above this, heavy penalty
SWELL_OK  = 1.0  # m — above this, moderate penalty (open spots)
SWELL_BAD = 2.0  # m — above this, safety flag + heavy penalty
```

To add or change spots, edit the `SPOTS` list. Set `"exp"` to
`"open"`, `"semi"`, or `"bay"` to control swell treatment.
