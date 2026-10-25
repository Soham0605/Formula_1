"""Serve the repo and load a page in headless Chromium; print its #out text and console errors.
    python tests/run_browser.py tests/engine_test.html [--shot out.png] [--wait-js window.DONE]"""
import argparse, functools, http.server, socketserver, threading, sys
from pathlib import Path
from playwright.sync_api import sync_playwright
ap = argparse.ArgumentParser(); ap.add_argument("page"); ap.add_argument("--shot"); ap.add_argument("--wait-js", default="window.DONE === true")
ap.add_argument("--timeout", type=int, default=240000); ap.add_argument("--width", type=int, default=1440); ap.add_argument("--height", type=int, default=900)
ap.add_argument("--full", action="store_true"); ap.add_argument("--script", default=None, help="python file with run(page) for interactions")
a = ap.parse_args()
root = Path(__file__).resolve().parents[1]
H = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(root))
H.log_message = lambda *x: None
srv = socketserver.ThreadingTCPServer(("127.0.0.1", 0), H); port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
errs = []
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-gl=swiftshader", "--enable-unsafe-swiftshader"])
    pg = b.new_page(viewport={"width": a.width, "height": a.height})
    pg.on("console", lambda m: errs.append(f"[{m.type}] {m.text}") if m.type in ("error", "warning") else None)
    pg.on("pageerror", lambda e: errs.append(f"[pageerror] {e}"))
    pg.goto(f"http://127.0.0.1:{port}/{a.page}")
    if a.script:
        ns = {}; exec(Path(a.script).read_text(), ns); ns["run"](pg)
    else:
        pg.wait_for_function(a.wait_js, timeout=a.timeout)
    out = pg.query_selector("#out")
    if out: print(out.inner_text())
    if a.shot: pg.screenshot(path=a.shot, full_page=a.full)
    b.close()
print("\n".join(errs) if errs else "(no console errors)")
srv.shutdown()
