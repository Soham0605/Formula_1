#!/usr/bin/env python3
"""Build the event bundle the dashboard needs for one race weekend (run on a node with internet).

    python fetch_event.py                       # 2026 United States GP (round 18)
    python fetch_event.py --season 2026 --round 18

Writes
    dashboard/data/calendar.json            every round of the season with its status (completed / live / upcoming)
    dashboard/data/event/<slug>.json        track, sessions, grid, field pace, driver seasons, incident rates,
                                            weather snapshot, sources

Sources (all public, no credentials):
    Jolpica-F1 (Ergast API)      schedule, qualifying, 2026 results            https://api.jolpi.ca/ergast/f1
    OpenF1                       session times, team colours, race control,    https://api.openf1.org/v1
                                 position data of the pole lap (sector split)
    MultiViewer circuit API      track outline, corner numbers, pit loss       https://api.multiviewer.app
    Open-Meteo                   race-day hourly forecast (snapshot)           https://open-meteo.com
FastF1 is not used here: since 3.9 its timing download needs an F1 account.
Nothing is invented: a field that cannot be fetched is written as null and the dashboard shows it as unavailable.
"""
from __future__ import annotations

import argparse
import json
import math
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "dashboard" / "data"
JOLPICA = "https://api.jolpi.ca/ergast/f1"
OPENF1 = "https://api.openf1.org/v1"
MV = "https://api.multiviewer.app/api/v1/circuits"
UA = {"User-Agent": "pit-wall-dashboard (research)"}

# Event facts that no API returns. Each carries its source.
EVENT_FACTS = {
    (2026, 18): dict(
        slug="usa_2026", laps=56, lap_km=5.513, tz="America/Chicago",
        compounds=dict(S="C4", M="C3", H="C2"), sets=dict(S=8, M=3, H=2),
        facts_source="Pirelli allocation: formula1.com 'What tyres will the teams and drivers have for the 2026 "
                     "United States Grand Prix?'; laps/length: COTA official figures",
    ),
}
OUR_TEAM = "red_bull"


def get(url, params=None, tries=5):
    for k in range(tries):
        try:
            r = requests.get(url, params=params, headers=UA, timeout=40)
        except requests.RequestException as e:
            print(f"  network error {e}; retry")
            time.sleep(2 ** k)
            continue
        if r.status_code == 429:
            time.sleep(min(60, 3 * 2 ** k))
            continue
        if r.status_code == 404:
            return []
        r.raise_for_status()
        time.sleep(0.35)
        return r.json()
    raise RuntimeError(f"{url} failed after {tries} tries")


def lap_s(t):
    if not t:
        return None
    m, s = (t.split(":") + [None])[:2] if ":" in t else (None, t)
    return (int(m) * 60 + float(s)) if s is not None else float(m)


def jolpica_races(path):
    out, off = {}, 0
    while True:
        d = get(f"{JOLPICA}/{path}", {"limit": 100, "offset": off})["MRData"]
        for r in d["RaceTable"]["Races"]:
            k = int(r["round"])
            if k not in out:
                out[k] = r
            else:
                for sub in ("Results", "QualifyingResults"):
                    out[k].setdefault(sub, []).extend(r.get(sub, []))
        off += 100
        if off >= int(d["total"]):
            return out


def utc(date, tm):
    return f"{date}T{(tm or '00:00:00Z')}".replace("Z", "+00:00") if date else None


def calendar(season, now):
    sched = jolpica_races(f"{season}.json")
    rows = []
    for k in sorted(sched):
        r = sched[k]
        race = datetime.fromisoformat(utc(r["date"], r.get("time")))
        status = "completed" if race + timedelta(hours=3) < now else (
            "live" if race - timedelta(days=4) <= now else "upcoming")
        rows.append(dict(round=k, name=r["raceName"], circuit=r["Circuit"]["circuitName"],
                         circuit_id=r["Circuit"]["circuitId"], country=r["Circuit"]["Location"]["country"],
                         locality=r["Circuit"]["Location"]["locality"], lat=float(r["Circuit"]["Location"]["lat"]),
                         lon=float(r["Circuit"]["Location"]["long"]), race_utc=race.isoformat(),
                         sprint="Sprint" in r, status=status))
    return rows, sched


def track_block(circuit_key, season, quali_key, pole_number):
    mv = get(f"{MV}/{circuit_key}/{season}")
    xs, ys = mv["x"], mv["y"]
    out = dict(outline=[[float(x), float(y)] for x, y in zip(xs, ys)], rotation=mv.get("rotation", 0),
               corners=[dict(n=c["number"], x=c["trackPosition"]["x"], y=c["trackPosition"]["y"], angle=c["angle"])
                        for c in mv["corners"]],
               pit_loss=dict(normal=float(mv["pitLoss"]["normal"]), sc=float(mv["pitLoss"]["sc"]),
                             vsc=float(mv["pitLoss"]["vsc"])) if mv.get("pitLoss") else None,
               outline_source=f"MultiViewer circuit API (reference lap {mv.get('raceDate')}, layout unchanged)",
               sector_idx=None, speed=None, st_speed=None, pole_lap=None)
    # Sector split and speed trace from the pole lap (OpenF1 position + car data, same coordinate frame).
    laps = [l for l in get(f"{OPENF1}/laps", {"session_key": quali_key, "driver_number": pole_number}) if l.get("lap_duration")]
    if not laps:
        return out
    best = min(laps, key=lambda l: l["lap_duration"])
    t0 = datetime.fromisoformat(best["date_start"])
    t1 = t0 + timedelta(seconds=best["lap_duration"])
    loc = get(f"{OPENF1}/location", {"session_key": quali_key, "driver_number": pole_number,
                                     "date>": t0.isoformat(), "date<": t1.isoformat()})
    car = get(f"{OPENF1}/car_data", {"session_key": quali_key, "driver_number": pole_number,
                                     "date>": t0.isoformat(), "date<": t1.isoformat()})
    out["pole_lap"] = dict(number=pole_number, lap_s=best["lap_duration"], s1=best["duration_sector_1"],
                           s2=best["duration_sector_2"], s3=best["duration_sector_3"], st_speed=best.get("st_speed"),
                           i1_speed=best.get("i1_speed"), i2_speed=best.get("i2_speed"))
    out["st_speed"] = best.get("st_speed")

    def nearest(px, py):
        return min(range(len(xs)), key=lambda i: (xs[i] - px) ** 2 + (ys[i] - py) ** 2)

    if loc:
        def at(sec):
            tt = t0 + timedelta(seconds=sec)
            p = min(loc, key=lambda q: abs((datetime.fromisoformat(q["date"]) - tt).total_seconds()))
            return nearest(p["x"], p["y"])
        out["sector_idx"] = [at(0.0), at(best["duration_sector_1"]),
                             at(best["duration_sector_1"] + best["duration_sector_2"])]
    if loc and car:
        # speed at each outline point: nearest location sample in space -> nearest car_data sample in time
        locd = [(datetime.fromisoformat(q["date"]), q["x"], q["y"]) for q in loc if q["x"] or q["y"]]
        card = [(datetime.fromisoformat(c["date"]), c["speed"]) for c in car if c.get("speed") is not None]
        spd = []
        for x, y in zip(xs, ys):
            tq = min(locd, key=lambda q: (q[1] - x) ** 2 + (q[2] - y) ** 2)[0]
            spd.append(min(card, key=lambda c: abs((c[0] - tq).total_seconds()))[1])
        out["speed"] = spd
        out["speed_source"] = f"OpenF1 car_data, pole lap #{pole_number}"
    return out


def grid_block(quali_race, drivers_meta):
    rows = []
    for x in quali_race.get("QualifyingResults", []):
        times = [lap_s(x.get(q)) for q in ("Q1", "Q2", "Q3")]
        best = min([t for t in times if t], default=None)
        num = int(x["number"])
        meta = drivers_meta.get(num, {})
        rows.append(dict(pos=int(x["position"]), number=num, code=x["Driver"]["code"],
                         driver_id=x["Driver"]["driverId"],
                         name=f"{x['Driver']['givenName']} {x['Driver']['familyName']}",
                         team=x["Constructor"]["name"], team_id=x["Constructor"]["constructorId"],
                         colour="#" + meta["team_colour"] if meta.get("team_colour") else None,
                         q=times, best_s=best))
    pole = min(r["best_s"] for r in rows if r["best_s"])
    for r in rows:
        r["gap_s"] = round(r["best_s"] - pole, 3) if r["best_s"] else None
    return rows


def season_block(season, results, quali, upto_round):
    by = {}
    for k in sorted(results):
        if k >= upto_round:
            continue
        r = results[k]
        qpos = {q["Driver"]["driverId"]: int(q["position"]) for q in quali.get(k, {}).get("QualifyingResults", [])}
        for x in r.get("Results", []):
            st = x["status"]
            fin = st == "Finished" or st.startswith("+") or st == "Lapped"
            by.setdefault(x["Driver"]["driverId"], []).append(dict(
                round=k, race=r["raceName"].replace(" Grand Prix", ""), circuit_id=r["Circuit"]["circuitId"],
                team_id=x["Constructor"]["constructorId"], grid=int(x["grid"]), quali=qpos.get(x["Driver"]["driverId"]),
                finish=int(x["position"]), classified=fin, status=st, points=float(x["points"])))
    return by


def retirement_rates(season_by):
    team = {}
    for rows in season_by.values():
        for r in rows:
            t = team.setdefault(r["team_id"], [0, 0])
            t[0] += not r["classified"]
            t[1] += 1
    prior, w = 0.15, 12.0
    return {k: round((a + prior * w) / (n + w), 4) for k, (a, n) in team.items()}, prior


def incident_block(season, circuit_short, laps):
    """SC/VSC deployments per race from OpenF1 race control: this circuit 2023+ and the current season."""
    def count(sk):
        rc = get(f"{OPENF1}/race_control", {"session_key": sk, "category": "SafetyCar"})
        msg = [m["message"].upper() for m in rc]
        vsc = sum(("VSC DEPLOYED" in m) or ("VIRTUAL SAFETY CAR DEPLOYED" in m) for m in msg)
        sc = sum(("SAFETY CAR DEPLOYED" in m) and ("VIRTUAL" not in m) for m in msg)
        red = len(get(f"{OPENF1}/race_control", {"session_key": sk, "flag": "RED"}))
        return sc, vsc, red
    now = datetime.now(timezone.utc)
    here, seas = [], []
    for y in range(2023, season + 1):
        for s in get(f"{OPENF1}/sessions", {"year": y, "session_name": "Race"}):
            if s.get("is_cancelled") or datetime.fromisoformat(s["date_end"]) > now:
                continue
            if s["circuit_short_name"] == circuit_short or y == season:
                sc, vsc, red = count(s["session_key"])
                row = dict(year=y, circuit=s["circuit_short_name"], sc=sc, vsc=vsc, red=red)
                if s["circuit_short_name"] == circuit_short:
                    here.append(row)
                if y == season:
                    seas.append(row)
    def rate(rows, k):
        return sum(r[k] for r in rows) / len(rows) if rows else None
    # Blend: the current season's rate (same cars/rules) with this circuit's history, equal weight.
    est = {}
    for k in ("sc", "vsc", "red"):
        a, b = rate(seas, k), rate(here, k)
        est[k] = (a + b) / 2 if a is not None and b is not None else (a if a is not None else b)
    return dict(circuit_history=here, season=seas,
                per_race=est, per_lap={k: (v / laps if v is not None else None) for k, v in est.items()},
                method="mean of (current-season rate, this circuit 2023+ rate); deployments counted from OpenF1 race control")


def weather_block(lat, lon, date, tz):
    try:
        d = get("https://api.open-meteo.com/v1/forecast", {
            "latitude": lat, "longitude": lon, "start_date": date, "end_date": date, "timezone": tz,
            "hourly": "temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,"
                      "precipitation_probability,precipitation,weather_code,cloud_cover"})
        return dict(retrieved_at=datetime.now(timezone.utc).isoformat(), kind="forecast_snapshot", hourly=d["hourly"],
                    source="Open-Meteo forecast API")
    except Exception as e:  # noqa: BLE001
        print("  weather snapshot failed:", e)
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=2026)
    ap.add_argument("--round", type=int, default=18)
    a = ap.parse_args()
    facts = EVENT_FACTS[(a.season, a.round)]
    now = datetime.now(timezone.utc)
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "event").mkdir(exist_ok=True)

    print("calendar")
    cal, sched = calendar(a.season, now)
    (OUT / "calendar.json").write_text(json.dumps(dict(season=a.season, generated=now.isoformat(), races=cal,
                                                       live_round=a.round), indent=1))
    ev = next(r for r in cal if r["round"] == a.round)

    print("OpenF1 sessions")
    meet = [s for s in get(f"{OPENF1}/sessions", {"year": a.season}) if abs((datetime.fromisoformat(s["date_start"]) - datetime.fromisoformat(ev["race_utc"])).days) <= 3]
    sessions = [dict(name=s["session_name"], type=s["session_type"], start_utc=s["date_start"], end_utc=s["date_end"],
                     key=s["session_key"]) for s in sorted(meet, key=lambda s: s["date_start"])]
    quali_key = next((s["key"] for s in sessions if s["name"] == "Qualifying"), None)
    circuit_key = meet[0]["circuit_key"] if meet else None
    circuit_short = meet[0]["circuit_short_name"] if meet else None

    print("qualifying + drivers")
    q = jolpica_races(f"{a.season}/{a.round}/qualifying.json").get(a.round, {})
    dmeta = {d["driver_number"]: d for d in get(f"{OPENF1}/drivers", {"session_key": quali_key})} if quali_key else {}
    grid = grid_block(q, dmeta) if q else []

    print("track")
    pole_num = grid[0]["number"] if grid else None
    trk = track_block(circuit_key, a.season, quali_key, pole_num) if circuit_key else None

    print("season results")
    res = jolpica_races(f"{a.season}/results.json")
    qual = jolpica_races(f"{a.season}/qualifying.json")
    season_by = season_block(a.season, res, qual, a.round)
    dnf, dnf_prior = retirement_rates(season_by)

    print("incident rates (OpenF1 race control)")
    inc = incident_block(a.season, circuit_short, facts["laps"])

    print("weather snapshot")
    wx = weather_block(ev["lat"], ev["lon"], ev["race_utc"][:10], facts["tz"])

    ours = [g for g in grid if g["team_id"] == OUR_TEAM]
    bundle = dict(
        meta=dict(season=a.season, round=a.round, slug=facts["slug"], name=ev["name"], circuit=ev["circuit"],
                  country=ev["country"], locality=ev["locality"], lat=ev["lat"], lon=ev["lon"], race_utc=ev["race_utc"],
                  tz=facts["tz"], laps=facts["laps"], lap_km=facts["lap_km"], sprint=ev["sprint"],
                  compounds=facts["compounds"], sets=facts["sets"], generated=now.isoformat(),
                  grid_note="Grid = qualifying order. Penalties not verified; edit the start position if the official grid differs.",
                  our_team=OUR_TEAM),
        sessions=sessions, grid=grid, our_drivers=[g["driver_id"] for g in ours], track=trk,
        season=season_by, retirement=dict(by_team=dnf, prior=dnf_prior,
                                          method="2026 non-classified finishes per car-race, shrunk to a 15 % prior with weight 12"),
        incidents=inc, weather_snapshot=wx,
        sources=[
            dict(name="Jolpica-F1 (Ergast API)", url="https://api.jolpi.ca/ergast/f1", used="schedule, qualifying, 2026 results"),
            dict(name="OpenF1", url="https://openf1.org", used="session times, team colours, race control, pole-lap position/speed"),
            dict(name="MultiViewer circuit API", url="https://api.multiviewer.app", used="track outline, corners, pit loss"),
            dict(name="Open-Meteo", url="https://open-meteo.com", used="hourly forecast (live in the browser, snapshot here)"),
            dict(name="Pirelli / formula1.com", url="https://www.formula1.com/en/latest/article/what-tyres-will-the-teams-and-drivers-have-for-the-2026-united-states-grand-prix.44LKddYSbUJK1LxMAa6VLI",
                 used="compound allocation C2/C3/C4"),
        ])
    path = OUT / "event" / f"{facts['slug']}.json"
    path.write_text(json.dumps(bundle, separators=(",", ":")))
    print(f"wrote {path} ({path.stat().st_size // 1024} kB); grid rows {len(grid)}, sessions {len(sessions)}")


if __name__ == "__main__":
    main()
