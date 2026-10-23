"""Candidate generation, staged Monte-Carlo search and ranking of race strategies."""
from __future__ import annotations

import itertools
import os
import time
from concurrent.futures import ProcessPoolExecutor
from multiprocessing import get_context
from typing import Dict, List, Sequence

import numpy as np

from .config import Config, COMP_CODES, INF_LAP, S_MAX
from .sim import generate_world, simulate, summarise, World, _pad_comps, _pad_stops


def _label(comps: Sequence[int], stops: Sequence[int]) -> str:
    seq = "→".join(COMP_CODES[c] for c in comps)
    return f"{seq} (L{', L'.join(str(s) for s in stops)})"


def enumerate_candidates(cfg: Config, react_sc: bool = True, uc_laps: int | None = None) -> List[dict]:
    uc = cfg.uc_laps_default if uc_laps is None else uc_laps
    L = cfg.laps
    life = cfg.max_life
    out: List[dict] = []

    def feasible(comps, stops):
        bounds = [0] + list(stops) + [L]
        for k, c in enumerate(comps):
            ln = bounds[k + 1] - bounds[k]
            if ln > life[c] or ln < cfg.min_stint:
                return False
        return len(set(comps)) >= 2

    # 1-stop
    for comps in itertools.permutations(range(3), 2):
        for p in range(8, 47, 2):
            if feasible(comps, [p]):
                out.append(dict(comps=list(comps), stops=[p]))
    # 2-stop
    for comps in itertools.product(range(3), repeat=3):
        for p1 in range(7, 37, 3):
            for p2 in range(p1 + 8, 58, 3):
                if feasible(comps, [p1, p2]):
                    out.append(dict(comps=list(comps), stops=[p1, p2]))
    # 3-stop (consecutive compounds differ to keep the space tractable)
    for comps in itertools.product(range(3), repeat=4):
        if any(comps[i] == comps[i + 1] for i in range(3)):
            continue
        for p1 in range(7, 25, 4):
            for p2 in range(p1 + 8, 45, 4):
                for p3 in range(p2 + 8, 59, 4):
                    if feasible(comps, [p1, p2, p3]):
                        out.append(dict(comps=list(comps), stops=[p1, p2, p3]))
    if cfg.start_compound >= 0:
        out = [o for o in out if o["comps"][0] == cfg.start_compound]
    for o in out:
        o["react_sc"] = react_sc
        o["uc_laps"] = uc
        o["label"] = _label(o["comps"], o["stops"])
        o["n_stops"] = len(o["stops"])
    return out


def pack(cands: Sequence[dict]) -> Dict[str, np.ndarray]:
    return dict(
        comps=np.array([_pad_comps(c["comps"]) for c in cands], dtype=np.int8),
        stops=np.array([_pad_stops(c["stops"]) for c in cands], dtype=np.int32),
        react_sc=np.array([c["react_sc"] for c in cands], dtype=bool),
        uc_laps=np.array([c["uc_laps"] for c in cands], dtype=np.int32),
    )


_G: dict = {}


def _eval_chunk(cfg, sub, world, keep_raw, track=False):
    R = world.reps
    tab = pack(sub)
    k = len(sub)
    cand_idx = np.repeat(np.arange(k), R)
    rep_idx = np.tile(np.arange(R), k)
    out = simulate(cfg, world, tab, cand_idx, rep_idx, track=track)
    res, raw = [], []
    for j in range(k):
        sl = slice(j * R, (j + 1) * R)
        m = summarise(out["pos"][sl], out["race_time"][sl], out["leader_time"][sl], cfg.n_cars)
        m["pits"] = float(out["pits"][sl].mean())
        m["held_laps"] = float(out["held_laps"][sl].mean())
        m["passes"] = float(out["passes"][sl].mean())
        res.append(m)
        if keep_raw:
            r = dict(pos=out["pos"][sl].copy(), time=out["race_time"][sl].copy(), lead=out["leader_time"][sl].copy())
            if track:
                for key in ("lap_pos", "lap_g3", "lap_comp", "lap_age"):
                    r[key] = out[key][sl].copy()
            raw.append(r)
    return res, raw


def _work(span):
    a, b = span
    return a, _eval_chunk(_G["cfg"], _G["cands"][a:b], _G["world"], _G["keep_raw"], _G.get("track", False))


def default_workers() -> int:
    for k in ("SLURM_CPUS_PER_TASK", "SLURM_CPUS_ON_NODE"):
        if os.environ.get(k):
            try:
                return max(1, int(os.environ[k]))
            except ValueError:
                pass
    return max(1, os.cpu_count() or 1)


def evaluate(cfg: Config, cands: Sequence[dict], world: World, chunk: int = 24000, keep_raw: bool = False,
             workers: int = 1, track: bool = False):
    """Run every candidate against the same `world` (common random numbers). Returns metrics per candidate."""
    K, R = len(cands), world.reps
    per = max(1, chunk // R)
    if workers > 1:
        per = max(1, min(per, -(-K // (workers * 2))))
    spans = [(a, min(a + per, K)) for a in range(0, K, per)]
    results = [None] * K
    raws = [None] * K
    if workers > 1 and len(spans) > 1:
        _G.update(cfg=cfg, cands=list(cands), world=world, keep_raw=keep_raw, track=track)
        with ProcessPoolExecutor(max_workers=workers, mp_context=get_context("fork")) as ex:
            for a, (res, raw) in ex.map(_work, spans):
                for j, m in enumerate(res):
                    results[a + j] = m
                    if keep_raw:
                        raws[a + j] = raw[j]
    else:
        for a, b in spans:
            res, raw = _eval_chunk(cfg, cands[a:b], world, keep_raw, track)
            for j, m in enumerate(res):
                results[a + j] = m
                if keep_raw:
                    raws[a + j] = raw[j]
    return (results, raws) if keep_raw else results


def score(m: dict) -> float:
    return m["p_podium"] + 0.02 * m["e_points"] / 25.0 - 0.0005 * m["e_pos"]


def search(cfg: Config, workers: int = 1, verbose: bool = True):
    t0 = time.time()
    cands = enumerate_candidates(cfg, react_sc=True, uc_laps=0)
    if verbose:
        print(f"[search] {len(cands)} candidate plans, {workers} worker(s)")
    # stage 1: broad screen, few races each
    w1 = generate_world(cfg, cfg.stage1_reps, cfg.seed + 1)
    r1 = evaluate(cfg, cands, w1, workers=workers)
    order = sorted(range(len(cands)), key=lambda i: score(r1[i]), reverse=True)
    pick = list(order[:100])
    for n in (1, 2, 3):
        pick += [i for i in order if cands[i]["n_stops"] == n][:12]
    keep2 = [cands[i] for i in dict.fromkeys(pick)]
    if verbose:
        print(f"[search] stage 1 done in {time.time() - t0:.0f}s; carrying {len(keep2)}")
    # stage 2
    w2 = generate_world(cfg, cfg.stage2_reps, cfg.seed + 2)
    r2 = evaluate(cfg, keep2, w2, workers=workers)
    order2 = sorted(range(len(keep2)), key=lambda i: score(r2[i]), reverse=True)
    pick2 = list(order2[:27])
    for n in (1, 2, 3):
        pick2 += [i for i in order2 if keep2[i]["n_stops"] == n][:2]
    plans = [keep2[i] for i in dict.fromkeys(pick2)]
    if verbose:
        print(f"[search] stage 2 done in {time.time() - t0:.0f}s; {len(plans)} plans x contingency rules")
    # stage 3: independent final worlds; each plan with 3 'stuck in traffic' rules (0 = never, 3, 5 laps)
    keep3 = []
    for p in plans:
        for uc in (0, 3, 5):
            c = dict(p)
            c["uc_laps"] = uc
            keep3.append(c)
    w3 = generate_world(cfg, cfg.final_reps, cfg.seed + 3)
    r3, raw3 = evaluate(cfg, keep3, w3, keep_raw=True, workers=workers)
    for c, m in zip(keep3, r3):
        c["metrics"] = m
        c["score"] = score(m)
    ranked = sorted(range(len(keep3)), key=lambda i: keep3[i]["score"], reverse=True)
    board = [dict(keep3[i], raw_index=i) for i in ranked]
    if verbose:
        print(f"[search] stage 3 done in {time.time() - t0:.0f}s")
    return board, raw3, w3, keep3


def pick_top3(board: List[dict], tol: float = 0.03) -> List[dict]:
    """Best strategy first, then prefer different stop counts when within `tol` of podium probability."""
    chosen: List[dict] = []
    seen_seq = set()
    pool = list(board)
    while len(chosen) < 3 and pool:
        best = next((b for b in pool if (b["n_stops"], tuple(b["comps"])) not in seen_seq), None)
        if best is None:
            break
        novel = next((b for b in pool if b["n_stops"] not in {c["n_stops"] for c in chosen}
                      and (b["n_stops"], tuple(b["comps"])) not in seen_seq), None)
        pick = novel if (novel is not None and chosen and best["metrics"]["p_podium"] - novel["metrics"]["p_podium"] <= tol) else best
        chosen.append(pick)
        seen_seq.add((pick["n_stops"], tuple(pick["comps"])))
        pool = [b for b in pool if b is not pick]
    return chosen


def name_strategy(s: dict, rank: int) -> str:
    n = s["n_stops"]
    first = s["stops"][0]
    if n == 1:
        return "Track-position 1-stop"
    if n == 2:
        return "Early-undercut 2-stop" if first <= 14 else "Balanced 2-stop"
    return "Sprint 3-stop"
