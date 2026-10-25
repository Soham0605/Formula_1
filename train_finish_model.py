#!/usr/bin/env python3
"""Statistical finishing-position model: P(finish = k | qualifying, form) for one driver.

    python train_finish_model.py                 # needs numpy + scipy + requests; internet for Jolpica

Model: ordered logit (proportional odds) on classified finishers,
    P(finish <= k) = logistic(theta_k - x.beta),  k = 1..19  (P20 and below are one class)
plus a separate retirement probability (team 2026 rate, from fetch_event.py). Positive beta = worse finish.

Features of a driver-race, each computed from EARLIER races of the same season only (no leakage):
    log_grid         log of the starting slot (pit-lane start = 22)
    quali_gap_pct    best qualifying lap vs pole, % (one-lap pace)
    team_form        mean classified finish of the constructor's cars over its last 5 races, minus 10.5
                     (0 before the first race of the season)
    racecraft        sum(grid - finish) / (n + 3) over the driver's classified races this season
                     (positions gained per race, shrunk toward 0)
Validation: rolling origin. For each test race (2024 onward) the model is refit on every earlier race,
then scored on that race. Compared with a grid-only ordered logit and with "finish = grid".

Writes dashboard/data/model/finish_model.json (coefficients, backtest metrics, Red Bull features for this race).
"""
from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import requests
from scipy.optimize import minimize

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "dashboard" / "data" / "model"
JOLPICA = "https://api.jolpi.ca/ergast/f1"
K = 20
FEATURES = ["log_grid", "quali_gap_pct", "team_form", "racecraft"]
SEASONS = [2022, 2023, 2024, 2025, 2026]
TARGET = (2026, 18)


def get_all(path):
    out, off, sess = {}, 0, requests.Session()
    while True:
        for k in range(6):
            r = sess.get(f"{JOLPICA}/{path}", params={"limit": 100, "offset": off}, timeout=40)
            if r.status_code == 429:
                import time
                time.sleep(3 * 2 ** k)
                continue
            r.raise_for_status()
            break
        d = r.json()["MRData"]
        for race in d["RaceTable"]["Races"]:
            key = int(race["round"])
            if key not in out:
                out[key] = race
            else:
                for sub in ("Results", "QualifyingResults"):
                    out[key].setdefault(sub, []).extend(race.get(sub, []))
        off += 100
        if off >= int(d["total"]):
            return out


def lap_s(t):
    if not t:
        return None
    if ":" in t:
        m, s = t.split(":")
        return int(m) * 60 + float(s)
    return float(t)


def build_rows(season, results, quali):
    """One row per driver-race with features from earlier rounds only. Includes rows of races without
    results yet (finish=None) so the target race gets features too."""
    rows = []
    team_hist: dict = {}
    drv_hist: dict = {}
    rounds = sorted(set(results) | set(quali))
    for rnd in rounds:
        q = quali.get(rnd, {}).get("QualifyingResults", [])
        best = {x["Driver"]["driverId"]: min([t for t in (lap_s(x.get(k)) for k in ("Q1", "Q2", "Q3")) if t], default=None)
                for x in q}
        pole = min([v for v in best.values() if v], default=None)
        res = results.get(rnd, {}).get("Results", [])
        entries = res if res else [dict(Driver=x["Driver"], Constructor=x["Constructor"], grid=x["position"],
                                        position=None, status=None) for x in q]
        for x in entries:
            d, t = x["Driver"]["driverId"], x["Constructor"]["constructorId"]
            g = int(x["grid"]) if x.get("grid") not in (None, "") else None
            g = 22 if g == 0 else g
            th = team_hist.get(t, [])[-10:]
            dh = drv_hist.get(d, [])
            st = x.get("status") or ""
            classified = bool(st) and (st == "Finished" or st.startswith("+") or st == "Lapped")
            rows.append(dict(
                season=season, round=rnd, driver=d, team=t, grid=g,
                finish=int(x["position"]) if x.get("position") and classified else None,
                dnf=(not classified) if st else None,
                log_grid=math.log(g) if g else None,
                quali_gap_pct=min(5.0, (best[d] / pole - 1) * 100) if best.get(d) and pole else None,
                team_form=(np.mean(th[-10:]) - 10.5) if th else 0.0,   # last 5 races x 2 cars
                racecraft=sum(dh) / (len(dh) + 3)))
        for x in res:
            st = x["status"]
            if st == "Finished" or st.startswith("+") or st == "Lapped":
                team_hist.setdefault(x["Constructor"]["constructorId"], []).append(int(x["position"]))
                g = int(x["grid"]) or 22
                drv_hist.setdefault(x["Driver"]["driverId"], []).append(g - int(x["position"]))
    return rows


def design(rows, feats):
    X = np.array([[r[f] for f in feats] for r in rows], float)
    y = np.array([min(r["finish"], K) for r in rows], int)
    return X, y


def nll(params, X, y, lam):
    p = X.shape[1]
    beta = params[:p]
    theta = params[p] + np.concatenate([[0.0], np.cumsum(np.exp(params[p + 1:]))])
    eta = X @ beta
    cdf = lambda k: np.where(k >= K, 1.0, np.where(k <= 0, 0.0, 1 / (1 + np.exp(-(theta[np.clip(k - 1, 0, K - 2)] - eta)))))
    pr = np.clip(cdf(y) - cdf(y - 1), 1e-12, 1)
    return -np.log(pr).sum() + lam * (beta ** 2).sum()


def fit(X, y, lam=1.0):
    mu, sd = X.mean(0), X.std(0) + 1e-9
    Z = (X - mu) / sd
    p = Z.shape[1]
    x0 = np.concatenate([np.zeros(p), [-3.0], np.full(K - 2, np.log(6.0 / (K - 1)))])
    r = minimize(nll, x0, args=(Z, y, lam), method="L-BFGS-B")
    beta_z = r.x[:p]
    theta = r.x[p] + np.concatenate([[0.0], np.cumsum(np.exp(r.x[p + 1:]))])
    # back to raw feature units: x.beta_z/sd shifted by mu/sd.beta_z, absorbed into the cut-points
    return dict(beta=(beta_z / sd).tolist(), theta=(theta + (mu / sd * beta_z).sum()).tolist())


def probs(m, x):
    eta = float(np.dot(m["beta"], x))
    th = np.array(m["theta"])
    cdf = np.concatenate([1 / (1 + np.exp(-(th - eta))), [1.0]])
    return np.diff(np.concatenate([[0.0], cdf]))


def main():
    rows = []
    for s in SEASONS:
        print("season", s)
        rows += build_rows(s, get_all(f"{s}/results.json"), get_all(f"{s}/qualifying.json"))
    ok = lambda r, feats: r["finish"] is not None and all(r[f] is not None for f in feats)
    # rolling-origin backtest over 2024+ races
    test_races = sorted({(r["season"], r["round"]) for r in rows if r["season"] >= 2024 and r["finish"] is not None})
    metrics = {k: dict(ll=[], mae=[], top3_brier=[]) for k in ("full", "grid_only", "finish_eq_grid")}
    for (s, rd) in test_races:
        tr = [r for r in rows if (r["season"], r["round"]) < (s, rd)]
        te = [r for r in rows if (r["season"], r["round"]) == (s, rd)]
        for name, feats in (("full", FEATURES), ("grid_only", ["log_grid"])):
            trr, tee = [r for r in tr if ok(r, feats)], [r for r in te if ok(r, feats)]
            if len(trr) < 200 or not tee:
                continue
            m = fit(*design(trr, feats))
            for r in tee:
                p = probs(m, [r[f] for f in feats])
                y = min(r["finish"], K)
                metrics[name]["ll"].append(-math.log(max(p[y - 1], 1e-12)))
                metrics[name]["mae"].append(abs(float(np.dot(p, np.arange(1, K + 1))) - y))
                metrics[name]["top3_brier"].append((p[:3].sum() - (y <= 3)) ** 2)
        for r in te:
            if r["finish"] is not None and r["grid"]:
                metrics["finish_eq_grid"]["mae"].append(abs(min(r["grid"], K) - min(r["finish"], K)))
    summary = {k: {mk: (round(float(np.mean(v)), 4) if v else None) for mk, v in d.items()} | {"n": len(d["mae"])}
               for k, d in metrics.items()}
    print(json.dumps(summary, indent=1))
    final = fit(*design([r for r in rows if ok(r, FEATURES)], FEATURES))
    target = {r["driver"]: r for r in rows if (r["season"], r["round"]) == TARGET}
    feats_now = {d: {f: target[d][f] for f in FEATURES} | dict(grid=target[d]["grid"], team=target[d]["team"])
                 for d in ("max_verstappen", "hadjar") if d in target}
    for d, f in feats_now.items():
        p = probs(final, [f[k] for k in FEATURES])
        f["p_finish"] = [round(float(v), 4) for v in p]
        f["e_finish"] = round(float(np.dot(p, np.arange(1, K + 1))), 2)
        print(d, "grid", f["grid"], "E[finish|classified]", f["e_finish"], "P(top3)", round(float(p[:3].sum()), 3))
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "finish_model.json").write_text(json.dumps(dict(
        generated=datetime.now(timezone.utc).isoformat(), kind="ordered_logit", K=K, features=FEATURES,
        beta=final["beta"], theta=final["theta"], train_rows=sum(ok(r, FEATURES) for r in rows),
        train_seasons=SEASONS, backtest=dict(method="rolling origin, refit before every race 2024+", **summary),
        target=dict(season=TARGET[0], round=TARGET[1], drivers=feats_now),
        notes=["Conditional on finishing (classified). Retirement probability is applied separately.",
               "Features use earlier races of the same season only; 2026 team form starts at 0 in round 1."]), indent=1))
    print("wrote", OUT / "finish_model.json")


if __name__ == "__main__":
    main()
