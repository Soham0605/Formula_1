#!/usr/bin/env python3
"""Run the Barcelona-Catalunya 2026 strategy analysis and write dashboard/data/results.json.

    python run_analysis.py                 # full run
    python run_analysis.py --quick         # small smoke test (~1 min)
    python run_analysis.py --workers 16    # use 16 cores (defaults to SLURM_CPUS_PER_TASK)
"""
import argparse
import json
from dataclasses import fields
from pathlib import Path

from f1strat.analysis import run
from f1strat.config import Config, load_calibration
from f1strat.strategies import default_workers

ROOT = Path(__file__).resolve().parent


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true", help="few simulations, for testing")
    ap.add_argument("--workers", type=int, default=default_workers())
    ap.add_argument("--air-c", type=float, default=25.0, help="air temperature (default 25)")
    ap.add_argument("--track-offset", type=float, default=15.0, help="track temp = air + offset")
    ap.add_argument("--sims", type=int, default=None, help="final-stage races per strategy")
    ap.add_argument("--seed", type=int, default=2026)
    ap.add_argument("--quality", choices=["quick", "standard", "full"], default=None,
                    help="quick ~10 s, standard ~1 min, full (default) ~3 min on 2 cores")
    ap.add_argument("--params", default=None, help="JSON object of Config fields, e.g. '{\"lap1_pos\": 5, \"force_lap\": 20, \"force_kind\": 2}'")
    ap.add_argument("--lap1-pos", type=int, default=None, help="running order after turn 1 (default 4)")
    ap.add_argument("--grid-pos", type=int, default=None, help="qualifying position (default 3)")
    ap.add_argument("--no-uncertainty", action="store_true", help="disable parameter uncertainty")
    ap.add_argument("--out", default=str(ROOT / "dashboard" / "data"))
    ap.add_argument("--calibration", default=str(ROOT / "data" / "calibration.json"))
    ap.add_argument("--track", default=str(ROOT / "data" / "track_real.json"))
    a = ap.parse_args()

    cfg = Config(air_c=a.air_c, track_offset_c=a.track_offset, seed=a.seed)
    cfg = load_calibration(cfg, a.calibration)
    if a.params:
        valid = {f.name: f for f in fields(Config)}
        upd = {}
        for k, v in json.loads(a.params).items():
            if k in valid and not isinstance(getattr(cfg, k), tuple):
                upd[k] = type(getattr(cfg, k))(v)
        cfg = cfg.with_(**upd)
    if a.lap1_pos:
        cfg = cfg.with_(lap1_pos=a.lap1_pos)
    if a.grid_pos:
        cfg = cfg.with_(grid_pos=a.grid_pos)
    if a.no_uncertainty:
        cfg = cfg.with_(uncertainty=False)
    quality = "quick" if a.quick else a.quality
    if quality == "quick":
        a.quick = True
        cfg = cfg.with_(stage1_reps=6, stage2_reps=40, final_reps=150)
    elif quality == "standard":
        cfg = cfg.with_(stage1_reps=12, stage2_reps=120, final_reps=600)
    if a.sims:
        cfg = cfg.with_(final_reps=a.sims)
    run(cfg, a.out, workers=a.workers, real_track=a.track, quick=a.quick)


if __name__ == "__main__":
    main()
