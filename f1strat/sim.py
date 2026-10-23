"""Vectorised lap-by-lap race simulator (Monte Carlo over N races at once).

State arrays are [N, C]: N simulated races x C cars. Car 0 is ours. Grid after turn 1:
  rank0 = car 1 (P1), rank1 = car 2 (P2), rank2 = car 3 (the car that passed us into T1),
  rank3 = car 0 (us, P4), rank4.. = cars 4..21.

Race model per lap and car
  lap = base + compound offset + wear(effective age) + thermal-window penalty + fuel mass
        + car pace offset + noise (+ start loss / out-lap warm-up)
  effective age grows faster when the surface is hot (>100 C) and in dirty air
Traffic: a car that would end the lap within `follow_gap` of the car ahead is held up unless a
pass succeeds (probability = logistic of its pace advantage). Cars that pit are not held.
Neutralisations: VSC (gaps frozen), SC (field bunches to ~0.9 s), red flag (free tyres, bunched restart).
"""
from __future__ import annotations

import itertools
from dataclasses import dataclass
from functools import lru_cache
from typing import Dict, List, Optional

import numpy as np

from .config import Config, INF_LAP, S_MAX

GREEN, VSC, SC, RED = 0, 1, 2, 3

# archetypes for the rest of the field: (compound seq, nominal stop laps, weight)
AI_ARCHETYPES = [
    ([1, 2], [25], 9.0),                    # M-H
    ([2, 1], [35], 8.0),                    # H-M
    ([0, 1, 2], [14, 38], 15.0),            # S-M-H
    ([0, 2, 1], [13, 40], 11.0),            # S-H-M
    ([1, 2, 1], [20, 44], 12.0),            # M-H-M
    ([1, 1, 2], [22, 44], 6.0),             # M-M-H
    ([2, 1, 0], [27, 50], 6.0),             # H-M-S
    ([0, 1, 0, 2], [12, 28, 46], 8.0),      # S-M-S-H
    ([0, 0, 1, 2], [12, 25, 42], 7.0),      # S-S-M-H
    ([1, 0, 1, 2], [18, 31, 47], 6.0),      # M-S-M-H
]


def solo_time(cfg: Config, comps, stops) -> float:
    """Traffic-free green-flag race time of a plan (pure python, used to build the field's strategy mix)."""
    L = cfg.laps
    b = [0] + list(stops) + [L]
    t = 0.0
    fuel = cfg.start_fuel_kg
    base = cfg.base_lap_s
    for k, c in enumerate(comps):
        temp = cfg.temp_base_c[c] + cfg.temp_track_k * (cfg.track_c - cfg.ref_track_c)
        therm = 1.0 + cfg.thermal_k * max(temp - 100.0, 0.0)
        window = 0.04 * max(cfg.window_lo_c - temp, 0.0) + 0.03 * max(temp - cfg.window_hi_c, 0.0)
        lin, cliff, quad = cfg.wear_lin[c], cfg.wear_cliff[c], cfg.wear_quad[c]
        age = 0.0
        for lap in range(b[k], b[k + 1]):
            pen = (lin * age + quad * max(age - cliff, 0.0) ** 2) * cfg.deg_scale + window
            t += base + cfg.comp_offset_s[c] + pen + cfg.fuel_s_per_kg * fuel + (cfg.outlap_pen_s if (lap == b[k] and k > 0) else 0.0)
            fuel -= cfg.fuel_burn_kg_lap
            age += therm
        if k < len(comps) - 1:
            t += cfg.pit_loss_s
    return t


@lru_cache(maxsize=32)
def field_archetypes(cfg: Config):
    """Strategy mix of the other 21 cars: the solo-optimal plan of the best few compound orders per stop count
    (what a team's strategy software would hand its drivers), weighted towards 2-stops."""
    L = cfg.laps
    life = cfg.max_life
    best: dict = {1: {}, 2: {}, 3: {}}

    def feas(comps, stops):
        bb = [0] + list(stops) + [L]
        return all(cfg.min_stint <= bb[i + 1] - bb[i] <= life[c] for i, c in enumerate(comps)) and len(set(comps)) >= 2

    def consider(comps, stops):
        if not feas(comps, stops):
            return
        t = solo_time(cfg, comps, stops)
        key = tuple(comps)
        cur = best[len(stops)].get(key)
        if cur is None or t < cur[0]:
            best[len(stops)][key] = (t, list(stops))

    for comps in itertools.permutations(range(3), 2):
        for p in range(10, 46):
            consider(comps, [p])
    for comps in itertools.product(range(3), repeat=3):
        for p1 in range(8, 34, 2):
            for p2 in range(p1 + 8, 56, 2):
                consider(comps, [p1, p2])
    for comps in itertools.product(range(3), repeat=4):
        if any(comps[i] == comps[i + 1] for i in range(3)):
            continue
        for p1 in range(8, 24, 3):
            for p2 in range(p1 + 8, 44, 3):
                for p3 in range(p2 + 8, 58, 3):
                    consider(comps, [p1, p2, p3])
    out = []
    for n, weights in ((2, [26, 18, 12, 8]), (1, [8, 5]), (3, [4, 3])):
        ranked = sorted(best[n].items(), key=lambda kv: kv[1][0])
        for (key, (t, stops)), w in zip(ranked, weights):
            out.append((list(key), stops, float(w)))
    return out


def _pad_stops(stops: List[int]) -> List[int]:
    return list(stops) + [INF_LAP] * (S_MAX - len(stops))


def _pad_comps(comps: List[int]) -> List[int]:
    return list(comps) + [comps[-1]] * (S_MAX + 1 - len(comps))


@dataclass
class World:
    reps: int
    status: np.ndarray          # [reps, L+2] int8
    noise: np.ndarray           # [reps, L, C] float32
    pace: np.ndarray            # [reps, C]
    degk: np.ndarray            # [reps, C]
    pit_extra: np.ndarray       # [reps, L, C]
    start_off: np.ndarray       # [reps, C]
    ai_stops: np.ndarray        # [reps, C, S_MAX]
    ai_comps: np.ndarray        # [reps, C, S_MAX+1]
    ai_react: np.ndarray        # [reps, C]
    u_pass: np.ndarray          # [reps, L, C]
    ev_class: np.ndarray        # [reps] 0 none, 1 VSC only, 2 SC, 3 red
    sc_start1: np.ndarray       # [reps] SC/red on lap 1 or 2 (bool)
    deg_mult: np.ndarray        # [reps] per-race tyre wear multiplier (parameter uncertainty)
    pit_add: np.ndarray         # [reps] per-race pit loss shift (s)
    pass_add: np.ndarray        # [reps] per-race shift of the pass threshold (s)
    haz_mult: np.ndarray        # [reps] per-race incident rate multiplier


def generate_status(cfg: Config, reps: int, rng: np.random.Generator, hmult=None) -> np.ndarray:
    L = cfg.laps
    hm = 1.0 if hmult is None else hmult
    status = np.zeros((reps, L + 2), dtype=np.int8)
    left = np.zeros(reps, dtype=int)
    kind = np.zeros(reps, dtype=np.int8)
    for l in range(1, L + 1):
        active = left > 0
        status[:, l] = np.where(active, kind, 0)
        left = np.where(active, left - 1, 0)
        u = rng.random(reps)
        h_sc = (cfg.h_sc_lap1 if l == 1 else cfg.h_sc) * hm
        h_red = cfg.h_red * hm
        h_vsc = cfg.h_vsc * hm
        free = (~active) & (l < L)
        red = free & (u < h_red)
        sc = free & ~red & (u < h_red + h_sc)
        vsc = free & ~red & ~sc & (u < h_red + h_sc + h_vsc)
        n_sc = np.clip(2 + rng.poisson(1.6, reps), 3, 7)
        n_vsc = np.clip(1 + rng.poisson(0.9, reps), 1, 3)
        for mask, k, dur in ((red, RED, np.full(reps, 2)), (sc, SC, n_sc), (vsc, VSC, n_vsc)):
            if mask.any():
                status[mask, l] = k
                left = np.where(mask, dur - 1, left)
                kind = np.where(mask, k, kind)
    return status


def forced_status(cfg: Config, reps: int, events: List[tuple]) -> np.ndarray:
    status = np.zeros((reps, cfg.laps + 2), dtype=np.int8)
    for (lap, kind, dur) in events:
        status[:, lap:lap + dur] = kind
    return status


def grid_ranks(cfg: Config) -> np.ndarray:
    """Running order after turn 1: rank (0 = leader) of every car. Car 0 is ours; cars 1.. fill the other slots in order."""
    C = cfg.n_cars
    p = int(np.clip(cfg.lap1_pos, 1, C)) - 1
    rank = np.empty(C, int)
    rank[0] = p
    rank[1:] = [r for r in range(C) if r != p]
    return rank


def generate_world(cfg: Config, reps: int, seed: int, status: Optional[np.ndarray] = None,
                   unc: Optional[bool] = None) -> World:
    rng = np.random.default_rng(seed)
    L, C = cfg.laps, cfg.n_cars
    use_unc = cfg.uncertainty if unc is None else unc
    if use_unc:
        ru = np.random.default_rng(seed + 424242)      # separate stream: other draws stay identical with/without it
        deg_mult = np.exp(ru.standard_normal(reps) * cfg.unc_deg_sigma)
        pit_add = ru.standard_normal(reps) * cfg.unc_pit_sigma_s
        pass_add = ru.standard_normal(reps) * cfg.unc_pass_sigma_s
        haz_mult = np.exp(ru.standard_normal(reps) * cfg.unc_hazard_sigma)
    else:
        deg_mult, pit_add, pass_add, haz_mult = np.ones(reps), np.zeros(reps), np.zeros(reps), np.ones(reps)
    if status is None:
        st = generate_status(cfg, reps, rng, hmult=haz_mult)
        if cfg.force_lap > 0 and cfg.force_kind > 0:
            a = int(np.clip(cfg.force_lap, 1, L))
            st[:, a:min(a + max(cfg.force_dur, 1), L + 1)] = cfg.force_kind
    else:
        st = status
    noise = (rng.standard_normal((reps, L, C)) * cfg.lap_sigma_s).astype(np.float32)
    pace = rng.standard_normal((reps, C)) * cfg.pace_sigma_s
    degk = np.exp(rng.standard_normal((reps, C)) * cfg.degk_sigma) * deg_mult[:, None]
    slow = rng.random((reps, L, C)) < cfg.slow_stop_p
    pit_extra = rng.standard_normal((reps, L, C)) * cfg.pit_sigma_s + slow * rng.uniform(2.0, 6.0, (reps, L, C))
    pit_extra = (pit_extra + pit_add[:, None, None]).astype(np.float32)
    # start offsets from the running order after T1 (order is preserved; the gaps are noisy)
    rank_of_car = grid_ranks(cfg)
    p = int(rank_of_car[0])
    nominal = np.arange(C) * cfg.start_gap_s
    if p > 0:
        nominal[p:] += cfg.gap_ahead_s - cfg.start_gap_s
    if p < C - 1:
        nominal[p + 1:] += cfg.gap_behind_s - cfg.start_gap_s
    by_rank = np.sort(nominal[None, :] + rng.standard_normal((reps, C)) * cfg.start_noise_s, axis=1)
    start_off = by_rank[:, rank_of_car]
    start_off = start_off - start_off.min(axis=1, keepdims=True)
    # field strategies
    archs = field_archetypes(cfg)
    w = np.array([a[2] for a in archs], float)
    w /= w.sum()
    arch = rng.choice(len(archs), size=(reps, C), p=w)
    comps_tab = np.array([_pad_comps(a[0]) for a in archs])
    stops_tab = np.array([_pad_stops(a[1]) for a in archs])
    ai_comps = comps_tab[arch]
    ai_stops = stops_tab[arch].astype(np.int32)
    jitter = np.rint(rng.standard_normal((reps, C, S_MAX)) * 2.0).astype(np.int32)
    real = ai_stops < INF_LAP
    ai_stops = np.where(real, ai_stops + jitter, ai_stops)
    # keep stops increasing with a minimum stint
    for k in range(1, S_MAX):
        prev = ai_stops[:, :, k - 1]
        cur = ai_stops[:, :, k]
        ai_stops[:, :, k] = np.where(cur < INF_LAP, np.maximum(cur, prev + cfg.min_stint + 1), cur)
    ai_stops = np.where(ai_stops < INF_LAP, np.clip(ai_stops, 4, cfg.laps - 4), ai_stops)
    ai_react = rng.random((reps, C))
    u_pass = rng.random((reps, L, C)).astype(np.float32)
    ev = np.zeros(reps, dtype=np.int8)
    ev = np.where((st == VSC).any(axis=1), 1, ev)
    ev = np.where((st == SC).any(axis=1), 2, ev)
    ev = np.where((st == RED).any(axis=1), 3, ev)
    sc1 = (st[:, 1:3] >= SC).any(axis=1)
    return World(reps, st, noise, pace, degk, pit_extra, start_off, ai_stops, ai_comps.astype(np.int8),
                 ai_react, u_pass, ev.astype(np.int8), sc1, deg_mult, pit_add, pass_add, haz_mult)


def _tyre_pen(cfg: Config, comp, age, degk, temp):
    lin = np.asarray(cfg.wear_lin)[comp]
    cliff = np.asarray(cfg.wear_cliff)[comp]
    quad = np.asarray(cfg.wear_quad)[comp]
    wear = lin * age + quad * np.clip(age - cliff, 0.0, None) ** 2
    window = 0.04 * np.clip(cfg.window_lo_c - temp, 0.0, None) + 0.03 * np.clip(temp - cfg.window_hi_c, 0.0, None)
    return wear * degk * cfg.deg_scale + window


def _tyre_temp(cfg: Config, comp, held, status):
    t = (np.asarray(cfg.temp_base_c)[comp] + cfg.temp_track_k * (cfg.track_c - cfg.ref_track_c)
         + cfg.temp_dirty_c * held)
    t = np.where(status[:, None] == SC, t - 9.0, np.where(status[:, None] == VSC, t - 4.0, t))
    return t


def simulate(cfg: Config, world: World, cand: Dict[str, np.ndarray], cand_idx: np.ndarray,
             rep_idx: np.ndarray, record: Optional[int] = None,
             status_override: Optional[np.ndarray] = None, track: bool = False) -> Dict[str, np.ndarray]:
    N = len(cand_idx)
    C, L = cfg.n_cars, cfg.laps
    ar = np.arange(N)
    status_all = world.status if status_override is None else status_override
    comps_plan = world.ai_comps[rep_idx].astype(np.int8)
    stops_plan = world.ai_stops[rep_idx].astype(np.int32)
    comps_plan[:, 0, :] = cand["comps"][cand_idx]
    stops_plan[:, 0, :] = cand["stops"][cand_idx]
    react_us = cand["react_sc"][cand_idx]
    uc_us = cand["uc_laps"][cand_idx]

    stint = np.zeros((N, C), dtype=np.int32)
    comp = comps_plan[:, :, 0].astype(np.int64)
    next_stop = stops_plan[:, :, 0].copy()
    age = np.zeros((N, C))
    age_laps = np.zeros((N, C), dtype=np.int32)
    fuel = np.full((N, C), cfg.start_fuel_kg)
    cum = world.start_off[rep_idx].copy()
    held = np.zeros((N, C))
    held_run = np.zeros((N, C), dtype=np.int32)
    outlap = np.zeros((N, C), dtype=bool)
    pace = world.pace[rep_idx]
    degk = world.degk[rep_idx]
    react_draw = world.ai_react[rep_idx]
    pits_done = np.zeros((N, C), dtype=np.int32)
    laps_held_us = np.zeros(N, dtype=np.int32)
    passes_us = np.zeros(N, dtype=np.int32)
    lost_us = np.zeros(N, dtype=np.int32)

    base = cfg.base_lap_s
    comp_off = np.asarray(cfg.comp_offset_s)
    pass_shift = cfg.pass_delta_s + world.pass_add[rep_idx]
    if track:
        lap_pos = np.zeros((N, L), dtype=np.int8)
        lap_g3 = np.zeros((N, L), dtype=np.float32)
        lap_comp = np.zeros((N, L), dtype=np.int8)
        lap_age = np.zeros((N, L), dtype=np.int16)
    log = None
    if record is not None:
        log = dict(order=[], cum=[], comp=[], age=[], status=[], lap_us=[], temp_us=[], fuel_us=[], pit=[], held=[])

    for l in range(1, L + 1):
        st = status_all[rep_idx, l]
        green = st == GREEN
        order_prev = np.argsort(cum, axis=1, kind="stable")

        temp = _tyre_temp(cfg, comp, held, st)
        pen = _tyre_pen(cfg, comp, age, degk, temp)
        lap_free = (base + comp_off[comp] + pen + cfg.fuel_s_per_kg * fuel + pace
                    + world.noise[rep_idx, l - 1] + np.where(outlap, cfg.outlap_pen_s, 0.0))
        if l == 1:
            lap_free = lap_free + cfg.start_loss_s
        lap_time = np.where(st[:, None] == GREEN, lap_free,
                            np.where(st[:, None] == VSC, cfg.vsc_lap_s, cfg.sc_lap_s) + world.noise[rep_idx, l - 1])

        # ---- pit decisions (end of this lap) --------------------------------
        more = next_stop < INF_LAP
        pit_plan = (next_stop == l) & (l < L)
        neutral = (st == VSC) | (st == SC)
        react = np.zeros((N, C), dtype=bool)
        react[:, 1:] = react_draw[:, 1:] < cfg.react_prob_ai
        react[:, 0] = react_us
        pit_react = neutral[:, None] & more & (age_laps >= cfg.react_min_age) & react & ((L - l) >= 6) & ~pit_plan
        uc_ok = np.zeros((N, C), dtype=bool)
        uc_ok[:, 0] = (uc_us > 0) & (held_run[:, 0] >= np.maximum(uc_us, 1))
        pit_uc = green[:, None] & uc_ok & more & (age_laps >= 8) & ((L - l) > 10) & ~pit_plan
        pit_red = (st == RED)[:, None] & (((L - l) >= 3)) & np.ones((N, C), dtype=bool)
        pit = (pit_plan | pit_react | pit_uc | pit_red) & (l < L)
        pit_f = np.where(st[:, None] == SC, cfg.sc_pit_factor, np.where(st[:, None] == VSC, cfg.vsc_pit_factor, 1.0))
        pit_time = np.where(pit & ~pit_red, (cfg.pit_loss_s + world.pit_extra[rep_idx, l - 1]) * pit_f, 0.0)

        # ---- arrivals with traffic ------------------------------------------
        t_nopit = cum + lap_time
        t_free = t_nopit + pit_time
        arr = t_free.copy()
        blocked_flag = np.zeros((N, C), dtype=bool)
        passed_flag = np.zeros((N, C), dtype=bool)
        if green.any():
            i1 = np.full(N, -1, dtype=np.int64)
            i2 = np.full(N, -1, dtype=np.int64)
            a1 = np.full(N, -np.inf)
            a2 = np.full(N, -np.inf)
            for r in range(C):
                c = order_prev[:, r]
                tc = t_free[ar, c]
                pit_c = pit[ar, c]
                if r > 0:
                    use1 = a1 >= a2
                    ref = np.where(use1, i1, i2)
                    ta = np.where(use1, a1, a2)
                    has = ref >= 0
                    refc = np.where(has, ref, 0)
                    g0 = cum[ar, c] - cum[ar, refc]
                    delta = lap_free[ar, refc] - lap_free[ar, c]
                    cond = green & has & ~pit_c & (tc < ta + cfg.follow_gap_s)
                    attempt = cond & (g0 < cfg.zone_s)
                    p = 1.0 / (1.0 + np.exp(-(delta - pass_shift) / cfg.pass_scale_s))
                    success = world.u_pass[rep_idx, l - 1, c] < p
                    do_pass = attempt & success & (tc < ta + 0.3)
                    new_t = np.where(do_pass, np.minimum(tc + cfg.pass_cost_s, ta - 0.1),
                                     np.where(cond, ta + cfg.follow_gap_s, tc))
                    arr[ar, c] = np.where(green, new_t, tc)
                    blocked_flag[ar, c] = cond & ~do_pass
                    passed_flag[ar, c] = do_pass
                    tc_final = arr[ar, c]
                else:
                    tc_final = tc
                # update the two most recent non-pitting cars
                upd = ~pit_c
                i2 = np.where(upd, i1, i2)
                a2 = np.where(upd, a1, a2)
                i1 = np.where(upd, c, i1)
                a1 = np.where(upd, tc_final, a1)
            arr = np.where(green[:, None], arr, t_free)

        # ---- neutralisation: bunch the field -----------------------------------
        sc_idx = np.nonzero(st >= SC)[0]
        if len(sc_idx):
            tn = t_nopit[sc_idx]
            o = np.argsort(tn, axis=1, kind="stable")
            srt = np.take_along_axis(tn, o, axis=1)
            cap = np.where(st[sc_idx] == RED, cfg.red_gap_s, cfg.sc_gap_s)
            newt = srt.copy()
            for r in range(1, C):
                newt[:, r] = newt[:, r - 1] + np.minimum(srt[:, r] - srt[:, r - 1], cap)
            res = np.empty_like(newt)
            np.put_along_axis(res, o, newt, axis=1)
            arr[sc_idx] = res + pit_time[sc_idx]

        # ---- bookkeeping ------------------------------------------------------
        if record is not None:
            n = record
            log["order"].append(np.argsort(arr[n]).tolist())
            log["cum"].append(arr[n].tolist())
            log["comp"].append(comp[n].tolist())
            log["age"].append(age_laps[n].tolist())
            log["status"].append(int(st[n]))
            log["lap_us"].append(float(arr[n, 0] - cum[n, 0]))
            log["temp_us"].append(float(temp[n, 0]))
            log["fuel_us"].append(float(fuel[n, 0]))
            log["pit"].append(pit[n].tolist())
            log["held"].append(bool(blocked_flag[n, 0]))

        laps_held_us += blocked_flag[:, 0]
        passes_us += passed_flag[:, 0]
        cum = arr
        if track:
            lap_pos[:, l - 1] = (cum < cum[:, :1]).sum(axis=1) + 1
            lap_g3[:, l - 1] = cum[:, 0] - np.partition(cum, 2, axis=1)[:, 2]
            lap_comp[:, l - 1] = comp[:, 0]
            lap_age[:, l - 1] = age_laps[:, 0] + 1
        held = blocked_flag.astype(float)
        held_run = np.where(blocked_flag, held_run + 1, 0)

        wear_f = np.where(st == SC, cfg.sc_wear_f, np.where(st == VSC, cfg.vsc_wear_f, 1.0))[:, None]
        therm = 1.0 + cfg.thermal_k * np.clip(temp - 100.0, 0.0, None)
        inc = therm * (1.0 + cfg.wear_dirty * held) * wear_f
        fuel_f = np.where(st == SC, cfg.sc_fuel_f, np.where(st == VSC, cfg.vsc_fuel_f, np.where(st == RED, cfg.sc_fuel_f, 1.0)))[:, None]
        fuel = np.maximum(fuel - cfg.fuel_burn_kg_lap * fuel_f, 0.0)

        # tyre change
        if pit.any():
            new_stint = np.minimum(stint + 1, S_MAX)
            planned_next = np.take_along_axis(comps_plan, np.minimum(new_stint, S_MAX)[:, :, None], axis=2)[:, :, 0]
            next_plan_stop = np.take_along_axis(
                np.concatenate([stops_plan, np.full((N, C, 1), INF_LAP, dtype=np.int32)], axis=2),
                np.minimum(new_stint, S_MAX)[:, :, None], axis=2)[:, :, 0]
            early = pit & ~pit_plan
            guard = np.where(early, np.maximum(next_plan_stop, l + cfg.min_stint + 4), next_plan_stop)
            guard = np.where(next_plan_stop >= INF_LAP, INF_LAP, guard)
            rem = L - l
            red_comp = np.where(rem >= 40, 2, np.where(rem >= 22, 1, 0))
            if pit_red.any():
                use_red = pit_red & pit
                planned_next = np.where(use_red, red_comp, planned_next)
                guard = np.where(use_red, INF_LAP, guard)
            comp = np.where(pit, planned_next, comp)
            next_stop = np.where(pit, guard, next_stop)
            stint = np.where(pit, new_stint, stint)
            age = np.where(pit, 0.0, age + inc)
            age_laps = np.where(pit, 0, age_laps + 1)
            outlap = pit.copy()
            pits_done += pit
            held_run = np.where(pit, 0, held_run)
        else:
            age = age + inc
            age_laps = age_laps + 1
            outlap = np.zeros((N, C), dtype=bool)

    final_order = np.argsort(cum, axis=1, kind="stable")
    pos = np.empty((N, C), dtype=np.int32)
    np.put_along_axis(pos, final_order, np.arange(1, C + 1, dtype=np.int32)[None, :].repeat(N, axis=0), axis=1)
    out = dict(pos=pos[:, 0], race_time=cum[:, 0], leader_time=cum.min(axis=1), pits=pits_done[:, 0],
               held_laps=laps_held_us, passes=passes_us, all_pos=pos)
    if track:
        out.update(lap_pos=lap_pos, lap_g3=lap_g3, lap_comp=lap_comp, lap_age=lap_age)
    if log is not None:
        log["pit_laps_us"] = [i + 1 for i, p in enumerate(log["pit"]) if p[0]]
        out["log"] = log
    return out


POINTS = np.array([25, 18, 15, 12, 10, 8, 6, 4, 2, 1] + [0] * 12, dtype=float)


def summarise(pos: np.ndarray, race_time: np.ndarray, leader_time: np.ndarray, C: int = 22) -> Dict:
    n = len(pos)
    hist = np.bincount(pos, minlength=C + 1)[1:C + 1] / n
    return dict(
        n=int(n),
        p_podium=float((pos <= 3).mean()),
        p_win=float((pos == 1).mean()),
        p_top5=float((pos <= 5).mean()),
        p_points=float((pos <= 10).mean()),
        e_pos=float(pos.mean()),
        e_points=float(POINTS[pos - 1].mean()),
        hist=hist.tolist(),
        t_p10=float(np.percentile(race_time, 10)),
        t_p50=float(np.percentile(race_time, 50)),
        t_p90=float(np.percentile(race_time, 90)),
        gap_p50=float(np.percentile(race_time - leader_time, 50)),
    )
