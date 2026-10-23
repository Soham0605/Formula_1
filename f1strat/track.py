"""Track model: corners, straights, a point-mass lap simulation and the map geometry.

Two geometry sources:
  * data/track_real.json  (written by fetch_fastf1.py from real telemetry) -> used when present
  * a schematic reconstruction built from the corner table below (fallback)

The corner table is an indicative description of the 14-turn layout, NOT survey data.
Reference apex speeds only fix the corner radii; the lap is then calibrated to the real
2026 pole time by scaling grip, so what the dashboard shows are model speeds.
"""
from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Dict, List

import numpy as np

from .config import Config

G = 9.81
RHO = 1.20

# (number, direction +1 right / -1 left, turn angle deg, reference apex km/h, apex distance m, type)
CORNERS = [
    (1, +1, 90, 110, 1090, "low"),
    (2, -1, 55, 148, 1330, "medium"),
    (3, +1, 100, 232, 1650, "high"),
    (4, +1, 75, 105, 2060, "low"),
    (5, -1, 50, 190, 2300, "medium"),
    (6, -1, 60, 138, 2480, "medium"),
    (7, +1, 50, 190, 2640, "medium"),
    (8, -1, 70, 222, 2900, "high"),
    (9, +1, 110, 246, 3250, "high"),
    (10, +1, 120, 102, 3750, "low"),
    (11, -1, 45, 165, 3990, "medium"),
    (12, +1, 55, 132, 4120, "medium"),
    (13, -1, 35, 210, 4310, "high"),
    (14, +1, 100, 118, 4520, "low"),
]

# vehicle (2026 active-aero car, indicative numbers)
CLA_Z = 3.8          # downforce area, corner mode
CDA_Z = 1.70         # drag area, corner mode
CLA_X = 2.0          # straight mode
CDA_X = 1.05
P_ICE = 400e3        # W
P_MGUK = 350e3       # W peak electric deployment
ETA = 0.96
V_K_FULL = 290 / 3.6     # deployment starts tapering above this (FIA 2026)
V_K_ZERO = 355 / 3.6     # and reaches zero here
ERS_DEPLOY_MJ = 8.5      # per-lap deployment is bounded by what can be harvested (FIA 2026: 8.5 MJ recuperation per lap)
MU0 = 1.6
M_REF = 773.0
DS = 6.0
APEX_CAP = 1.00      # apex speed may exceed the reference by at most 6 % (keeps fast corners sane)


def _a_lat_apex_radius(v: float, mu: float, m: float) -> float:
    return v * v / (mu * (G + 0.5 * RHO * CLA_Z * v * v / m))


def corner_geometry(cfg: Config):
    """Radii at baseline grip, arc lengths and straight spans."""
    out = []
    for (n, d, ang, vref, dist, kind) in CORNERS:
        v = vref / 3.6
        R = _a_lat_apex_radius(v, MU0, M_REF)
        L = R * math.radians(ang)
        out.append(dict(n=n, dir=d, angle=ang, vref=vref, dist=dist, kind=kind, R=R, L=L))
    return out


def _speed_limit_from_radius(R: float, mu: float, m: float) -> float:
    den = 1.0 - R * mu * 0.5 * RHO * CLA_Z / m
    if den <= 1e-6:
        return 120.0
    return min(120.0, math.sqrt(R * mu * G / den))


def solve_profile(cfg: Config, mu_scale: float, mass: float, ers_frac: float, geo=None, vc_scale: float = 1.0):
    """Quasi-steady-state point-mass lap on a circular track. Returns arrays + ERS energy used."""
    geo = geo or corner_geometry(cfg)
    M = int(round(cfg.lap_m / DS))
    ds = cfg.lap_m / M
    s = np.arange(M) * ds
    mu = MU0 * mu_scale
    vlim = np.full(M, 120.0)
    in_corner = np.zeros(M, dtype=bool)
    for c in geo:
        a, b = c["dist"] - c["L"] / 2, c["dist"] + c["L"] / 2
        vc = min(_speed_limit_from_radius(c["R"], mu, mass), c["vref"] / 3.6 * APEX_CAP * vc_scale)
        idx = np.nonzero(((s - a) % cfg.lap_m) <= (b - a))[0]
        vlim[idx] = np.minimum(vlim[idx], vc)
        in_corner[idx] = True
    v = vlim.copy()
    q_z = 0.5 * RHO * CLA_Z / mass
    c_z = 0.5 * RHO * CDA_Z / mass
    # braking pass (go round twice for the wrap-around)
    for _ in range(2):
        for i in range(M - 1, -1, -1):
            j = (i + 1) % M
            vj = v[j]
            a_b = mu * (G + q_z * vj * vj) + c_z * vj * vj
            vi = math.sqrt(vj * vj + 2.0 * a_b * ds)
            if vi < v[i]:
                v[i] = vi
    # acceleration pass
    q_x = 0.5 * RHO * CLA_X / mass
    ers_j = 0.0
    for lap in range(2):
        ers_j = 0.0
        for i in range(M):
            j = (i + 1) % M
            vi = v[i]
            if in_corner[j] and in_corner[i]:
                continue
            if vi < 1.0:
                vi = 1.0
            if vi < V_K_FULL:
                pk = P_MGUK
            elif vi < V_K_ZERO:
                pk = P_MGUK * (V_K_ZERO - vi) / (V_K_ZERO - V_K_FULL)
            else:
                pk = 0.0
            pk *= ers_frac
            p_wheel = ETA * (P_ICE + pk)
            drag = 0.5 * RHO * CDA_X * vi * vi
            roll = 0.012 * mass * G
            a_pow = (p_wheel / vi - drag - roll) / mass
            a_trac = 0.60 * mu * (G + q_x * vi * vi)
            a = min(a_pow, a_trac)
            vn = math.sqrt(max(vi * vi + 2.0 * a * ds, 0.0))
            if vn <= v[j]:
                # full acceleration is possible here: the car is slower than the limit at j
                v[j] = vn
                if a_pow <= a_trac and pk > 0:
                    ers_j += pk * ds / max(vi, 1.0)
    t = np.cumsum(ds / np.maximum(v, 1.0))
    return dict(s=s, v=v, t=t, lap_time=float(t[-1]), ers_mj=ers_j / 1e6, ds=ds, in_corner=in_corner)


def calibrate(cfg: Config, geo=None, verbose: bool = False):
    """Fit the corner-speed scale so a qualifying-trim lap equals the real pole time.

    Grip (MU) is held at a physical value; the reference apex speeds in the corner table are
    indicative, so they are scaled until the lap matches. ERS deployment is limited to the
    per-lap harvest budget. Straight speeds are NOT scaled: they come out of the power/drag model.
    """
    geo = geo or corner_geometry(cfg)
    mass_q = cfg.min_mass_kg + 6.0
    mu_scale = 1.20
    ers = 1.0
    if solve_profile(cfg, mu_scale, mass_q, 1.0, geo)["ers_mj"] > ERS_DEPLOY_MJ:
        lo_e, hi_e = 0.0, 1.0
        for _ in range(14):
            me = 0.5 * (lo_e + hi_e)
            if solve_profile(cfg, mu_scale, mass_q, me, geo)["ers_mj"] > ERS_DEPLOY_MJ:
                hi_e = me
            else:
                lo_e = me
        ers = lo_e
    lo, hi = 0.7, 1.6
    for _ in range(24):
        mid = 0.5 * (lo + hi)
        lt = solve_profile(cfg, mu_scale, mass_q, ers, geo, mid)["lap_time"]
        if lt > cfg.pole_lap_s:
            lo = mid
        else:
            hi = mid
    vc = 0.5 * (lo + hi)
    prof = solve_profile(cfg, mu_scale, mass_q, ers, geo, vc)
    prof = dict(prof, time_k=1.0, vc_scale=vc, mu_scale=mu_scale)
    if verbose:
        print(f"[track] corner-speed scale {vc:.3f}, ERS use {ers:.2f}, lap {prof['lap_time']:.3f}s, ERS {prof['ers_mj']:.2f} MJ")
    return mu_scale, ers, prof


def corner_straight_stats(cfg: Config, prof, geo) -> Dict[str, list]:
    s, v = prof["s"], prof["v"] * 3.6
    M = len(s)
    corners, straights = [], []
    ends = []
    for c in geo:
        a, b = c["dist"] - c["L"] / 2, c["dist"] + c["L"] / 2
        idx = np.nonzero(((s - a) % cfg.lap_m) <= (b - a))[0]
        entry_i = (idx[0] - 1) % M
        exit_i = (idx[-1] + int(100 / DS)) % M
        corners.append(dict(n=c["n"], kind=c["kind"], dir="R" if c["dir"] > 0 else "L", dist_m=c["dist"],
                            start_m=a % cfg.lap_m, end_m=b % cfg.lap_m,
                            apex_kmh=float(v[idx].min()), entry_kmh=float(v[entry_i]),
                            exit_kmh=float(v[exit_i]), angle=c["angle"]))
        ends.append((a % cfg.lap_m, b % cfg.lap_m, c["n"]))
    for k in range(len(geo)):
        c0, c1 = geo[k], geo[(k + 1) % len(geo)]
        a = (c0["dist"] + c0["L"] / 2) % cfg.lap_m
        b = (c1["dist"] - c1["L"] / 2) % cfg.lap_m
        length = (b - a) % cfg.lap_m
        idx = np.nonzero(((s - a) % cfg.lap_m) <= length)[0]
        if len(idx) == 0:
            continue
        straights.append(dict(name=f"T{c0['n']}-T{c1['n']}", start_m=a, end_m=b, length_m=length,
                              vmax_kmh=float(v[idx].max()), v_end_kmh=float(v[idx[-1]]),
                              main=bool(a > b)))   # wraps through the start line
    # label the straights that matter
    if straights:
        main = max(straights, key=lambda x: x["length_m"])
        main["label"] = "Start/finish straight"
    return dict(corners=corners, straights=straights)


# ----------------------------------------------------------------------------
# schematic geometry
# ----------------------------------------------------------------------------
def _chaikin(P: np.ndarray, it: int = 4) -> np.ndarray:
    for _ in range(it):
        Q = np.roll(P, -1, axis=0)
        A = 0.75 * P + 0.25 * Q
        B = 0.25 * P + 0.75 * Q
        P = np.empty((2 * len(P), 2))
        P[0::2], P[1::2] = A, B
    return P


def schematic_geometry(cfg: Config, geo) -> Dict:
    n = len(geo)
    dist = np.array([c["dist"] for c in geo], float)
    ell = np.empty(n)
    for j in range(n):
        ell[j] = (dist[(j + 1) % n] - dist[j]) % cfg.lap_m
    th = np.array([-c["dir"] * math.radians(c["angle"]) for c in geo], float)   # right = clockwise = negative
    for _ in range(60):
        H = np.cumsum(th)
        x = float(np.sum(ell * np.cos(H)))
        y = float(np.sum(ell * np.sin(H)))
        g = np.array([x, y, float(np.sum(th)) + 2 * math.pi])
        if np.abs(g).max() < 1e-6:
            break
        rev = lambda a: np.cumsum(a[::-1])[::-1]
        dx = -rev(ell * np.sin(H))
        dy = rev(ell * np.cos(H))
        J = np.vstack([dx, dy, np.ones(n)])
        th = th - J.T @ np.linalg.solve(J @ J.T, g)
    H = np.cumsum(th)
    V = np.zeros((n, 2))
    pos = np.zeros(2)
    # vertex 0 = T1; edge 13 (T14 -> T1) arrives at T1, so start from T1 and walk edges 0..12
    for j in range(n):
        V[j] = pos
        pos = pos + ell[j] * np.array([math.cos(H[j]), math.sin(H[j])])
    # smooth
    P = _chaikin(V, 4)
    seg = np.hypot(*(np.roll(P, -1, axis=0) - P).T)
    U = np.concatenate([[0.0], np.cumsum(seg)])[:-1]
    total = seg.sum()
    anchors = []
    for k in range(n):
        d = np.hypot(*(P - V[k]).T)
        anchors.append(int(np.argmin(d)))
    # anchors in lap distance -> polyline arc-length
    a_s = np.array(dist)
    a_u = np.array([U[a] for a in anchors])
    order = np.argsort(a_s)
    a_s, a_u = a_s[order], a_u[order]
    a_s_ext = np.concatenate([a_s, [a_s[0] + cfg.lap_m]])
    a_u_ext = np.concatenate([a_u, [a_u[0] + total]])

    def s_to_u(s_vals):
        s_vals = np.asarray(s_vals, float)
        s_mod = np.where(s_vals < a_s[0], s_vals + cfg.lap_m, s_vals)
        return np.interp(s_mod, a_s_ext, a_u_ext) % total

    def u_to_xy(u_vals):
        u_vals = np.asarray(u_vals, float) % total
        ext = np.concatenate([U, [total]])
        Pe = np.vstack([P, P[:1]])
        return np.stack([np.interp(u_vals, ext, Pe[:, 0]), np.interp(u_vals, ext, Pe[:, 1])], axis=1)

    return dict(s_to_xy=lambda s: u_to_xy(s_to_u(s)), polyline=P, total=total)


def _normalise_xy(xy: np.ndarray, w: float = 1000.0, h: float = 640.0, pad: float = 40.0):
    mn, mx = xy.min(axis=0), xy.max(axis=0)
    span = np.maximum(mx - mn, 1e-9)
    k = min((w - 2 * pad) / span[0], (h - 2 * pad) / span[1])
    off = np.array([pad, pad]) + ((np.array([w - 2 * pad, h - 2 * pad]) - span * k) / 2)
    return k, mn, off


def build_track(cfg: Config, real_path: str | Path | None = None, verbose: bool = True) -> Dict:
    geo = corner_geometry(cfg)
    scale, ers, prof = calibrate(cfg, geo, verbose)
    stats = corner_straight_stats(cfg, prof, geo)
    s, v = prof["s"], prof["v"] * 3.6
    source = "schematic reconstruction (corner table + calibrated point-mass model)"

    real = None
    if real_path and Path(real_path).exists():
        try:
            real = json.loads(Path(real_path).read_text())
        except Exception:
            real = None

    if real and real.get("points"):
        pts = np.array([[p["x"], p["y"]] for p in real["points"]], float)
        dist = np.array([p["dist"] for p in real["points"]], float)
        spd = np.array([p["speed"] for p in real["points"]], float)
        source = f"real telemetry ({real.get('source', 'FastF1')}, {real.get('session', '')})"
        k, mn, off = _normalise_xy(pts * np.array([1, -1]))
        xy = (pts * np.array([1, -1]) - np.array([0, 0]))
        xy = (xy - xy.min(axis=0)) * k + off
        corners = []
        for c in real.get("corners", []):
            i = int(np.argmin(np.abs(dist - c["dist"])))
            lo, hi = np.searchsorted(dist, c["dist"] - 60), np.searchsorted(dist, c["dist"] + 60)
            ent = np.searchsorted(dist, c["dist"] - 200)
            ex = np.searchsorted(dist, c["dist"] + 150)
            corners.append(dict(n=c["n"], kind="", dir="", dist_m=c["dist"], apex_kmh=float(spd[lo:max(hi, lo + 1)].min()),
                                entry_kmh=float(spd[min(ent, len(spd) - 1)]), exit_kmh=float(spd[min(ex, len(spd) - 1)]),
                                angle=None, x=float(xy[i, 0]), y=float(xy[i, 1])))
        stats["corners"] = corners or stats["corners"]
        straights = []
        cs = sorted(corners, key=lambda c: c["dist_m"])
        for a, b in zip(cs, cs[1:] + cs[:1]):
            lo, hi = a["dist_m"] + 80, b["dist_m"] - 120
            if b is cs[0]:
                hi += dist.max()
            if hi - lo < 120:
                continue
            m = (dist >= lo) & (dist <= hi)
            if m.any():
                straights.append(dict(name=f"T{a['n']}-T{b['n']}", start_m=float(lo), end_m=float(hi % dist.max()),
                                      length_m=float(hi - lo), vmax_kmh=float(spd[m].max()), v_end_kmh=float(spd[m][-1])))
        stats["straights"] = straights or stats["straights"]
        speed_pts = [[float(a), float(b)] for a, b in zip(dist[::2], spd[::2])]
        path = [[round(float(x), 1), round(float(y), 1)] for x, y in xy[::2]]
        path_speed = [round(float(z), 1) for z in spd[::2]]
        path_dist = [round(float(z), 1) for z in dist[::2]]
    else:
        sg = schematic_geometry(cfg, geo)
        s_path = np.linspace(0, cfg.lap_m, 900, endpoint=False)
        xy = sg["s_to_xy"](s_path)
        xy = xy * np.array([1, -1])
        k, mn, off = _normalise_xy(xy)
        xy = (xy - xy.min(axis=0)) * k + off
        v_path = np.interp(s_path, s, v, period=cfg.lap_m)
        for c in stats["corners"]:
            i = int(np.argmin(np.abs(((s_path - c["dist_m"] + cfg.lap_m / 2) % cfg.lap_m) - cfg.lap_m / 2)))
            c["x"], c["y"] = float(xy[i, 0]), float(xy[i, 1])
        path = [[round(float(x), 1), round(float(y), 1)] for x, y in xy]
        path_speed = [round(float(z), 1) for z in v_path]
        path_dist = [round(float(z), 1) for z in s_path]
        speed_pts = [[float(a), float(b)] for a, b in zip(s[::2], v[::2])]

    for st in stats["straights"]:
        a = st["start_m"]
        i = int(np.argmin(np.abs(np.array(path_dist) - ((a + st["length_m"] / 2) % cfg.lap_m))))
        st["x"], st["y"] = path[i][0], path[i][1]

    return dict(source=source, lap_m=cfg.lap_m, path=path, path_speed=path_speed, path_dist=path_dist,
                speed_profile=speed_pts, corners=stats["corners"], straights=stats["straights"],
                calibration=dict(grip_scale=round(scale, 4), ers_use=round(ers, 3), corner_speed_scale=round(prof['vc_scale'], 4), model_lap_s=round(prof["lap_time"], 3),
                                 ers_mj=round(float(prof["ers_mj"]), 2), pole_s=cfg.pole_lap_s),
                real=bool(real))
