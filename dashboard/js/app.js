/* Pit Wall · main controller. */
import { $, $$, h, pct, fx, fmtLap, timeIn, dayIn, localHourKey, countdown, flag, CHEQUER, tyreSVG, wxSVG, ICON, glassify, traceSVG } from "./ui.js";
import { trackSVG, SECTOR_COL } from "./track.js";
import { buildConfig, buildField, finishProbs, driverFeatures, loadWeather, weatherAt, wxKind } from "./model.js";
import { fieldArchetypes, COMP, OBJECTIVES, GREEN, VSC, SC, RED } from "./engine.js";
import { search } from "./strategy.js";
import { startBackground } from "./bg.js";
import { fieldAtLap, currentLap, getToken, setToken } from "./live.js";
import { trackZones, zoneMap, stintsOf, usageBar, levelGauge, ZONE } from "./callsheet.js";

/* Driver photos: Wikimedia Commons, CC BY-SA 4.0 (credited in the footer and on hover). */
const PHOTOS = {
  max_verstappen: { src: "img/drivers/max_verstappen.jpg", pos: "50% 18%", credit: "Steffen Prößdorf", lic: "CC BY-SA 4.0",
    url: "https://commons.wikimedia.org/wiki/File:2024-08-25_Motorsport,_Formel_1,_Gro%C3%9Fer_Preis_der_Niederlande_2024_STP_3973_by_Stepro_(medium_crop).jpg" },
  hadjar: { src: "img/drivers/hadjar.jpg", pos: "50% 30%", credit: "Yu Chu Chin", lic: "CC BY-SA 4.0",
    url: "https://commons.wikimedia.org/wiki/File:Isack_Hadjar_at_the_Melbourne_Walk_during_the_2026_Australian_Grand_Prix_(028A8753)_(cropped).jpg" },
};

const S = { cal: null, ev: null, model: null, wx: null, driver: null, objective: "points", cfg: null, arch: null, field: null,
  pre: {}, live: null, history: [], gsap: null, lenis: null, bg: null, bgStop: null, stops: [], raceClicks: [],
  sync: { field: null, auto: false, every: 10, timer: null, next: 0, busy: false }, sheet: null };
const STATUS_NAME = ["GREEN", "VSC", "SC", "RED"];
const TZ_USER = Intl.DateTimeFormat().resolvedOptions().timeZone;

/* ------------------------------------------------------------ background switcher */
function switchBg(mode) {
  S.bgStop?.(); S.bgStop = null; S.bg = null;
  const el = $("#bg");
  while (el.firstChild) el.removeChild(el.firstChild);
  localStorage.setItem("pitwall_bg", mode);
  if (mode === "shader") {
    startBackground(el).then(b => { S.bg = b; if (S.ev) S.bg.setEnergy?.(.55); }).catch(() => {});
  } else if (mode === "iso") {
    import("./bg-iso.js").then(({ startIsoEngine }) => {
      const bg = startIsoEngine(el); S.bgStop = () => bg.stop();
    }).catch(e => console.warn("iso bg:", e));
  }
}
function initBgMenu() {
  let menu = null;
  const close = () => { menu?.remove(); menu = null; };
  const MODES = [
    { id: "shader", icon: "〜", title: "Shader waves", desc: "Animated deep-space shader" },
    { id: "iso",    icon: "⬡", title: "Engine build",  desc: "Isometric F1 power unit" },
    { id: "plain",  icon: "○", title: "Plain dark",    desc: "No background distraction" },
  ];
  document.addEventListener("contextmenu", e => {
    e.preventDefault(); close();
    const cur = localStorage.getItem("pitwall_bg") || "shader";
    menu = h("div", { class: "bg-menu glass", style: `left:${Math.min(e.clientX + 4, innerWidth - 248)}px;top:${Math.min(e.clientY + 4, innerHeight - 180)}px` });
    const lbl = h("div", { class: "bg-menu-label" }, "Background");
    menu.append(lbl);
    MODES.forEach(m => {
      const btn = h("button", { class: "bg-opt" + (m.id === cur ? " active" : ""), onclick: () => { switchBg(m.id); close(); } });
      btn.innerHTML = `<span class="bg-icon">${m.icon}</span><span><b>${m.title}</b><small>${m.desc}</small></span>${m.id === cur ? '<span class="bg-check">✓</span>' : ""}`;
      menu.append(btn);
    });
    document.body.append(menu);
    requestAnimationFrame(() => menu.classList.add("on"));
  });
  document.addEventListener("click", close);
  document.addEventListener("keydown", e => { if (e.key === "Escape") close(); });
}

/* ------------------------------------------------------------ boot */
boot();
async function boot() {
  const savedBg = localStorage.getItem("pitwall_bg") || "shader";
  switchBg(savedBg);
  initBgMenu();
  loadMotionLibs();
  try {
    S.cal = await (await fetch("data/calendar.json", { cache: "no-store" })).json();
  } catch (e) {
    $("#boot-msg").textContent = "Calendar data missing. Run `python fetch_event.py` and reload.";
    return;
  }
  $("#season-label").textContent = S.cal.season;
  buildPicker();
  tickClock(); setInterval(tickClock, 1000);
  const live = S.cal.races.find(r => r.status === "live");
  if (live) { $("#countdown").classList.remove("hidden"); }
  document.addEventListener("keydown", onKey);
  if (new URLSearchParams(location.search).get("race")) {
    const r = S.cal.races.find(x => String(x.round) === new URLSearchParams(location.search).get("race"));
    if (r && r.status === "live") selectRace(r);
  }
}
async function loadMotionLibs() {
  try {
    const [{ gsap }, { ScrollTrigger }] = await Promise.all([import("gsap"), import("gsap/ScrollTrigger")]);
    gsap.registerPlugin(ScrollTrigger); S.gsap = gsap;
    gsap.from(".hero .kicker, .hero h1, .hero .sub, .hero .countdown, .picker", { y: 30, opacity: 0, duration: 1.1, stagger: .09, ease: "expo.out" });
  } catch (e) { /* motion is optional */ }
  try {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const { default: Lenis } = await import("lenis");
    S.lenis = new Lenis({ lerp: .11, wheelMultiplier: .95 });
    const raf = t => { S.lenis.raf(t); requestAnimationFrame(raf); };
    requestAnimationFrame(raf);
    if (S.gsap) S.lenis.on("scroll", () => S.gsap.ScrollTrigger?.update?.());
  } catch (e) { /* native scrolling */ }
}
/* Smooth scroll to a section. Lenis measures the page once, so it must re-measure after sections are revealed,
   otherwise it stops short (this left the cards below the fold when the browser was zoomed in). */
function scrollToEl(el) {
  if (S.lenis) { S.lenis.resize(); requestAnimationFrame(() => S.lenis.scrollTo(el, { offset: -70, duration: 1.1, force: true })); }
  else el.scrollIntoView({ behavior: "smooth", block: "start" });
  setTimeout(() => {
    const r = el.getBoundingClientRect();
    if (r.top > innerHeight * .5) { if (S.lenis) S.lenis.scrollTo(scrollY + r.top - 70, { immediate: true, force: true }); else scrollTo(0, scrollY + r.top - 70); }
  }, 1400);
}
function toast(html, ms = 6000) {
  let t = $("#toast");
  if (!t) { t = h("div", { id: "toast", class: "toast glass", role: "status" }); document.body.append(t); }
  t.innerHTML = html; t.classList.add("on");
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("on"), ms);
}
function reveal(els) {
  els = [els].flat().filter(Boolean);
  if (S.gsap) S.gsap.fromTo(els, { opacity: 0, y: 26 }, { opacity: 1, y: 0, duration: .8, stagger: .07, ease: "expo.out" });
}

/* ------------------------------------------------------------ clock + countdown */
function tickClock() {
  const now = new Date();
  $("#tb-clock").textContent = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) + " " + TZ_USER.split("/").pop().replace("_", " ");
  const live = S.cal?.races.find(r => r.status === "live");
  if (!live) return;
  const ms = new Date(live.race_utc) - now, cd = countdown(ms), el = $("#countdown");
  if (cd) el.innerHTML = `<span class="dot-live"></span><span class="muted">${live.name.replace(" Grand Prix", " GP")} · lights out in</span>` +
    (cd.d ? `<span><b>${cd.d}</b><small>d</small></span>` : "") + `<span><b>${String(cd.hh).padStart(2, "0")}</b><small>h</small></span><span><b>${String(cd.mm).padStart(2, "0")}</b><small>m</small></span><span><b>${String(cd.ss).padStart(2, "0")}</b><small>s</small></span>`;
  else {
    const lap = Math.min(S.ev?.meta.laps || 56, Math.max(1, Math.floor(-ms / 1000 / 100) + 1));
    el.innerHTML = `<span class="dot-live"></span><span><b>RACE UNDERWAY</b></span><span class="muted">≈ lap ${lap} by the clock</span>`;
  }
}

/* ------------------------------------------------------------ race picker */
function buildPicker() {
  const list = $("#picker-list"), btn = $("#picker-btn"), pk = $("#picker");
  list.innerHTML = "";
  for (const r of S.cal.races) {
    const date = new Date(r.race_utc).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    const badge = r.status === "live" ? `<span class="badge live">This week</span>` : r.status === "completed" ? `<span class="badge done">Completed</span>` : `<span class="badge">Opens race week</span>`;
    const o = h("button", { class: "race-opt", role: "option", disabled: r.status !== "live", "aria-disabled": r.status !== "live", html:
      `<span class="rd">R${String(r.round).padStart(2, "0")}</span><span class="fl">${flag(r.country)}</span><span class="nm">${r.name}<small>${r.locality} · ${date}${r.sprint ? " · Sprint" : ""}</small></span>${badge}` });
    if (r.status === "live") o.addEventListener("click", () => { closePicker(); selectRace(r); });
    list.append(o);
  }
  const closePicker = () => { pk.classList.remove("open"); btn.setAttribute("aria-expanded", "false"); };
  btn.addEventListener("click", () => {
    const open = !pk.classList.contains("open"); pk.classList.toggle("open", open); btn.setAttribute("aria-expanded", open);
    if (open) { const l = list.querySelector(".race-opt:not([disabled])"); l?.scrollIntoView({ block: "center" }); l?.focus(); }
  });
  document.addEventListener("click", e => { if (!pk.contains(e.target)) closePicker(); });
  S.closePicker = closePicker;
}

/* ------------------------------------------------------------ race selected */
async function selectRace(r) {
  const now = Date.now();
  S.raceClicks = [...S.raceClicks.filter(t => now - t < 30000), now];
  if (S.raceClicks.length >= 3) {
    toast(`<b>The race weekend is just below.</b> Scroll down ↓, or zoom out (<kbd>${/Mac/.test(navigator.platform) ? "⌘" : "Ctrl"}</kbd> + <kbd>−</kbd>) if the page looks cramped.`, 9000);
    if (S.ev && S.ev.meta.round === r.round) { scrollToEl($("#sec-event")); return; }
  }
  $("#picker-flag").innerHTML = flag(r.country); $("#picker-label").textContent = r.name;
  showLoader("Loading race weekend");
  setProgress(.15, "Event data");
  try {
    const slug = { 18: "usa_2026" }[r.round] || `round_${r.round}`;
    const [ev, model] = await Promise.all([
      fetch(`data/event/${slug}.json`, { cache: "no-store" }).then(x => { if (!x.ok) throw new Error("event bundle missing"); return x.json(); }),
      fetch("data/model/finish_model.json", { cache: "no-store" }).then(x => x.ok ? x.json() : null).catch(() => null)]);
    S.ev = ev; S.model = model;
    setProgress(.45, "Live weather (Open-Meteo)");
    S.wx = await loadWeather(ev);
    setProgress(.75, "Rival strategy mix");
    const wxRace = weatherAt(S.wx, localHourKey(ev.meta.race_utc, ev.meta.tz));
    S.cfg = buildConfig(ev, { airC: wxRace?.temp ?? 27 });
    S.arch = fieldArchetypes(S.cfg);
    setProgress(1, "Ready");
  } catch (e) {
    hideLoader();
    $("#boot-msg").textContent = "Could not load this race: " + e.message;
    return;
  }
  await hideLoader();
  $("#topbar").classList.add("on");
  $("#tb-event").textContent = `R${r.round} · ${r.name.replace("Grand Prix", "GP")}`;
  $("#tb-live").classList.remove("hidden");
  S.bg?.setEnergy?.(.55);
  renderCards();
  renderDrivers();
  renderModelBox();
  ["#sec-event", "#sec-driver", "#sec-model"].forEach(s => $(s).classList.remove("hidden"));
  reveal($$("#cards4 .card"));
  reveal($$("#drivers .drv"));
  history.replaceState(null, "", `?race=${r.round}`);
  scrollToEl($("#sec-event"));
}

/* ------------------------------------------------------------ 4 cards */
function renderCards() {
  const ev = S.ev, m = ev.meta, host = $("#cards4");
  S.stops.forEach(f => f()); S.stops = [];
  host.innerHTML = "";
  $("#event-aside").textContent = `${m.circuit} · ${m.locality}`;
  // 1 weather
  const w = weatherAt(S.wx, localHourKey(m.race_utc, m.tz));
  const wc = h("article", { class: "glass card click", tabindex: 0, "aria-label": "Weather, open hourly forecast" });
  if (w) {
    const kind = wxKind(w.code, w.cloud);
    wc.innerHTML = `<div class="lab">${ICON.flag.replace("<svg", '<svg width="13" height="13"')} Race-time weather <span class="more">Hourly ›</span></div>
      <div class="wx-main">${wxSVG(kind)}<div><div class="wx-temp num">${Math.round(w.temp)}<sup>°C</sup></div>
      <div class="muted" style="font-size:13px;text-transform:capitalize">${{ sun: "Sunny", partly: "Sun & cloud", cloud: "Overcast", rain: "Rain", storm: "Thunderstorms", fog: "Fog" }[kind]} · track ≈ ${Math.round(w.temp + S.cfg.trackOffset)}°C</div></div></div>
      <div class="wx-grid"><div>${ICON.drop}<b>${Math.round(w.rh)}%</b><small>Humidity</small></div>
      <div>${ICON.wind(w.dir)}<b>${Math.round(w.wind)}</b><small>km/h</small></div>
      <div>${ICON.rain}<b>${Math.round(w.rain ?? 0)}%</b><small>Rain</small></div></div>
      <div class="wx-note">${S.wx.live ? "Live" : "Snapshot"} · ${S.wx.source} · ${timeIn(m.race_utc, m.tz)} local</div>`;
    wc.addEventListener("click", openWeather);
    wc.addEventListener("keydown", e => { if (e.key === "Enter") openWeather(); });
  } else wc.innerHTML = `<div class="lab">Weather</div><div class="empty">Forecast unavailable</div>`;
  // 2 track
  const tc = h("article", { class: "glass card click trk", tabindex: 0, "aria-label": "Track, open map" });
  const tr = trackSVG(ev.track, { W: 400, H: 230, width: 5 });
  const pl = ev.track?.pole_lap;
  tc.innerHTML = `<div class="lab">${m.circuit.replace("Circuit of the Americas", "COTA")} <span class="more">Map ›</span></div>${tr.html}
    <div class="legend">${[0, 1, 2].map(k => `<span><i style="background:${SECTOR_COL[k]}"></i>S${k + 1}${pl ? ` <span class="num dim">${pl["s" + (k + 1)].toFixed(3)}</span>` : ""}</span>`).join("")}</div>`;
  S.stops.push(tr.start(tc, 5));
  tc.addEventListener("click", openTrack);
  tc.addEventListener("keydown", e => { if (e.key === "Enter") openTrack(); });
  // 3 schedule
  const sc = h("article", { class: "glass card" });
  const now = Date.now(), nextIdx = ev.sessions.findIndex(s => new Date(s.end_utc) > now);
  const abbr = n => ({ "Practice 1": "FP1", "Practice 2": "FP2", "Practice 3": "FP3", Qualifying: "Q", Race: "R", Sprint: "SPR", "Sprint Qualifying": "SQ", "Sprint Shootout": "SQ" }[n] || n.slice(0, 3).toUpperCase());
  sc.innerHTML = `<div class="lab">Weekend <span class="more">${m.sprint ? "Sprint format" : "No sprint"}</span></div>
    <ul class="sched">${ev.sessions.map((s, i) => `<li class="${new Date(s.end_utc) < now ? "done" : i === nextIdx ? "next" : ""}">
      <span class="ic">${new Date(s.end_utc) < now ? "✓" : abbr(s.name)}</span><span>${s.name}<br><small class="dim">${dayIn(s.start_utc, m.tz)}</small></span>
      <span class="t">${timeIn(s.start_utc, m.tz)}<small>${timeIn(s.start_utc, TZ_USER)} yours</small></span></li>`).join("")}</ul>`;
  // 4 race (the picker, now a card)
  const rc = h("article", { class: "glass card race-card" });
  const dist = (m.laps * m.lap_km).toFixed(1);
  rc.innerHTML = `<div class="lab">Round ${m.round} <span class="more"><span class="badge live">This week</span></span></div>
    <div class="flag-big">${flag(m.country)}</div><h3>${m.name}</h3><div class="meta">${m.circuit}</div>
    <div class="statrow"><div><b>${m.laps}</b><small>Laps</small></div><div><b>${m.lap_km}</b><small>km</small></div><div><b>${dist}</b><small>Race km</small></div></div>
    <div class="muted" style="font-size:13px;margin:-4px 0 12px">Lights out <b class="num">${timeIn(m.race_utc, m.tz)}</b> local · <span class="num">${timeIn(m.race_utc, TZ_USER)}</span> yours</div>
    <div class="tyres">${["H", "M", "S"].map(c => `<span title="${m.compounds[c]}">${tyreSVG(c)}</span><span class="num dim" style="font-size:11px;margin-right:6px">${m.compounds[c]}</span>`).join("")}
    <button class="btn-ghost" style="margin-left:auto" id="change-race">Change</button></div>`;
  rc.querySelector("#change-race").addEventListener("click", () => { scrollToEl($("#hero")); setTimeout(() => $("#picker-btn").click(), 700); });
  host.append(wc, tc, sc, rc);
  $$(".card", host).forEach(c => glassify(c, 4));
}

function openModal(html, after) {
  const sheet = $("#sheet");
  sheet.innerHTML = `<button class="x" aria-label="Close">✕</button>` + html;
  $("#modal").classList.add("on");
  const close = () => { $("#modal").classList.remove("on"); S.modalStop?.(); };
  sheet.querySelector(".x").addEventListener("click", close);
  $("#modal").onclick = e => { if (e.target.id === "modal") close(); };
  S.closeModal = close;
  after && after(sheet);
}
function openWeather() {
  const m = S.ev.meta, hr = S.wx.hourly, raceKey = localHourKey(m.race_utc, m.tz), nowKey = localHourKey(new Date().toISOString(), m.tz);
  const raceI = hr.time.findIndex(t => t.slice(0, 13) === raceKey);
  const from = Math.max(0, Math.min(raceI - 6, hr.time.findIndex(t => t.slice(0, 13) >= nowKey)));
  const idx = hr.time.map((t, i) => i).filter(i => i >= from);
  const temps = idx.map(i => hr.temperature_2m[i]), lo = Math.min(...temps), hi = Math.max(...temps);
  const spark = idx.map((i, k) => `${(k / (idx.length - 1) * 100).toFixed(2)},${(36 - (hr.temperature_2m[i] - lo) / Math.max(hi - lo, 1) * 30).toFixed(1)}`).join(" ");
  openModal(`<div class="lab" style="font-size:11px;letter-spacing:.3em;color:var(--ink3)">RACE DAY · ${dayIn(m.race_utc, m.tz).toUpperCase()} · ${m.locality.toUpperCase()}</div>
    <h2 style="margin:6px 0 14px">Hour by hour</h2>
    <svg viewBox="0 0 100 40" preserveAspectRatio="none" style="width:100%;height:60px"><polyline points="${spark}" fill="none" stroke="#ffc906" stroke-width=".6" vector-effect="non-scaling-stroke"/></svg>
    <div class="hours">${idx.map(i => {
      const k = hr.time[i].slice(0, 13), race = raceI >= 0 && i >= raceI && i < raceI + 2, past = k < nowKey;
      return `<div class="hour ${race ? "race" : ""} ${past ? "past" : ""}"><div class="t">${hr.time[i].slice(11, 16)}${race ? " " + CHEQUER.replace('width="18" height="18"', 'width="11" height="11"') : ""}</div>${wxSVG(wxKind(hr.weather_code[i], hr.cloud_cover[i]))}
        <b>${Math.round(hr.temperature_2m[i])}°</b><small>${Math.round(hr.relative_humidity_2m[i])}% RH</small><small>${Math.round(hr.wind_speed_10m[i])} km/h</small><small>☂ ${hr.precipitation_probability[i] ?? 0}%</small></div>`; }).join("")}</div>
    <p class="note">${S.wx.live ? "Live forecast" : "Stored snapshot"} from ${S.wx.source}, retrieved ${new Date(S.wx.retrieved_at).toLocaleString()}. Times are circuit local (${m.tz}). The race window is outlined in red. Track temperature in the model = air + ${S.cfg.trackOffset} °C (assumed for this cloud cover).</p>`);
}
function openTrack() {
  const t = S.ev.track, m = S.ev.meta, pl = t.pole_lap, big = trackSVG(t, { W: 900, H: 520, mode: "speed", corners: true, width: 6 });
  const pole = S.ev.grid[0];
  openModal(`<div class="lab" style="font-size:11px;letter-spacing:.3em;color:var(--ink3)">${m.circuit.toUpperCase()}</div>
    <h2 style="margin:6px 0 4px">Speed map · pole lap</h2>
    <div class="seg" id="tmode" style="margin:8px 0"><button aria-pressed="true" data-m="speed">Speed</button><button aria-pressed="false" data-m="sectors">Sectors</button></div>
    <div class="track-big" id="tbig">${big.html}</div>
    <div class="facts">
      <div class="fact"><b>${pl ? fmtLap(pl.lap_s) : "–"}</b><small>Pole · ${pole?.code || ""}</small></div>
      ${pl ? [1, 2, 3].map(k => `<div class="fact" style="box-shadow:inset 3px 0 0 ${SECTOR_COL[k - 1]}"><b>${pl["s" + k].toFixed(3)}</b><small>Sector ${k}</small></div>`).join("") : ""}
      <div class="fact"><b>${t.st_speed ?? "–"}</b><small>Speed trap km/h</small></div>
      <div class="fact"><b>${t.pit_loss ? t.pit_loss.normal.toFixed(1) + " s" : "–"}</b><small>Pit loss green</small></div>
      <div class="fact"><b>${t.pit_loss ? t.pit_loss.sc.toFixed(1) + " / " + t.pit_loss.vsc.toFixed(1) : "–"}</b><small>Pit loss SC / VSC</small></div>
      <div class="fact"><b>${t.corners?.length ?? "–"}</b><small>Corners</small></div>
    </div>
    <p class="note">Outline: ${t.outline_source}. Sectors and speed: ${t.speed_source || "unavailable"}. Colour scale 80 (blue) → 330 km/h (red).</p>`, sheet => {
    let stop = big.start(sheet.querySelector("#tbig"), 4);
    S.modalStop = () => stop();
    sheet.querySelectorAll("#tmode button").forEach(b => b.addEventListener("click", () => {
      sheet.querySelectorAll("#tmode button").forEach(x => x.setAttribute("aria-pressed", x === b));
      stop(); const v = trackSVG(t, { W: 900, H: 520, mode: b.dataset.m, corners: true, width: 6 });
      sheet.querySelector("#tbig").innerHTML = v.html; stop = v.start(sheet.querySelector("#tbig"), 4);
    }));
  });
}

/* ------------------------------------------------------------ drivers */
function renderDrivers() {
  const host = $("#drivers"); host.innerHTML = "";
  const ev = S.ev;
  $("#grid-note").textContent = ev.grid.length ? "Grid = qualifying order (penalties not verified)" : "Qualifying not yet run";
  for (const id of ["max_verstappen", "hadjar"]) {
    const g = ev.grid.find(x => x.driver_id === id);
    const info = { max_verstappen: { no: 3, first: "Max", last: "Verstappen" }, hadjar: { no: 6, first: "Isack", last: "Hadjar" } }[id];
    const d = h("button", { class: "glass drv", "aria-pressed": "false", "data-id": id, html:
      `<span class="stripe"></span><span class="face-wrap"><span class="no">${g?.number ?? info.no}</span>${PHOTOS[id] ? `<img class="face" src="${PHOTOS[id].src}" alt="${info.first} ${info.last}" style="object-position:${PHOTOS[id].pos}" title="Photo: ${PHOTOS[id].credit}, ${PHOTOS[id].lic}" loading="lazy" onerror="this.remove()">` : ""}</span>
       <span class="nm">${info.first}<br>${info.last.toUpperCase()}<small>Red Bull Racing · ${g?.code ?? ""}</small></span>
       <span class="qpos">${g ? `<b>P${g.pos}</b><small>${g.best_s ? fmtLap(g.best_s) : ""}${g.gap_s ? ` · +${g.gap_s.toFixed(3)}` : " · POLE"}</small>` : `<b class="dim" style="font-size:18px">Quali<br>pending</b>`}</span>` });
    if (g) d.addEventListener("click", () => selectDriver(id));
    else d.disabled = true;
    glassify(d, 3);
    host.append(d);
  }
}

async function selectDriver(id) {
  S.driver = id;
  $$("#drivers .drv").forEach(b => { b.classList.toggle("sel", b.dataset.id === id); b.setAttribute("aria-pressed", b.dataset.id === id); });
  S.field = buildField(S.ev, id, S.arch);
  S.history = [];
  const g = S.ev.grid.find(x => x.driver_id === id);
  S.live = { lap: 0, pos: g.pos, comp: 1, age: 0, pits: 0, used: [], status: GREEN, statusLeft: 3, gapAhead: null, gapBehind: null, out: new Set() };
  await runPreRace();
}

async function runPreRace() {
  const key = S.driver + ":" + S.objective;
  const lsKey = `pitwall:pre:${S.ev.meta.slug}:${S.ev.meta.generated}:${S.cfg.airC}:${key}:v1`;
  if (!S.pre[key]) { try { const c = localStorage.getItem(lsKey); if (c) S.pre[key] = JSON.parse(c); } catch (e) { /* storage unavailable */ } }
  if (!S.pre[key]) {
    showLoader("Pre-race strategy");
    try {
      S.pre[key] = await search(S.cfg, S.field, { lap: 0 }, { quality: "standard", objective: S.objective, onStage: (l, p) => setProgress(p, l) });
      try { localStorage.setItem(lsKey, JSON.stringify({ ...S.pre[key], ranked: undefined })); } catch (e) { /* storage full or blocked */ }
    } catch (e) { await hideLoader(); alert("Simulation failed: " + e.message); return; }
    await hideLoader();
  }
  const res = S.pre[key];
  const best = res.top[0];
  S.live.comp = best.plan.comps[0];
  renderPrediction(res);
  renderStrategies(res);
  renderConsole();
  renderHistory();
  ["#sec-pred", "#sec-strat", "#sec-live"].forEach(s => $(s).classList.remove("hidden"));
  reveal([...$$("#pred > *"), ...$$("#strats > *"), $("#console")]);
  scrollToEl($("#sec-pred"));
}

/* ------------------------------------------------------------ prediction */
function blendDist(res) {
  const sim = res.top[0].m, C = 22, g = S.ev.grid.find(x => x.driver_id === S.driver);
  const pdnf = S.field.cars[0].pdnf;
  let ml = null;
  if (S.model) {
    const x = driverFeatures(S.model, S.driver, g.pos);
    if (x) { const p = finishProbs(S.model, x); ml = new Array(C).fill(0); p.forEach((v, i) => { ml[Math.min(i, C - 1)] += v * (1 - pdnf); }); }
  }
  const simH = sim.hist.slice(0, C);
  const blend = ml ? simH.map((v, i) => 0.5 * v + 0.5 * ml[i]) : simH;
  const dnfB = ml ? 0.5 * sim.p_dnf + 0.5 * pdnf : sim.p_dnf;
  return { sim: { h: simH, dnf: sim.p_dnf }, ml: ml ? { h: ml, dnf: pdnf } : null, blend: { h: blend, dnf: dnfB } };
}
function stats(d) {
  const cl = 1 - d.dnf, e = d.h.reduce((s, v, i) => s + v * (i + 1), 0) / Math.max(cl, 1e-9);
  const mode = d.h.indexOf(Math.max(...d.h)) + 1;
  return { win: d.h[0], pod: d.h[0] + d.h[1] + d.h[2], pts: d.h.slice(0, 10).reduce((a, b) => a + b, 0), dnf: d.dnf, e, mode };
}
function renderPrediction(res) {
  const host = $("#pred"), D = blendDist(res), g = S.ev.grid.find(x => x.driver_id === S.driver);
  const seasonRows = S.ev.season[S.driver] || [];
  $("#pred-aside").innerHTML = `${PHOTOS[S.driver] ? `<img class="avatar" src="${PHOTOS[S.driver].src}" alt="" style="object-position:${PHOTOS[S.driver].pos}">` : ""}${g.name} · starts P${g.pos} · ${(res.races / 1000).toFixed(0)}k simulated races`;
  host.innerHTML = "";
  const gauge = h("div", { class: "glass gauge-card" });
  const draw = which => {
    const d = D[which] || D.blend, st = stats(d), R = 104, C = 2 * Math.PI * R;
    gauge.innerHTML = `<div class="gauge"><svg viewBox="0 0 240 240"><circle cx="120" cy="120" r="${R}" fill="none" stroke="rgba(255,255,255,.07)" stroke-width="14"/>
      <circle cx="120" cy="120" r="${R}" fill="none" stroke="url(#gg)" stroke-width="14" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C}" id="garc"/>
      <defs><linearGradient id="gg" x1="0" x2="1"><stop offset="0" stop-color="#e8002d"/><stop offset="1" stop-color="#ffc906"/></linearGradient></defs></svg>
      <div class="center"><div><small>Most likely</small><b>P${st.mode}</b><small>avg P${st.e.toFixed(1)} if classified</small></div></div></div>
      <div class="dim" style="font-size:11px;letter-spacing:.2em;margin-top:4px">RING = PODIUM ${pct(st.pod)}</div>
      <div class="pills"><div class="pill win"><b>${pct(st.win)}</b><small>Win</small></div><div class="pill"><b>${pct(st.pod)}</b><small>Podium</small></div>
      <div class="pill"><b>${pct(st.pts)}</b><small>Points</small></div><div class="pill dnf"><b>${pct(st.dnf)}</b><small>DNF</small></div></div>`;
    const arc = gauge.querySelector("#garc"), off = C * (1 - st.pod);
    requestAnimationFrame(() => { arc.style.transition = "stroke-dashoffset 1.2s cubic-bezier(.2,.8,.2,1)"; arc.setAttribute("stroke-dashoffset", off); });
  };
  const dist = h("div", { class: "glass dist-card" });
  const seg = h("div", { class: "seg", role: "group", "aria-label": "Source" });
  const srcs = [["blend", "Blend"], ["sim", "Simulator"], ["ml", "Statistical model"]].filter(([k]) => D[k]);
  const bars = h("div", { class: "bars" }), xs = h("div", { class: "bars-x" });
  const drawBars = which => {
    const d = D[which], vals = [...d.h.slice(0, 20), d.dnf], mx = Math.max(...vals, .01);
    bars.innerHTML = vals.map((v, i) => `<div class="b ${i === 20 ? "dnf" : i < 3 ? "pod" : ""}" style="height:${(v / mx * 100).toFixed(1)}%" title="${i === 20 ? "DNF" : "P" + (i + 1)}: ${pct(v, 1)}">${v >= .03 ? `<span>${Math.round(v * 100)}</span>` : ""}</div>`).join("");
    if (S.gsap) S.gsap.from(bars.children, { scaleY: 0, duration: .7, stagger: .02, ease: "expo.out" });
    draw(which);
  };
  xs.innerHTML = [...Array(20)].map((_, i) => `<span>${i + 1}</span>`).join("") + "<span>DNF</span>";
  srcs.forEach(([k, l], i) => seg.append(h("button", { "aria-pressed": i === 0, onclick: e => { $$("button", seg).forEach(b => b.setAttribute("aria-pressed", b === e.currentTarget)); drawBars(k); } }, l)));
  const bt = S.model?.backtest;
  const form = h("div", { class: "form-strip" }, seasonRows.map(r => {
    const dnf = !r.classified, cls = dnf ? "dnf" : r.finish === 1 ? "p1" : r.finish <= 3 ? "pod" : "";
    const d = r.grid - r.finish;
    return h("div", { class: "fs " + cls, title: `${r.race}: grid P${r.grid} → ${dnf ? "DNF (" + r.status + ")" : "P" + r.finish}` },
      h("div", { class: "r" }, "R" + r.round), h("b", {}, dnf ? "✕" : "P" + r.finish),
      h("div", { class: "g " + (dnf ? "dim" : d > 0 ? "up" : d < 0 ? "down" : "dim"), html: dnf ? "DNF" : `${d > 0 ? ICON.up : d < 0 ? ICON.down : "="} ${d ? Math.abs(d) : ""}<span class="dim"> P${r.grid}</span>` }));
  }));
  dist.append(
    h("div", { style: { display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" } }, h("div", { class: "lab", style: { fontSize: "11px", letterSpacing: ".3em", color: "var(--ink3)" } }, "FINISHING POSITION"), h("div", { style: { marginLeft: "auto" } }, seg)),
    bars, xs,
    h("div", { class: "lab", style: { fontSize: "11px", letterSpacing: ".3em", color: "var(--ink3)", marginTop: "18px" } }, `${S.ev.meta.season} SEASON · GRID → FINISH`), form,
    h("p", { class: "note", style: { marginTop: "14px" }, html:
      `<b>Simulator</b>: best pre-race plan over ${res.top[0].m.n} races with the real field (qualifying pace gaps, team retirement rates, SC/VSC history). ` +
      (bt ? `<b>Statistical model</b>: ordered logit on grid, qualifying gap, team form and racecraft from earlier 2026 races; rolling backtest 2024-26 (${bt.full.n} driver-races): log-loss ${bt.full.ll} vs ${bt.grid_only.ll} grid-only, mean error ${bt.full.mae} vs ${bt.finish_eq_grid.mae} positions for "finish = grid". ` : "") +
      `<b>Blend</b>: equal-weight average of the two.` }));
  host.append(gauge, dist);
  glassify(gauge, 3);
  drawBars(srcs[0][0]);
}

/* ------------------------------------------------------------ strategy cards */
function objectiveSeg(onChange) {
  const seg = $("#obj-seg"); seg.innerHTML = "";
  for (const [k, o] of Object.entries(OBJECTIVES))
    seg.append(h("button", { "aria-pressed": k === S.objective, onclick: () => { if (k === S.objective) return; S.objective = k; onChange(); } }, o.label));
}
function stintBar(plan, fromLap, laps) {
  const segs = [], b = [fromLap, ...plan.stops, laps];
  let html = "";
  if (fromLap > 0) html += `<div class="st done" style="flex:${fromLap}"><em>L1–${fromLap}</em></div>`;
  plan.comps.forEach((c, i) => { const n = b[i + 1] - b[i]; segs.push(n); html += `<div class="st ${COMP[c]}" style="flex:${n}">${COMP[c]}<em>${n}</em></div>`; });
  const marks = plan.stops.map(l => `<span class="pitlap" style="left:${(l / laps * 100).toFixed(2)}%">L${l}</span>`).join("");
  const now = fromLap > 0 ? `<span class="now" style="left:${(fromLap / laps * 100).toFixed(2)}%"></span>` : "";
  return `<div class="stint">${html}${marks}${now}</div>`;
}
function stratCard(s, i, fromLap, prevBest) {
  const m = s.m, laps = S.cfg.laps, best = i === 0;
  const el = h("article", { class: "glass strat" + (best ? " best" : "") });
  const dPts = prevBest != null ? m.e_points - prevBest : null;
  el.innerHTML = `<div class="rank"><b>${i + 1}</b> ${s.plan.n}-stop · ${s.plan.comps.map(c => COMP[c]).join("→")}${best ? '<span class="best-tag">CALL</span>' : ""}</div>
    ${stintBar(s.plan, fromLap, laps)}
    <div class="kpis"><div class="kpi"><b>${fx(m.e_points, 1)}</b><small>Exp. pts${dPts != null ? ` <span class="${dPts >= 0 ? "up" : "down"}">${dPts >= 0 ? "+" : ""}${dPts.toFixed(1)}</span>` : ""}</small></div>
      <div class="kpi"><b>${pct(m.p_win)}</b><small>Win</small></div><div class="kpi"><b>${pct(m.p_podium)}</b><small>Podium</small></div>
      <div class="kpi"><b>P${fx(m.e_pos, 1)}</b><small>Avg finish</small></div></div>
    <div class="trace">${m.trace ? traceSVG(m.trace, laps, 12, best ? "#ffc906" : "#5b8cff", fromLap) : ""}</div>
    <div class="rules"><span class="rule-chip">${ICON.sc.replace("<svg", '<svg width="13" height="13"')} SC/VSC & tyres ≥ ${S.cfg.reactMinAge} laps → box</span>
      <span class="rule-chip">${ICON.pit.replace("<svg", '<svg width="13" height="13"')} ${s.plan.stops.length ? "Box L" + s.plan.stops.join(", L") : "No more stops"}</span>
      <span class="rule-chip">DNF ${pct(m.p_dnf)}</span></div>`;
  glassify(el, 2);
  return el;
}
function renderStrategies(res) {
  objectiveSeg(async () => { objectiveSeg(() => {}); await runPreRace(); });
  const host = $("#strats"); host.innerHTML = "";
  res.top.forEach((s, i) => host.append(stratCard(s, i, 0, null)));
}

/* ------------------------------------------------------------ live console */
function renderConsole() {
  const L = S.live, host = $("#console"), laps = S.cfg.laps;
  const g = S.ev.grid;
  const sy = S.sync;
  host.innerHTML = `
  <div class="sync">
    <span class="sync-dot ${sy.auto ? "on" : ""}" id="sync-dot"></span>
    <div class="sync-t"><b>Live timing</b><small id="sync-msg">${sy.field ? `Field synced at lap ${sy.field.lap}` : "OpenF1 · pull the real field at any lap"}</small></div>
    <button class="btn-ghost" id="sync-pull">Pull lap <span class="num" id="sync-lap">${L.lap || 1}</span></button>
    <div class="seg" id="sync-every" role="group" aria-label="Auto interval">${[5, 10, 15].map(n => `<button aria-pressed="${n === sy.every}" data-n="${n}">${n} laps</button>`).join("")}</div>
    <button class="btn-ghost ${sy.auto ? "active" : ""}" id="sync-auto" aria-pressed="${sy.auto}">${sy.auto ? "Auto ON" : "Auto off"}</button>
    <input type="password" id="sync-token" placeholder="OpenF1 token (live sessions)" value="${getToken() ? "••••••••" : ""}" autocomplete="off" aria-label="OpenF1 bearer token">
  </div>
  <div class="state-banner" id="sban">
    <div class="sb-item"><b id="sban-lap">0</b><small>Lap</small></div>
    <div class="sb-item"><b id="sban-pos">P1</b><small>Position</small></div>
    <div class="sb-item"><b id="sban-comp">M</b><small>Tyre</small></div>
    <div class="sb-item"><b id="sban-age">0L</b><small>Age</small></div>
    <div class="sb-item"><b id="sban-pits">0</b><small>Stops</small></div>
    <div class="sb-item"><b id="sban-status">GREEN</b><small>Status</small></div>
  </div>
  <div class="ctl">
    <h4>Lap completed <kbd>← →</kbd></h4>
    <div class="quick-laps" id="qlaps">${[10, 20, 30, 40, 50].filter(l => l < laps).map(l => `<button data-l="${l}">L${l}</button>`).join("")}</div>
    <div class="stepper" id="lap-st"><button data-d="-1" aria-label="Previous lap">−</button><div class="val"><b class="num" id="lap-v"></b><small>of ${laps}</small></div><button data-d="1" aria-label="Next lap">+</button></div>
    <input type="range" min="0" max="${laps - 1}" id="lap-r" aria-label="Lap">
    <h4>Running position <kbd>↑ ↓</kbd></h4>
    <div class="stepper" id="pos-st"><button data-d="-1" aria-label="Gain a place">−</button><div class="val"><b class="num" id="pos-v"></b><small>position</small></div><button data-d="1" aria-label="Lose a place">+</button></div>
    <h4>Track status <kbd>G V S R</kbd></h4>
    <div class="status-pick" id="status">${STATUS_NAME.map((n, i) => `<button data-v="${i}">${n}</button>`).join("")}</div>
    <div class="mini" id="stleft-wrap"><button data-d="-1">−</button><div class="v"><b id="stleft-v"></b><small>laps of neutralisation left</small></div><button data-d="1">+</button></div>
  </div>
  <div class="ctl">
    <h4>Tyre on the car <kbd>1 2 3</kbd></h4>
    <div class="tyre-pick" id="tyre">${COMP.map((c, i) => `<button data-v="${i}">${tyreSVG(c)}${["Soft", "Medium", "Hard"][i]} · ${S.ev.meta.compounds[c]}</button>`).join("")}</div>
    <div class="mini-row">
      <div class="mini" id="age-st"><button data-d="-1">−</button><div class="v"><b id="age-v"></b><small>tyre age (laps)</small></div><button data-d="1">+</button></div>
      <div class="mini" id="pits-st"><button data-d="-1">−</button><div class="v"><b id="pits-v"></b><small>stops made</small></div><button data-d="1">+</button></div>
    </div>
    <h4>Compounds already used</h4>
    <div class="outs" id="used">${COMP.map((c, i) => `<button data-v="${i}">${c}</button>`).join("")}</div>
    <div class="mini-row">
      <div class="mini" id="ga-st"><button data-d="-1">−</button><div class="v"><b id="ga-v"></b><small>gap ahead s</small></div><button data-d="1">+</button></div>
      <div class="mini" id="gb-st"><button data-d="-1">−</button><div class="v"><b id="gb-v"></b><small>gap behind s</small></div><button data-d="1">+</button></div>
    </div>
  </div>
  <div class="ctl">
    <h4>Retired cars <span class="dim" style="letter-spacing:0;text-transform:none;font-weight:400">tap to mark out</span></h4>
    <div class="outs" id="outs">${g.filter(x => x.driver_id !== S.driver).map(x => `<button data-code="${x.code}"><i style="background:${x.colour || "#888"}"></i>${x.code}</button>`).join("")}</div>
    <h4>State</h4>
    <div class="summary-line" id="sum"></div>
    <button class="run-btn" id="run">Find best 3 calls<small>Enter · ≈ 3-6 s</small></button>
    <p class="note" id="console-note"></p>
  </div>`;
  const step = (id, fn) => $$(`#${id} button[data-d]`, host).forEach(b => b.addEventListener("click", () => { fn(+b.dataset.d); syncConsole(); }));
  step("lap-st", d => setLap(L.lap + d));
  step("pos-st", d => { L.pos = clamp(L.pos + d, 1, 22 - L.out.size); });
  step("stleft-wrap", d => { L.statusLeft = clamp(L.statusLeft + d, 1, 8); });
  step("age-st", d => { L.age = clamp(L.age + d, 0, Math.max(L.lap, 0)); });
  step("pits-st", d => { L.pits = clamp(L.pits + d, 0, 3); });
  step("ga-st", d => { L.gapAhead = L.gapAhead == null ? (d > 0 ? 1.0 : null) : (L.gapAhead + d * 0.5 <= 0 ? null : +(L.gapAhead + d * 0.5).toFixed(1)); });
  step("gb-st", d => { L.gapBehind = L.gapBehind == null ? (d > 0 ? 1.0 : null) : (L.gapBehind + d * 0.5 <= 0 ? null : +(L.gapBehind + d * 0.5).toFixed(1)); });
  $$("#qlaps button", host).forEach(b => b.addEventListener("click", () => { setLap(+b.dataset.l); syncConsole(); }));
  $("#lap-r", host).addEventListener("input", e => { setLap(+e.target.value); syncConsole(); });
  $$("#status button", host).forEach(b => b.addEventListener("click", () => { L.status = +b.dataset.v; if (L.status === RED) L.statusLeft = 1; syncConsole(); }));
  $$("#tyre button", host).forEach(b => b.addEventListener("click", () => { setComp(+b.dataset.v); syncConsole(); }));
  $$("#used button", host).forEach(b => b.addEventListener("click", () => {
    const v = +b.dataset.v, u = new Set(L.used); u.has(v) ? u.delete(v) : u.add(v); L.used = [...u]; syncConsole(); }));
  $$("#outs button", host).forEach(b => b.addEventListener("click", () => {
    L.out.has(b.dataset.code) ? L.out.delete(b.dataset.code) : L.out.add(b.dataset.code); L.pos = clamp(L.pos, 1, 22 - L.out.size); syncConsole(); }));
  $("#run", host).addEventListener("click", () => runWhatIf());
  $("#sync-pull", host).addEventListener("click", () => pullLap(Math.max(L.lap, 1), false));
  $$("#sync-every button", host).forEach(b => b.addEventListener("click", () => { S.sync.every = +b.dataset.n; S.sync.next = 0; renderConsole(); }));
  $("#sync-auto", host).addEventListener("click", () => { S.sync.auto ? stopAuto() : startAuto(); renderConsole(); });
  $("#sync-token", host).addEventListener("change", e => { const v = e.target.value; if (v && !v.startsWith("•")) { setToken(v); syncMsg("Token saved for this tab"); } else if (!v) setToken(""); });
  syncConsole();
}

/* ------------------------------------------------------------ live timing sync */
const raceKey = () => S.ev.sessions.find(x => x.name === "Race")?.key;
function syncMsg(t, bad) { const m = $("#sync-msg"); if (m) { m.textContent = t; m.classList.toggle("bad", !!bad); } }
async function pullLap(lap, autoRun) {
  if (S.sync.busy) return;
  S.sync.busy = true; syncMsg(`Pulling lap ${lap}…`);
  try {
    const f = await fieldAtLap(raceKey(), lap, S.ev.grid);
    const ours = f.cars[S.field.cars[0].code];
    if (!ours || ours.out) throw new Error(`${S.field.cars[0].code} is out of the race at lap ${lap}.`);
    const L = S.live;
    L.lap = lap; L.pos = ours.pos; L.comp = ours.comp; L.age = ours.age; L.pits = ours.pits; L.used = ours.used.filter(c => c !== ours.comp);
    L.status = f.status; L.statusLeft = f.statusLeft || 3;
    L.out = new Set(Object.entries(f.cars).filter(([, c]) => c.out).map(([k]) => k));
    const run = Object.values(f.cars).filter(c => !c.out).sort((a, b) => a.gap - b.gap), i = run.indexOf(ours);
    L.gapAhead = i > 0 ? +(ours.gap - run[i - 1].gap).toFixed(1) : null;
    L.gapBehind = i < run.length - 1 ? +(run[i + 1].gap - ours.gap).toFixed(1) : null;
    S.sync.field = { lap, pos: ours.pos, cars: S.field.cars.map(c => f.cars[c.code] ? { ...f.cars[c.code], used: f.cars[c.code].used || [] } : { out: true }) };
    renderConsole();
    syncMsg(`Field synced at lap ${lap} · ${new Date().toLocaleTimeString("en-GB")}${f.warnings.length ? " · " + f.warnings.length + " warning(s)" : ""}`);
    if (f.warnings.length) console.warn("live sync:", f.warnings);
    if (autoRun) await runWhatIf({ auto: true });
  } catch (e) { syncMsg(e.message, true); }
  finally { S.sync.busy = false; }
}
function startAuto() {
  S.sync.auto = true; S.sync.next = S.sync.next || S.sync.every;
  const tick = async () => {
    if (!S.sync.auto || S.sync.busy || $("#loader").classList.contains("on")) return;
    try {
      const lap = await currentLap(raceKey(), Math.max(S.sync.next - 2, 1));
      if (lap >= S.sync.next) { const L = Math.floor(lap / S.sync.every) * S.sync.every; S.sync.next = L + S.sync.every; await pullLap(L, true); }
      else syncMsg(`Auto: leader on lap ${lap + 1}, next call at lap ${S.sync.next}`);
    } catch (e) { syncMsg(e.message, true); }
  };
  tick(); S.sync.timer = setInterval(tick, 20000);
}
function stopAuto() { S.sync.auto = false; clearInterval(S.sync.timer); }
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function setLap(v) {
  const L = S.live, prev = L.lap; L.lap = clamp(v, 0, S.cfg.laps - 1);
  L.age = clamp(L.age + (L.lap - prev), 0, L.lap);   // tyre ages with the laps
}
function setComp(c) { S.live.comp = c; }
function syncConsole() {
  const L = S.live, host = $("#console");
  if (!host.querySelector("#lap-v")) return;
  $("#lap-v").textContent = L.lap; $("#lap-r").value = L.lap; $("#pos-v").textContent = "P" + L.pos;
  $("#age-v").textContent = L.age; $("#pits-v").textContent = L.pits;
  $("#ga-v").textContent = L.gapAhead == null ? "auto" : L.gapAhead.toFixed(1); $("#gb-v").textContent = L.gapBehind == null ? "auto" : L.gapBehind.toFixed(1);
  $$("#status button").forEach(b => b.setAttribute("aria-pressed", +b.dataset.v === L.status));
  $("#stleft-wrap").classList.toggle("hidden", L.status === GREEN);
  $("#stleft-v").textContent = L.statusLeft;
  $$("#tyre button").forEach(b => b.setAttribute("aria-pressed", +b.dataset.v === L.comp));
  const used = new Set([...L.used, L.comp]);
  $$("#used button").forEach(b => { const v = +b.dataset.v; b.setAttribute("aria-pressed", "false"); b.style.borderColor = used.has(v) ? "#fff" : ""; b.style.color = used.has(v) ? "#fff" : ""; b.style.opacity = v === L.comp ? .55 : 1; });
  $$("#outs button").forEach(b => b.setAttribute("aria-pressed", L.out.has(b.dataset.code)));
  const lapTxt = L.lap === 0 ? "Pre-race (grid)" : `End of lap ${L.lap}`;
  $("#sum").innerHTML = `${lapTxt} · P${L.pos} · ${COMP[L.comp]} ${L.age} laps · ${L.pits} stop${L.pits === 1 ? "" : "s"} · ${STATUS_NAME[L.status]}${L.status ? ` (${L.statusLeft} lap${L.statusLeft > 1 ? "s" : ""})` : ""}${L.out.size ? ` · out: ${[...L.out].join(" ")}` : ""}`;
  const warn = [];
  if (L.lap > 0 && L.pits === 0 && L.age < L.lap) warn.push("No stop made but tyre age < laps run: check the age or the stop count.");
  if (L.lap > 0 && L.pits > 0 && used.size < 2) warn.push("A stop was made: mark the compound used before it.");
  $("#console-note").textContent = warn.join(" ");
  const sbl = $("#sban-lap"); if (sbl) {
    sbl.textContent = L.lap || "0";
    const sbp = $("#sban-pos"); if (sbp) sbp.textContent = "P" + L.pos;
    const sbc = $("#sban-comp"); if (sbc) { sbc.textContent = COMP[L.comp]; sbc.style.color = ["var(--soft)", "var(--med)", "var(--hard)"][L.comp]; }
    const sba = $("#sban-age"); if (sba) sba.textContent = L.age + "L";
    const sbpi = $("#sban-pits"); if (sbpi) sbpi.textContent = L.pits;
    const sbst = $("#sban-status"); if (sbst) { sbst.textContent = STATUS_NAME[L.status]; sbst.style.color = ["var(--good)", "var(--warn)", "var(--s3)", "var(--bad)"][L.status]; }
  }
}

async function runWhatIf(opts = {}) {
  const L = S.live;
  if (!S.field) return;
  if (L.lap > 0 && L.pits === 0 && L.age !== L.lap) L.age = L.lap;   // no stop: the tyre is as old as the race
  syncConsole();
  const used = [...new Set([...L.used, L.comp])];
  const state = L.lap === 0
    ? { lap: 0, status: L.status, statusLeft: L.status ? L.statusLeft : 0, startComp: L.comp }
    : { lap: L.lap, ourPos: L.pos, ourComp: L.comp, ourAge: L.age, ourPits: L.pits, usedComps: used, status: L.status,
      statusLeft: L.status ? L.statusLeft : 0, gapAhead: L.gapAhead, gapBehind: L.gapBehind, out: [...L.out] };
  const synced = S.sync.field && L.lap > 0 && S.sync.field.lap === L.lap && S.sync.field.pos === L.pos;
  if (synced) state.cars = S.sync.field.cars;
  let field = S.field;
  if (L.lap === 0) field = buildField(S.ev, S.driver, S.arch, { startPos: L.pos, dnfOverride: Object.fromEntries([...L.out].map(c => [c, 1])) });
  showLoader(L.lap === 0 ? "Re-planning from the grid" : `Lap ${L.lap} · P${L.pos}`);
  let res;
  try {
    res = await search(S.cfg, field, state, { quality: "fast", objective: S.objective, onStage: (l, p) => setProgress(p, l) });
  } catch (e) { await hideLoader(); $("#console-note").textContent = e.message; return; }
  await hideLoader();
  const prev = S.history[0];
  const entry = { id: S.history.length + 1, at: new Date(), state: { ...L, out: new Set(L.out), used: [...L.used] }, res, auto: !!opts.auto, synced,
    prevBest: prev ? prev.res.top[0].m.e_points : S.pre[S.driver + ":" + S.objective]?.top[0].m.e_points };
  S.history.unshift(entry);
  renderCallSheet(entry, 0);
  renderHistory(true);
  setTimeout(() => scrollToEl($("#callsheet")), 250);
}
function renderHistory(animate) {
  const host = $("#history"); host.innerHTML = "";
  for (const it of S.history) {
    const st = it.state, top = it.res.top, b = top[0].m;
    const d = it.prevBest != null ? b.e_points - it.prevBest : null;
    const tagCls = ["", "vsc", "sc", "red"][st.status];
    const box = h("div", { class: "glass wi" });
    const head = h("div", { class: "wi-head", html:
      `<h3>${it.auto ? "Auto call" : "What-if"} #${it.id}</h3>${it.synced ? '<span class="tag live-tag">LIVE FIELD</span>' : ""}<span class="tag">${st.lap ? "L" + st.lap : "Grid"}</span><span class="tag">P${st.pos}</span><span class="tag">${COMP[st.comp]} · ${st.age}L</span><span class="tag">${st.pits} stop${st.pits === 1 ? "" : "s"}</span>` +
      (st.status ? `<span class="tag ${tagCls}">${STATUS_NAME[st.status]}</span>` : "") + (st.out.size ? `<span class="tag">out ${[...st.out].join(" ")}</span>` : "") +
      (d != null ? `<span class="delta ${d >= 0 ? "up" : "down"}">${d >= 0 ? "▲" : "▼"} ${Math.abs(d).toFixed(1)} exp. pts vs previous call</span>` : "") +
      `<span class="when">${it.at.toLocaleTimeString("en-GB")} · ${(it.res.ms / 1000).toFixed(1)} s · ${(it.res.races / 1000).toFixed(0)}k races</span>` });
    const restore = h("button", { class: "btn-ghost", onclick: () => { S.live = { ...it.state, out: new Set(it.state.out), used: [...it.state.used] }; renderConsole(); scrollToEl($("#sec-live")); } }, "Restore state");
    head.append(h("button", { class: "btn-ghost", onclick: () => { renderCallSheet(it, 0); scrollToEl($("#callsheet")); } }, "Call sheet"), restore);
    const grid = h("div", { class: "strats", style: { marginTop: "10px" } });
    top.forEach((s, i) => grid.append(stratCard(s, i, st.lap, null)));
    box.append(head, grid);
    host.append(box);
  }
  if (animate && host.firstChild) { reveal(host.firstChild); }
}

/* ------------------------------------------------------------ model box */
function renderModelBox() {
  const cfg = S.cfg, ev = S.ev, bt = S.model?.backtest;
  $("#model-box").innerHTML = `
    <div class="prov">${Object.entries(cfg.provenance).map(([k, v]) => `<div><span>${k}</span><span class="tagp ${v}">${v}</span></div>`).join("")}</div>
    <p class="note" style="margin-top:14px"><b>Simulator</b>: lap-by-lap Monte Carlo of all ${ev.grid.length} cars (tyre wear with a cliff, thermal window, fuel burn, traffic and overtaking, pit stops, SC/VSC/red flag, retirements).
      Rival pace = 0.85 × qualifying gap per lap; rival strategies are drawn from the fastest plans for this tyre model. Every candidate plan is run on the same set of random races.
      SC rate ${fx(ev.incidents?.per_race?.sc, 2)} and VSC rate ${fx(ev.incidents?.per_race?.vsc, 2)} per race (${ev.incidents?.method}). Pit loss ${fx(cfg.pitLoss, 1)} s green, ${fx(cfg.scPit, 1)} s SC, ${fx(cfg.vscPit, 1)} s VSC.
      Tyre wear rates are priors from the Barcelona study scaled to COTA's lap length: the ranking of plans is more trustworthy than the absolute percentages.</p>
    ${bt ? `<p class="note"><b>Statistical model</b>: ${S.model.kind.replace("_", " ")} trained on ${S.model.train_rows} driver-races (${S.model.train_seasons[0]}–${S.model.train_seasons.at(-1)}); features ${S.model.features.join(", ")}.
      Rolling-origin backtest (refit before each race, 2024 onward): log-loss ${bt.full.ll} vs ${bt.grid_only.ll} (grid only); mean absolute error ${bt.full.mae} vs ${bt.grid_only.mae} (grid only) and ${bt.finish_eq_grid.mae} ("finish = grid"). Conditional on finishing; retirements come from the team's 2026 rate.</p>` : ""}
    <p class="note"><b>Not modelled</b>: lapped traffic, penalties, damage, rain transitions, tyre-set availability, team orders, per-car energy (ERS) state. Grid = qualifying order; penalties not verified.</p>
    <p class="note"><b>Sources</b>: ${ev.sources.map(s => `<a href="${s.url}" target="_blank" rel="noopener">${s.name}</a> (${s.used})`).join(" · ")}. Bundle generated ${new Date(ev.meta.generated).toLocaleString()}.</p>`;
  $("#foot").innerHTML = `Pit Wall · built by Soham Savarkar · <a href="barcelona/">Barcelona 2026 case study</a> · Not affiliated with Formula 1, the FIA or Red Bull Racing. No official logos are used; team colours only. Driver photos: ${Object.values(PHOTOS).map(p => `<a href="${p.url}" target="_blank" rel="noopener">${p.credit}</a>`).join(", ")} via Wikimedia Commons, <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener">CC BY-SA 4.0</a> (cropped for display).`;
}

/* ------------------------------------------------------------ loader */
let loaderShown = 0;
function showLoader(label) {
  const l = $("#lights");
  if (!l.children.length) for (let i = 0; i < 5; i++) l.append(h("div", { class: "light" }, h("i"), h("i")));
  $$(".light", l).forEach(x => x.classList.remove("on"));
  $("#bar").style.width = "0%"; $("#stage").textContent = label || "";
  $("#loader").classList.add("on"); loaderShown = performance.now();
}
function setProgress(p, label) {
  $("#bar").style.width = (p * 100).toFixed(1) + "%";
  if (label) $("#stage").textContent = label;
  $$(".light").forEach((x, i) => x.classList.toggle("on", p >= (i + 1) / 5 - 1e-6 || p > i / 5 + 0.1));
}
async function hideLoader() {
  const wait = Math.max(0, 450 - (performance.now() - loaderShown));
  await new Promise(r => setTimeout(r, wait));
  $$(".light").forEach(x => x.classList.remove("on"));   // lights out
  await new Promise(r => setTimeout(r, 220));
  $("#loader").classList.remove("on");
}

/* ------------------------------------------------------------ keyboard */
function onKey(e) {
  if (e.key === "Escape") { S.closeModal?.(); S.closePicker?.(); return; }
  if (!S.live || $("#sec-live").classList.contains("hidden") || $("#loader").classList.contains("on")) return;
  if (["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName) && e.key !== "Enter") return;
  const L = S.live, k = e.key;
  let hit = true;
  if (k === "ArrowRight") setLap(L.lap + 1);
  else if (k === "ArrowLeft") setLap(L.lap - 1);
  else if (k === "ArrowUp") L.pos = clamp(L.pos - 1, 1, 22 - L.out.size);
  else if (k === "ArrowDown") L.pos = clamp(L.pos + 1, 1, 22 - L.out.size);
  else if (k === "1" || k === "2" || k === "3") setComp(+k - 1);
  else if (k === "g" || k === "G") L.status = GREEN;
  else if (k === "v" || k === "V") { L.status = VSC; L.statusLeft = 2; }
  else if (k === "s" || k === "S") { L.status = SC; L.statusLeft = 4; }
  else if (k === "r" || k === "R") { L.status = RED; L.statusLeft = 1; }
  else if (k === "Enter") { e.preventDefault(); runWhatIf(); return; }
  else hit = false;
  if (hit) { e.preventDefault(); syncConsole(); }
}

/* ------------------------------------------------------------ call sheet */
function renderCallSheet(entry, k, stintIdx = 0) {
  const host = $("#callsheet"), cfg = S.cfg, st = entry.state, calls = entry.res.top, sel = calls[k];
  S.zones = S.zones || trackZones(S.ev.track);
  const stints = stintsOf(cfg, sel.plan, st.lap, st.lap ? st.age : 0), cur = stints[Math.min(stintIdx, stints.length - 1)];
  const map = zoneMap(S.ev.track, S.zones, cur.comp, cur.level);
  const tip = {
    push: `Short stint for this compound: attack in the red zones, take the overtake-mode fights, push the out-lap.`,
    balanced: `Race the gaps, not the tyre: full attack only within 1 s of the car ahead; smooth through the blue esses.`,
    manage: `Long stint near the end of the tyre's life: lift-and-coast into T1 and T12, short-shift out of the orange exits, defend rather than attack.`,
  }[cur.level];
  host.classList.remove("hidden");
  host.innerHTML = `
    <div class="cs-head">
      <div><div class="lab">CALL SHEET · ${entry.auto ? "AUTO · " : ""}${st.lap ? "END OF LAP " + st.lap : "GRID"} · P${st.pos}</div>
        <h3>${sel.plan.comps.map(c => COMP[c]).join(" → ")} <span class="dim">${sel.plan.stops.length ? "· box L" + sel.plan.stops.join(", L") : "· no more stops"}</span></h3></div>
      <div class="cs-tabs">${calls.map((c, i) => `<button aria-pressed="${i === k}" data-k="${i}"><b>${i + 1}</b><span>${c.plan.comps.map(x => COMP[x]).join("")}</span><small>${fx(c.m.e_points, 1)} pts</small></button>`).join("")}</div>
    </div>
    <div class="cs-body">
      <div class="cs-map">${map.html}
        <div class="cs-legend">${Object.values(ZONE).map(z => `<span title="${z.tip}"><i style="background:${z.col}"></i>${z.label}</span>`).join("")}</div>
      </div>
      <div class="cs-side">
        <div class="lab">TYRE USAGE · REST OF RACE</div>${usageBar(stints)}
        <div class="lab" style="margin-top:14px">STINTS <span class="dim" style="letter-spacing:0;text-transform:none">tap one</span></div>
        <div class="cs-stints">${stints.map((x, i) => `<button class="cs-stint ${i === stintIdx ? "on" : ""}" data-i="${i}">${tyreSVG(COMP[x.comp])}<span><b>L${x.from}–${x.to}</b><small>${x.laps} laps · ${x.level}</small></span></button>`).join("")}</div>
        ${levelGauge(cur)}
        <p class="cs-tip">${tip}</p>
        <div class="kpis"><div class="kpi"><b>${fx(sel.m.e_points, 1)}</b><small>Exp. pts</small></div><div class="kpi"><b>${pct(sel.m.p_win)}</b><small>Win</small></div>
          <div class="kpi"><b>${pct(sel.m.p_podium)}</b><small>Podium</small></div><div class="kpi"><b>P${fx(sel.m.e_pos, 1)}</b><small>Avg</small></div></div>
        <p class="note" style="margin-top:10px">Safety car or VSC with tyres ≥ ${cfg.reactMinAge} laps old: box. Zones come from the pole-lap speed trace and Pirelli's COTA notes (driving guidance, not simulated); push level = share of the tyre's usable life the stint uses (model figures).</p>
      </div>
    </div>`;
  $$(".cs-tabs button", host).forEach(b => b.addEventListener("click", () => renderCallSheet(entry, +b.dataset.k, 0)));
  $$(".cs-stint", host).forEach(b => b.addEventListener("click", () => renderCallSheet(entry, k, +b.dataset.i)));
  // car running the lap in the stint's compound colour
  S.sheetStop?.();
  const Q = map.Q, n = Q.length, v = S.ev.track.speed, car = host.querySelector("#cs-car");
  const cum = [0]; for (let i = 1; i <= n; i++) { const a = Q[i - 1], b = Q[i % n]; cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]) / Math.max(v ? v[i - 1] : 200, 40)); }
  let raf, t0 = performance.now();
  const loop = now => {
    const t = ((now - t0) / 1000 * 0.9) % cum[n];
    let lo = 0, hi = n; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= t) lo = m; else hi = m; }
    const a = Q[lo], b = Q[(lo + 1) % n], u = (t - cum[lo]) / Math.max(cum[lo + 1] - cum[lo], 1e-9);
    car?.setAttribute("transform", `translate(${a[0] + (b[0] - a[0]) * u} ${a[1] + (b[1] - a[1]) * u})`);
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop); S.sheetStop = () => cancelAnimationFrame(raf);
  if (S.gsap) S.gsap.fromTo(host, { opacity: 0, y: 20, scale: .99 }, { opacity: 1, y: 0, scale: 1, duration: .6, ease: "expo.out" });
}
