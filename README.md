# Pit Wall: race engineering console

A browser console for a race engineer: pick the race of the week, see race-time weather, the track, the weekend
schedule and the grid, pick a driver (Verstappen or Hadjar), and get

- a **finish prediction** from two independent models (a Monte Carlo race simulator and a backtested statistical
  model) plus their blend, next to the driver's season so far
- the **three best pre-race strategies**, optimised for expected points, podium chance or win chance
- a **live what-if console**: set the lap, running position, tyre and age, stops made, track status (green / VSC /
  SC / red) and retired cars, press Enter, and get the three best calls for the rest of the race in a few seconds.
  Every what-if stays in a timeline you can restore.

Live site: https://soham0605.github.io/Formula_1/ (static, GitHub Pages; the simulator runs in your browser).

## How it works

| Piece | Where | What |
|---|---|---|
| Event data | `fetch_event.py` → `dashboard/data/` | Calendar, sessions, qualifying grid, track outline + sectors + speed trace, pit loss, SC/VSC rates, team retirement rates, both drivers' seasons, weather snapshot |
| Statistical model | `train_finish_model.py` → `dashboard/data/model/finish_model.json` | Ordered logit P(finish = k) on grid, qualifying gap, team form, racecraft; rolling-origin backtest |
| Simulator | `dashboard/js/engine.js` (Web Workers) | Lap-by-lap Monte Carlo of all 22 cars: tyre wear + cliff, thermal window, fuel, traffic/overtaking, pit stops, SC/VSC/red flag, retirements. Starts from the grid or from any live race state |
| Strategy search | `dashboard/js/strategy.js` | ~1,300 plans screened, refined, final top 3 (with different stop counts preferred when close); common random numbers so plans face identical races |
| UI | `dashboard/index.html`, `style.css`, `js/app.js` | three.js shader background, GSAP motion, Lenis smooth scroll, glass cards, SVG weather/tyre/track graphics |

Weather is fetched live from Open-Meteo in the browser (the bundled snapshot is the fallback).

### Live timing sync (every N laps)
The console's **Live timing** strip rebuilds the real field at the end of any lap from OpenF1 (order and gaps
from line-crossing times, every car's tyre, age and stops, SC/VSC/red status, retirements) and runs the
strategy search from there. **Auto** does this every 5 / 10 / 15 laps.

OpenF1 is free after a session ends. **While a session is live it refuses every unauthenticated request,
including the browser's CORS preflight**, so the static GitHub Pages site cannot read it during a race. For live
use, run the console through the relay in `serve.py` with a paid OpenF1 account (credentials stay on your machine):

```bash
export OPENF1_USERNAME=you@example.com OPENF1_PASSWORD='...'
python serve.py --local --port 8050      # open http://localhost:8050, select the race, press Auto
```
The authenticated relay path is written to OpenF1's documented token flow but has not been tested against a
paid account.

### Call sheet
Each "Find best 3 calls" opens a call sheet: the three calls as tabs, the track map with attack / traction /
front-load zones (derived from the pole-lap speed trace and Pirelli's COTA notes; guidance, not simulated),
tyre usage for the rest of the race, and a push / balanced / manage level per stint (share of the tyre's usable
life the stint uses).

### Data sources
Jolpica-F1 (Ergast API): schedule, qualifying, results · OpenF1: session times, team colours, race control,
pole-lap position and speed · MultiViewer circuit API: outline, corners, pit loss · Open-Meteo: forecast ·
Pirelli via formula1.com: compound allocation. FastF1 is not used for the console: since 3.9 its timing data needs
an F1 account.

### Validation (statistical model)
Rolling origin: refit before every race from 2024 on, score that race (1,109 classified driver-races).
Log-loss 2.36 vs 2.43 for a grid-only model; mean absolute error 2.23 positions vs 2.44 (grid only) and 2.65
("finish = grid"). The simulator's tyre-wear rates are engineering priors (see the Model & sources panel), so trust
its ranking of plans more than its absolute percentages.

## Run it

```bash
python -m venv ../.venv && . ../.venv/bin/activate
pip install numpy scipy requests            # data + model scripts
python fetch_event.py                       # needs internet; ~1-2 min
python train_finish_model.py                # ~1 min
python serve.py --local --port 8050         # http://localhost:8050  (any static server works)
```

Each race week: add the event to `EVENT_FACTS` in `fetch_event.py` (laps, length, compounds, time zone), run both
scripts, commit `dashboard/data/`, push. GitHub Pages redeploys on every push to `main`.

### Tests
```bash
pip install playwright && python -m playwright install chromium
python tests/run_browser.py tests/engine_test.html          # engine: determinism, probabilities, search timing
python tests/run_browser.py tests/live_test.html            # live sync on an OpenF1-shaped fixture
python tests/run_browser.py dashboard/index.html --script tests/ui_flow.py   # full UI flow with screenshots
```

### Keyboard (live console)
`← →` lap · `↑ ↓` position · `1 2 3` soft / medium / hard · `G V S R` green / VSC / SC / red · `Enter` run · `Esc` close

## Barcelona case study
The original study (qualify P3, start P4, three best plans for a podium) lives in `f1strat/` + `run_analysis.py`
and its dashboard at `dashboard/barcelona/`. See `TESTING.md` for its checks.

```bash
python run_analysis.py --workers 4          # writes dashboard/barcelona/data/results.json
```

## Limits
Grid = qualifying order (penalties not verified). Not modelled: lapped traffic, penalties, damage, rain
transitions, tyre-set availability, team orders, per-car energy state. Rival pace is 0.85 × qualifying gap.
Not affiliated with Formula 1, the FIA or Red Bull Racing; no official logos are used.
Driver photos: Steffen Prößdorf (Verstappen) and Yu Chu Chin (Hadjar), Wikimedia Commons, CC BY-SA 4.0.
