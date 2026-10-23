"""Runs the full analysis and writes dashboard/data/results.json."""
from __future__ import annotations

import datetime as dt
import json
import math
import time
from pathlib import Path
from typing import Dict, List

import numpy as np

from . import strategies as S
from . import track as T
from .config import COMP_CODES, COMP_NAMES, COMP_PIRELLI, INF_LAP, Config, PROVENANCE
from .sim import (field_archetypes, GREEN, RED, SC, VSC, World, generate_status, generate_world, forced_status,
                  grid_ranks, simulate, summarise, _tyre_pen, _tyre_temp)


def car_labels(cfg: Config) -> List[str]:
    """Display name of each car index (0 = us) from the running order after turn 1."""
    rank = grid_ranks(cfg)
    out = ["YOU"]
    for c in range(1, cfg.n_cars):
        r = int(rank[c])
        if r == 0:
            out.append("LEADER (P1)")
        elif cfg.lap1_pos > cfg.grid_pos and r == cfg.lap1_pos - 2:
            out.append(f"T1 PASSER (P{r + 1})")
        else:
            out.append(f"P{r + 1} AFTER T1")
    return out

KIND_NAMES = {1: "VSC", 2: "SC", 3: "Red flag"}

SCENARIOS = [
    ("green", "Green flag", []),
    ("vsc", "VSC · L20", [(20, VSC, 2)]),
    ("sc", "SC · L20", [(20, SC, 4)]),
    ("sc_late", "SC · L52", [(52, SC, 4)]),
    ("red", "Red flag · L30", [(30, RED, 2)]),
]


def scenarios_for(cfg: Config):
    sc = list(SCENARIOS)
    if cfg.force_lap > 0 and cfg.force_kind in KIND_NAMES:
        dur = max(cfg.force_dur, 1)
        sc.append(("custom", f"{KIND_NAMES[cfg.force_kind]} · L{cfg.force_lap} (your event)", [(cfg.force_lap, cfg.force_kind, dur)]))
    return sc


def fmt_time(s: float) -> str:
    h = int(s // 3600)
    m = int((s % 3600) // 60)
    sec = s - 3600 * h - 60 * m
    return f"{h}:{m:02d}:{sec:06.3f}"


def fmt_lap(s: float) -> str:
    return f"{int(s // 60)}:{s % 60:06.3f}"


# ----------------------------------------------------------------------------
# model blocks
# ----------------------------------------------------------------------------
def tyre_block(cfg: Config) -> Dict:
    out = []
    ages = np.arange(0, 50)
    for c in range(3):
        row = dict(code=COMP_CODES[c], name=COMP_NAMES[c], pirelli=COMP_PIRELLI[c],
                   offset_s=cfg.comp_offset_s[c], max_life=cfg.max_life[c], curves={})
        for tag, dair in (("cool", -8.0), ("nominal", 0.0), ("hot", 8.0)):
            cc = cfg.with_(air_c=cfg.air_c + dair)
            comp = np.array([[c]])
            temp = float(_tyre_temp(cc, comp, np.zeros((1, 1)), np.zeros(1, int))[0, 0])
            therm = 1.0 + cc.thermal_k * max(temp - 100.0, 0.0)
            eff = ages * therm
            pen = _tyre_pen(cc, np.full(len(ages), c)[None, :], eff[None, :], np.ones((1, len(ages))),
                            np.full((1, len(ages)), temp))[0]
            row["curves"][tag] = dict(temp=round(temp, 1), pen=[round(float(x), 3) for x in pen])
        nom = np.array(row["curves"]["nominal"]["pen"])
        row["temp_c"] = row["curves"]["nominal"]["temp"]
        row["deg_early"] = round(float((nom[8] - nom[0]) / 8), 4)
        row["loss_10"] = round(float(nom[10]), 2)
        row["loss_20"] = round(float(nom[20]), 2)
        row["loss_30"] = round(float(nom[30]), 2)
        row["loss_at_life"] = round(float(nom[min(cfg.max_life[c], 49)]), 2)
        slope = np.diff(nom)
        base_slope = slope[:6].mean()
        cl = next((i for i in range(6, len(slope)) if slope[i] > base_slope * 1.6), None)
        row["cliff_lap"] = int(cl) if cl is not None else None
        row["window_c"] = [cfg.window_lo_c, cfg.window_hi_c]
        row["lap_fresh"] = dict(
            lap2=cfg.base_lap_s + cfg.comp_offset_s[c] + cfg.fuel_s_per_kg * (cfg.start_fuel_kg - cfg.fuel_burn_kg_lap),
            mid=cfg.base_lap_s + cfg.comp_offset_s[c] + cfg.fuel_s_per_kg * (cfg.start_fuel_kg / 2),
            light=cfg.base_lap_s + cfg.comp_offset_s[c] + cfg.fuel_s_per_kg * 8.0,
            quali=cfg.pole_lap_s + cfg.comp_offset_s[c])
        out.append(row)
    return dict(compounds=out, ages=ages.tolist())


def fuel_block(cfg: Config) -> Dict:
    laps = np.arange(0, cfg.laps + 1)
    fuel = np.maximum(cfg.start_fuel_kg - cfg.fuel_burn_kg_lap * laps, cfg.fuel_end_kg)
    full_flow_kg_h = cfg.flow_limit_mj_h / cfg.fuel_lhv_mj_kg
    lap_s = cfg.base_lap_s + 1.5
    return dict(
        laps=laps.tolist(), fuel_kg=[round(float(x), 2) for x in fuel],
        mass_kg=[round(float(cfg.min_mass_kg + x), 1) for x in fuel],
        lap_penalty_s=[round(float(cfg.fuel_s_per_kg * x), 3) for x in fuel],
        start_fuel_kg=cfg.start_fuel_kg, end_fuel_kg=cfg.fuel_end_kg, burn_kg_lap=cfg.fuel_burn_kg_lap,
        start_mass_kg=cfg.min_mass_kg + cfg.start_fuel_kg, end_mass_kg=cfg.min_mass_kg + cfg.fuel_end_kg,
        full_flow_kg_h=full_flow_kg_h, full_flow_kg_lap=full_flow_kg_h * lap_s / 3600.0,
        race_fuel_low=0.80 * full_flow_kg_h * lap_s / 3600.0 * cfg.laps,
        race_fuel_high=0.90 * full_flow_kg_h * lap_s / 3600.0 * cfg.laps,
        total_burn_kg=cfg.fuel_burn_kg_lap * cfg.laps,
        min_mass_kg=cfg.min_mass_kg, fuel_s_per_kg=cfg.fuel_s_per_kg)


def incident_block(cfg: Config, n: int = 40000) -> Dict:
    rng = np.random.default_rng(cfg.seed + 99)
    st = generate_status(cfg, n, rng)
    L = cfg.laps
    any_sc = (st == SC).any(axis=1)
    any_vsc = (st == VSC).any(axis=1)
    any_red = (st == RED).any(axis=1)
    laps_arr = np.arange(1, L + 1)
    per_lap_sc = [(st[:, l] == SC).mean() for l in laps_arr]
    per_lap_vsc = [(st[:, l] == VSC).mean() for l in laps_arr]
    per_lap_red = [(st[:, l] == RED).mean() for l in laps_arr]
    sc_laps = (st == SC).sum(axis=1)
    return dict(
        p_sc=float(any_sc.mean()), p_vsc=float(any_vsc.mean()), p_red=float(any_red.mean()),
        p_any=float((any_sc | any_vsc | any_red).mean()),
        p_sc_window=float(((st[:, 12:27] == SC) | (st[:, 12:27] == RED)).any(axis=1).mean()),
        p_neutral_first_stop_window=float((st[:, 12:27] >= VSC).any(axis=1).mean()),
        p_sc_lap1_2=float((st[:, 1:3] >= SC).any(axis=1).mean()),
        mean_sc_laps_given_sc=float(sc_laps[any_sc].mean()) if any_sc.any() else 0.0,
        per_lap_sc=[round(float(x), 5) for x in per_lap_sc],
        per_lap_vsc=[round(float(x), 5) for x in per_lap_vsc],
        per_lap_red=[round(float(x), 5) for x in per_lap_red],
        note="Priors tuned to Barcelona's modest neutralisation rate; run fetch_fastf1.py to replace them with 2019-2026 counts.")


def decision_block(cfg: Config) -> Dict:
    d = np.round(np.arange(-0.2, 2.01, 0.1), 2)
    p = 1.0 / (1.0 + np.exp(-(d - cfg.pass_delta_s) / cfg.pass_scale_s))
    # undercut / stay-out break-even: pit for the next compound now vs staying out for the rest of the stint
    ages = list(range(6, 33, 2))
    rows = []
    for c in range(3):
        target = 2 if c != 2 else 1
        row = dict(code=COMP_CODES[c], target=COMP_CODES[target], cells=[])
        for a in ages:
            if a > cfg.max_life[c] + 2:
                row["cells"].append(None)
                continue
            gain = -(cfg.pit_loss_s + cfg.outlap_pen_s)
            found = None
            for k in range(1, 40):
                old_pen = float(_tyre_pen(cfg, np.array([[c]]), np.array([[(a + k) * 1.1]]), np.ones((1, 1)),
                                          np.array([[100.0]]))[0, 0])
                new_pen = float(_tyre_pen(cfg, np.array([[target]]), np.array([[k * 1.0]]), np.ones((1, 1)),
                                          np.array([[95.0]]))[0, 0])
                gain += (cfg.comp_offset_s[c] + old_pen) - (cfg.comp_offset_s[target] + new_pen)
                if gain >= 0:
                    found = k
                    break
            row["cells"].append(found)
        rows.append(row)
    return dict(pass_delta=d.tolist(), pass_prob=[round(float(x), 4) for x in p],
                zone_s=cfg.zone_s, follow_gap_s=cfg.follow_gap_s, pass_delta_50=cfg.pass_delta_s,
                breakeven_ages=ages, breakeven=rows,
                dirty_air=dict(temp_c=cfg.temp_dirty_c, wear_pct=cfg.wear_dirty * 100))


# ----------------------------------------------------------------------------
# strategy analysis
# ----------------------------------------------------------------------------
def stints_of(cfg: Config, s: dict) -> List[dict]:
    bounds = [0] + list(s["stops"]) + [cfg.laps]
    return [dict(comp=COMP_CODES[c], start=bounds[i] + 1, end=bounds[i + 1], laps=bounds[i + 1] - bounds[i])
            for i, c in enumerate(s["comps"])]


def rules_of(cfg: Config, s: dict) -> List[str]:
    r = [f"Safety car / VSC with tyres ≥ {cfg.react_min_age} laps old and a stop still to make → box (stop costs ~{int(cfg.sc_pit_factor*100)} % under SC, ~{int(cfg.vsc_pit_factor*100)} % under VSC).",
         "Red flag → free tyre change; pick the compound by remaining distance (≥40 laps hard, 22-39 medium, otherwise soft)."]
    if s["uc_laps"] > 0:
        r.insert(0, f"Stuck within {cfg.zone_s:.1f} s of a car for {s['uc_laps']} laps with tyres ≥ 8 laps old and >10 laps to go → pit now (undercut) instead of waiting for the planned lap.")
    else:
        r.insert(0, "Stay on the planned stop laps; if stuck, keep trying to pass and accept the tyre cost.")
    return r


def scenario_breakdown(world: World, raw: dict) -> Dict:
    pos = raw["pos"]
    out = {}
    classes = {"clean": world.ev_class == 0, "vsc": world.ev_class == 1, "sc": world.ev_class == 2, "red": world.ev_class == 3,
               "early_sc": world.sc_start1}
    for k, m in classes.items():
        n = int(m.sum())
        if n == 0:
            out[k] = dict(share=0.0, n=0, p_podium=None, e_pos=None, p_win=None)
            continue
        out[k] = dict(share=n / len(pos), n=n, p_podium=float((pos[m] <= 3).mean()),
                      p_win=float((pos[m] == 1).mean()), e_pos=float(pos[m].mean()))
    return out


def run_replay(cfg: Config, strat: dict, scenario, reps: int = 240, seed: int = 4242) -> Dict:
    key, label, events = scenario
    st = forced_status(cfg, reps, events)
    w = generate_world(cfg, reps, seed, status=st, unc=False)
    tab = S.pack([strat])
    out = simulate(cfg, w, tab, np.zeros(reps, int), np.arange(reps))
    pos, tm = out["pos"], out["race_time"]
    med_pos = float(np.median(pos))
    cand = np.nonzero(np.abs(pos - med_pos) == np.abs(pos - med_pos).min())[0]
    rep = int(cand[np.argmin(np.abs(tm[cand] - np.median(tm[cand])))])
    rec = simulate(cfg, w, tab, np.zeros(1, int), np.array([rep]), record=0)
    lg = rec["log"]
    C = cfg.n_cars
    # starting state
    so = w.start_off[rep]
    start_order = np.argsort(so).tolist()
    start_gap = (so[start_order] - so.min()).round(3).tolist()
    start_comp = [int(strat["comps"][0])] + [int(x) for x in w.ai_comps[rep][1:, 0]]
    start_comp = [start_comp[0]] + start_comp[1:]
    cum = np.array(lg["cum"])
    gaps = (cum - cum.min(axis=1, keepdims=True))
    order = np.array(lg["order"])
    gap_sorted = np.take_along_axis(gaps, order, axis=1)
    pit_laps = {str(c): [i + 1 for i, p in enumerate(lg["pit"]) if p[c]] for c in range(C)}
    return dict(
        key=key, label=label, rep=rep, finish=int(rec["pos"][0]), race_time=float(rec["race_time"][0]),
        mean_finish=float(pos.mean()), p_podium=float((pos <= 3).mean()), p_win=float((pos == 1).mean()),
        leader_time_mean=float(out["leader_time"].mean()),
        start=dict(order=start_order, gap=start_gap, comp=start_comp),
        order=order.tolist(), gap=np.round(gap_sorted, 3).tolist(), comp=lg["comp"], age=lg["age"],
        status=lg["status"], lap_us=[round(x, 3) for x in lg["lap_us"]], temp_us=[round(x, 1) for x in lg["temp_us"]],
        fuel_us=[round(x, 2) for x in lg["fuel_us"]], pit_laps=pit_laps, held_us=lg["held"],
        events=[dict(lap=a, kind=int(b), dur=c) for (a, b, c) in events])


def sensitivity(cfg: Config, strats: List[dict], reps: int = 1200) -> List[dict]:
    variants = [
        ("Baseline", {}),
        ("Hot day  +8 °C", dict(air_c=cfg.air_c + 8)),
        ("Cool day  −8 °C", dict(air_c=cfg.air_c - 8)),
        ("Degradation +25 %", dict(deg_scale=1.25)),
        ("Degradation −20 %", dict(deg_scale=0.80)),
        ("Pit loss +3 s", dict(pit_loss_s=cfg.pit_loss_s + 3.0)),
        ("Chaotic race (SC ×2)", dict(h_sc=cfg.h_sc * 2, h_vsc=cfg.h_vsc * 1.5, h_red=cfg.h_red * 2)),
        ("No neutralisations", dict(h_sc=0.0, h_vsc=0.0, h_red=0.0, h_sc_lap1=0.0)),
        ("Overtaking harder (+0.3 s)", dict(pass_delta_s=cfg.pass_delta_s + 0.3)),
        ("Overtaking easier (−0.3 s)", dict(pass_delta_s=cfg.pass_delta_s - 0.3)),
    ]
    out = []
    for name, kw in variants:
        c2 = cfg.with_(**kw)
        w = generate_world(c2, reps, cfg.seed + 555, unc=False)
        res = S.evaluate(c2, strats, w)
        out.append(dict(name=name, results=[dict(p_podium=r["p_podium"], e_pos=r["e_pos"], p_win=r["p_win"]) for r in res]))
    return out


def stop_window(cfg: Config, strat: dict, reps: int = 1500) -> Dict:
    shifts = list(range(-6, 7, 2))
    cands = []
    for sh in shifts:
        stops = list(strat["stops"])
        stops[0] = int(np.clip(stops[0] + sh, 5, cfg.laps - 8))
        if len(stops) > 1 and stops[1] <= stops[0] + cfg.min_stint:
            stops[1] = stops[0] + cfg.min_stint + 1
        c = dict(strat)
        c["stops"] = stops
        cands.append(c)
    w = generate_world(cfg, reps, cfg.seed + 777)
    res = S.evaluate(cfg, cands, w)
    return dict(shifts=shifts, first_stop=[c["stops"][0] for c in cands],
                p_podium=[r["p_podium"] for r in res], e_pos=[r["e_pos"] for r in res])


def wilson(k: float, n: int, z: float = 1.96):
    if n == 0:
        return (0.0, 1.0)
    p = k / n
    den = 1 + z * z / n
    c = (p + z * z / (2 * n)) / den
    hw = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return (max(0.0, c - hw), min(1.0, c + hw))


def _q(a, qs=(10, 50, 90)):
    return [float(x) for x in np.percentile(a, qs)]


def forecast_block(cfg: Config, world: World, raws: List[dict], pt_res: List[dict]) -> Dict:
    """Checkpoint forecasts, fan charts, confidence intervals and parameter sensitivity for the chosen plans."""
    L, C = cfg.laps, cfg.n_cars
    cps = [max(1, min(L, int(math.floor(f * L + 0.5)))) for f in cfg.checkpoints]
    groups = [("P1–P3", 1, 3), ("P4", 4, 4), ("P5–P6", 5, 6), ("P7–P10", 7, 10), ("P11+", 11, C)]
    par = dict(
        deg=dict(label="Tyre wear rate", vals=world.deg_mult, fmt=lambda v: f"{(v - 1) * 100:+.0f}%"),
        pit=dict(label="Pit-stop time loss", vals=world.pit_add, fmt=lambda v: f"{v:+.1f} s"),
        pas=dict(label="Overtaking difficulty", vals=world.pass_add, fmt=lambda v: f"{v:+.2f} s"),
        haz=dict(label="Safety-car / incident rate", vals=world.haz_mult, fmt=lambda v: f"×{v:.2f}"))
    per_plan = []
    for raw, pt in zip(raws, pt_res):
        pos = raw["pos"]
        n = len(pos)
        lp = raw["lap_pos"].astype(int)
        podium = pos <= 3
        lo, hi = wilson(float(podium.sum()), n)
        worst = np.sort(pos)[int(0.9 * n):]
        unc = dict(
            p_podium=float(podium.mean()), ci=[lo, hi], p_podium_point=pt["p_podium"], e_pos_point=pt["e_pos"],
            e_pos_se=float(pos.std() / math.sqrt(n)), bad10_pos=float(worst.mean()),
            p_outside_top6=float((pos > 6).mean()), p_outside_top10=float((pos > 10).mean()),
            pos_p10=_q(pos)[0], pos_p50=_q(pos)[1], pos_p90=_q(pos)[2], n=n, params=[])
        for key, d in par.items():
            v = np.asarray(d["vals"], float)
            if np.ptp(v) < 1e-12:
                continue
            q1, q2 = np.percentile(v, [33.3, 66.7])
            bins = [v <= q1, (v > q1) & (v <= q2), v > q2]
            unc["params"].append(dict(
                key=key, label=d["label"],
                ranges=[d["fmt"](float(v[m].mean())) for m in bins],
                p_podium=[float((pos[m] <= 3).mean()) for m in bins],
                e_pos=[float(pos[m].mean()) for m in bins]))
        fan = dict(laps=list(range(1, L + 1)),
                   q10=[], q25=[], q50=[], q75=[], q90=[], p_podium=[], gap3_p50=[])
        for l in range(L):
            col = lp[:, l]
            a = np.percentile(col, [10, 25, 50, 75, 90])
            for k, key in enumerate(("q10", "q25", "q50", "q75", "q90")):
                fan[key].append(float(a[k]))
            fan["p_podium"].append(float((col <= 3).mean()))
            fan["gap3_p50"].append(float(np.median(raw["lap_g3"][:, l])))
        checkpoints = []
        for f, lap in zip(cfg.checkpoints, cps):
            col = lp[:, lap - 1]
            hist = (np.bincount(col, minlength=C + 1)[1:C + 1] / n).tolist()
            g3 = raw["lap_g3"][:, lap - 1]
            comps = raw["lap_comp"][:, lap - 1]
            modal = int(np.bincount(comps, minlength=3).argmax())
            ages = raw["lap_age"][:, lap - 1][comps == modal]
            trans = []
            for name, a, b in groups:
                m = (col >= a) & (col <= b)
                trans.append(dict(group=name, share=float(m.mean()),
                                  p_podium=float(podium[m].mean()) if m.any() else None,
                                  e_pos=float(pos[m].mean()) if m.any() else None))
            checkpoints.append(dict(
                frac=f, lap=lap, hist=hist, p_podium_now=float((col <= 3).mean()), p_lead=float((col == 1).mean()),
                pos_q=_q(col, (10, 50, 90)), pos_mean=float(col.mean()), gap3_q=_q(g3), gap3_mean=float(g3.mean()),
                p_podium_final_given_podium_now=float(podium[col <= 3].mean()) if (col <= 3).any() else None,
                p_podium_final_given_not=float(podium[col > 3].mean()) if (col > 3).any() else None,
                tyre=dict(comp=COMP_CODES[modal], age=int(np.median(ages)) if len(ages) else 0, share=float((comps == modal).mean())),
                transition=trans))
        per_plan.append(dict(checkpoints=checkpoints, fan=fan, uncertainty=unc))
    # head-to-head and rank stability across the chosen plans (same random races, paired)
    k = len(raws)
    pos_all = np.stack([r["pos"] for r in raws])
    pod_all = (pos_all <= 3).astype(float)
    h2h = []
    for i in range(k):
        for j in range(i + 1, k):
            d = pod_all[i] - pod_all[j]
            se = d.std() / math.sqrt(len(d))
            h2h.append(dict(a=i, b=j, a_ahead=float((pos_all[i] < pos_all[j]).mean()), tie=float((pos_all[i] == pos_all[j]).mean()),
                            b_ahead=float((pos_all[j] < pos_all[i]).mean()), d_podium=float(d.mean()), d_ci=[float(d.mean() - 1.96 * se), float(d.mean() + 1.96 * se)]))
    rng = np.random.default_rng(cfg.seed + 31337)
    B, n = 500, pos_all.shape[1]
    idx = rng.integers(0, n, size=(B, n))
    sc = np.stack([pod_all[i][idx].mean(axis=1) - 0.0005 * pos_all[i][idx].mean(axis=1) for i in range(k)])
    best = sc.argmax(axis=0)
    p_best = [float((best == i).mean()) for i in range(k)]
    return dict(checkpoint_laps=cps, plans=per_plan, head2head=h2h, p_best=p_best,
                uncertainty_model=dict(enabled=bool(cfg.uncertainty), deg_sigma=cfg.unc_deg_sigma, pit_sigma_s=cfg.unc_pit_sigma_s,
                                       pass_sigma_s=cfg.unc_pass_sigma_s, hazard_sigma=cfg.unc_hazard_sigma))


def build_qa(cfg: Config, tyres: Dict, fuel: Dict, trk: Dict, inc: Dict, best_by: Dict, field_lap: Dict) -> List[dict]:
    def comp(c):
        return tyres["compounds"][c]
    c0, c1, c2 = comp(0), comp(1), comp(2)
    cs = trk["corners"]
    fastest_corner = max(cs, key=lambda c: c["apex_kmh"])
    slowest_corner = min(cs, key=lambda c: c["apex_kmh"])
    st = max(trk["straights"], key=lambda s: s["vmax_kmh"])
    main = max(trk["straights"], key=lambda s: s["length_m"])
    qa = []
    qa.append(dict(
        id=1, q="Fuel load and car weight", conf="model",
        a=(f"Start ≈ {fuel['start_fuel_kg']:.0f} kg, finish ≈ {fuel['end_fuel_kg']:.1f} kg (≈ {fuel['burn_kg_lap']:.2f} kg/lap). "
           f"Car + driver minimum is {cfg.min_mass_kg:.0f} kg without fuel (FIA 2026), so the car races at ≈ {fuel['start_mass_kg']:.0f} kg on the grid "
           f"and ≈ {fuel['end_mass_kg']:.0f} kg at the flag. 2026 has no per-race fuel mass cap; the figure is derived from the "
           f"{cfg.flow_limit_mj_h:.0f} MJ/h energy-flow limit ({fuel['full_flow_kg_h']:.0f} kg/h at {cfg.fuel_lhv_mj_kg:.0f} MJ/kg → "
           f"{fuel['race_fuel_low']:.0f}-{fuel['race_fuel_high']:.0f} kg for 80-90 % duty). Treat it as ±8 kg."),
        data=dict(start=fuel["start_fuel_kg"], end=fuel["end_fuel_kg"])))
    lf = lambda c: comp(c)["lap_fresh"]
    qa.append(dict(
        id=2, q="Standard lap time per compound", conf="calibrated",
        a=(f"Anchored to the 2026 pole lap {fmt_lap(cfg.pole_lap_s)} (soft, qualifying trim). Race pace, fresh tyre, clean air: "
           f"Soft {fmt_lap(lf(0)['lap2'])} on lap 2 → {fmt_lap(lf(0)['mid'])} mid-race → {fmt_lap(lf(0)['light'])} light; "
           f"Medium +{cfg.comp_offset_s[1]:.2f} s; Hard +{cfg.comp_offset_s[2]:.2f} s on the same fuel. "
           f"Real race fastest laps were 1:20.1-1:20.6, which this reproduces."),
        data={}))
    qa.append(dict(
        id=3, q="Degradation rate per compound", conf="assumed",
        a=(f"Early-stint slope (s/lap): Soft {c0['deg_early']:.3f}, Medium {c1['deg_early']:.3f}, Hard {c2['deg_early']:.3f} at {cfg.air_c:.0f} °C air. "
           f"The cliff starts around lap {c0['cliff_lap']} (Soft), {c1['cliff_lap']} (Medium) and {c2['cliff_lap']} (Hard) of a stint; total pace lost vs a fresh tyre after 10 / 20 / 30 laps: "
           f"Soft {c0['loss_10']:.1f} / {c0['loss_20']:.1f} / {c0['loss_30']:.1f} s, Medium {c1['loss_10']:.1f} / {c1['loss_20']:.1f} / {c1['loss_30']:.1f} s, Hard {c2['loss_10']:.1f} / {c2['loss_20']:.1f} / {c2['loss_30']:.1f} s. "
           f"Pirelli describes Barcelona degradation as predominantly thermal with the front axle limiting, so wear accelerates above 100 °C surface temperature. "
           f"These rates are priors: fetch_fastf1.py can replace them with fuel-corrected fits."),
        data={}))
    qa.append(dict(
        id=4, q="Highest speed on each corner and straight", conf="model",
        a=(f"Model apex speeds run from {slowest_corner['apex_kmh']:.0f} km/h (T{slowest_corner['n']}) to {fastest_corner['apex_kmh']:.0f} km/h "
           f"(T{fastest_corner['n']}); top speed ≈ {st['vmax_kmh']:.0f} km/h on {st['name']}, "
           f"with the start/finish straight ({main['length_m']:.0f} m) reaching ≈ {main['vmax_kmh']:.0f} km/h. "
           f"Full table is on the Track tab. Source: {trk['source']}."),
        data={}))
    qa.append(dict(
        id=5, q="Pit-lane speed limit and pit delta", conf="assumed",
        a=(f"Pit-lane limit {cfg.pit_limit_kmh:.0f} km/h (verify against the FIA event notes). Green-flag time loss ≈ {cfg.pit_loss_s:.1f} s "
           f"(σ {cfg.pit_sigma_s:.1f} s, {cfg.slow_stop_p*100:.0f} % chance of a 2-6 s slow stop); under SC ≈ {cfg.pit_loss_s*cfg.sc_pit_factor:.1f} s, "
           f"under VSC ≈ {cfg.pit_loss_s*cfg.vsc_pit_factor:.1f} s."),
        data={}))
    b = best_by
    parts = []
    for n in (1, 2, 3):
        if n in b:
            m = b[n]["metrics"]
            parts.append(f"best {n}-stop {b[n]['label']}: podium {m['p_podium']*100:.0f} %, E[finish] P{m['e_pos']:.1f}")
    qa.append(dict(
        id=6, q="1-stop vs 2-stop (vs 3-stop)", conf="model",
        a="Starting P4 with the field on typical strategies: " + "; ".join(parts) +
          f". Green-flag, no-traffic race times differ by single-digit seconds between stop counts, so track position and neutralisations decide it."
          if parts else "see strategy tab",
        data={}))
    qa.append(dict(
        id=7, q="Stuck behind a car: overtake or pit?", conf="assumed",
        a=(f"Within {cfg.zone_s:.1f} s a pass is attempted each lap with probability = logistic((pace edge − {cfg.pass_delta_s:.2f} s)/{cfg.pass_scale_s:.2f}); "
           f"the follower is held at ≥ {cfg.follow_gap_s:.2f} s otherwise, runs {cfg.temp_dirty_c:.0f} °C hotter and wears {cfg.wear_dirty*100:.0f} % faster. "
           f"The strategy search compares 'keep trying' against 'undercut after 3 or 5 stuck laps'; break-even tables are on the Risk tab."),
        data={}))
    qa.append(dict(
        id=8, q="Chances of VSC, SC and red flag", conf="assumed",
        a=(f"Per-race: SC ≈ {inc['p_sc']*100:.0f} %, VSC ≈ {inc['p_vsc']*100:.0f} %, red flag ≈ {inc['p_red']*100:.0f} %, any neutralisation ≈ {inc['p_any']*100:.0f} %. "
           f"A neutralisation lands inside the first stop window (laps 12-26) in ≈ {inc['p_neutral_first_stop_window']*100:.0f} % of races."),
        data={}))
    qa.append(dict(
        id=9, q="Other factors modelled", conf="model",
        a=("Fuel burn (lighter car each lap), thermal tyre window 85-110 °C and thermal wear acceleration, dirty-air heating, out-lap warm-up, "
           "standing-start loss, slow stops, SC bunching, reduced SC/VSC pit cost, red-flag free tyres, field strategy mix with SC reactions, "
           "common random numbers across strategies. Not modelled: lapped traffic, penalties, weather change, ERS state-of-charge per car, "
           "tyre-set availability, damage, driver-specific skill."),
        data={}))
    return qa


# ----------------------------------------------------------------------------
def run(cfg: Config, outdir: str | Path, workers: int = 1, real_track: str | Path | None = None, quick: bool = False):
    t0 = time.time()
    outdir = Path(outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    print("[1/8] track model")
    trk = T.build_track(cfg, real_track)

    print("[2/8] strategy search")
    board, raw3, w3, keep3 = S.search(cfg, workers=workers)
    top = S.pick_top3(board)
    used = set()
    for i, s in enumerate(top):
        nm = f"{COMP_NAMES[s['comps'][0]]} start, {s['n_stops']}-stop"
        if nm in used:
            nm += f" (L{s['stops'][0]} stop)"
        used.add(nm)
        s["name"] = nm
        s["rank"] = i + 1
    best_by = {}
    for b in board:
        best_by.setdefault(b["n_stops"], b)

    arche = field_archetypes(cfg)
    base_c = []
    for comps, stops, w in arche[:1] + [a for a in arche if len(a[1]) == 1][:1]:
        base_c.append(dict(comps=list(comps), stops=list(stops), react_sc=True, uc_laps=0,
                           label=S._label(comps, stops), n_stops=len(stops)))
    base_res = S.evaluate(cfg, base_c, w3)
    baseline = [dict(label=c["label"], n_stops=c["n_stops"], p_podium=r["p_podium"], e_pos=r["e_pos"], p_win=r["p_win"])
                for c, r in zip(base_c, base_res)]

    print("[3/8] scenario breakdown")
    strategies = []
    for s in top:
        raw = raw3[s["raw_index"]]
        strategies.append(dict(
            rank=s["rank"], name=s["name"], label=s["label"], comps=[COMP_CODES[c] for c in s["comps"]], stops=s["stops"],
            n_stops=s["n_stops"], uc_laps=s["uc_laps"], stints=stints_of(cfg, s), rules=rules_of(cfg, s),
            metrics=s["metrics"], scenarios=scenario_breakdown(w3, raw),
            race_time_fmt=dict(p10=fmt_time(s["metrics"]["t_p10"]), p50=fmt_time(s["metrics"]["t_p50"]), p90=fmt_time(s["metrics"]["t_p90"]))))

    print("[4/8] forecast and uncertainty")
    f_res, f_raw = S.evaluate(cfg, top, w3, keep_raw=True, track=True)
    cfg_pt = cfg.with_(uncertainty=False)
    w_pt = generate_world(cfg_pt, cfg.final_reps, cfg.seed + 3)
    pt_res = S.evaluate(cfg_pt, top, w_pt)
    forecast = forecast_block(cfg, w3, f_raw, pt_res)
    for strat, fp in zip(strategies, forecast["plans"]):
        strat["forecast"] = fp
        strat["metrics"]["p_podium_ci"] = fp["uncertainty"]["ci"]

    print("[5/8] replays")
    reps = 80 if quick else 240
    scen = scenarios_for(cfg)
    for strat, s in zip(strategies, top):
        strat["replays"] = {sc[0]: run_replay(cfg, s, sc, reps=reps) for sc in scen}

    print("[6/8] sensitivity and stop-window")
    sens = sensitivity(cfg, top, reps=300 if quick else 1200)
    for strat, s in zip(strategies, top):
        strat["window"] = stop_window(cfg, s, reps=300 if quick else 1500)

    print("[7/8] model blocks")
    tyres = tyre_block(cfg)
    fuel = fuel_block(cfg)
    inc = incident_block(cfg, 4000 if quick else 40000)
    dec = decision_block(cfg)
    green = strategies[0]["replays"]["green"]
    qa = build_qa(cfg, tyres, fuel, trk, inc, best_by, {})

    lb = []
    for b in board[:24]:
        m = b["metrics"]
        lb.append(dict(label=b["label"], n_stops=b["n_stops"], uc=b["uc_laps"], p_podium=m["p_podium"], p_win=m["p_win"],
                       e_pos=m["e_pos"], e_points=m["e_points"], gap_p50=m["gap_p50"]))
    by_stops = {str(n): dict(label=b["label"], uc=b["uc_laps"], **{k: b["metrics"][k] for k in ("p_podium", "p_win", "e_pos", "e_points", "gap_p50", "hist")})
                for n, b in best_by.items()}

    res = dict(
        meta=dict(
            generated=dt.datetime.now().isoformat(timespec="seconds"), event="Barcelona-Catalunya Grand Prix · 2026 regulations",
            laps=cfg.laps, lap_km=cfg.lap_m / 1000.0, air_c=cfg.air_c, track_c=cfg.track_c, tyre_window=[85, 110],
            scenario=(f"Qualify P{cfg.grid_pos} → P{cfg.lap1_pos} after Turn 1. Target: podium."
                      if cfg.grid_pos != cfg.lap1_pos else f"Qualify P{cfg.grid_pos}, no change at Turn 1. Target: podium."),
            case=dict(grid_pos=cfg.grid_pos, lap1_pos=cfg.lap1_pos, gap_ahead_s=cfg.gap_ahead_s, gap_behind_s=cfg.gap_behind_s,
                      start_compound=cfg.start_compound, force_lap=cfg.force_lap, force_kind=cfg.force_kind, force_dur=cfg.force_dur,
                      air_c=cfg.air_c, track_offset_c=cfg.track_offset_c, uncertainty=cfg.uncertainty,
                      pit_loss_s=cfg.pit_loss_s, pass_delta_s=cfg.pass_delta_s, deg_scale=cfg.deg_scale, seed=cfg.seed,
                      final_reps=cfg.final_reps),
            sims_final=cfg.final_reps, sims_per_strategy=cfg.final_reps, n_candidates=len(S.enumerate_candidates(cfg)),
            model_green_leader_time=fmt_time(green["leader_time_mean"]),
            real_winner_time="1:32:28.105", pole=fmt_lap(cfg.pole_lap_s),
            compounds=dict(S="C4", M="C3", H="C2"),
            sets_available=dict(S=8, M=3, H=2),
            provenance=PROVENANCE, runtime_s=round(time.time() - t0, 1)),
        config={k: (list(v) if isinstance(v, tuple) else v) for k, v in cfg.__dict__.items()},
        track=trk, tyres=tyres, fuel=fuel, incidents=inc, decision=dec,
        pit=dict(limit_kmh=cfg.pit_limit_kmh, loss_s=cfg.pit_loss_s, sigma_s=cfg.pit_sigma_s, sc_loss_s=cfg.pit_loss_s * cfg.sc_pit_factor,
                 vsc_loss_s=cfg.pit_loss_s * cfg.vsc_pit_factor, slow_p=cfg.slow_stop_p),
        strategies=strategies, baseline=baseline, forecast=dict((k, v) for k, v in forecast.items() if k != "plans"), sensitivity=sens, leaderboard=lb, by_stops=by_stops, qa=qa,
        field=dict(labels=car_labels(cfg), archetypes=[dict(seq="→".join(COMP_CODES[c] for c in a[0]), stops=a[1], weight=a[2]) for a in field_archetypes(cfg)]),
        scenarios=[dict(key=k, label=l, events=[dict(lap=a, kind=int(b), dur=c) for a, b, c in ev]) for k, l, ev in scen],
    )

    print("[8/8] writing")

    def enc(o):
        if isinstance(o, (np.integer,)):
            return int(o)
        if isinstance(o, (np.floating,)):
            return float(o)
        if isinstance(o, np.ndarray):
            return o.tolist()
        if isinstance(o, (np.bool_,)):
            return bool(o)
        raise TypeError(type(o))

    (outdir / "results.json").write_text(json.dumps(res, default=enc, separators=(",", ":")))
    print(f"done in {time.time() - t0:.0f}s -> {outdir / 'results.json'}")
    return res
