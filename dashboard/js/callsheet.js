/* Call sheet: the three calls on the track map, with tyre usage and push/manage guidance per stint.
 *
 * Track zones are derived from the pole-lap speed trace and Pirelli's COTA notes (fronts loaded in sector 1,
 * rear thermal degradation out of slow corners). They are driving guidance, not simulator output.
 * Push level per stint = share of the compound's usable life (model max stint) used by the end of the stint:
 *   <= 60 % push, <= 85 % balanced, above that manage
 */
import { COMP, tyreTemp } from "./engine.js";
import { TYRE_COL, pct, fx, tyreSVG } from "./ui.js";

export const ZONE = {
  attack: { col: "#ff2a4d", label: "Attack · overtake mode", tip: "Long straight: deploy, attack or defend" },
  traction: { col: "#ffb020", label: "Traction · protect rears", tip: "Slow-corner exit: progressive throttle saves the rears" },
  fronts: { col: "#2fa8ff", label: "Fronts loaded · smooth", tip: "High-speed direction changes load the front-left" },
};

/* Zones as outline index ranges. */
export function trackZones(trk) {
  const v = trk?.speed, n = trk?.outline?.length || 0;
  if (!v || !n) return [];
  const out = [];
  // attack: the two longest runs above 280 km/h
  const runs = [];
  for (let i = 0; i < n; i++) {
    if (v[i] >= 280 && v[(i - 1 + n) % n] < 280) {
      let j = i; while (v[(j + 1) % n] >= 280 && j - i < n) j++;
      runs.push([i, j % n, j - i]);
    }
  }
  runs.sort((a, b) => b[2] - a[2]).slice(0, 2).forEach(([a, b]) => out.push({ type: "attack", a, b }));
  // traction: exits of corners whose apex is under 130 km/h
  const near = c => { let bi = 0, bd = Infinity; trk.outline.forEach((p, i) => { const d = (p[0] - c.x) ** 2 + (p[1] - c.y) ** 2; if (d < bd) { bd = d; bi = i; } }); return bi; };
  const sidx = trk.sector_idx || [0, Math.round(n / 3), Math.round(2 * n / 3)];
  const inS1 = i => (sidx[0] <= sidx[1] ? i >= sidx[0] && i < sidx[1] : i >= sidx[0] || i < sidx[1]);
  for (const c of trk.corners || []) {
    const i = near(c);
    let apex = i, mn = Infinity;
    for (let k = -12; k <= 12; k++) { const j = (i + k + n) % n; if (v[j] < mn) { mn = v[j]; apex = j; } }
    c._apex = mn;
    if (mn < 130) out.push({ type: "traction", a: apex, b: (apex + 22) % n, corner: c.n });
    else if (mn >= 170 && mn <= 265 && inS1(i)) out.push({ type: "fronts", a: (apex - 8 + n) % n, b: (apex + 8) % n, corner: c.n });
  }
  return out;
}

export function pushLevel(cfg, comp, laps, ageAtStart = 0) {
  // share of the compound's usable life (model max stint) the tyre will have used by the end of the stint
  const life = cfg.maxLife[comp], used = ageAtStart + laps, frac = used / life;
  const level = frac <= 0.6 ? "push" : frac <= 0.85 ? "balanced" : "manage";
  const temp = tyreTemp(cfg, comp, 0, 0), therm = 1 + cfg.thermalK * Math.max(temp - 100, 0);
  return { level, frac, used, life, overKnee: Math.max(0, Math.round(used - cfg.wearCliff[comp] / therm)) };
}

function fitPts(pts, W, H, pad) {
  const xs = pts.map(p => p[0]), ys = pts.map(p => -p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const k = Math.min((W - 2 * pad) / (x1 - x0), (H - 2 * pad) / (y1 - y0));
  const ox = (W - (x1 - x0) * k) / 2, oy = (H - (y1 - y0) * k) / 2;
  return p => [ox + (p[0] - x0) * k, oy + (-p[1] - y0) * k];
}

/* Map with zones; `emph` scales zone strength by push level. */
export function zoneMap(trk, zones, comp, level) {
  const W = 640, H = 400, P = trk.outline, n = P.length, T = fitPts(P, W, H, 26), Q = P.map(T);
  const seg = (a, b) => { const o = []; for (let i = a; ; i = (i + 1) % n) { o.push(Q[i]); if (i === b) break; } return o.map(p => p.map(x => x.toFixed(1)).join(",")).join(" "); };
  const strength = { attack: { push: 1, balanced: .75, manage: .35 }, traction: { push: .45, balanced: .75, manage: 1 }, fronts: { push: .45, balanced: .75, manage: 1 } };
  let body = `<polyline points="${Q.map(p => p.join(",")).join(" ")} ${Q[0].join(",")}" fill="none" stroke="rgba(255,255,255,.07)" stroke-width="16" stroke-linejoin="round"/>`;
  body += `<polyline points="${Q.map(p => p.join(",")).join(" ")} ${Q[0].join(",")}" fill="none" stroke="${TYRE_COL[COMP[comp]]}" stroke-opacity=".35" stroke-width="4" stroke-linejoin="round"/>`;
  for (const z of zones) {
    const s = strength[z.type][level], c = ZONE[z.type].col;
    body += `<polyline points="${seg(z.a, z.b)}" fill="none" stroke="${c}" stroke-width="${6 + 6 * s}" stroke-opacity="${(.35 + .65 * s).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round" style="filter:drop-shadow(0 0 ${Math.round(10 * s)}px ${c})"><title>${ZONE[z.type].label}${z.corner ? " · T" + z.corner : ""}</title></polyline>`;
  }
  for (const c of trk.corners || []) {
    const [x, y] = T([c.x, c.y]), a = (c.angle || 0) * Math.PI / 180, lx = x + Math.cos(a) * 17, ly = y - Math.sin(a) * 17;
    body += `<g><circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="8" fill="#0b1020" stroke="rgba(255,255,255,.3)"/><text x="${lx.toFixed(1)}" y="${(ly + 3).toFixed(1)}" text-anchor="middle" font-size="8.5" font-family="JetBrains Mono" fill="#cfd6e6">${c.n}</text></g>`;
  }
  const sidx = trk.sector_idx?.[0] ?? 0, s0 = Q[sidx];
  body += `<circle cx="${s0[0]}" cy="${s0[1]}" r="5" fill="#fff"/><text x="${s0[0] + 8}" y="${s0[1] - 8}" font-size="10" fill="#fff" font-family="JetBrains Mono">S/F</text>`;
  body += `<g id="cs-car"><circle r="11" fill="${TYRE_COL[COMP[comp]]}" opacity=".25"/><circle r="6" fill="${TYRE_COL[COMP[comp]]}" stroke="#0b1020" stroke-width="2"/></g>`;
  return { html: `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Track guidance map">${body}</svg>`, Q };
}

/* Stint list of a plan from `fromLap` with push level. ourAge = age of the tyre on the car at fromLap. */
export function stintsOf(cfg, plan, fromLap, ourAge) {
  const b = [fromLap, ...plan.stops, cfg.laps];
  return plan.comps.map((c, i) => {
    const laps = b[i + 1] - b[i], age0 = i === 0 ? ourAge : 0;
    return { comp: c, from: b[i] + 1, to: b[i + 1], laps, ...pushLevel(cfg, c, laps, age0) };
  });
}

export function usageBar(stints) {
  const tot = stints.reduce((s, x) => s + x.laps, 0), by = [0, 0, 0];
  stints.forEach(s => { by[s.comp] += s.laps; });
  return `<div class="usage">${by.map((l, c) => l ? `<div class="u ${COMP[c]}" style="flex:${l}"><b>${COMP[c]}</b><span>${l} laps · ${Math.round(l / tot * 100)}%</span></div>` : "").join("")}</div>`;
}

export function levelGauge(st) {
  const pos = Math.max(4, Math.min(96, (st.frac - 0.3) / 0.75 * 100));
  const lab = { push: "Push", balanced: "Balanced", manage: "Manage" }[st.level];
  const txt = `${lab} · ${Math.round(st.frac * 100)}% of the tyre's life by the end of the stint (${st.used} of ~${st.life} laps)` +
    (st.overKnee ? ` · ${st.overKnee} laps beyond the wear knee` : "");
  return `<div class="lvl"><div class="lvl-track"><i style="left:${pos.toFixed(0)}%"></i></div><div class="lvl-lab"><span>Push</span><span>Balanced</span><span>Manage</span></div><div class="lvl-txt ${st.level}">${txt}</div></div>`;
}
