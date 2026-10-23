"""Central configuration for the Barcelona-Catalunya strategy model.

Every number carries a provenance tag in PROVENANCE so the dashboard can show
what is sourced, what is calibrated and what is an engineering assumption.
Anything tagged "assumed" is a tunable prior, not an official figure.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, replace, fields
from pathlib import Path
from typing import Tuple

COMP_CODES = ("S", "M", "H")
COMP_NAMES = ("Soft", "Medium", "Hard")
COMP_PIRELLI = ("C4", "C3", "C2")      # Barcelona-Catalunya 2026 allocation (Pirelli / F1.com)
INF_LAP = 999                           # "no further stop" sentinel
S_MAX = 3                               # max stops modelled


@dataclass(frozen=True)
class Config:
    # ---- race -------------------------------------------------------------
    laps: int = 66                       # sourced: 66 laps (Williams / F1 race preview)
    lap_m: float = 4657.0                # sourced: circuit length
    n_cars: int = 22                     # 11 teams x 2 in 2026

    # ---- weather ----------------------------------------------------------
    air_c: float = 25.0                  # given by the user
    track_offset_c: float = 15.0         # assumed: sunny afternoon, track ~ air + 15 C
    ref_track_c: float = 40.0            # track temperature the tyre temps below are referenced to

    # ---- mass and fuel ----------------------------------------------------
    min_mass_kg: float = 768.0           # sourced: FIA 2026, car + driver, no fuel, incl. nominal tyre mass
    start_fuel_kg: float = 92.0          # estimated from energy-flow limit, see qa in export.py
    fuel_burn_kg_lap: float = 1.37       # estimated
    fuel_s_per_kg: float = 0.032         # assumed: lap-time sensitivity to fuel mass
    fuel_lhv_mj_kg: float = 42.0         # assumed lower heating value of the sustainable fuel
    flow_limit_mj_h: float = 3000.0      # sourced: 2026 fuel energy-flow limit (Wikipedia, FIA regs)
    fuel_end_kg: float = 1.5             # residual (FIA sample needs ~1 kg)

    # ---- pace -------------------------------------------------------------
    pole_lap_s: float = 74.679           # sourced: 2026 Barcelona pole (Russell)
    race_mode_offset_s: float = 4.2      # calibrated so a mid-race fresh soft is ~1:20.0 (race FL was 1:20.1)
    start_loss_s: float = 4.2            # standing start + cold tyres, lap 1
    outlap_pen_s: float = 0.9            # tyre warm-up on the out-lap
    lap_sigma_s: float = 0.14            # lap-to-lap noise
    pace_sigma_s: float = 0.04           # car/driver spread (tiny: "same cars, similar drivers")
    degk_sigma: float = 0.08             # lognormal sigma on tyre wear per car per race
    start_gap_s: float = 0.22            # time between grid slots after T1
    start_noise_s: float = 0.07

    # ---- tyres (index 0=S, 1=M, 2=H) --------------------------------------
    comp_offset_s: Tuple[float, ...] = (0.0, 0.55, 1.10)    # assumed pace deltas, fresh tyre
    wear_lin: Tuple[float, ...] = (0.085, 0.055, 0.036)     # s/lap per effective lap
    wear_cliff: Tuple[float, ...] = (11.0, 18.0, 28.0)      # effective laps where the cliff begins
    wear_quad: Tuple[float, ...] = (0.030, 0.018, 0.011)    # s/lap^2 beyond the cliff
    temp_base_c: Tuple[float, ...] = (104.0, 99.0, 94.0)    # surface temp at ref track temp, clean air
    temp_track_k: float = 0.55           # deg C of tyre temp per deg C of track temp
    temp_dirty_c: float = 5.0            # extra tyre temp when following closely
    thermal_k: float = 0.05              # extra wear per deg C above 100
    wear_dirty: float = 0.25             # extra wear fraction in dirty air
    window_lo_c: float = 86.0
    window_hi_c: float = 108.0
    max_life: Tuple[int, ...] = (22, 32, 44)                # hard feasibility cap on stint length
    deg_scale: float = 1.0               # global multiplier used in sensitivity runs

    # ---- pit ---------------------------------------------------------------
    pit_limit_kmh: float = 80.0          # assumed (verify against FIA event notes)
    pit_loss_s: float = 21.5             # assumed total time loss of a green-flag stop
    pit_sigma_s: float = 0.5
    slow_stop_p: float = 0.04
    sc_pit_factor: float = 0.50
    vsc_pit_factor: float = 0.70
    min_stint: int = 6

    # ---- traffic -----------------------------------------------------------
    zone_s: float = 1.2                  # within this gap a pass can be attempted
    follow_gap_s: float = 0.65           # closest a following car can run
    pass_delta_s: float = 0.70           # pace advantage per lap for a 50 % pass chance (Barcelona is hard)
    pass_scale_s: float = 0.30
    pass_cost_s: float = 0.25
    uc_laps_default: int = 3             # laps stuck before the undercut rule fires

    # ---- incidents (priors, calibrate with fetch_fastf1.py) ----------------
    h_sc: float = 0.0058                 # per-lap SC hazard
    h_sc_lap1: float = 0.030
    h_vsc: float = 0.0043
    h_red: float = 0.0008
    sc_lap_s: float = 125.0
    vsc_lap_s: float = 108.0
    sc_gap_s: float = 0.9
    red_gap_s: float = 0.5
    sc_fuel_f: float = 0.50
    vsc_fuel_f: float = 0.75
    sc_wear_f: float = 0.30
    vsc_wear_f: float = 0.60
    react_min_age: int = 8
    react_prob_ai: float = 0.75

    # ---- the case being studied --------------------------------------------
    grid_pos: int = 3                    # qualifying position (display only)
    lap1_pos: int = 4                    # running order after turn 1 (1-based); everything is simulated from here
    gap_ahead_s: float = 0.22            # gap to the car directly ahead after turn 1
    gap_behind_s: float = 0.22           # gap to the car directly behind after turn 1
    start_compound: int = -1             # -1 = search all, 0/1/2 = force the starting tyre S/M/H
    force_lap: int = 0                   # 0 = none; else a neutralisation is forced to start on this lap
    force_kind: int = 0                  # 1 VSC, 2 SC, 3 red flag
    force_dur: int = 3                   # laps the forced neutralisation lasts (red flag: 2)

    # ---- uncertainty (parameter uncertainty is drawn once per simulated race, shared by all cars) --------
    uncertainty: bool = True
    unc_deg_sigma: float = 0.15          # lognormal sigma on tyre wear rate
    unc_pit_sigma_s: float = 1.0         # normal sigma on pit-stop time loss (s)
    unc_pass_sigma_s: float = 0.12       # normal sigma on the pace edge needed for a 50 % pass (s)
    unc_hazard_sigma: float = 0.35       # lognormal sigma on the SC/VSC/red hazard rates
    checkpoints: Tuple[float, ...] = (0.25, 0.50, 0.75)

    # ---- search ------------------------------------------------------------
    stage1_reps: int = 24
    stage2_reps: int = 300
    final_reps: int = 1500
    seed: int = 2026

    # ------------------------------------------------------------------------
    @property
    def track_c(self) -> float:
        return self.air_c + self.track_offset_c

    @property
    def base_lap_s(self) -> float:
        """Fresh soft, zero fuel, race mode, clean air."""
        return self.pole_lap_s + self.race_mode_offset_s

    def with_(self, **kw) -> "Config":
        return replace(self, **kw)


PROVENANCE = {
    "laps / length": "sourced",
    "min mass 768 kg": "sourced",
    "compound allocation C2/C3/C4": "sourced",
    "pole 1:14.679": "sourced",
    "fuel energy-flow limit": "sourced",
    "start fuel / burn": "model",
    "compound pace deltas": "assumed",
    "degradation rates": "assumed",
    "pit loss / limit": "assumed",
    "incident probabilities": "assumed",
    "overtaking model": "assumed",
    "track temperature": "assumed",
}


def load_calibration(cfg: Config, path: str | Path) -> Config:
    """Overlay values written by fetch_fastf1.py (any field name of Config is accepted)."""
    p = Path(path)
    if not p.exists():
        return cfg
    data = json.loads(p.read_text())
    valid = {f.name for f in fields(Config)}
    upd = {}
    for k, v in data.items():
        if k in valid:
            cur = getattr(cfg, k)
            upd[k] = tuple(v) if isinstance(cur, tuple) else v
    return cfg.with_(**upd) if upd else cfg
