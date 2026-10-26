#!/usr/bin/env python3
"""
Fetch actual race results, compare with Pit Wall predictions, write to
dashboard/data/actuals/{slug}_actual.json  and update
dashboard/data/actuals/season_{year}.json index.

Usage:
    python fetch_actual.py --round 18
    python fetch_actual.py --round 18 --season 2026
    python fetch_actual.py --round 18 --notes "VSC triggered by COL crash, strategy triggered by tyre deg"
"""
import json, requests, sys, argparse
from pathlib import Path
from datetime import datetime, timezone
from collections import defaultdict

BASE_JOLPICA = "https://api.jolpi.ca/ergast/f1"
BASE_OPENF1  = "https://api.openf1.org/v1"
TIMEOUT      = 15

# Our drivers (map from event-bundle driver_id → Jolpica driverId)
OUR_DRIVERS = {
    "max_verstappen": {"jolpica_id": "max_verstappen", "code": "VER", "number": 3},
    "hadjar":         {"jolpica_id": "isack_hadjar",   "code": "HAD", "number": 6},
}

COMPOUND_SHORT = {"SOFT": "S", "MEDIUM": "M", "HARD": "H",
                  "INTERMEDIATE": "I", "WET": "W"}

EVENT_SLUGS = {
    (2026, 18): "usa_2026",
}


def get(url, **params):
    r = requests.get(url, params=params or None, timeout=TIMEOUT)
    r.raise_for_status()
    return r.json()


def jolpica_results(season, rnd):
    d = get(f"{BASE_JOLPICA}/{season}/{rnd}/results.json")
    races = d["MRData"]["RaceTable"].get("Races", [])
    if not races:
        sys.exit(f"Jolpica returned no race data for {season} R{rnd}.")
    return races[0]


def jolpica_pitstops(season, rnd):
    d = get(f"{BASE_JOLPICA}/{season}/{rnd}/pitstops.json")
    races = d["MRData"]["RaceTable"].get("Races", [])
    return races[0].get("PitStops", []) if races else []


def openf1_stints(session_key, driver_number):
    return get(f"{BASE_OPENF1}/stints",
               session_key=session_key, driver_number=driver_number)


def openf1_race_control(session_key):
    sc  = get(f"{BASE_OPENF1}/race_control",
              session_key=session_key, category="SafetyCar")
    red = get(f"{BASE_OPENF1}/race_control",
              session_key=session_key, flag="RED")
    return sc + red


def build_strategy(stints, jolpica_stops):
    """Reconstruct compound sequence and stop laps from OpenF1 stints."""
    stints = sorted(stints, key=lambda s: s["stint_number"])
    compounds = [COMPOUND_SHORT.get(s["compound"], s["compound"]) for s in stints]
    # Stop laps come from Jolpica (more reliable), stints give compounds
    stop_laps = sorted(int(s["lap"]) for s in jolpica_stops)
    return {"compounds": compounds, "stop_laps": stop_laps, "stops": len(stints) - 1}


def parse_race_events(rc_messages):
    """Turn race_control rows into tidy event dicts."""
    events = []
    deployed = {}
    for m in sorted(rc_messages, key=lambda x: x.get("date", "")):
        msg  = (m.get("message") or "").upper()
        lap  = m.get("lap_number")
        flag = (m.get("flag") or "").upper()
        if "VSC DEPLOYED" in msg or "VIRTUAL SAFETY CAR DEPLOYED" in msg:
            deployed["VSC"] = lap
        elif ("VSC ENDING" in msg or "VIRTUAL SAFETY CAR ENDING" in msg) and "VSC" in deployed:
            events.append({"type": "VSC", "lap": deployed.pop("VSC"), "end_lap": lap})
        elif "SAFETY CAR DEPLOYED" in msg and "VSC" not in msg:
            deployed["SC"] = lap
        elif "IN THIS LAP" in msg and "SC" in deployed:
            events.append({"type": "SC", "lap": deployed.pop("SC"), "end_lap": lap})
        elif flag == "RED":
            events.append({"type": "RED", "lap": lap})
    # Flush any still-open events (e.g. VSC at end of race)
    for k, v in deployed.items():
        events.append({"type": k, "lap": v, "end_lap": None})
    return events


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--round",  type=int, required=True)
    ap.add_argument("--season", type=int, default=2026)
    ap.add_argument("--notes",  default="")
    args = ap.parse_args()

    slug = EVENT_SLUGS.get((args.season, args.round),
                           f"r{args.round:02d}_{args.season}")

    # Load event bundle for session key + context
    ev_path = Path(f"dashboard/data/event/{slug}.json")
    ev = json.loads(ev_path.read_text()) if ev_path.exists() else {}
    meta = ev.get("meta", {})
    sessions = ev.get("sessions", [])
    race_session = next((s for s in sessions if s["name"] == "Race"), None)
    openf1_key = race_session["key"] if race_session else None

    print(f"Fetching {args.season} R{args.round} ({slug})…")

    # ── Jolpica data ─────────────────────────────────────────────────────────
    race  = jolpica_results(args.season, args.round)
    pstops_raw = jolpica_pitstops(args.season, args.round)
    pstops_by_driver = defaultdict(list)
    for s in pstops_raw:
        pstops_by_driver[s["driverId"]].append(s)

    # Full results (all 22 drivers)
    full_results = []
    for res in race["Results"]:
        drv = res["Driver"]
        pos_txt = res.get("positionText", "")
        pos = int(res["position"]) if pos_txt.lstrip("+-").isdigit() else None
        full_results.append({
            "pos": pos, "code": drv["code"],
            "driver_id": drv["driverId"],
            "team": res["Constructor"]["constructorId"],
            "grid": int(res.get("grid", 0)),
            "status": res.get("status", ""),
            "points": float(res.get("points", 0)),
        })

    # ── OpenF1 data ──────────────────────────────────────────────────────────
    race_events = []
    if openf1_key:
        rc = openf1_race_control(openf1_key)
        race_events = parse_race_events(rc)
    else:
        print("  [warn] No OpenF1 session key; skipping SC/VSC data.")

    # ── Per-driver data for our two drivers ──────────────────────────────────
    drivers_out = {}
    for driver_id, info in OUR_DRIVERS.items():
        jid  = info["jolpica_id"]
        code = info["code"]
        num  = info["number"]

        # Jolpica result row
        res = next((r for r in race["Results"]
                    if r["Driver"]["driverId"] == jid), None)
        if not res:
            print(f"  [warn] {code} not found in results")
            drivers_out[driver_id] = {"code": code, "error": "not in results"}
            continue

        pos_txt = res.get("positionText", "")
        pos = int(res["position"]) if pos_txt.lstrip("+-").isdigit() else None
        grid = int(res.get("grid", 0))
        fl = res.get("FastestLap")

        # Strategy from OpenF1 stints + Jolpica pit laps
        stints_raw = openf1_stints(openf1_key, num) if openf1_key else []
        j_stops = pstops_by_driver.get(jid, [])
        strategy = build_strategy(stints_raw, j_stops)

        drivers_out[driver_id] = {
            "code": code,
            "number": num,
            "qualifying_pos": grid,   # grid = qualifying order (penalties not verified)
            "finish_pos": pos,
            "positions_gained": (grid - pos) if (pos and grid) else None,
            "classified": res.get("status") in ("Finished", "") or (pos is not None),
            "status": res.get("status", ""),
            "points": float(res.get("points", 0)),
            "strategy": strategy,
            "fastest_lap": {
                "rank": int(fl["rank"]),
                "lap":  int(fl.get("lap", 0)),
                "time": fl.get("Time", {}).get("time", ""),
            } if fl else None,
            "laps_completed": int(res.get("laps", 0)),
        }
        print(f"  {code}: P{pos} (Q P{grid}) | {' → '.join(strategy['compounds'])} | "
              f"stops L{strategy['stop_laps']} | {res.get('status','')}")

    winner = full_results[0] if full_results else {}
    top5   = [r["code"] for r in full_results[:5]]

    # ── Assemble output ───────────────────────────────────────────────────────
    out = {
        "round": args.round,
        "season": args.season,
        "slug": slug,
        "race_name": race.get("raceName", meta.get("name", "")),
        "circuit": race.get("Circuit", {}).get("circuitName", meta.get("circuit", "")),
        "locality": race.get("Circuit", {}).get("Location", {}).get("locality", meta.get("locality", "")),
        "country": meta.get("country", ""),
        "drivers": drivers_out,
        "race_events": race_events,
        "winner": {"code": winner.get("code"), "driver_id": winner.get("driver_id"), "team": winner.get("team")},
        "top5": top5,
        "full_results": full_results,
        "laps": meta.get("laps", 0),
        "notes": args.notes,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "sources": ["Jolpica (ergast API)", "OpenF1"] if openf1_key else ["Jolpica (ergast API)"],
    }

    out_dir = Path("dashboard/data/actuals")
    out_dir.mkdir(parents=True, exist_ok=True)
    race_file = out_dir / f"{slug}_actual.json"
    race_file.write_text(json.dumps(out, indent=2))
    print(f"  Written: {race_file}")

    # ── Update season index ───────────────────────────────────────────────────
    idx_file = out_dir / f"season_{args.season}.json"
    idx = json.loads(idx_file.read_text()) if idx_file.exists() else {"season": args.season, "races": []}
    # Replace entry for this round if it exists
    idx["races"] = [r for r in idx["races"] if r["round"] != args.round]
    idx["races"].append({
        "round": args.round,
        "slug": slug,
        "file": f"{slug}_actual.json",
        "drivers": list(drivers_out.keys()),
        "winner_code": winner.get("code"),
        "race_events_count": len(race_events),
    })
    idx["races"].sort(key=lambda r: r["round"])
    idx["updated_at"] = datetime.now(timezone.utc).isoformat()
    idx_file.write_text(json.dumps(idx, indent=2))
    print(f"  Index:   {idx_file}")

    print("\nTo add to GitHub Pages: git add dashboard/data/actuals/ && git commit -m 'R{} actual data' && git push".format(args.round))


if __name__ == "__main__":
    main()
