/* Race simulation engine (pure functions; runs in a Web Worker or on the main thread).
 *
 * JavaScript port of f1strat/sim.py, extended for live use:
 *   - the real field: every rival has its own pace offset (from its qualifying gap) and retirement hazard
 *     (its team's 2026 retirement rate), instead of 21 interchangeable cars
 *   - any race state can be the starting point (lap, position, tyre + age, stops done, track status)
 *   - common random numbers: race r uses the same random stream for every candidate plan, so plans are
 *     compared on identical races and their ranking is not noise
 *
 * Lap model per car:  base + compound offset + wear(effective age) + thermal-window penalty + fuel mass
 *                     + car pace + noise (+ standing start / out-lap)
 * Traffic: within `zone` of the car ahead a pass is attempted with probability logistic(edge - passDelta);
 * otherwise the follower is held `followGap` behind. SC bunches the field, VSC freezes gaps,
 * red flag = free tyre change + bunched restart. Cars retire with a per-lap hazard.
 */
export const GREEN = 0, VSC = 1, SC = 2, RED = 3;
export const COMP = ["S", "M", "H"];
export const INF = 999;
const POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];

/* ---------- seeded random numbers (mulberry32 + Box-Muller) ---------- */
export function rng(seed) {
  let a = seed >>> 0;
  const u = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const n = () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(6.283185307179586 * u());
  return { u, n };
}

/* ---------- tyre model ---------- */
export function tyreTemp(cfg, c, held, st) {
  let t = cfg.tempBase[c] + cfg.tempTrackK * (cfg.airC + cfg.trackOffset - cfg.refTrack) + cfg.tempDirty * held;
  if (st === SC) t -= 9; else if (st === VSC) t -= 4;
  return t;
}
export function tyrePen(cfg, c, age, degk, temp) {
  const over = Math.max(age - cfg.wearCliff[c], 0);
  const wear = cfg.wearLin[c] * age + cfg.wearQuad[c] * over * over;
  const win = 0.04 * Math.max(cfg.winLo - temp, 0) + 0.03 * Math.max(temp - cfg.winHi, 0);
  return wear * degk * cfg.degScale + win;
}

/* Traffic-free green-flag time of a plan from lap 0 (builds the rivals' strategy mix). */
export function soloTime(cfg, comps, stops) {
  const b = [0, ...stops, cfg.laps];
  let t = 0, fuel = cfg.fuel0;
  for (let k = 0; k < comps.length; k++) {
    const c = comps[k], temp = tyreTemp(cfg, c, 0, GREEN), therm = 1 + cfg.thermalK * Math.max(temp - 100, 0);
    let age = 0;
    for (let l = b[k]; l < b[k + 1]; l++) {
      t += cfg.baseLap + cfg.compOff[c] + tyrePen(cfg, c, age, 1, temp) + cfg.fuelK * fuel + (l === b[k] && k > 0 ? cfg.outlapPen : 0);
      fuel -= cfg.burn; age += therm;
    }
    if (k < comps.length - 1) t += cfg.pitLoss;
  }
  return t;
}

function feasibleFull(cfg, comps, stops) {
  const b = [0, ...stops, cfg.laps];
  for (let k = 0; k < comps.length; k++) {
    const len = b[k + 1] - b[k];
    if (len < cfg.minStint || len > cfg.maxLife[comps[k]]) return false;
  }
  return new Set(comps).size >= 2;
}

/* Strategy mix of the rivals: the solo-optimal stop laps of the best compound orders per stop count. */
export function fieldArchetypes(cfg) {
  const best = { 1: new Map(), 2: new Map(), 3: new Map() };
  const consider = (comps, stops) => {
    if (!feasibleFull(cfg, comps, stops)) return;
    const t = soloTime(cfg, comps, stops), key = comps.join(""), m = best[stops.length], cur = m.get(key);
    if (!cur || t < cur.t) m.set(key, { t, comps: [...comps], stops: [...stops] });
  };
  const L = cfg.laps;
  for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) if (a !== b) for (let p = 8; p < L - 8; p++) consider([a, b], [p]);
  for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) for (let c = 0; c < 3; c++)
    for (let p1 = 7; p1 < L - 20; p1 += 2) for (let p2 = p1 + 7; p2 < L - 6; p2 += 2) consider([a, b, c], [p1, p2]);
  const out = [];
  for (const [n, ws] of [[1, [26, 18, 8]], [2, [20, 12, 8]], [3, []]]) {
    [...best[n].values()].sort((x, y) => x.t - y.t).slice(0, ws.length).forEach((s, i) => out.push({ ...s, w: ws[i] }));
  }
  return out;
}

/* ---------- one simulated race ----------
 * plan:  { comps:[c0,c1,..], stops:[lap,..] }  for car 0 (ours); comps[0] is the tyre we are on at `state.lap`.
 * state: { lap, order:[car indices, leader first], gaps:[s behind leader per car index], comp:[], age:[],
 *          stint:[], pits:[], usedOurs:Set, status, statusLeft }   built by initialState()
 */
export function simulateRace(cfg, field, state, plan, rep, record = false) {
  const C = field.cars.length, L = cfg.laps, R = rng(cfg.seed * 1000003 + rep * 7919 + 17);
  // per-race draws (fixed order so every plan sees the same race)
  const degMult = Math.exp(R.n() * cfg.uncDeg), pitAdd = R.n() * cfg.uncPit, passAdd = R.n() * cfg.uncPass, hazMult = Math.exp(R.n() * cfg.uncHaz);
  const pace = new Float64Array(C), degk = new Float64Array(C), react = new Float64Array(C);
  const cComps = [], cStops = [];
  const archs = field.archetypes, wsum = archs.reduce((s, a) => s + a.w, 0);
  for (let c = 0; c < C; c++) {
    pace[c] = field.cars[c].pace + R.n() * cfg.paceSigma;
    degk[c] = Math.exp(R.n() * cfg.degkSigma) * degMult;
    react[c] = R.u();
    let x = R.u() * wsum, k = 0;
    while (k < archs.length - 1 && x > archs[k].w) { x -= archs[k].w; k++; }
    const a = archs[k];
    const st = a.stops.map(s => s + Math.round(R.n() * 2));
    for (let i = 1; i < st.length; i++) st[i] = Math.max(st[i], st[i - 1] + cfg.minStint + 1);
    cComps.push([...a.comps]); cStops.push(st.map(s => Math.min(Math.max(s, 4), L - 4)));
  }
  const startN = new Float64Array(C);
  for (let c = 0; c < C; c++) startN[c] = R.n();
  cComps[0] = plan.comps; cStops[0] = plan.stops;

  // state arrays
  const cum = new Float64Array(C), comp = new Int8Array(C), age = new Float64Array(C), ageLaps = new Int32Array(C);
  const stint = new Int8Array(C), nextStop = new Int32Array(C), fuel = new Float64Array(C), held = new Uint8Array(C);
  const heldRun = new Int32Array(C), outlap = new Uint8Array(C), alive = new Uint8Array(C).fill(1), pits = new Int32Array(C);
  const L0 = state.lap;
  for (let c = 0; c < C; c++) {
    if (L0 === 0) {
      cum[c] = state.slot[c] * cfg.startGap + startN[c] * cfg.startNoise;
      comp[c] = cComps[c][0]; stint[c] = 0; nextStop[c] = cStops[c].length ? cStops[c][0] : INF;
    } else if (c === 0) {
      cum[c] = state.gap[c]; comp[c] = plan.comps[0]; stint[c] = 0;
      age[c] = state.ourAge; ageLaps[c] = state.ourAge; nextStop[c] = plan.stops.length ? plan.stops[0] : INF; pits[c] = state.ourPits;
    } else {
      // rival: where its own plan has it at lap L0
      cum[c] = state.gap[c] + startN[c] * 0.15;
      let k = 0;
      while (k < cStops[c].length && cStops[c][k] <= L0) k++;
      stint[c] = k; comp[c] = cComps[c][k]; nextStop[c] = k < cStops[c].length ? cStops[c][k] : INF;
      const since = L0 - (k ? cStops[c][k - 1] : 0); age[c] = since; ageLaps[c] = since; pits[c] = k;
    }
    if (state.out && state.out[c]) { alive[c] = 0; cum[c] = Infinity; }
    fuel[c] = Math.max(cfg.fuel0 - cfg.burn * L0, 1.5);
  }

  // track status: forced events from the state, random hazard afterwards
  let left = state.statusLeft || 0, kind = state.status || GREEN;
  const order = new Int32Array(C), lapFree = new Float64Array(C), tFree = new Float64Array(C), arr = new Float64Array(C);
  const pit = new Uint8Array(C), pitPlan = new Uint8Array(C), pitRed = new Uint8Array(C), tNo = new Float64Array(C);
  const temp = new Float64Array(C), blocked = new Uint8Array(C), passed = new Uint8Array(C), uP = new Float64Array(C);
  let ourDnf = false, ourPassed = 0, ourHeld = 0, sawSC = false, sawVSC = false, sawRed = false;
  const log = record ? { pos: [], comp: [], age: [], status: [], gapAhead: [], gapBehind: [], pitLaps: [], laps: [] } : null;
  const hDnf = field.cars.map(c => 1 - Math.pow(1 - c.pdnf, 1 / L));
  const scPitF = cfg.scPit / cfg.pitLoss, vscPitF = cfg.vscPit / cfg.pitLoss;

  for (let l = L0 + 1; l <= L; l++) {
    // ---- status ----
    const us = R.u(), ud = R.u();
    let st;
    if (left > 0) { st = kind; left--; } else {
      st = GREEN;
      if (l < L) {
        const hm = hazMult, hR = cfg.hRed * hm, hS = (l === 1 ? cfg.hScLap1 : cfg.hSc) * hm, hV = cfg.hVsc * hm;
        if (us < hR) { st = RED; kind = RED; left = 1; }
        else if (us < hR + hS) { st = SC; kind = SC; left = 2 + Math.floor(ud * 4); }
        else if (us < hR + hS + hV) { st = VSC; kind = VSC; left = Math.floor(ud * 3); }
      }
    }
    if (st === SC) sawSC = true; else if (st === VSC) sawVSC = true; else if (st === RED) sawRed = true;
    // ---- order before the lap ----
    for (let c = 0; c < C; c++) order[c] = c;
    order.sort((a, b) => cum[a] - cum[b]);
    // ---- free lap times + per-car draws (always drawn, alive or not) ----
    for (let c = 0; c < C; c++) {
      const nz = R.n() * cfg.lapSigma, uPass = R.u(), pn = R.n(), slow = R.u(), slowAmt = R.u(), uD = R.u();
      lapFree[c] = 0; pit[c] = 0;
      if (!alive[c]) continue;
      if (uD < hDnf[c]) { alive[c] = 0; cum[c] = Infinity; if (c === 0) ourDnf = true; continue; }
      temp[c] = tyreTemp(cfg, comp[c], held[c], st);
      let lf = cfg.baseLap + cfg.compOff[comp[c]] + tyrePen(cfg, comp[c], age[c], degk[c], temp[c]) + cfg.fuelK * fuel[c] + pace[c] + nz + (outlap[c] ? cfg.outlapPen : 0);
      if (l === 1) lf += cfg.startLoss;
      lapFree[c] = lf;
      const lapT = st === GREEN ? lf : (st === VSC ? cfg.vscLap : cfg.scLap) + nz;
      // pit decision at the end of this lap
      const more = nextStop[c] < INF;
      pitPlan[c] = more && nextStop[c] === l && l < L ? 1 : 0;
      const neutral = st === VSC || st === SC;
      const reacts = c === 0 ? plan.reactSC !== false : react[c] < cfg.reactAI;
      const pReact = neutral && more && ageLaps[c] >= cfg.reactMinAge && reacts && (L - l) >= 6 && !pitPlan[c];
      pitRed[c] = st === RED && (L - l) >= 3 ? 1 : 0;
      pit[c] = (pitPlan[c] || pReact || pitRed[c]) && l < L ? 1 : 0;
      const f = st === SC ? scPitF : st === VSC ? vscPitF : 1;
      const extra = pn * cfg.pitSigma + (slow < cfg.slowP ? 2 + 4 * slowAmt : 0) + pitAdd;
      const pitT = pit[c] && !pitRed[c] ? (cfg.pitLoss + extra) * f : 0;
      tNo[c] = cum[c] + lapT; tFree[c] = tNo[c] + pitT; arr[c] = tFree[c];
      blocked[c] = 0; passed[c] = 0; uP[c] = uPass;
    }
    // ---- traffic (green only) ----
    if (st === GREEN) {
      let i1 = -1, i2 = -1, a1 = -Infinity, a2 = -Infinity;
      for (let r = 0; r < C; r++) {
        const c = order[r];
        if (!alive[c]) continue;
        let tc = tFree[c];
        if (i1 >= 0 || i2 >= 0) {
          const use1 = a1 >= a2, ref = use1 ? i1 : i2, ta = use1 ? a1 : a2;
          if (ref >= 0 && !pit[c] && tc < ta + cfg.followGap) {
            const g0 = cum[c] - cum[ref], delta = lapFree[ref] - lapFree[c];
            const p = 1 / (1 + Math.exp(-(delta - (cfg.passDelta + passAdd)) / cfg.passScale));
            if (g0 < cfg.zone && uP[c] < p && tc < ta + 0.3) { tc = Math.min(tc + cfg.passCost, ta - 0.1); passed[c] = 1; }
            else { tc = ta + cfg.followGap; blocked[c] = 1; }
          }
        }
        arr[c] = tc;
        if (!pit[c]) { i2 = i1; a2 = a1; i1 = c; a1 = tc; }
      }
    }
    // ---- neutralisation: bunch the field ----
    if (st >= SC) {
      const live = [];
      for (let c = 0; c < C; c++) if (alive[c]) live.push(c);
      live.sort((a, b) => tNo[a] - tNo[b]);
      const cap = st === RED ? cfg.redGap : cfg.scGap;
      let prev = tNo[live[0]], prevNew = prev;
      for (let k = 0; k < live.length; k++) {
        const c = live[k];
        const nt = k === 0 ? tNo[c] : prevNew + Math.min(tNo[c] - prev, cap);
        prev = tNo[c]; prevNew = nt;
        arr[c] = nt + (tFree[c] - tNo[c]);
      }
    }
    // ---- bookkeeping ----
    if (blocked[0]) ourHeld++;
    if (passed[0]) ourPassed++;
    const wearF = st === SC ? cfg.scWear : st === VSC ? cfg.vscWear : 1;
    const fuelF = st === SC || st === RED ? cfg.scFuel : st === VSC ? cfg.vscFuel : 1;
    const rem = L - l;
    for (let c = 0; c < C; c++) {
      if (!alive[c]) continue;
      cum[c] = arr[c];
      held[c] = blocked[c];
      heldRun[c] = blocked[c] ? heldRun[c] + 1 : 0;
      const therm = 1 + cfg.thermalK * Math.max(temp[c] - 100, 0);
      const inc = therm * (1 + cfg.wearDirty * blocked[c]) * wearF;
      fuel[c] = Math.max(fuel[c] - cfg.burn * fuelF, 0);
      if (pit[c]) {
        const ns = Math.min(stint[c] + 1, cComps[c].length - 1);
        let nc = cComps[c][Math.min(stint[c] + 1, cComps[c].length - 1)];
        let nxt = stint[c] + 1 < cStops[c].length ? cStops[c][stint[c] + 1] : INF;
        if (!pitPlan[c] && nxt < INF) nxt = Math.max(nxt, l + cfg.minStint + 4);
        if (pitRed[c]) { nc = rem >= 30 ? 2 : rem >= 16 ? 1 : 0; nxt = INF; }
        comp[c] = nc; nextStop[c] = nxt; stint[c] = ns; age[c] = 0; ageLaps[c] = 0; outlap[c] = 1; pits[c]++; heldRun[c] = 0;
      } else { age[c] += inc; ageLaps[c]++; outlap[c] = 0; }
    }
    if (record) {
      let pos = 1;
      if (alive[0]) for (let c = 1; c < C; c++) if (alive[c] && cum[c] < cum[0]) pos++;
      let ga = Infinity, gb = Infinity;
      if (alive[0]) for (let c = 1; c < C; c++) if (alive[c]) { const d = cum[0] - cum[c]; if (d > 0) ga = Math.min(ga, d); else gb = Math.min(gb, -d); }
      log.laps.push(l); log.pos.push(alive[0] ? pos : null); log.comp.push(comp[0]); log.age.push(ageLaps[0]); log.status.push(st);
      log.gapAhead.push(isFinite(ga) ? ga : null); log.gapBehind.push(isFinite(gb) ? gb : null);
      if (pit[0]) log.pitLaps.push(l);
    }
  }
  let pos = null;
  if (alive[0]) { pos = 1; for (let c = 1; c < C; c++) if (alive[c] && cum[c] < cum[0]) pos++; }
  let lead = Infinity;
  for (let c = 0; c < C; c++) if (alive[c]) lead = Math.min(lead, cum[c]);
  return { pos, dnf: ourDnf, gap: alive[0] ? cum[0] - lead : null, pits: pits[0], held: ourHeld, passes: ourPassed,
    ev: sawRed ? 3 : sawSC ? 2 : sawVSC ? 1 : 0, log };
}

/* Build the starting state.
 * pre-race:  { lap:0, slotOf:{carIndex: gridSlot0} }
 * live:      { lap, ourPos, ourAge, ourPits, usedComps:[...], gapAhead, gapBehind, status, statusLeft, out:[codes] }
 */
export function initialState(cfg, field, s) {
  const C = field.cars.length;
  if (!s || !s.lap) {
    const slot = field.cars.map(c => c.grid - 1);
    return { lap: 0, slot, gap: new Array(C).fill(0), status: s?.status || GREEN, statusLeft: s?.statusLeft || 0, out: null };
  }
  // running order: rivals keep their grid order, ours is inserted at ourPos
  const rivals = field.cars.map((c, i) => ({ i, g: c.grid })).filter(x => x.i !== 0).sort((a, b) => a.g - b.g).map(x => x.i);
  const outSet = new Set(s.out || []);
  const running = rivals.filter(i => !outSet.has(field.cars[i].code));
  const p = Math.max(1, Math.min(s.ourPos, running.length + 1)) - 1;
  const ord = [...running.slice(0, p), 0, ...running.slice(p)];
  // gaps: a field spread that grows with laps run (~0.35 s per lap per position, capped), user gaps around us
  const spread = Math.min(1.0 + 0.04 * s.lap, 3.0);
  const gap = new Array(C).fill(0);
  let t = 0;
  ord.forEach((c, k) => {
    if (k > 0) {
      let d = spread;
      if (ord[k] === 0 && s.gapAhead != null) d = s.gapAhead;
      if (ord[k - 1] === 0 && s.gapBehind != null) d = s.gapBehind;
      t += d;
    }
    gap[c] = t;
  });
  const out = field.cars.map(c => outSet.has(c.code));
  return { lap: s.lap, gap, ourAge: s.ourAge, ourPits: s.ourPits, usedComps: s.usedComps, status: s.status || GREEN,
    statusLeft: s.statusLeft || 0, out };
}

/* ---------- candidate plans for the rest of the race ---------- */
export function candidates(cfg, s) {
  const L = cfg.laps, L0 = s.lap || 0, out = [];
  const cur = s.lap ? s.ourComp : null, age0 = s.lap ? s.ourAge : 0;
  const used = new Set(s.usedComps || []);
  const push = (comps, stops) => {
    // stint lengths (first stint includes the laps already done on the current set)
    const b = [L0, ...stops, L];
    for (let k = 0; k < comps.length; k++) {
      const len = b[k + 1] - b[k] + (k === 0 ? age0 : 0);
      if (len > cfg.maxLife[comps[k]]) return;
      if (k > 0 && b[k + 1] - b[k] < cfg.minStint) return;
    }
    if (stops.some(x => x <= L0 || x >= L - 1)) return;
    const all = new Set([...used, ...comps]);
    if (all.size < 2) return;
    out.push({ comps, stops, reactSC: true, n: stops.length + (s.ourPits || 0), label: comps.map(c => COMP[c]).join("-") + (stops.length ? " · L" + stops.join(", L") : " · no stop") });
  };
  const starts = cur != null ? [cur] : s.startComp != null ? [s.startComp] : [0, 1, 2];
  const step1 = L0 ? 1 : 2, step2 = 2;
  for (const c0 of starts) {
    push([c0], []);
    for (let a = 0; a < 3; a++) for (let p = L0 + 1; p < L - 2; p += step1) push([c0, a], [p]);
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++)
      for (let p1 = L0 + 1; p1 < L - 10; p1 += step1 + 1) for (let p2 = p1 + cfg.minStint; p2 < L - 3; p2 += step2 + 1) push([c0, a, b], [p1, p2]);
    if (!L0) for (const seq of [[0, 1, 0, 1], [0, 2, 0, 1], [1, 0, 1, 0], [0, 1, 2, 0], [0, 0, 1, 1]])
      if (seq[0] === c0) for (let p1 = 8; p1 < 20; p1 += 3) for (let p2 = p1 + 9; p2 < 36; p2 += 3) for (let p3 = p2 + 9; p3 < L - 5; p3 += 4) push(seq, [p1, p2, p3]);
  }
  return out;
}

/* ---------- summary of a plan over many races ---------- */
export function summarise(results, C) {
  const n = results.length, hist = new Array(C).fill(0);
  let win = 0, pod = 0, pts = 0, top10 = 0, dnf = 0, sumPos = 0, nCl = 0, ePts = 0;
  const gaps = [];
  for (const r of results) {
    if (r.pos == null) { dnf++; continue; }
    hist[r.pos - 1]++; nCl++; sumPos += r.pos;
    if (r.pos === 1) win++;
    if (r.pos <= 3) pod++;
    if (r.pos <= 10) top10++;
    ePts += r.pos <= 10 ? POINTS[r.pos - 1] : 0;
    gaps.push(r.gap);
  }
  gaps.sort((a, b) => a - b);
  return { n, p_win: win / n, p_podium: pod / n, p_points: top10 / n, p_dnf: dnf / n, e_pos: nCl ? sumPos / nCl : null,
    e_points: ePts / n, hist: hist.map(h => h / n), gap_p50: gaps.length ? gaps[gaps.length >> 1] : null };
}

export const OBJECTIVES = {
  points: { label: "Expected points", f: m => m.e_points + 2 * m.p_win, tol: 0.6 },
  podium: { label: "Podium chance", f: m => m.p_podium + 0.01 * m.e_points / 25, tol: 0.03 },
  win: { label: "Win chance", f: m => m.p_win + 0.01 * m.p_podium, tol: 0.03 },
};

/* Three plans: best first; then prefer a different stop count when it is within `tol` of the best
   remaining option (same rule as f1strat.strategies.pick_top3). `ranked` is sorted best-first. */
export function pickTop3(ranked, score, tol) {
  const chosen = [], seen = new Set();
  const key = p => p.plan.n + ":" + p.plan.comps.join("");
  let pool = [...ranked];
  while (chosen.length < 3 && pool.length) {
    const best = pool.find(p => !seen.has(key(p)));
    if (!best) break;
    const counts = new Set(chosen.map(c => c.plan.n));
    const novel = pool.find(p => !seen.has(key(p)) && !counts.has(p.plan.n));
    const pick = novel && chosen.length && score(best.m) - score(novel.m) <= tol ? novel : best;
    chosen.push(pick); seen.add(key(pick));
    pool = pool.filter(p => p !== pick);
  }
  return chosen;
}
