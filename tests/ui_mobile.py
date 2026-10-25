import os
SHOTS = os.environ.get("SHOTS", "/tmp/shots")
def run(pg):
    pg.wait_for_selector("#picker-list .race-opt", state="attached", timeout=30000)
    pg.click("#picker-btn"); pg.wait_for_timeout(600)
    pg.screenshot(path=f"{SHOTS}/m1_picker.png")
    pg.click("#picker-list .race-opt:not([disabled])")
    pg.wait_for_selector("#sec-driver:not(.hidden)", timeout=60000); pg.wait_for_timeout(2000)
    pg.click("#drivers .drv[data-id=hadjar]")
    pg.wait_for_selector("#sec-strat:not(.hidden)", timeout=120000)
    pg.wait_for_function("!document.querySelector('#loader').classList.contains('on')", timeout=120000)
    pg.wait_for_timeout(1500)
    w = pg.evaluate("document.documentElement.scrollWidth"); print("scrollWidth", w, "viewport", pg.viewport_size["width"])
    pg.screenshot(path=f"{SHOTS}/m2_full.png", full_page=True)
