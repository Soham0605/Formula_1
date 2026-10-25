#!/usr/bin/env python3
"""Serve the dashboard and (optionally) run new cases from the browser.

    python serve.py                 # port 8050, listens on all interfaces (HiPerGator node)
    python serve.py --local         # 127.0.0.1 only: the right choice on your own laptop
    python serve.py --port 8123
    python serve.py --no-api        # static files only, the control panel is disabled
    python serve.py --workers 8     # cores used by runs started from the browser

OpenF1 relay (race console live sync):
    GET  /api/openf1/<endpoint>?...   forwards laps / stints / race_control / intervals / position / pit / sessions /
                                      drivers to api.openf1.org. With OPENF1_USERNAME and OPENF1_PASSWORD set it adds a
                                      bearer token (fetched and refreshed here), which OpenF1 requires during live sessions.
                                      Credentials stay on this machine; the browser never sees them.

API (used by the dashboard, JSON):
    GET  /api/state        -> {api, running, job, workers}
    POST /api/run          -> body {"params": {...}, "quality": "quick|standard|full"}; returns the job (cached results return at once)
Finished runs are cached in dashboard/data/cache/<id>/results.json, so the same case is never computed twice and
a link such as  http://localhost:8050/?src=<id>  reopens it.

Standard library only; every asset in the page is a relative URL, so it also works behind a tunnel or path-prefix proxy.
"""
import argparse
import functools
import getpass
import hashlib
import http.server
import json
import os
import re
import shutil
import socket
import socketserver
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE / "dashboard"
CACHE = ROOT / "barcelona" / "data" / "cache"   # Barcelona case-study runs
MAX_CACHE = 40

# name: (type, min, max). Anything not listed here is rejected.
ALLOWED = {
    "grid_pos": (int, 1, 22), "lap1_pos": (int, 1, 22),
    "gap_ahead_s": (float, 0.05, 3.0), "gap_behind_s": (float, 0.05, 3.0),
    "start_compound": (int, -1, 2),
    "force_lap": (int, 0, 65), "force_kind": (int, 0, 3), "force_dur": (int, 1, 8),
    "air_c": (float, 5.0, 45.0), "track_offset_c": (float, 0.0, 30.0),
    "pit_loss_s": (float, 15.0, 35.0), "pass_delta_s": (float, 0.0, 2.0), "deg_scale": (float, 0.4, 2.0),
    "uncertainty": (bool, 0, 1), "seed": (int, 1, 99999),
}
QUALITY = {"quick": "~15 s", "standard": "~1-2 min", "full": "~4 min"}

STATE = dict(job=None)
LOCK = threading.Lock()
SETTINGS = dict(workers=1, api=True)


OPENF1 = "https://api.openf1.org"
OPENF1_ENDPOINTS = {"laps", "stints", "race_control", "intervals", "position", "pit", "sessions", "drivers"}
_TOKEN = dict(value=None, until=0.0)
_RELAY_CACHE: dict = {}


def openf1_token():
    """Bearer token from OPENF1_USERNAME / OPENF1_PASSWORD (OAuth password flow, 1 h lifetime), cached."""
    user, pw = os.environ.get("OPENF1_USERNAME"), os.environ.get("OPENF1_PASSWORD")
    if not (user and pw):
        return None
    if _TOKEN["value"] and time.time() < _TOKEN["until"] - 120:
        return _TOKEN["value"]
    body = urllib.parse.urlencode({"username": user, "password": pw}).encode()
    req = urllib.request.Request(f"{OPENF1}/token", data=body, headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=20) as r:
        d = json.loads(r.read())
    _TOKEN.update(value=d["access_token"], until=time.time() + float(d.get("expires_in", 3600)))
    return _TOKEN["value"]


def openf1_relay(endpoint, raw_query):
    """Forward one whitelisted OpenF1 request. Browsers percent-encode '<' and '>' in filters; OpenF1 wants them raw."""
    pairs = [urllib.parse.unquote(x) for x in raw_query.split("&") if x]
    q = "&".join(urllib.parse.quote(x, safe="=<>:+-._") for x in pairs)
    key = (endpoint, q)
    hit = _RELAY_CACHE.get(key)
    if hit and time.time() - hit[0] < 5:
        return hit[1], hit[2]
    headers = {"User-Agent": "pit-wall-relay"}
    tok = openf1_token()
    if tok:
        headers["Authorization"] = f"Bearer {tok}"
    try:
        with urllib.request.urlopen(urllib.request.Request(f"{OPENF1}/v1/{endpoint}?{q}", headers=headers), timeout=25) as r:
            code, body = r.status, r.read()
    except urllib.error.HTTPError as e:
        code, body = e.code, e.read()
    _RELAY_CACHE[key] = (time.time(), code, body)
    return code, body


def clean(params):
    out = {}
    for k, v in (params or {}).items():
        if k not in ALLOWED:
            continue
        t, lo, hi = ALLOWED[k]
        if t is bool:
            out[k] = bool(v) if not isinstance(v, str) else v.lower() in ("1", "true", "yes", "on")
        else:
            try:
                x = t(float(v)) if t is int else float(v)
            except (TypeError, ValueError):
                continue
            out[k] = max(lo, min(hi, x))
    return out


def job_id(params, quality):
    blob = json.dumps([sorted(params.items()), quality, (HERE / "f1strat" / "sim.py").stat().st_mtime_ns // 10**9 // 3600], default=str)
    return hashlib.sha1(blob.encode()).hexdigest()[:10]


def prune():
    dirs = sorted([d for d in CACHE.glob("*") if d.is_dir()], key=lambda d: d.stat().st_mtime)
    for d in dirs[:-MAX_CACHE]:
        shutil.rmtree(d, ignore_errors=True)


def run_job(job):
    out = CACHE / job["id"]
    tmp = CACHE / (job["id"] + ".tmp")
    shutil.rmtree(tmp, ignore_errors=True)
    cmd = [sys.executable, str(HERE / "run_analysis.py"), "--quality", job["quality"], "--workers", str(SETTINGS["workers"]),
           "--params", json.dumps(job["params"]), "--out", str(tmp)]
    job["log"] = []
    try:
        proc = subprocess.Popen(cmd, cwd=str(HERE), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        names = {1: "track model", 2: "strategy search", 3: "scenario breakdown", 4: "forecast and uncertainty",
                 5: "race replays", 6: "sensitivity", 7: "model blocks", 8: "writing results"}
        for line in proc.stdout:
            line = line.rstrip()
            job["log"] = (job["log"] + [line])[-30:]
            m = re.match(r"\[(\d)/8\]", line)
            if m:
                job["step"] = int(m.group(1))
                job["step_name"] = names.get(job["step"], "")
            m = re.match(r"\[search\] stage (\d) done", line)
            if m:
                job["substep"] = f"search stage {m.group(1)} of 3 done"
        code = proc.wait()
        if code != 0 or not (tmp / "results.json").exists():
            raise RuntimeError("run_analysis.py exited with code %s\n%s" % (code, "\n".join(job["log"][-8:])))
        shutil.rmtree(out, ignore_errors=True)
        tmp.rename(out)
        job["status"] = "done"
        prune()
    except Exception as e:  # noqa: BLE001
        job["status"] = "error"
        job["error"] = str(e)
    job["finished"] = time.time()


def public(job):
    if job is None:
        return None
    keys = ("id", "status", "quality", "params", "step", "step_name", "substep", "error", "started", "finished", "eta")
    d = {k: job.get(k) for k in keys}
    d["elapsed"] = round((job.get("finished") or time.time()) - job["started"], 1)
    return d


def start(params, quality):
    params = clean(params)
    quality = quality if quality in QUALITY else "standard"
    jid = job_id(params, quality)
    with LOCK:
        cur = STATE["job"]
        if (CACHE / jid / "results.json").exists():
            job = dict(id=jid, status="done", quality=quality, params=params, started=time.time(), finished=time.time(), step=8)
            if not (cur and cur["status"] == "running"):
                STATE["job"] = job
            return job, 200
        if cur and cur["status"] == "running":
            return cur, (200 if cur["id"] == jid else 409)
        job = dict(id=jid, status="running", quality=quality, params=params, started=time.time(), step=0, step_name="starting", eta=QUALITY[quality])
        STATE["job"] = job
        CACHE.mkdir(parents=True, exist_ok=True)
        threading.Thread(target=run_job, args=(job,), daemon=True).start()
        return job, 200


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        m = re.search(r"/api/openf1/([a-z_]+)$", path.rstrip("/"))
        if m:
            if m.group(1) not in OPENF1_ENDPOINTS:
                return self._json(dict(error="endpoint not allowed"), 404)
            try:
                code, body = openf1_relay(m.group(1), self.path.split("?", 1)[1] if "?" in self.path else "")
            except Exception as e:  # noqa: BLE001
                return self._json(dict(detail=f"relay error: {e}"), 502)
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path.rstrip("/").endswith("/api/state"):
            if not SETTINGS["api"]:
                return self._json(dict(api=False, openf1_relay=True, openf1_auth=bool(os.environ.get("OPENF1_USERNAME"))))
            job = STATE["job"]
            return self._json(dict(api=True, openf1_relay=True, openf1_auth=bool(os.environ.get("OPENF1_USERNAME")),
                                   running=bool(job and job["status"] == "running"), job=public(job),
                                   workers=SETTINGS["workers"], quality=QUALITY, limits={k: [v[1], v[2]] for k, v in ALLOWED.items()}))
        return super().do_GET()

    def do_POST(self):
        path = self.path.split("?")[0]
        if not path.rstrip("/").endswith("/api/run") or not SETTINGS["api"]:
            return self._json(dict(error="not found"), 404)
        try:
            n = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(min(n, 20000)) or b"{}")
        except Exception:  # noqa: BLE001
            return self._json(dict(error="bad request"), 400)
        job, code = start(body.get("params", {}), body.get("quality", "standard"))
        return self._json(public(job), code)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8050)
    ap.add_argument("--local", action="store_true", help="bind 127.0.0.1 only")
    ap.add_argument("--no-api", action="store_true", help="serve static files only (no runs from the browser)")
    ap.add_argument("--workers", type=int, default=None, help="cores for runs started from the browser")
    a = ap.parse_args()
    from f1strat.strategies import default_workers
    SETTINGS.update(workers=a.workers or default_workers(), api=not a.no_api)
    if not (ROOT / "data" / "event").exists():
        print("Event bundle not found: run `python fetch_event.py` (race console) first.")
    host = "127.0.0.1" if a.local else "0.0.0.0"
    handler = functools.partial(Handler, directory=str(ROOT))
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    node = socket.gethostname().split(".")[0]
    user = os.environ.get("USER") or getpass.getuser()
    with socketserver.ThreadingTCPServer((host, a.port), handler) as srv:
        print(f"\nDashboard is up: http://localhost:{a.port}   (runs from the browser: {'on, %d workers' % SETTINGS['workers'] if SETTINGS['api'] else 'off'})\n")
        if not a.local:
            print("On a cluster node, reach it with one of:")
            print("  VS Code Remote-SSH: Ports panel -> forward", a.port, "-> http://localhost:%d" % a.port)
            print(f"  SSH tunnel (run on your laptop): ssh -N -L {a.port}:{node}:{a.port} {user}@hpg.rc.ufl.edu")
            print(f"  Open OnDemand proxy: https://ood.rc.ufl.edu/rnode/{node}/{a.port}/")
            if SETTINGS["api"]:
                print("  Note: anyone who can reach this port can start runs. Use --local on a shared node, or --no-api.")
        print("\nCtrl-C to stop.")
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")


if __name__ == "__main__":
    main()
