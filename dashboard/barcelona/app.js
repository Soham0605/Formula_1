/* Pit Wall dashboard. Vanilla JS + SVG, no external requests (works behind SSH tunnels / OnDemand proxies). */
"use strict";
const $ = (s, el = document) => el.querySelector(s);
const NS = "http://www.w3.org/2000/svg";
const TYRE = { S: "#ff4136", M: "#ffd60a", H: "#f4f4f4" };
const SCOL = ["#38bdf8", "#c084fc", "#34d399"];
const STATUS = ["GREEN", "VSC", "SC", "RED FLAG"];
const pct = (x, d = 0) => (x == null ? "–" : (x * 100).toFixed(d) + "%");
const f1 = (x, d = 1) => (x == null ? "–" : Number(x).toFixed(d));

function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}
function sv(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
  if (parent) parent.append(e);
  return e;
}
function niceTicks(min, max, n = 5) {
  const span = max - min || 1, s0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(s0))), nm = s0 / mag;
  const step = (nm < 1.5 ? 1 : nm < 3 ? 2 : nm < 7 ? 5 : 10) * mag, t = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) t.push(+v.toFixed(10));
  return t;
}
const fmtTime = s => { const hh = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s - hh * 3600 - m * 60; return `${hh}:${String(m).padStart(2, "0")}:${sec.toFixed(1).padStart(4, "0")}`; };
const fmtLap = s => `${Math.floor(s / 60)}:${(s % 60).toFixed(3).padStart(6, "0")}`;

/* ---------------- tooltip ---------------- */
const tip = $("#tip");
function showTip(html, ev) {
  tip.innerHTML = html; tip.hidden = false;
  const w = tip.offsetWidth, x = Math.min(ev.clientX + 14, innerWidth - w - 8);
  tip.style.left = x + "px"; tip.style.top = Math.min(ev.clientY + 14, innerHeight - tip.offsetHeight - 8) + "px";
}
const hideTip = () => { tip.hidden = true; };

/* ---------------- line chart ---------------- */
function lineChart(host, o) {
  const W = 720, H = o.height || 250, m = { l: 48, r: 14, t: 14, b: 34 };
  host.innerHTML = ""; host.classList.add("chartbox");
  const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": o.title || "chart" }, host);
  let xs = [], ys = [];
  o.series.forEach(s => s.x.forEach((x, i) => { if (s.y[i] != null) { xs.push(x); ys.push(s.y[i]); } }));
  let x0 = o.xMin ?? Math.min(...xs), x1 = o.xMax ?? Math.max(...xs);
  let y0 = o.yMin ?? Math.min(...ys), y1 = o.yMax ?? Math.max(...ys);
  if (o.yMin == null) y0 = Math.min(y0, 0 + (o.zeroBase ? 0 : y0));
  if (y0 === y1) { y0 -= 1; y1 += 1; }
  const pad = o.yMax == null ? (y1 - y0) * 0.06 : 0; y1 += pad; if (o.yMin == null && !o.zeroBase) y0 -= pad;
  const X = v => m.l + (v - x0) / (x1 - x0) * (W - m.l - m.r);
  const Y = v => o.invert ? m.t + (v - y0) / (y1 - y0) * (H - m.t - m.b) : H - m.b - (v - y0) / (y1 - y0) * (H - m.t - m.b);
  (o.hbands || []).forEach(b => {
    const a = Y(Math.max(b.y0, y0)), c = Y(Math.min(b.y1, y1));
    sv("rect", { x: m.l, y: Math.min(a, c), width: W - m.l - m.r, height: Math.abs(a - c), fill: b.color, opacity: .16 }, svg);
    if (b.label) sv("text", { x: W - m.r - 4, y: Math.min(a, c) + 12, "text-anchor": "end", fill: b.color }, svg).textContent = b.label;
  });
  (o.bands || []).forEach(b => {
    sv("rect", { x: X(b.x0), y: m.t, width: Math.max(2, X(b.x1) - X(b.x0)), height: H - m.t - m.b, fill: b.color, opacity: .2 }, svg);
    if (b.label) sv("text", { x: X(b.x0) + 3, y: m.t + 11, fill: b.color }, svg).textContent = b.label;
  });
  niceTicks(y0, y1, 5).forEach(t => {
    sv("line", { x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t), class: "gridl" }, svg);
    sv("text", { x: m.l - 6, y: Y(t) + 4, "text-anchor": "end" }, svg).textContent = (o.yFmt || (v => v))(t);
  });
  niceTicks(x0, x1, 8).forEach(t => {
    sv("text", { x: X(t), y: H - m.b + 15, "text-anchor": "middle" }, svg).textContent = (o.xFmt || (v => v))(t);
  });
  sv("line", { x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b, class: "axis" }, svg);
  if (o.xLabel) sv("text", { x: (m.l + W - m.r) / 2, y: H - 3, "text-anchor": "middle" }, svg).textContent = o.xLabel;
  if (o.yLabel) { const t = sv("text", { x: 11, y: (m.t + H - m.b) / 2, "text-anchor": "middle", transform: `rotate(-90 11 ${(m.t + H - m.b) / 2})` }, svg); t.textContent = o.yLabel; }
  (o.markers || []).forEach(k => {
    sv("line", { x1: X(k.x), x2: X(k.x), y1: m.t, y2: H - m.b, stroke: k.color || "#9096a3", "stroke-dasharray": "3 3", "stroke-width": 1, opacity: .8 }, svg);
    if (k.label) sv("text", { x: X(k.x) + 2, y: k.y ?? m.t + 10, fill: k.color || "#9096a3" }, svg).textContent = k.label;
  });
  o.series.forEach(s => {
    let d = "", pen = false;
    s.x.forEach((x, i) => { const y = s.y[i]; if (y == null) { pen = false; return; } d += `${pen ? "L" : "M"}${X(x).toFixed(1)},${Y(y).toFixed(1)}`; pen = true; });
    sv("path", { d, fill: "none", stroke: s.color, "stroke-width": s.width || 2, "stroke-dasharray": s.dash || "", "stroke-linejoin": "round" }, svg);
    if (s.dots) s.x.forEach((x, i) => { if (s.y[i] != null) sv("circle", { cx: X(x), cy: Y(s.y[i]), r: 2.6, fill: s.dots[i] || s.color }, svg); });
  });
  const cur = sv("line", { y1: m.t, y2: H - m.b, stroke: "#ecedf0", "stroke-width": 1, opacity: 0 }, svg);
  const overlay = sv("rect", { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: "transparent" }, svg);
  overlay.addEventListener("mousemove", ev => {
    const r = svg.getBoundingClientRect(), px = (ev.clientX - r.left) / r.width * W;
    const xv = x0 + (px - m.l) / (W - m.l - m.r) * (x1 - x0);
    const base = o.series[0]; let bi = 0, bd = 1e18;
    base.x.forEach((x, i) => { const d = Math.abs(x - xv); if (d < bd) { bd = d; bi = i; } });
    const xx = base.x[bi]; cur.setAttribute("x1", X(xx)); cur.setAttribute("x2", X(xx)); cur.setAttribute("opacity", .5);
    const rows = o.series.map(s => { const i = s.x.indexOf(xx); const v = i >= 0 ? s.y[i] : null; return v == null ? "" : `<div><span style="color:${s.color}">●</span> ${s.name}: <b class="num">${(o.tipFmt || (v => f1(v, 2)))(v)}</b></div>`; }).join("");
    showTip(`<div class="num">${o.xTip ? o.xTip(xx) : (o.xLabel || "x") + " " + (o.xFmt || (v => v))(xx)}</div>${rows}`, ev);
    if (o.onHover) o.onHover(xx);
  });
  overlay.addEventListener("mouseleave", () => { hideTip(); cur.setAttribute("opacity", 0); });
  if (o.legend !== false && o.series.length > 1 || o.legend) host.append(h("div", { class: "legend" }, o.series.map(s => h("span", { html: `<i style="background:${s.color}"></i>${s.name}` }))));
  return { svg, X, Y };
}

/* ---------------- grouped bars ---------------- */
function barChart(host, o) {
  const W = 720, H = o.height || 230, m = { l: 44, r: 10, t: 12, b: 30 };
  host.innerHTML = ""; host.classList.add("chartbox");
  const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": o.title || "bar chart" }, host);
  const ymax = o.yMax ?? (Math.max(...o.series.flatMap(s => s.vals)) * 1.08 || 1);
  const Y = v => H - m.b - v / ymax * (H - m.t - m.b);
  niceTicks(0, ymax, 4).forEach(t => { sv("line", { x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t), class: "gridl" }, svg); sv("text", { x: m.l - 6, y: Y(t) + 4, "text-anchor": "end" }, svg).textContent = (o.yFmt || (v => v))(t); });
  const gw = (W - m.l - m.r) / o.cats.length, bw = Math.min(26, (gw - 6) / o.series.length);
  o.cats.forEach((c, i) => {
    const gx = m.l + i * gw + gw / 2 - bw * o.series.length / 2;
    sv("text", { x: m.l + i * gw + gw / 2, y: H - m.b + 15, "text-anchor": "middle" }, svg).textContent = c;
    o.series.forEach((s, j) => {
      const v = s.vals[i], r = sv("rect", { x: gx + j * bw, y: Y(v), width: bw - 2, height: Math.max(0, H - m.b - Y(v)), fill: s.color, rx: 1.5 }, svg);
      r.addEventListener("mousemove", ev => showTip(`<b>${s.name}</b><div class="num">${o.catName || ""} ${c}: ${(o.tipFmt || (x => pct(x, 1)))(v)}</div>`, ev));
      r.addEventListener("mouseleave", hideTip);
    });
  });
  sv("line", { x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b, class: "axis" }, svg);
  if (o.series.length > 1) host.append(h("div", { class: "legend" }, o.series.map(s => h("span", { html: `<i style="background:${s.color}"></i>${s.name}` }))));
}

function heatColor(v, lo, hi, rev) {
  let t = Math.max(0, Math.min(1, (v - lo) / (hi - lo || 1))); if (rev) t = 1 - t;
  const a = [248, 113, 113], b = [251, 191, 36], c = [52, 211, 153];
  const mix = (p, q, u) => p.map((x, i) => Math.round(x + (q[i] - x) * u));
  const col = t < .5 ? mix(a, b, t * 2) : mix(b, c, (t - .5) * 2);
  return `rgb(${col.join(",")})`;
}

/* ============================================================== */
let R = null, API = null, SRC = null;
const DEFAULT_CASE = { grid_pos: 3, lap1_pos: 4, start_compound: -1, gap_ahead_s: 0.22, gap_behind_s: 0.22, force_kind: 0, force_lap: 20, force_dur: 3,
  air_c: 25, track_offset_c: 15, pit_loss_s: 21.5, pass_delta_s: 0.7, deg_scale: 1, uncertainty: true, seed: 2026 };
const QUALITY_LABEL = { quick: "Quick (~15 s, rough)", standard: "Standard (~1–2 min)", full: "Full (~4 min, 1,500 races/plan)" };

async function boot() {
  const q = new URLSearchParams(location.search);
  SRC = /^[0-9a-f]{10}$/.test(q.get("src") || "") ? q.get("src") : null;
  try { const r = await fetch("api/state", { cache: "no-store" }); API = r.ok ? await r.json() : null; if (API && !API.api) API = null; } catch (e) { API = null; }
  try {
    const res = await fetch(SRC ? `data/cache/${SRC}/results.json` : "data/results.json", { cache: "no-store" });
    if (!res.ok) throw new Error(res.status);
    R = await res.json();
  } catch (e) {
    $("#subtitle").textContent = API ? "No results yet. Choose a case below and press Run." : "No results yet. Run `python run_analysis.py`, then reload this page.";
    buildControls();
    autoRun(q);
    return;
  }
  header(); buildControls();
  const builders = { strategy: buildStrategy, forecast: buildForecast, replay: buildReplay, track: buildTrack, tyres: buildTyres, risk: buildRisk, model: buildModel };
  const done = {};
  const show = name => {
    document.querySelectorAll(".tabs button").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === name));
    document.querySelectorAll(".panel").forEach(p => p.hidden = p.id !== "tab-" + name);
    if (!done[name]) { done[name] = true; builders[name]($("#tab-" + name)); }
    history.replaceState(null, "", location.search + "#" + name);
  };
  document.querySelectorAll(".tabs button").forEach(b => b.addEventListener("click", () => show(b.dataset.tab)));
  show(location.hash.slice(1) in builders ? location.hash.slice(1) : "strategy");
  autoRun(q);
}

/* ---------------- case controls + live runs ---------------- */
function caseFromQuery(q) {
  const out = {};
  for (const k of Object.keys(DEFAULT_CASE)) if (q.has(k)) out[k] = typeof DEFAULT_CASE[k] === "boolean" ? q.get(k) === "1" || q.get(k) === "true" : Number(q.get(k));
  return out;
}
function autoRun(q) {
  const p = caseFromQuery(q);
  if (API && !q.get("src") && Object.keys(p).length) runCase({ ...(R?.meta?.case || DEFAULT_CASE), ...p }, q.get("q") || "standard");
}
function queryOf(params, quality, src) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) u.set(k, typeof v === "boolean" ? (v ? 1 : 0) : v);
  u.set("q", quality); if (src) u.set("src", src);
  return "?" + u.toString();
}
let ctlState = null;
function buildControls() {
  const host = $("#controls"), c0 = { ...DEFAULT_CASE, ...(R?.meta?.case || {}) };
  const st = ctlState = { ...c0, quality: new URLSearchParams(location.search).get("q") || "standard" };
  const num = (key, label, min, max, step, hint) => h("label", { class: "fld" }, h("span", {}, label),
    h("input", { type: "number", min, max, step, value: st[key], onchange: e => { st[key] = Number(e.target.value); } }), hint ? h("small", {}, hint) : null);
  const sel = (key, label, opts, hint, numeric = true) => h("label", { class: "fld" }, h("span", {}, label),
    h("select", { onchange: e => { st[key] = numeric ? Number(e.target.value) : e.target.value; } }, opts.map(([v, t]) => h("option", { value: v, selected: v === st[key] }, t))), hint ? h("small", {}, hint) : null);
  const pos = Array.from({ length: 22 }, (_, i) => [i + 1, "P" + (i + 1)]);
  const status = h("div", { class: "runstatus", role: "status" });
  const bar = h("div", { class: "bar", hidden: true }, h("i"));
  const btn = h("button", { class: "btn primary", disabled: !API, onclick: () => {
    const { quality, ...params } = st; runCase(params, quality, { status, bar, btn });
  } }, "Run this case");
  const share = h("button", { class: "btn", onclick: async () => {
    const { quality, ...params } = st; const link = location.origin + location.pathname + queryOf(params, quality, SRC);
    try { await navigator.clipboard.writeText(link); status.textContent = "Link copied. Opening it on this server re-uses the finished run."; } catch (e) { status.textContent = link; }
  } }, "Copy link");
  const m = R?.meta;
  const summary = h("summary", {}, h("b", {}, "Case"), " ", m ? m.scenario : "choose a case",
    h("span", { class: "muted" }, m ? ` · ${m.air_c} °C · ${m.sims_per_strategy.toLocaleString()} races per plan${R.forecast?.uncertainty_model?.enabled ? " · with parameter uncertainty" : ""} · click to change` : ""));
  host.replaceChildren(h("details", { class: "ctl", open: !R }, summary,
    h("div", { class: "fields" },
      sel("grid_pos", "Qualified", pos), sel("lap1_pos", "Running order after Turn 1", pos, "the sim starts lap 2 from here"),
      num("gap_ahead_s", "Gap to car ahead (s)", 0.05, 3, 0.05), num("gap_behind_s", "Gap to car behind (s)", 0.05, 3, 0.05),
      sel("start_compound", "Starting tyre", [[-1, "Best of all"], [0, "Soft"], [1, "Medium"], [2, "Hard"]], "Best of all lets the search choose"),
      sel("force_kind", "Forced event", [[0, "None"], [1, "Virtual safety car"], [2, "Safety car"], [3, "Red flag"]], "on top of the random ones"),
      num("force_lap", "…on lap", 1, 65, 1), num("force_dur", "…lasting (laps)", 1, 8, 1),
      num("air_c", "Air temperature (°C)", 5, 45, 1), num("track_offset_c", "Track above air (°C)", 0, 30, 1)),
    h("details", { class: "adv" }, h("summary", {}, "Model assumptions and run quality"),
      h("div", { class: "fields" },
        num("pit_loss_s", "Pit-stop time loss (s)", 15, 35, 0.5), num("pass_delta_s", "Overtaking difficulty (s)", 0, 2, 0.05, "pace edge for a 50 % pass"),
        num("deg_scale", "Tyre wear scale", 0.4, 2, 0.05), num("seed", "Random seed", 1, 99999, 1),
        h("label", { class: "fld chk" }, h("input", { type: "checkbox", checked: st.uncertainty, onchange: e => { st.uncertainty = e.target.checked; } }), h("span", {}, "Parameter uncertainty"), h("small", {}, "draw wear, pit loss, overtaking and incident rates per race")),
        sel("quality", "Run quality", Object.entries(QUALITY_LABEL), null, false))),
    h("div", { class: "runrow" }, btn, share, status), bar,
    API ? null : h("p", { class: "note" }, "Running new cases needs the server: start it with `python serve.py` and open the page from there. You are looking at saved results.")));
  const j = API?.job;
  if (j && j.status === "running") trackJob(j.id, { status, bar, btn });
}
async function runCase(params, quality, ui) {
  ui = ui || { status: $(".runstatus"), bar: $(".bar"), btn: $(".runrow .btn") };
  if (!API) return;
  ui.btn && (ui.btn.disabled = true); ui.status.textContent = "Starting…";
  let r, j;
  try { r = await fetch("api/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ params, quality }) }); j = await r.json(); }
  catch (e) { ui.status.textContent = "Could not reach the server."; ui.btn && (ui.btn.disabled = false); return; }
  if (r.status === 409) ui.status.textContent = "Another case is still running; showing its progress. Press Run again when it finishes.";
  trackJob(j.id, ui, params, quality);
}
function trackJob(id, ui, params, quality) {
  ui.btn && (ui.btn.disabled = true); ui.bar.hidden = false;
  const tick = async () => {
    let s; try { s = await (await fetch("api/state", { cache: "no-store" })).json(); } catch (e) { ui.status.textContent = "Lost contact with the server."; return; }
    const j = s.job;
    if (!j || j.id !== id) { ui.status.textContent = "Run replaced by another one."; ui.btn && (ui.btn.disabled = false); return; }
    ui.bar.firstChild.style.width = Math.max(4, (j.step || 0) / 8 * 100) + "%";
    if (j.status === "running") { ui.status.textContent = `Step ${j.step || 0}/8 · ${j.step_name || "starting"}${j.substep ? " · " + j.substep : ""} · ${Math.round(j.elapsed)} s (expected ${j.eta})`; setTimeout(tick, 1000); return; }
    if (j.status === "error") { ui.status.textContent = "Run failed: " + (j.error || "unknown error"); ui.btn && (ui.btn.disabled = false); return; }
    ui.status.textContent = "Done. Loading…";
    const p = params || (({ quality: _q, ...r }) => r)(ctlState);
    location.href = location.pathname + queryOf(j.params ? { ...p, ...j.params } : p, quality || j.quality, id) + (location.hash || "#forecast");
  };
  tick();
}

function header() {
  const m = R.meta;
  $("#subtitle").textContent = m.scenario;
  $("#readouts").replaceChildren(
    ...[["Start", m.case ? `P${m.case.grid_pos} → P${m.case.lap1_pos}` : "P3 → P4", "after Turn 1"], ["Air", m.air_c + "", "°C"], ["Track (est.)", m.track_c.toFixed(0), "°C"], ["Tyre window", "85–110", "°C"],
      ["Distance", `${m.laps}`, `laps · ${m.lap_km.toFixed(3)} km`], ["Races / plan", m.sims_per_strategy.toLocaleString(), ""]]
      .map(([k, v, u]) => h("div", {}, h("dt", {}, k), h("dd", {}, v, h("small", {}, u)))));
  $("#foot").textContent = `Model run ${m.generated} · ${m.n_candidates.toLocaleString()} candidate plans screened in ${m.runtime_s}s · geometry: ${R.track.source}. Figures tagged “assumed” are tunable priors, not official data.`;
}
function tabs() {}

/* ---------------- forecast & risk ---------------- */
function hist(vals, nShow, color) {
  const v = vals.slice(0, nShow).concat([vals.slice(nShow).reduce((a, b) => a + b, 0)]);
  const mx = Math.max(...v, 0.01);
  return h("div", { class: "hist", role: "img", "aria-label": "position distribution" },
    v.map((x, i) => h("div", { class: "hb" + (i < 3 ? " pod" : ""), title: `${i < nShow ? "P" + (i + 1) : "P" + (nShow + 1) + "+"}: ${pct(x, 1)}`, style: `--c:${color}` },
      h("i", { style: `height:${Math.max(1, x / mx * 100)}%` }), h("span", {}, i < nShow ? i + 1 : (nShow + 1) + "+"))));
}
function gapText(g) {
  if (g[1] <= 0.05) return `On the podium line (P3 ± ${f1(Math.abs(g[1]), 1)} s)`;
  return `${f1(g[1], 1)} s behind P3`;
}
function buildForecast(root) {
  const F = R.forecast, S = R.strategies, L = R.meta.laps;
  if (!F || !S[0].forecast) { root.append(h("div", { class: "card" }, h("p", {}, "This results file predates the forecast. Press Run in the case panel or run `python run_analysis.py` again."))); return; }
  const um = F.uncertainty_model;
  let si = 0;
  const chips = h("div", { class: "row" });
  const body = h("div", { class: "fbody" });
  root.append(h("div", { class: "card" }, h("h3", {}, "Where you will be, and how sure we are"),
    h("p", { class: "sub" }, `Each plan is raced ${R.meta.sims_per_strategy.toLocaleString()} times from ${R.meta.scenario.replace(" Target: podium.", "")} ` +
      (um.enabled ? `On top of the usual race randomness (incidents, traffic, tyre noise), every simulated race also draws its own tyre wear (σ ${(um.deg_sigma * 100).toFixed(0)}%), pit loss (σ ${um.pit_sigma_s} s), overtaking difficulty (σ ${um.pass_sigma_s} s) and incident rate (σ ${(um.hazard_sigma * 100).toFixed(0)}%), so the spreads below include doubt about the model's own assumptions. Those spreads are judgement calls, not fitted values.`
        : "Parameter uncertainty is switched off, so the spreads below only reflect race randomness.")),
    chips), body);
  const draw = () => {
    const s = S[si], fp = s.forecast, u = fp.uncertainty, c = SCOL[si];
    chips.replaceChildren(...S.map((x, i) => h("button", { class: "chip", "aria-pressed": i === si, onclick: () => { si = i; draw(); } }, h("i", { style: `background:${SCOL[i]}` }), `${x.rank}. ${x.name} · ${x.label}`)));
    body.replaceChildren();

    /* checkpoints */
    const cps = h("div", { class: "grid3" });
    fp.checkpoints.forEach(cp => {
      const tr = h("table", { class: "mini" }, h("thead", {}, h("tr", {}, h("th", {}, "If you are…"), h("th", { class: "n" }, "How often"), h("th", { class: "n" }, "Podium at the flag"))),
        h("tbody", {}, cp.transition.map(t => h("tr", {}, h("td", {}, t.group), h("td", { class: "n" }, pct(t.share)),
          t.p_podium == null ? h("td", { class: "n" }, "–") : h("td", { class: "n", "data-v": 1, style: `background:${heatColor(t.p_podium, 0, 1)}` }, pct(t.p_podium))))));
      cps.append(h("div", { class: "card" }, h("h3", {}, `${Math.round(cp.frac * 100)}% · after lap ${cp.lap}`),
        h("div", { class: "big" }, h("b", { class: "num" }, pct(cp.p_podium_now)), h("span", {}, "chance you are on the podium at this point")),
        h("p", { class: "note" }, `Median P${f1(cp.pos_q[1], 0)}, 80% of races between P${f1(cp.pos_q[0], 0)} and P${f1(cp.pos_q[2], 0)}. ${gapText(cp.gap3_q)} (80% range ${f1(cp.gap3_q[0], 1)} to ${f1(cp.gap3_q[2], 1)} s). Most likely on ${cp.tyre.comp} tyres, ${cp.tyre.age} laps old.`),
        hist(cp.hist, 10, c), tr));
    });
    body.append(h("h3", { class: "sect" }, "Predicted position at 25%, 50% and 75% of the race"), cps);

    /* fan charts */
    const fan = fp.fan, fh = h("div"), ph = h("div");
    const fc = h("div", { class: "card" }, h("h3", {}, "Position through the race"), h("p", { class: "sub" }, "Median position with the 50% and 80% bands. Green marks the podium."), fh);
    const pc = h("div", { class: "card" }, h("h3", {}, "Chance of being on the podium, lap by lap"), h("p", { class: "sub" }, "Dips at the stop windows are the cars that pitted while you did not, or the reverse."), ph);
    body.append(h("div", { class: "grid2", style: "margin-top:18px" }, fc, pc));
    const stopMk = s.stops.map(x => ({ x, color: c, label: "stop", y: 24 }));
    const cpMk = fp.checkpoints.map(k => ({ x: k.lap, color: "#9096a3", label: Math.round(k.frac * 100) + "%", y: 24 }));
    const lc = lineChart(fh, { series: [{ name: "Median position", color: c, x: fan.laps, y: fan.q50, width: 2.6 }], invert: true, yMin: 1, yMax: 14, xMin: 1, xMax: L, xLabel: "lap", yFmt: v => "P" + v, tipFmt: v => "P" + f1(v, 1), legend: false,
      hbands: [{ y0: 1, y1: 3.5, color: "#34d399", label: "podium" }], markers: stopMk.concat(cpMk), height: 280,
      xTip: x => `Lap ${x} · 50% of races P${f1(fan.q25[x - 1], 0)}–P${f1(fan.q75[x - 1], 0)} · 80% P${f1(fan.q10[x - 1], 0)}–P${f1(fan.q90[x - 1], 0)}` });
    const poly = (lo, hi, op) => {
      const clamp = v => Math.min(14, Math.max(1, v));
      let d = fan.laps.map((l, i) => `${i ? "L" : "M"}${lc.X(l).toFixed(1)},${lc.Y(clamp(lo[i])).toFixed(1)}`).join("");
      d += fan.laps.slice().reverse().map((l, i) => `L${lc.X(l).toFixed(1)},${lc.Y(clamp(hi[fan.laps.length - 1 - i])).toFixed(1)}`).join("") + "Z";
      const p = sv("path", { d, fill: c, opacity: op }); lc.svg.insertBefore(p, lc.svg.querySelector("path"));
    };
    poly(fan.q10, fan.q90, .13); poly(fan.q25, fan.q75, .22);
    lineChart(ph, { series: [{ name: "P(podium)", color: c, x: fan.laps, y: fan.p_podium, width: 2.6 }], yMin: 0, yMax: 1, xMin: 1, xMax: L, xLabel: "lap", yFmt: v => pct(v), tipFmt: v => pct(v, 1), legend: false, markers: stopMk.concat(cpMk), height: 280, xTip: x => "Lap " + x });

    /* uncertainty */
    body.append(h("h3", { class: "sect" }, "How much to trust it"));
    const inter = `${pct(u.ci[0])}–${pct(u.ci[1])}`;
    const k1 = h("div", { class: "card" }, h("h3", {}, "The headline number"),
      h("div", { class: "kpis k2" }, kpi(pct(u.p_podium), "podium chance"), kpi(inter, "95% interval from the finite number of races"),
        kpi(pct(u.p_podium_point), um.enabled ? "podium chance if every assumption is exactly right" : "same, no parameter draws"), kpi("P" + f1(u.bad10_pos, 1), "average finish in the worst 10% of races"),
        kpi(pct(u.p_outside_top6), "finish outside the top 6"), kpi(pct(u.p_outside_top10), "finish outside the points")),
      h("p", { class: "note", style: "margin-top:10px" }, `The 95% interval only reflects how many races were simulated (${u.n.toLocaleString()}). ` + (um.enabled ? "The gap between the first and third figure shows how much the podium chance moves when the model's own assumptions are allowed to be wrong." : "Turn parameter uncertainty on to see how much that matters.")));
    const names = S.map((x, i) => `${x.rank}. ${x.comps.join("→")} (${x.stops.map(v => "L" + v).join(", ")})`);
    const rows = F.head2head.map(x => h("tr", {}, h("td", {}, `${names[x.a]} vs ${names[x.b]}`), h("td", { class: "n" }, pct(x.a_ahead)), h("td", { class: "n" }, pct(x.tie)), h("td", { class: "n" }, pct(x.b_ahead)),
      h("td", { class: "n" }, `${x.d_podium >= 0 ? "+" : ""}${(x.d_podium * 100).toFixed(1)} (${(x.d_ci[0] * 100).toFixed(1)} to ${(x.d_ci[1] * 100).toFixed(1)})`)));
    const k2 = h("div", { class: "card" }, h("h3", {}, "Is the ranking real?"),
      h("p", { class: "sub" }, "Both plans in a pair are raced through the same simulated races, so this is a fair comparison. If the podium-chance difference interval spans zero, the plans are statistically indistinguishable at this number of races."),
      h("div", { class: "scroll" }, h("table", { class: "wrap" }, h("thead", {}, h("tr", {}, h("th", {}, "Pair"), h("th", { class: "n" }, "First finishes ahead"), h("th", { class: "n" }, "Same place"), h("th", { class: "n" }, "Second ahead"), h("th", { class: "n" }, "Podium diff., pts (95%)"))), h("tbody", {}, rows))),
      h("p", { class: "note", style: "margin-top:10px" }, "Chance each plan comes out best if the races are resampled: " + S.map((x, i) => `${names[i]} ${pct(F.p_best[i])}`).join(" · ")));
    body.append(h("div", { class: "grid2" }, k1, k2));
    const prow = u.params.map(q => h("tr", {}, h("td", {}, q.label), q.p_podium.map((v, i) => h("td", { class: "n", "data-v": 1, style: `background:${heatColor(v, .15, .85)}`, title: `average draw ${q.ranges[i]}, average finish P${f1(q.e_pos[i], 1)}` }, pct(v), h("small", {}, " " + q.ranges[i])))));
    const sc = [["clean", "No neutralisation"], ["vsc", "VSC only"], ["sc", "Safety car"], ["red", "Red flag"], ["early_sc", "SC in first 2 laps"]];
    const k3 = h("div", { class: "card" }, h("h3", {}, "Which assumptions move the answer"),
      h("p", { class: "sub" }, um.enabled ? "Races split into the lowest, middle and highest third of each drawn assumption. A big swing across a row means the plan's podium chance hinges on that assumption." : "Parameter uncertainty is off for this run, so there is nothing to split."),
      u.params.length ? h("div", { class: "scroll" }, h("table", { class: "heat" }, h("thead", {}, h("tr", {}, h("th", {}, "Assumption"), h("th", { class: "n" }, "Lowest third"), h("th", { class: "n" }, "Middle"), h("th", { class: "n" }, "Highest third"))), h("tbody", {}, prow))) : null);
    const k4 = h("div", { class: "card" }, h("h3", {}, "…and what happens on the day"),
      h("p", { class: "sub" }, "Same plan, races split by what happened on track."),
      h("div", { class: "scroll" }, h("table", { class: "heat" }, h("thead", {}, h("tr", {}, h("th", {}, "Race type"), h("th", { class: "n" }, "Share"), h("th", { class: "n" }, "Podium"), h("th", { class: "n" }, "Avg finish"))),
        h("tbody", {}, sc.map(([k, lab]) => { const v = s.scenarios[k]; return h("tr", {}, h("td", {}, lab), h("td", { class: "n" }, pct(v.share)),
          v.p_podium == null ? h("td", { class: "n" }, "–") : h("td", { class: "n", "data-v": 1, style: `background:${heatColor(v.p_podium, .15, .85)}` }, pct(v.p_podium)), h("td", { class: "n" }, v.e_pos == null ? "–" : "P" + f1(v.e_pos))); })))));
    body.append(h("div", { class: "grid2", style: "margin-top:18px" }, k3, k4));
  };
  draw();
}

/* ---------------- strategies ---------------- */
function stintBar(s) {
  const tot = s.stints.reduce((a, b) => a + b.laps, 0);
  const bar = h("div", { class: "stints", role: "img", "aria-label": s.label }, s.stints.map(st => h("div", { class: "stint " + st.comp, style: `flex:${st.laps}` }, st.comp, h("span", {}, st.laps))));
  const pr = h("div", { class: "pitrow" });
  let acc = 0;
  s.stints.slice(0, -1).forEach(st => { acc += st.laps; pr.append(h("span", { style: `left:${acc / tot * 100}%` }, "L" + acc)); });
  return h("div", {}, bar, pr);
}
function buildStrategy(root) {
  const S = R.strategies;
  root.append(h("div", { class: "card" }, h("h3", {}, `Three ways to reach the podium from P${R.meta.case ? R.meta.case.lap1_pos : 4}`),
    h("p", { class: "sub" }, `${R.meta.scenario.replace(" Target: podium.", "")} Ranked by the share of ${R.meta.sims_per_strategy.toLocaleString()} simulated races that end P1–P3. Every strategy sees the same random races (same safety cars, same rival stops), so differences are strategy, not luck. Rival cars run the same pace, with plans chosen the way a team's strategy software would.` + (R.baseline ? ` For scale: starting where you do and simply copying the most common rival plan (${R.baseline[0].label}) gives a podium in ${pct(R.baseline[0].p_podium)} of these races. Absolute percentages depend on the model's assumptions; the ranking and the gaps between plans are the useful part.` : ""))));
  const plans = h("div", { class: "plans" });
  S.forEach((s, i) => {
    const m = s.metrics, c = SCOL[i];
    const hist = h("div");
    const card = h("article", { class: "plan", style: `--c:${c}` },
      h("header", {}, h("div", {}, h("h3", {}, s.name), h("div", { class: "seq" }, s.label)), h("div", { class: "rank" }, String(s.rank))),
      stintBar(s),
      h("div", { class: "kpis" },
        kpi(pct(m.p_podium), "podium"), kpi(pct(m.p_win), "win"), kpi("P" + f1(m.e_pos), "avg finish"), kpi("+" + f1(m.gap_p50, 1) + "s", "median gap to winner")),
      hist,
      h("ul", { class: "rules" }, s.rules.map(r => h("li", {}, r))),
      h("div", { class: "note" }, (m.p_podium_ci ? `Podium ${pct(m.p_podium)} (95% interval ${pct(m.p_podium_ci[0])}–${pct(m.p_podium_ci[1])}). ` : "") + `Median finish ${s.race_time_fmt.p50} (10–90%: ${s.race_time_fmt.p10} – ${s.race_time_fmt.p90}). Stuck behind a car on ${f1(m.held_laps, 1)} laps per race on average; ${f1(m.pits, 1)} stops.`));
    plans.append(card);
    barChart(hist, { cats: Array.from({ length: 10 }, (_, k) => "P" + (k + 1)).concat(["P11+"]), series: [{ name: s.name, color: c, vals: m.hist.slice(0, 10).concat([m.hist.slice(10).reduce((a, b) => a + b, 0)]) }], height: 150, yFmt: v => pct(v), title: "finish distribution" });
  });
  root.append(plans);

  const g2 = h("div", { class: "grid2" });
  const a = h("div", { class: "card" }, h("h3", {}, "Chance of finishing at or above each position"), h("p", { class: "sub" }, "Cumulative share of races. The gap between the lines at P3 is the podium difference."));
  const ah = h("div"); a.append(ah);
  const b = h("div", { class: "card" }, h("h3", {}, "How sensitive is the first stop?"), h("p", { class: "sub" }, "Podium chance when the first stop moves earlier or later than planned. A wide flat top means the plan survives a late call."));
  const bh = h("div"); b.append(bh);
  g2.append(a, b); root.append(g2);
  lineChart(ah, { series: S.map((s, i) => { let acc = 0; return { name: s.name + " " + s.label.split(" ")[0], color: SCOL[i], x: Array.from({ length: 10 }, (_, k) => k + 1), y: s.metrics.hist.slice(0, 10).map(v => (acc += v)) }; }), xLabel: "finish position", xFmt: v => "P" + v, yFmt: v => pct(v), xMin: 1, xMax: 10, yMin: 0, yMax: 1, tipFmt: v => pct(v, 1), xTip: x => "Top " + x, height: 260 });
  lineChart(bh, { series: S.map((s, i) => ({ name: s.name, color: SCOL[i], x: s.window.first_stop, y: s.window.p_podium })), xLabel: "lap of first stop", yLabel: "podium chance", yFmt: v => pct(v), yMin: 0, tipFmt: v => pct(v, 1), xTip: x => "First stop lap " + x, height: 260, markers: S.map((s, i) => ({ x: s.stops[0], color: SCOL[i], label: "plan" })) });

  const c = h("div", { class: "grid2" });
  const bs = R.by_stops, ks = Object.keys(bs).sort();
  c.append(h("div", { class: "card" }, h("h3", {}, "Best plan for each number of stops"), h("p", { class: "sub" }, "Answers “one stop or two?” using each stop count's best plan from the same search."),
    h("div", { class: "scroll" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Stops"), h("th", {}, "Plan"), h("th", { class: "n" }, "Podium"), h("th", { class: "n" }, "Win"), h("th", { class: "n" }, "Avg finish"))),
      h("tbody", {}, ks.map(k => h("tr", {}, h("td", {}, k), h("td", { class: "num" }, bs[k].label + (bs[k].uc ? ` · undercut after ${bs[k].uc}` : "")), h("td", { class: "n" }, pct(bs[k].p_podium, 1)), h("td", { class: "n" }, pct(bs[k].p_win, 1)), h("td", { class: "n" }, "P" + f1(bs[k].e_pos)))))))));
  c.append(h("div", { class: "card" }, h("h3", {}, "Top 24 plans"), h("p", { class: "sub" }, "“Undercut” is the stuck-in-traffic rule: pit early after that many consecutive laps held up."),
    h("div", { class: "scroll", style: "max-height:330px;overflow:auto" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Plan"), h("th", {}, "Rule"), h("th", { class: "n" }, "Podium"), h("th", { class: "n" }, "Avg")) ),
      h("tbody", {}, R.leaderboard.map(l => h("tr", {}, h("td", { class: "num" }, l.label), h("td", {}, l.uc ? "undercut " + l.uc : "plan only"), h("td", { class: "n" }, pct(l.p_podium, 1)), h("td", { class: "n" }, f1(l.e_pos)))))))));
  root.append(c);
}
const kpi = (v, l) => h("div", { class: "kpi" }, h("b", {}, v), h("span", {}, l));

/* ---------------- replay ---------------- */
function buildReplay(root) {
  const L = R.meta.laps, labels = R.field.labels;
  let si = 0, sc = "green", lap = 0, timer = null;
  const ctl = h("div", { class: "card" });
  const stratChips = h("div", { class: "row" }), scChips = h("div", { class: "row", style: "margin-top:10px" });
  ctl.append(h("h3", {}, "Replay one representative race"), h("p", { class: "sub" }, "Each replay is the simulated race whose finish and time sit closest to the median for that plan and scenario. Pick a neutralisation to see how the same plan copes."), stratChips, scChips);
  root.append(ctl);
  const lay = h("div", { class: "replay" });
  const left = h("div", { class: "card" }), right = h("div", { class: "grid" , style: "display:grid;gap:18px"});
  lay.append(left, right); root.append(lay);
  const top = h("div", { class: "ctrl" });
  const lapno = h("div", { class: "lapno num" }), stat = h("span", { class: "status g" }, "GREEN");
  const playBtn = h("button", { class: "btn" }, "Play");
  const slider = h("input", { type: "range", min: 0, max: L, value: 0, "aria-label": "Lap" });
  top.append(lapno, stat, playBtn, slider);
  const tower = h("div", { class: "tower" });
  left.append(top, h("div", { style: "height:10px" }), tower);
  const rows = labels.map((nm, c) => {
    const r = h("div", { class: "trow" + (c === 0 ? " me" : "") }, h("span", { class: "p" }), h("span", { class: "nm" }, nm), h("span", { class: "tt" }), h("span", { class: "gp" }));
    tower.append(r); return r;
  });
  const c1 = h("div", { class: "card" }), c2 = h("div", { class: "card" }), c3 = h("div", { class: "card" });
  right.append(c1, c2, c3);
  const rep = () => R.strategies[si].replays[sc];

  function render() {
    const rp = rep();
    lapno.textContent = lap === 0 ? "Grid" : `Lap ${lap}/${L}`;
    const st = lap === 0 ? 0 : rp.status[lap - 1];
    stat.textContent = STATUS[st]; stat.className = "status " + ["g", "v", "s", "r"][st];
    let order, gap, comp, age;
    if (lap === 0) { order = rp.start.order; gap = rp.start.gap; comp = rp.start.comp; age = labels.map(() => 0); }
    else {
      order = rp.order[lap - 1]; gap = rp.gap[lap - 1];
      const nxt = Math.min(lap, L - 1); comp = lap < L ? rp.comp[nxt] : rp.comp[L - 1]; age = lap < L ? rp.age[nxt] : rp.age[L - 1].map(a => a + 1);
    }
    order.forEach((car, pos) => {
      const r = rows[car], pitting = lap > 0 && rp.pit_laps[car].includes(lap);
      r.style.transform = `translateY(${pos * 28}px)`;
      r.children[0].textContent = pos + 1;
      const cc = "SMH"[comp[car]];
      r.children[2].replaceChildren(h("span", { class: "tyre " + cc }, cc), String(age[car]));
      r.children[3].textContent = pos === 0 ? "Leader" : "+" + f1(gap[pos], 1);
      r.classList.toggle("pit", pitting);
    });
    slider.value = lap;
    cursorMove && cursorMove(lap);
  }
  let cursorMove = null;
  function charts() {
    const rp = rep(), s = R.strategies[si];
    const laps = Array.from({ length: L }, (_, i) => i + 1);
    const gapOf = car => laps.map(l => rp.gap[l - 1][rp.order[l - 1].indexOf(car)]);
    const evBands = rp.events.map(e => ({ x0: e.lap - .5, x1: e.lap + e.dur - .5, color: e.kind === 1 ? "#fbbf24" : e.kind === 2 ? "#ffe066" : "#f87171", label: STATUS[e.kind] }));
    const myPits = rp.pit_laps["0"].map(l => ({ x: l, color: SCOL[si], label: "box" }));
    c1.replaceChildren(h("h3", {}, "Gap to the leader"), h("p", { class: "sub" }, `You finish P${rp.finish} in this race (average over ${R.strategies[si].replays[sc].mean_finish ? "240 runs of this scenario: P" + f1(rp.mean_finish) + ", podium " + pct(rp.p_podium) : ""}). Dashed lines mark your stops.`));
    const b1 = h("div"); c1.append(b1);
    lineChart(b1, { series: [{ name: "You", color: SCOL[si], x: laps, y: gapOf(0), width: 2.6 }, { name: labels[1], color: "#ecedf0", x: laps, y: gapOf(1), width: 1.5 }, { name: labels[2], color: "#9096a3", x: laps, y: gapOf(2), width: 1.5 }, { name: labels[3], color: "#f87171", x: laps, y: gapOf(3), width: 1.5, dash: "4 3" }], bands: evBands, markers: myPits, yMin: 0, xMin: 1, xMax: L, xLabel: "lap", yLabel: "seconds behind leader", height: 250, tipFmt: v => f1(v, 1) + " s", xTip: x => "Lap " + x });
    const lt = rp.lap_us.map(v => (v > 100 ? null : v));
    const dots = laps.map(l => TYRE["SMH"[rp.comp[l - 1][0]]]);
    c2.replaceChildren(h("h3", {}, "Your lap times"), h("p", { class: "sub" }, "Dots show the tyre. Pit laps and safety-car laps run off the top and are left out of the line."));
    const b2 = h("div"); c2.append(b2);
    const cm = lineChart(b2, { series: [{ name: "Lap time", color: "#9096a3", x: laps, y: lt, dots, width: 1.2 }], bands: evBands, markers: myPits, xMin: 1, xMax: L, yMax: 90, yFmt: v => fmtLap(v).slice(0, 4), xLabel: "lap", legend: false, height: 240, tipFmt: v => fmtLap(v), xTip: x => "Lap " + x });
    c3.replaceChildren(h("h3", {}, "Your tyre surface temperature"), h("p", { class: "sub" }, "Operating window 85–110 °C. Following another car closely adds heat and wear."));
    const b3 = h("div"); c3.append(b3);
    lineChart(b3, { series: [{ name: "Surface temp", color: "#fb923c", x: laps, y: rp.temp_us, width: 2 }], hbands: [{ y0: 85, y1: 110, color: "#34d399", label: "window" }], yMin: 70, yMax: 120, xMin: 1, xMax: L, bands: evBands, markers: myPits, xLabel: "lap", yFmt: v => v + "°", legend: false, height: 220, tipFmt: v => f1(v, 0) + " °C", xTip: x => "Lap " + x });
    // moving cursor shared by the three charts
    const cur = [b1, b2, b3].map(b => { const svg = $("svg", b); const ln = sv("line", { y1: 14, y2: 216, stroke: "#ecedf0", "stroke-width": 1.2, opacity: 0, "pointer-events": "none" }, svg); return { svg, ln }; });
    cursorMove = l => cur.forEach(({ svg, ln }) => {
      const vb = svg.viewBox.baseVal, W = vb.width, Hh = vb.height;
      const x = 48 + (Math.max(l, 1) - 1) / (L - 1) * (W - 48 - 14);
      ln.setAttribute("x1", x); ln.setAttribute("x2", x); ln.setAttribute("y2", Hh - 34); ln.setAttribute("opacity", l === 0 ? 0 : .7);
    });
  }
  function chips() {
    stratChips.replaceChildren(...R.strategies.map((s, i) => h("button", { class: "chip", "aria-pressed": i === si, onclick: () => { si = i; chips(); charts(); render(); } }, h("i", { style: `background:${SCOL[i]}` }), s.name + " · " + s.label)));
    scChips.replaceChildren(...R.scenarios.map(s => h("button", { class: "chip", "aria-pressed": s.key === sc, onclick: () => { sc = s.key; chips(); charts(); render(); } }, s.label)));
  }
  slider.addEventListener("input", () => { lap = +slider.value; render(); });
  function stop() { clearInterval(timer); timer = null; playBtn.textContent = "Play"; }
  playBtn.addEventListener("click", () => {
    if (timer) return stop();
    if (lap >= L) lap = 0;
    playBtn.textContent = "Pause";
    timer = setInterval(() => { if (lap >= L) return stop(); lap++; render(); }, matchMedia("(prefers-reduced-motion: reduce)").matches ? 400 : 260);
  });
  chips(); charts(); render();
}

/* ---------------- track ---------------- */
const RAMP = ["#3b82f6", "#22d3ee", "#a3e635", "#facc15", "#f97316", "#ef4444"];
function speedColor(v, lo, hi) {
  const t = Math.max(0, Math.min(.999, (v - lo) / (hi - lo))) * (RAMP.length - 1), i = Math.floor(t), u = t - i;
  const a = RAMP[i], b = RAMP[i + 1], p = x => [1, 3, 5].map(k => parseInt(x.slice(k, k + 2), 16));
  const pa = p(a), pb = p(b); return `rgb(${pa.map((x, k) => Math.round(x + (pb[k] - x) * u)).join(",")})`;
}
function buildTrack(root) {
  const T = R.track, P = T.path, SP = T.path_speed, PD = T.path_dist;
  const lo = Math.min(...SP), hi = Math.max(...SP);
  root.append(h("div", { class: "card" }, h("h3", {}, "Circuit layout and speed"), h("p", { class: "sub" }, `Colour shows speed around one qualifying-trim lap (${T.calibration.pole_s ? fmtLap(T.calibration.pole_s) : ""}). Geometry: ${T.source}.` + (T.real ? "" : " This is a schematic outline built from the corner table; run fetch_fastf1.py to replace it with the real centre line and telemetry."))));
  const lay = h("div", { class: "grid2" }); root.append(lay);
  const mapCard = h("div", { class: "card" }), side = h("div", { style: "display:grid;gap:18px" });
  lay.append(mapCard, side);
  const wrap = h("div", { class: "mapwrap" }); mapCard.append(wrap);
  const svg = sv("svg", { viewBox: "0 0 1000 640", role: "img", "aria-label": "Track map" }, wrap);
  const d = "M" + P.map(p => p.join(",")).join("L") + "Z";
  sv("path", { d, fill: "none", stroke: "#2b2f38", "stroke-width": 17, "stroke-linejoin": "round" }, svg);
  for (let i = 0; i < P.length; i++) { const q = P[(i + 1) % P.length]; sv("line", { x1: P[i][0], y1: P[i][1], x2: q[0], y2: q[1], stroke: speedColor(SP[i], lo, hi), "stroke-width": 9, "stroke-linecap": "round" }, svg); }
  const cx = P.reduce((a, p) => a + p[0], 0) / P.length, cy = P.reduce((a, p) => a + p[1], 0) / P.length;
  // start/finish
  const a0 = P[0], a1 = P[1], dx = a1[0] - a0[0], dy = a1[1] - a0[1], dl = Math.hypot(dx, dy) || 1;
  sv("line", { x1: a0[0] - dy / dl * 12, y1: a0[1] + dx / dl * 12, x2: a0[0] + dy / dl * 12, y2: a0[1] - dx / dl * 12, stroke: "#fff", "stroke-width": 3, "stroke-dasharray": "3 3" }, svg);
  const ss = sv("text", { x: a0[0], y: a0[1] + 30, "text-anchor": "middle", fill: "#ecedf0", "font-size": 12 }, svg); ss.textContent = "S/F";
  T.corners.forEach(c => {
    let ox = c.x - cx, oy = c.y - cy; const l = Math.hypot(ox, oy) || 1; const bx = c.x + ox / l * 26, by = c.y + oy / l * 26;
    sv("line", { x1: c.x, y1: c.y, x2: bx, y2: by, stroke: "#646b79", "stroke-width": 1 }, svg);
    const g = sv("g", { style: "cursor:pointer" }, svg);
    sv("circle", { cx: bx, cy: by, r: 11, fill: "#0b0c0f", stroke: "#ecedf0", "stroke-width": 1.2 }, g);
    sv("text", { x: bx, y: by + 4, "text-anchor": "middle", fill: "#ecedf0", "font-size": 11, "font-family": "monospace" }, g).textContent = c.n;
    g.addEventListener("mousemove", ev => showTip(`<b>Turn ${c.n}</b> ${c.kind ? "· " + c.kind + " speed" : ""}<div class="num">entry ${c.entry_kmh.toFixed(0)} · apex ${c.apex_kmh.toFixed(0)} · exit ${c.exit_kmh.toFixed(0)} km/h</div>`, ev));
    g.addEventListener("mouseleave", hideTip);
  });
  [...T.straights].sort((a, b) => b.length_m - a.length_m).slice(0, 3).forEach(s => {
    let ox = s.x - cx, oy = s.y - cy; const l = Math.hypot(ox, oy) || 1;
    const t = sv("text", { x: s.x + ox / l * 40, y: s.y + oy / l * 40, "text-anchor": "middle", fill: "#cfd2d9", "font-size": 12 }, svg);
    t.textContent = `${s.length_m.toFixed(0)} m · ${s.vmax_kmh.toFixed(0)} km/h`;
  });
  const dot = sv("circle", { r: 8, fill: "#fff", stroke: "#e10600", "stroke-width": 3, cx: P[0][0], cy: P[0][1] }, svg);
  wrap.append(h("div", { style: "padding:6px 12px 10px" }, h("div", { class: "ramp" }), h("div", { class: "rampl" }, h("span", {}, lo.toFixed(0) + " km/h"), h("span", {}, hi.toFixed(0) + " km/h"))));

  // speed profile
  const sp = T.speed_profile, dist = sp.map(p => p[0]), spd = sp.map(p => p[1]);
  const t = [0]; for (let i = 1; i < dist.length; i++) t.push(t[i - 1] + (dist[i] - dist[i - 1]) / (Math.max(spd[i], 30) / 3.6));
  const total = t[t.length - 1];
  const pathAt = dm => { let a = 0, b = PD.length - 1; while (b - a > 1) { const m = (a + b) >> 1; if (PD[m] <= dm) a = m; else b = m; } return P[a]; };
  const speedAt = dm => { let a = 0, b = dist.length - 1; while (b - a > 1) { const m = (a + b) >> 1; if (dist[m] <= dm) a = m; else b = m; } return spd[a]; };
  const spCard = h("div", { class: "card" }, h("h3", {}, "Speed trace"), h("p", { class: "sub" }, "Hover to move the marker on the map. Dashed lines are corner apexes."));
  const sh = h("div"); spCard.append(sh);
  const rd = h("div", { class: "read", style: "margin-top:12px" }); const rSpeed = h("b", { class: "num" }), rDist = h("b", { class: "num" }), rTime = h("b", { class: "num" });
  rd.append(h("div", { class: "kpi" }, rSpeed, h("span", {}, "speed")), h("div", { class: "kpi" }, rDist, h("span", {}, "distance")), h("div", { class: "kpi" }, rTime, h("span", {}, "lap time")));
  const play = h("button", { class: "btn" }, "Drive the lap");
  spCard.append(rd, h("div", { style: "margin-top:10px" }, play));
  side.append(spCard);
  const place = dm => { const p = pathAt(dm); dot.setAttribute("cx", p[0]); dot.setAttribute("cy", p[1]); rSpeed.textContent = speedAt(dm).toFixed(0) + " km/h"; rDist.textContent = dm.toFixed(0) + " m"; let k = 0; while (k < dist.length - 1 && dist[k] < dm) k++; rTime.textContent = t[k].toFixed(2) + " s"; };
  lineChart(sh, { series: [{ name: "Speed", color: "#f97316", x: dist, y: spd, width: 2 }], markers: T.corners.map(c => ({ x: c.dist_m, label: "T" + c.n, color: "#646b79", y: 24 })), yMin: 0, yMax: Math.ceil(hi / 50) * 50 + 20, xMin: 0, xMax: T.lap_m, xLabel: "distance (m)", yFmt: v => v, legend: false, height: 250, tipFmt: v => v.toFixed(0) + " km/h", xTip: x => x.toFixed(0) + " m", onHover: x => place(x) });
  place(0);
  let raf = null;
  play.addEventListener("click", () => {
    if (raf) { cancelAnimationFrame(raf); raf = null; play.textContent = "Drive the lap"; return; }
    play.textContent = "Stop"; const t0 = performance.now(), rate = 3;
    const step = now => { const el = ((now - t0) / 1000 * rate) % total; let k = 0; while (k < t.length - 1 && t[k] < el) k++; place(dist[k]); raf = requestAnimationFrame(step); };
    raf = requestAnimationFrame(step);
  });

  const tcard = h("div", { class: "card" }, h("h3", {}, "Corners"), h("p", { class: "sub" }, "Entry is where braking starts, apex is the slowest point, exit is 100–150 m after the corner."));
  tcard.append(h("div", { class: "scroll" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Turn"), h("th", {}, "Type"), h("th", { class: "n" }, "Entry"), h("th", { class: "n" }, "Apex"), h("th", { class: "n" }, "Exit"))),
    h("tbody", {}, T.corners.map(c => h("tr", {}, h("td", { class: "num" }, "T" + c.n + (c.dir ? " " + c.dir : "")), h("td", {}, c.kind || "–"), h("td", { class: "n" }, c.entry_kmh.toFixed(0)), h("td", { class: "n" }, c.apex_kmh.toFixed(0)), h("td", { class: "n" }, c.exit_kmh.toFixed(0))))))));
  const scard = h("div", { class: "card" }, h("h3", {}, "Straights"), h("p", { class: "sub" }, "Top speed reached before the next braking zone."));
  scard.append(h("div", { class: "scroll" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Between"), h("th", { class: "n" }, "Length m"), h("th", { class: "n" }, "Top km/h"))),
    h("tbody", {}, T.straights.map(s => h("tr", {}, h("td", { class: "num" }, s.name + (s.label ? " · " + s.label : "")), h("td", { class: "n" }, s.length_m.toFixed(0)), h("td", { class: "n" }, s.vmax_kmh.toFixed(0))))))));
  const g = h("div", { class: "grid2" }, tcard, scard); root.append(g);
}

/* ---------------- tyres & fuel ---------------- */
function buildTyres(root) {
  const Tz = R.tyres, F = R.fuel, cfg = R.config;
  const cards = h("div", { class: "grid3" });
  Tz.compounds.forEach(c => cards.append(h("div", { class: "card" }, h("div", { class: "row", style: "justify-content:space-between" }, h("h3", {}, c.name + " · " + c.pirelli), h("span", { class: "tyre " + c.code }, c.code)),
    h("div", { class: "kpis", style: "grid-template-columns:repeat(2,1fr);margin-top:12px" }, kpi("+" + f1(c.offset_s, 2) + "s", "fresh pace vs soft"), kpi(f1(c.temp_c, 0) + "°C", "surface temp"), kpi(f1(c.deg_early, 3), "s/lap early slope"), kpi("lap " + (c.cliff_lap ?? "–"), "cliff begins")),
    h("div", { class: "note", style: "margin-top:10px" }, `Pace lost vs fresh after 10 laps: ${f1(c.loss_10)} s; after 20 laps: ${f1(c.loss_20)} s; at the ${c.max_life}-lap stint cap used in the search: ${f1(c.loss_at_life)} s.`))));
  root.append(h("div", { class: "card" }, h("h3", {}, "Compounds at Barcelona-Catalunya 2026"), h("p", { class: "sub" }, "Pirelli brought C2 (hard), C3 (medium) and C4 (soft), a step softer than usual, with 2 hard, 3 medium and 8 soft sets per driver. Degradation is mostly thermal and the front axle is the limit.")), cards);
  const g = h("div", { class: "grid2" }); root.append(g);
  const dc = h("div", { class: "card" }, h("h3", {}, "Lap time lost to tyre age"), h("p", { class: "sub" }, "Time lost against a fresh tyre of the same compound. Switch the air temperature to see the thermal effect."));
  const sel = h("div", { class: "row", style: "margin-bottom:8px" }); const dh = h("div"); dc.append(sel, dh);
  let tag = "nominal";
  const labelsT = { cool: "Air −8 °C", nominal: `Air ${R.meta.air_c} °C`, hot: "Air +8 °C" };
  const draw = () => {
    sel.replaceChildren(...Object.keys(labelsT).map(k => h("button", { class: "chip", "aria-pressed": k === tag, onclick: () => { tag = k; draw(); } }, labelsT[k])));
    lineChart(dh, { series: Tz.compounds.map(c => ({ name: `${c.name} (${c.curves[tag].temp}°C)`, color: TYRE[c.code], x: Tz.ages.slice(0, c.max_life + 5), y: c.curves[tag].pen.slice(0, c.max_life + 5) })), yMin: 0, xMin: 0, xMax: 48, xLabel: "tyre age (laps)", yLabel: "seconds per lap", height: 260, tipFmt: v => f1(v, 2) + " s", xTip: x => "Age " + x + " laps" });
  };
  draw();
  const tc = h("div", { class: "card" }, h("h3", {}, "Surface temperature vs the 85–110 °C window"), h("p", { class: "sub" }, "Clean-air temperature by compound across three air temperatures. Soft sits close to the upper edge, which is where wear accelerates."));
  const th = h("div"); tc.append(th);
  barChart(th, { cats: Tz.compounds.map(c => c.name), series: [["cool", "Air −8 °C", "#38bdf8"], ["nominal", `Air ${R.meta.air_c} °C`, "#e9e9ec"], ["hot", "Air +8 °C", "#f97316"]].map(([k, n, col]) => ({ name: n, color: col, vals: Tz.compounds.map(c => c.curves[k].temp) })), yMax: 125, yFmt: v => v + "°", tipFmt: v => v.toFixed(0) + " °C", height: 260 });
  g.append(dc, tc);
  const fc = h("div", { class: "card" }, h("h3", {}, "Fuel, weight and pace"), h("p", { class: "sub" }, `The car starts near ${f1(F.start_mass_kg, 0)} kg (${f1(cfg.min_mass_kg, 0)} kg minimum plus about ${f1(F.start_fuel_kg, 0)} kg of fuel) and finishes near ${f1(F.end_mass_kg, 0)} kg. Each kilogram costs about ${f1(F.fuel_s_per_kg, 3)} s per lap, so burning fuel is worth about ${f1(F.fuel_s_per_kg * (F.start_fuel_kg - F.end_fuel_kg), 1)} s per lap over the race.`));
  const fh = h("div"); fc.append(fh);
  lineChart(fh, { series: [{ name: "Fuel penalty (s/lap)", color: "#fb923c", x: F.laps, y: F.lap_penalty_s }], yMin: 0, xMin: 0, xMax: R.meta.laps, xLabel: "lap", yLabel: "seconds per lap", legend: false, height: 240, tipFmt: v => f1(v, 2) + " s", xTip: x => `Lap ${x} · ${f1(F.mass_kg[x], 0)} kg car, ${f1(F.fuel_kg[x], 0)} kg fuel` });
  const lc = h("div", { class: "card" }, h("h3", {}, "Standard lap times"), h("p", { class: "sub" }, "Clean air, fresh tyres, race mode. Qualifying trim is the 2026 pole lap on soft."));
  lc.append(h("div", { class: "scroll" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Compound"), h("th", { class: "n" }, "Quali trim"), h("th", { class: "n" }, "Race, lap 2"), h("th", { class: "n" }, "Race, mid"), h("th", { class: "n" }, "Race, light"))),
    h("tbody", {}, Tz.compounds.map(c => h("tr", {}, h("td", {}, h("span", { class: "tyre " + c.code }, c.code), " " + c.name), h("td", { class: "n" }, fmtLap(c.lap_fresh.quali)), h("td", { class: "n" }, fmtLap(c.lap_fresh.lap2)), h("td", { class: "n" }, fmtLap(c.lap_fresh.mid)), h("td", { class: "n" }, fmtLap(c.lap_fresh.light))))))),
    h("p", { class: "note", style: "margin-top:10px" }, `Fuel estimate cross-check: the ${cfg.flow_limit_mj_h} MJ/h flow limit allows ${f1(F.full_flow_kg_h, 0)} kg/h. At 80–90% of that, a ${R.meta.laps}-lap race needs ${f1(F.race_fuel_low, 0)}–${f1(F.race_fuel_high, 0)} kg.`));
  root.append(h("div", { class: "grid2" }, fc, lc));
}

/* ---------------- risk ---------------- */
function buildRisk(root) {
  const I = R.incidents, D = R.decision, S = R.strategies;
  root.append(h("div", { class: "card" }, h("h3", {}, "Neutralisation chances"), h("p", { class: "sub" }, I.note),
    h("div", { class: "big3" }, kpi(pct(I.p_sc), "at least one safety car"), kpi(pct(I.p_vsc), "at least one virtual SC"), kpi(pct(I.p_red), "red flag"), kpi(pct(I.p_any), "any neutralisation"), kpi(pct(I.p_neutral_first_stop_window), "one during laps 12–26"))));
  const g = h("div", { class: "grid2" }); root.append(g);
  const hz = h("div", { class: "card" }, h("h3", {}, "When they happen"), h("p", { class: "sub" }, "Chance that a given lap runs under each condition. The spike on lap 1 is the start."));
  const hh = h("div"); hz.append(hh);
  const laps = Array.from({ length: R.meta.laps }, (_, i) => i + 1);
  lineChart(hh, { series: [{ name: "Safety car", color: "#ffe066", x: laps, y: I.per_lap_sc }, { name: "Virtual SC", color: "#fbbf24", x: laps, y: I.per_lap_vsc, dash: "4 3" }, { name: "Red flag", color: "#f87171", x: laps, y: I.per_lap_red }], yMin: 0, xMin: 1, xMax: R.meta.laps, xLabel: "lap", yFmt: v => pct(v, 1), tipFmt: v => pct(v, 2), height: 250, xTip: x => "Lap " + x });
  const sm = h("div", { class: "card" }, h("h3", {}, "Podium chance by race type"), h("p", { class: "sub" }, "Same plans, split by what happened in the simulated race. Counts are small for red flags, so read those loosely."));
  const cols = [["clean", "Clean race"], ["vsc", "VSC only"], ["sc", "Safety car"], ["red", "Red flag"], ["early_sc", "SC laps 1–2"]];
  sm.append(h("div", { class: "scroll" }, h("table", { class: "heat" }, h("thead", {}, h("tr", {}, h("th", {}, "Plan"), cols.map(c => h("th", { class: "n" }, c[1])))),
    h("tbody", {}, S.map((s, i) => h("tr", {}, h("td", {}, h("span", { style: `color:${SCOL[i]}` }, "● "), s.name), cols.map(c => { const v = s.scenarios[c[0]]; return v.p_podium == null ? h("td", { class: "n" }, "–") : h("td", { class: "n", "data-v": 1, style: `background:${heatColor(v.p_podium, .1, .8)}`, title: v.n + " races" }, pct(v.p_podium)); })))))),
    h("p", { class: "note", style: "margin-top:8px" }, "Share of races: " + cols.map(c => `${c[1]} ${pct(S[0].scenarios[c[0]].share)}`).join(" · ")));
  g.append(hz, sm);
  const sens = h("div", { class: "card" }, h("h3", {}, "What if the assumptions are wrong?"), h("p", { class: "sub" }, "Podium chance for each plan when one input changes and the whole field adapts. A plan that holds up across rows is robust."));
  const allv = R.sensitivity.flatMap(r => r.results.map(x => x.p_podium));
  sens.append(h("div", { class: "scroll" }, h("table", { class: "heat" }, h("thead", {}, h("tr", {}, h("th", {}, "Change"), S.map((s, i) => h("th", { class: "n" }, s.name)))),
    h("tbody", {}, R.sensitivity.map(r => h("tr", {}, h("td", {}, r.name), r.results.map(x => h("td", { class: "n", "data-v": 1, style: `background:${heatColor(x.p_podium, Math.min(...allv), Math.max(...allv))}` }, pct(x.p_podium)))))))));
  root.append(sens);
  const g2 = h("div", { class: "grid2" }); root.append(g2);
  const pc = h("div", { class: "card" }, h("h3", {}, "Stuck behind a car: chance of getting past"), h("p", { class: "sub" }, `Within ${f1(D.zone_s, 1)} s a pass is attempted each lap. You need roughly ${f1(D.pass_delta_50, 2)} s per lap of pace advantage for an even chance; Barcelona makes that hard. Below that you sit at ${f1(D.follow_gap_s, 2)} s behind, ${D.dirty_air.temp_c} °C hotter, wearing tyres ${D.dirty_air.wear_pct}% faster.`));
  const ph = h("div"); pc.append(ph);
  lineChart(ph, { series: [{ name: "Pass probability", color: "#38bdf8", x: D.pass_delta, y: D.pass_prob }], yMin: 0, yMax: 1, xLabel: "pace advantage per lap (s)", yFmt: v => pct(v), legend: false, height: 240, tipFmt: v => pct(v, 0), xTip: x => "+" + x + " s per lap" });
  const bc = h("div", { class: "card" }, h("h3", {}, "Undercut break-even"), h("p", { class: "sub" }, "Laps a fresh set needs to win back the stop time, by current tyre and age (switching to hard, or medium if already on hard). Green means the stop pays back quickly; blank means it never does within the stint."));
  const vals = D.breakeven.flatMap(r => r.cells.filter(x => x != null));
  bc.append(h("div", { class: "scroll" }, h("table", { class: "heat" }, h("thead", {}, h("tr", {}, h("th", {}, "Tyre age →"), D.breakeven_ages.map(a => h("th", { class: "n" }, a)))),
    h("tbody", {}, D.breakeven.map(r => h("tr", {}, h("td", {}, h("span", { class: "tyre " + r.code }, r.code), " to " + r.target), r.cells.map(v => v == null ? h("td", { class: "n" }, "–") : h("td", { class: "n", "data-v": 1, style: `background:${heatColor(v, Math.min(...vals), Math.max(...vals), true)}` }, v))))))));
  g2.append(pc, bc);
}

/* ---------------- model ---------------- */
function buildModel(root) {
  root.append(h("div", { class: "card" }, h("h3", {}, "Your nine questions"), h("p", { class: "sub" }, "Each answer is tagged: sourced (published), calibrated (fitted to a real number), model (derived here) or assumed (tunable prior).")));
  const qa = h("div", { class: "qa" });
  R.qa.forEach(q => qa.append(h("div", { class: "card" }, h("div", { class: "qn" }, q.id), h("h3", {}, q.q, h("span", { class: "badge " + q.conf }, q.conf)), h("p", {}, q.a))));
  root.append(qa);
  const prov = R.meta.provenance;
  const g = h("div", { class: "grid2" });
  g.append(h("div", { class: "card" }, h("h3", {}, "Where the numbers come from"), h("div", { class: "scroll" }, h("table", {}, h("tbody", {}, Object.entries(prov).map(([k, v]) => h("tr", {}, h("td", {}, k), h("td", {}, h("span", { class: "badge " + (v === "sourced" ? "sourced" : v === "model" ? "model" : "assumed") }, v)))))))));
  g.append(h("div", { class: "card" }, h("h3", {}, "Rival strategies"), h("p", { class: "sub" }, "The other 21 cars draw one of these solo-optimal plans (stops jittered by about ±2 laps) and react to safety cars the same way you do."),
    h("div", { class: "scroll" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Plan"), h("th", {}, "Stops at"), h("th", { class: "n" }, "Weight"))),
      h("tbody", {}, R.field.archetypes.map(a => h("tr", {}, h("td", { class: "num" }, a.seq), h("td", { class: "num" }, a.stops.map(s => "L" + s).join(", ")), h("td", { class: "n" }, a.weight))))))));
  root.append(g);
  const cal = R.track.calibration;
  root.append(h("div", { class: "card" }, h("h3", {}, "Calibration checks"), h("p", { class: "sub" }, `Track model lap ${fmtLap(cal.model_lap_s)} against the real pole ${R.meta.pole}. Simulated green-flag winner time ${R.meta.model_green_leader_time}; the real 2026 race took ${R.meta.real_winner_time} with stops and neutralisations, so the model is plausible but untuned against race data until you run fetch_fastf1.py.`)));
}

boot();
