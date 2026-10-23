# Pit Wall: Barcelona-Catalunya 2026 strategy model

Monte Carlo race-strategy simulator (22 cars, 66 laps, lap-by-lap traffic, tyres, fuel, SC/VSC/red flag)
plus a browser dashboard. Case: qualify P3, lose a place at Turn 1 (start P4), find the 3 best plans for a podium.

## Install
Only numpy is required (`pip install --user numpy`). Python >= 3.9. Dashboard is plain HTML/JS, no internet needed.

## Run
```bash
python run_analysis.py --workers 4        # full quality, ~4 min on 2 cores; writes dashboard/data/results.json
python run_analysis.py --quality quick    # ~15-30 s, rough numbers
python serve.py --local --port 8050       # dashboard at http://localhost:8050 (laptop)
```
Workers default to the number of cores (or `SLURM_CPUS_PER_TASK`).

### Running other cases
Either use the **Case** panel at the top of the dashboard (needs `serve.py`; press *Run this case*, a progress bar
shows the 8 steps, and the page reloads with the finished case), or from the shell:
```bash
python run_analysis.py --quality standard --grid-pos 2 --lap1-pos 6
python run_analysis.py --quality standard --params '{"lap1_pos": 5, "force_kind": 2, "force_lap": 20, "start_compound": 1}'
python run_analysis.py --no-uncertainty   # race randomness only, no parameter draws
```
Case fields: `grid_pos`, `lap1_pos`, `gap_ahead_s`, `gap_behind_s`, `start_compound` (-1 any, 0 S, 1 M, 2 H),
`force_kind` (1 VSC, 2 SC, 3 red) with `force_lap` / `force_dur`, `air_c`, `track_offset_c`, `pit_loss_s`,
`pass_delta_s`, `deg_scale`, `uncertainty`, `seed`. Any other `Config` field can be set with `--params` from the CLI.
Runs started in the browser are cached in `dashboard/data/cache/<id>/`; the URL (`?src=<id>&...`) reopens a finished case,
and *Copy link* gives a link you can send to anyone using the same server. `serve.py --no-api` disables browser runs.

### What the Forecast & risk tab shows
- Predicted position at 25 / 50 / 75 % of the race (laps 17 / 33 / 50): distribution, podium chance at that point,
  gap to P3, expected tyre state, and "if you are P5 at lap 33, you finish on the podium X % of the time".
- Median position with 50 / 80 % bands and podium probability lap by lap.
- Uncertainty: 95 % interval on the podium chance (finite number of races), podium chance with and without parameter
  uncertainty, worst-10 % average finish, paired head-to-head between plans, bootstrap chance each plan is truly best,
  podium chance by tercile of each drawn assumption (wear, pit loss, overtaking, incident rate), and by race type.
- Parameter uncertainty draws one value of each assumption per simulated race, shared by all cars. The spreads
  (`unc_*` in `config.py`) are judgement calls, not fitted.

## Viewing on HiPerGator (headless)
Run `serve.py` on the node you are on (compute node via `srun --pty` / Slurm job, or a login node for light use), then either:
1. **VS Code**: Ports panel -> Forward a Port -> 8050 -> open `http://localhost:8050`.
2. **SSH tunnel** from your laptop: `ssh -N -L 8050:<NODE>:8050 <user>@hpg.rc.ufl.edu`, then `http://localhost:8050`.
3. **Open OnDemand**: `https://ood.rc.ufl.edu/rnode/<NODE>/8050/` (URLs in the dashboard are relative, so the proxy works).

If you work on your laptop none of this is needed: `python serve.py --local` and open `http://localhost:8050`.

Slurm example:
```bash
srun -p hpg-default -c 4 --mem=4g -t 01:00:00 --pty bash
python run_analysis.py --workers 4 && python serve.py --port 8050
```

## Layout
- `f1strat/config.py` all parameters with provenance tags (sourced / calibrated / model / assumed)
- `f1strat/track.py` circuit geometry + point-mass lap solver (corner/straight speeds)
- `f1strat/sim.py` vectorised race simulator
- `f1strat/strategies.py` candidate enumeration, 3-stage search, top-3 selection
- `f1strat/analysis.py` tyre/fuel/incident/decision blocks, replays, sensitivity, Q&A -> results.json
- `fetch_fastf1.py` optional: real track geometry + calibration from FastF1 (**untested**, see TESTING.md)
- `dashboard/` the UI

## What is sourced vs assumed
Sourced: 66 laps, 4.657 km, 768 kg minimum mass, C2/C3/C4 allocation, 2026 pole 1:14.679, fuel energy-flow limit.
Derived: start fuel ~92 kg (+/- 8), burn ~1.37 kg/lap.
**Assumed priors (not official)**: compound pace gaps, degradation rates, pit loss 21.5 s, pit limit 80 km/h,
SC/VSC/red hazards, overtaking model, track temp = air + 15 C.
The track map is schematic and corner speeds are model estimates unless you run `fetch_fastf1.py`.
Podium probabilities are model outputs conditional on these priors; use them to rank plans, not as forecasts.
