# Manual test cases

Status when shipped: the full pipeline (`run_analysis.py`, ~200 s on 2 cores) ran to completion and wrote
`dashboard/data/results.json`. The final dashboard re-screenshot after the last UI edits was **not** done.
`fetch_fastf1.py` has **never been executed** (no F1 data access where it was written).
Tick each box; note anything that fails.

## A. Setup
- [ ] `pip install --user numpy`; `python run_analysis.py --quick` finishes (~30 s) with no traceback.
- [ ] `python run_analysis.py --workers 4` finishes (~3 min), prints `done in ...s`, writes `dashboard/data/results.json`.
- [ ] Same `--seed` twice gives identical top-3 labels and podium %; a different `--seed` changes the numbers by only a few points (ranking should be stable; if rank 1 and 2 swap, check whether their podium % are within ~2 pts of each other, which is noise).
- [ ] `--workers 1` and `--workers 4` give the same results (common random numbers, deterministic).

## B. Server / access on HiPerGator
- [ ] `python serve.py --port 8050` prints the VS Code / SSH-tunnel / OnDemand URLs.
- [ ] VS Code port forward -> page loads.
- [ ] SSH tunnel URL loads.
- [ ] OnDemand `rnode` URL loads, all tabs work (relative URLs, no blank page).
- [ ] `python serve.py --local` binds to localhost only. Port already in use gives a readable error.
- [ ] Browser devtools console: no errors or failed requests on any tab.

## C. Dashboard checks, by tab
**Strategies**
- [ ] Three cards, distinct names (e.g. "Hard start, 2-stop", "Medium start, 2-stop", "Medium start, 2-stop (L19 stop)").
- [ ] Stint bars add up to 66 laps; pit-lap labels do not overlap; compound colours S red / M yellow / H white.
- [ ] Podium %, win %, avg finish are consistent with the scenario table of each plan.
- [ ] Baseline sentence (best 1-stop and best other 2-stop) matches the Model tab leaderboard.

**Race replay**
- [ ] Start grid is P1,P2 ahead of us, a car (the T1 passer) ahead, we are P4 on lap 1.
- [ ] Scenario chips (green, VSC L20, SC L20, SC L52, red L30) each change the status bar (G/V/S/R) on the right laps.
- [ ] Timing tower reorders smoothly, PIT tag appears on stop laps, slider and play/pause work, no row overlap.

**Track**
- [ ] 14 corners, 66-lap-free single lap map is a closed loop (schematic unless real data loaded).
- [ ] Hover the speed trace: marker moves on the map. "Drive the lap" animates and stops cleanly.
- [ ] Max speed on straights ~ 300-340 km/h; slowest corner (T10 / T1 area) ~ 100 km/h. Treat as model estimates.

**Tyres & fuel**
- [ ] Tyre curves stop near max life +5; soft degrades fastest, hard slowest; thermal window 85-110 C visible.
- [ ] Start fuel ~92 kg, end ~1.5 kg, car mass drops ~92 kg over the race (~768 kg + fuel at start).

**Risk**
- [ ] SC ~33%, VSC ~24%, red ~5% per race (priors). Heat tables render with readable numbers (dark text on colour).
- [ ] Sensitivity: cold day (-8 C) lowers plan 1 podium chance sharply (previous run: ~57% -> ~26%).

**Model**
- [ ] 9 Q&A cards, badges (sourced/calibrated/model/assumed) present, no "undefined"/NaN text anywhere.

## D. Model sanity checks (physics / racing logic)
- [ ] Green-flag winner time ~1:30-1:33 (real 2026 race: 1:32:28).
- [ ] Fresh soft mid-race lap ~1:20 at light fuel; fuel effect ~0.032 s/kg/lap.
- [ ] Pit loss ~21.5 s green, roughly half under SC, ~70% under VSC.
- [ ] Setting `--sims` low (e.g. 200) widens plan ranking noise; increasing it narrows it.
- [ ] Edit `f1strat/config.py`: `h_sc=0` and `h_vsc=0`, `h_red=0` -> SC/VSC/red probabilities go to 0 and podium odds shift (rerun).
- [ ] `pass_delta_s` lower (easier overtaking) -> podium odds rise; higher -> fall. Direction should match intuition.
- [ ] Raise `pit_loss_s` to 28 -> 1-stop plans gain relative to 2-stop.
- [ ] Raise `deg_scale` to 1.5 -> more stops preferred; 0.6 -> 1-stop becomes competitive.

## E. Edge cases
- [ ] `--air-c 15` and `--air-c 35` run without error; tyre-temperature charts move accordingly.
- [ ] `--track-offset 5` (overcast) runs; soft stints get longer/hard stints less attractive.
- [ ] Missing `dashboard/data/results.json` -> page shows a clear message instead of a blank screen.
- [ ] Narrow window (phone width ~400 px): tabs scroll, cards stack, no horizontal page scroll.

## F. FastF1 importer (untested, run on a login node with internet)
- [ ] `pip install --user fastf1`, then `python fetch_fastf1.py --years 2024 2025 2026`.
- [ ] Prints per-step progress; failures are caught and reported per step.
- [ ] Writes `data/track_real.json`, `data/calibration.json`, `data/deg_report.json`.
- [ ] `python run_analysis.py --track data/track_real.json --calibration data/calibration.json` runs; the Track tab then labels the source as FastF1 and the map matches the real layout (T1-T3 complex, last chicane, main straight).
- [ ] Check `calibration.json` values are sensible: `h_sc` ~0.003-0.01, `h_vsc` ~0.002-0.008, `pit_loss_s` ~18-26. If a field is absurd, delete it before rerunning.
- [ ] `deg_report.json` is report-only: compare with `wear_lin` in `config.py` and update by hand if warranted (older-spec tyres are not 2026 tyres).

## G. New in this version: cases, forecast, uncertainty, browser runs
Verified before shipping: quick run (36 s on 4 cores) and a browser-triggered run through `/api/run`; the Forecast tab,
Case panel and Replay tab rendered with no console errors on a quick case (start P5, SC on lap 20). Everything below is for you to check.
- [ ] Default case (grid P3, after T1 P4): header reads "P3 → P4", Strategies title says "from P4".
- [ ] Case panel: set *Running order after Turn 1* to P1, press Run, wait for the progress bar, the page reloads with `?src=...`. Strategies title now says "from P1" and the replay grid starts with you at the front.
- [ ] Set it to P10: podium chances fall sharply and the best plans change (more track-position-neutral plans).
- [ ] Forced event = Safety car, lap 20: a "SC · L20 (your event)" chip appears in Race replay and the "Safety car" share in Forecast > "what happens on the day" is ~100 %.
- [ ] Starting tyre = Hard: all three plans start on H.
- [ ] *Copy link*, open it in a new tab: loads the cached run instantly (no recompute).
- [ ] Press Run while another run is in progress: message says another case is running; no crash.
- [ ] Stop `serve.py`, open `dashboard/index.html` from disk (file://) or use `serve.py --no-api`: the page shows saved results and the Run button is disabled with an explanation.
- [ ] Forecast tab: checkpoint cards at laps 17 / 33 / 50; podium-at-this-point probability and the "if you are P.. you finish on the podium" table look sensible (higher position now -> higher final podium chance, monotone within noise).
- [ ] Fan chart: bands widen into and after the stop windows; median line is inside the 50 % band.
- [ ] Uncertainty: 95 % interval narrows when you use Full quality (1,500 races); "if every assumption is exactly right" differs from the headline by a few points when parameter uncertainty is on, and equals it when switched off (*Model assumptions* > uncheck, rerun).
- [ ] Head-to-head table: pair intervals that span 0 mean "cannot separate these plans". Bootstrap "best" shares sum to ~100 %.
- [ ] Reproducibility: same case + same seed gives identical numbers; changing the seed changes them by roughly the stated interval.
- [ ] Judgement check: in the previous quick run, higher tyre-wear draws *raised* the podium chance of the 2-stop plans (the simulated rivals include 1-stoppers that suffer more). Decide whether the rival field mix is realistic, since it drives that result.
- [ ] Edge cases: lap1_pos = 22 (last), lap1_pos = 1, forced red flag on lap 65, gap fields at 0.05 / 3.0 all run without error.

## Known limitations (not bugs)
- Rivals are interchangeable apart from their strategy; start position matters only through traffic and track position, not car or driver pace.
- "Predicted positions" are for your car; the model does not predict which rival will be where.
- Parameter-uncertainty spreads are judgement calls, not fitted to data.
- The real-track map still needs `fetch_fastf1.py` (untested).
- Absolute probabilities depend on assumed priors; rankings are more trustworthy than the percentages.
- Track map and corner speeds are model-derived unless real data is imported.
- Pit speed limit 80 km/h and pit loss 21.5 s are assumptions; verify against FIA event notes.
- Rival field behaviour is simplified (archetype strategies, 75% react probability under SC/VSC).
- Surface-temperature chart lacks the 85/110 C reference lines (optional polish, not done).
