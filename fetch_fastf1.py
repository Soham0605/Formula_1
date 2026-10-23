#!/usr/bin/env python3
"""Optional: pull real Barcelona data with FastF1 and calibrate the model.

Run this on a HiPerGator LOGIN node (compute nodes often have no internet), once:

    pip install --user fastf1
    python fetch_fastf1.py                    # 2019-2026, whatever exists
    python fetch_fastf1.py --years 2023 2024 2025 2026

It writes
    data/track_real.json      centre line, speed trace and corner distances from the fastest qualifying lap
    data/calibration.json     pole lap (if 2026 data exists), per-lap SC/VSC/red hazards, green-flag pit loss
    data/deg_report.json      fuel-corrected tyre degradation slopes per compound and year (report only)

run_analysis.py picks up track_real.json and calibration.json automatically.
Degradation is reported but not applied: older-regulation tyres/cars are not a drop-in for 2026,
so review deg_report.json and edit f1strat/config.py yourself.

NOTE: written against the FastF1 3.x API and not executed in the environment where it was authored
(no access to F1 timing data there). If a column name differs in your version, the try/except
blocks print which step failed and continue with the others.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
EVENT_NAMES = ["Barcelona", "Spain", "Spanish Grand Prix", "Barcelona-Catalunya Grand Prix"]


def get_session(ff1, year, kind):
    last = None
    for name in EVENT_NAMES:
        try:
            s = ff1.get_session(year, name, kind)
            s.load(telemetry=(kind == "Q"), weather=False, messages=True)
            return s
        except Exception as e:  # noqa: BLE001
            last = e
    raise RuntimeError(f"{year} {kind}: {last}")


def track_from_quali(ff1, years):
    for y in sorted(years, reverse=True):
        try:
            s = get_session(ff1, y, "Q")
            lap = s.laps.pick_fastest()
            tel = lap.get_telemetry().dropna(subset=["X", "Y", "Distance", "Speed"])
            pts = [dict(x=float(r.X), y=float(r.Y), dist=float(r.Distance), speed=float(r.Speed)) for r in tel.itertuples()]
            corners = []
            try:
                ci = s.get_circuit_info()
                xy = tel[["X", "Y"]].to_numpy(float)
                dd = tel["Distance"].to_numpy(float)
                for c in ci.corners.itertuples():
                    i = int(np.argmin(np.hypot(xy[:, 0] - c.X, xy[:, 1] - c.Y)))
                    corners.append(dict(n=int(c.Number), letter=str(c.Letter), dist=float(dd[i])))
            except Exception as e:  # noqa: BLE001
                print("  corner info failed:", e)
            lap_s = lap["LapTime"].total_seconds()
            return dict(source=f"FastF1 {y} fastest qualifying lap", session=f"{y} Q", points=pts, corners=corners), y, lap_s
        except Exception as e:  # noqa: BLE001
            print(f"  {y} qualifying unavailable: {e}")
    return None, None, None


def race_stats(ff1, years):
    sc = vsc = red = laps_total = races = 0
    sc_races = vsc_races = red_races = 0
    pit_losses, pit_lane = [], []
    deg = {}
    for y in years:
        try:
            s = get_session(ff1, y, "R")
        except Exception as e:  # noqa: BLE001
            print(f"  {y} race unavailable: {e}")
            continue
        races += 1
        laps = s.laps
        laps_total += int(laps["LapNumber"].max())
        try:
            msg = s.race_control_messages["Message"].astype(str).str.upper()
            a = int(msg.str.contains("SAFETY CAR DEPLOYED") .sum() - msg.str.contains("VIRTUAL SAFETY CAR DEPLOYED").sum())
            b = int(msg.str.contains("VIRTUAL SAFETY CAR DEPLOYED").sum())
            c = int(msg.str.contains("RED FLAG").sum())
            sc += max(a, 0); vsc += b; red += c
            sc_races += a > 0; vsc_races += b > 0; red_races += c > 0
        except Exception as e:  # noqa: BLE001
            print("  race-control parse failed:", e)
        try:
            d = laps.copy()
            d["lt"] = d["LapTime"].dt.total_seconds()
            clean = d[(d["TrackStatus"].astype(str) == "1") & d["PitInTime"].isna() & d["PitOutTime"].isna()
                      & (d["LapNumber"] > 1) & d["lt"].notna() & (d["IsAccurate"] if "IsAccurate" in d else True)]
            for drv, g in d.groupby("Driver"):
                g = g.sort_values("LapNumber")
                for i in g.index[g["PitInTime"].notna()]:
                    n = g.loc[i, "LapNumber"]
                    nxt = g[g["LapNumber"] == n + 1]
                    if nxt.empty or g.loc[i, "TrackStatus"] != "1" or nxt.iloc[0]["TrackStatus"] != "1":
                        continue
                    ref = clean[(clean["Driver"] == drv) & (abs(clean["LapNumber"] - n) <= 6)]["lt"]
                    if len(ref) < 3:
                        continue
                    loss = g.loc[i, "lt"] + nxt.iloc[0]["lt"] - 2 * ref.median()
                    if 10 < loss < 40:
                        pit_losses.append(float(loss))
                    pl = (nxt.iloc[0]["PitOutTime"] - g.loc[i, "PitInTime"]).total_seconds()
                    if 10 < pl < 40:
                        pit_lane.append(pl)
            for (drv, stint), g in clean.groupby(["Driver", "Stint"]):
                comp = str(g["Compound"].iloc[0])
                if len(g) < 6 or comp not in ("SOFT", "MEDIUM", "HARD"):
                    continue
                slope = float(np.polyfit(g["TyreLife"].to_numpy(float), g["lt"].to_numpy(float), 1)[0])
                deg.setdefault(f"{y}-{comp}", []).append(slope)
        except Exception as e:  # noqa: BLE001
            print("  lap analysis failed:", e)
    return dict(races=races, laps=laps_total, sc=sc, vsc=vsc, red=red, sc_races=sc_races, vsc_races=vsc_races,
                red_races=red_races, pit_losses=pit_losses, pit_lane=pit_lane, deg=deg)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--years", type=int, nargs="*", default=list(range(2019, 2027)))
    ap.add_argument("--cache", default=str(DATA / "fastf1_cache"))
    a = ap.parse_args()
    try:
        import fastf1 as ff1
    except ImportError:
        sys.exit("fastf1 is not installed: pip install --user fastf1")
    DATA.mkdir(exist_ok=True)
    Path(a.cache).mkdir(parents=True, exist_ok=True)
    ff1.Cache.enable_cache(a.cache)

    cal = {}
    print("track + pole lap")
    trk, y, lap_s = track_from_quali(ff1, a.years)
    if trk:
        (DATA / "track_real.json").write_text(json.dumps(trk))
        print(f"  wrote data/track_real.json from {trk['session']} ({len(trk['points'])} points, {len(trk['corners'])} corners)")
        if y == 2026 and lap_s:
            cal["pole_lap_s"] = round(float(lap_s), 3)
    print("race statistics")
    st = race_stats(ff1, a.years)
    if st["laps"]:
        cal["h_sc"] = round(st["sc"] / st["laps"], 5)
        cal["h_vsc"] = round(st["vsc"] / st["laps"], 5)
        cal["h_red"] = round(st["red"] / st["laps"], 5)
        print(f"  {st['races']} races: SC in {st['sc_races']}, VSC in {st['vsc_races']}, red flag in {st['red_races']}")
    if len(st["pit_losses"]) >= 15:
        cal["pit_loss_s"] = round(float(np.median(st["pit_losses"])), 2)
        cal["pit_sigma_s"] = round(float(np.std(st["pit_losses"])), 2)
        print(f"  green-flag pit loss median {cal['pit_loss_s']} s (n={len(st['pit_losses'])}); pit-lane time median {np.median(st['pit_lane']):.1f} s")
    (DATA / "calibration.json").write_text(json.dumps(cal, indent=2))
    (DATA / "deg_report.json").write_text(json.dumps(
        {k: dict(median_s_per_lap=float(np.median(v)), n_stints=len(v)) for k, v in st["deg"].items()}, indent=2))
    print("wrote data/calibration.json and data/deg_report.json. Re-run: python run_analysis.py")


if __name__ == "__main__":
    main()
