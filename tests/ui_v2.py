import os
SHOTS = os.environ.get("SHOTS", "/tmp/shots")
def run(pg):
    pg.wait_for_selector("#picker-list .race-opt", state="attached", timeout=30000); pg.wait_for_timeout(1200)
    pg.click("#picker-btn"); pg.click("#picker-list .race-opt:not([disabled])")
    pg.wait_for_selector("#sec-driver:not(.hidden)", timeout=60000); pg.wait_for_timeout(2600)
    top = pg.evaluate("Math.round(document.querySelector('#sec-event').getBoundingClientRect().top)")
    print("after select: section top =", top, "px (viewport h", pg.viewport_size["height"], ")")
    pg.screenshot(path=f"{SHOTS}/v2_after_select.png")
    for _ in range(3):
        pg.evaluate("scrollTo(0,0)"); pg.wait_for_timeout(300)
        pg.click("#picker-btn"); pg.click("#picker-list .race-opt:not([disabled])"); pg.wait_for_timeout(400)
    pg.wait_for_timeout(800)
    print("toast:", pg.inner_text("#toast")[:120] if pg.query_selector("#toast.on") else "none")
    pg.screenshot(path=f"{SHOTS}/v2_toast.png")
