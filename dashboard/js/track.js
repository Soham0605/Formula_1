/* Track map: real outline (MultiViewer), 3 sectors from the pole lap, speed heat and a car running the pole lap. */
const SECTOR_COL = ["#ff2a4d", "#2fa8ff", "#ffd21f"];

function fit(pts, W, H, pad) {
  const xs = pts.map(p => p[0]), ys = pts.map(p => -p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const k = Math.min((W - 2 * pad) / (x1 - x0), (H - 2 * pad) / (y1 - y0));
  const ox = (W - (x1 - x0) * k) / 2, oy = (H - (y1 - y0) * k) / 2;
  return p => [ox + (p[0] - x0) * k, oy + (-p[1] - y0) * k];
}
const speedCol = v => {
  // 80 km/h deep blue -> 330 km/h hot
  const t = Math.max(0, Math.min(1, (v - 80) / 250));
  const stops = [[47, 91, 255], [46, 216, 255], [255, 210, 31], [255, 42, 77]];
  const i = Math.min(2, Math.floor(t * 3)), u = t * 3 - i, a = stops[i], b = stops[i + 1];
  return `rgb(${a.map((x, j) => Math.round(x + (b[j] - x) * u)).join(",")})`;
};

/* Returns {svg markup, start(): stop()} ; mode "sectors" | "speed" */
export function trackSVG(trk, { W = 400, H = 240, pad = 14, mode = "sectors", corners = false, car = true, width = 5 } = {}) {
  if (!trk || !trk.outline?.length) return { html: `<div class="empty">Track data unavailable</div>`, start() {} };
  const P = trk.outline, n = P.length, T = fit(P, W, H, pad), Q = P.map(T);
  const sidx = trk.sector_idx || [0, Math.round(n / 3), Math.round(2 * n / 3)];
  const poly = (a, b) => { const out = []; for (let i = a; ; i = (i + 1) % n) { out.push(Q[i]); if (i === b) break; } return out.map(p => p.map(v => v.toFixed(1)).join(",")).join(" "); };
  let body = `<polyline points="${Q.map(p => p.map(v => v.toFixed(1)).join(",")).join(" ")} ${Q[0].join(",")}" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="${width + 7}" stroke-linejoin="round"/>`;
  if (mode === "speed" && trk.speed) {
    for (let i = 0; i < n; i++) { const a = Q[i], b = Q[(i + 1) % n];
      body += `<line x1="${a[0].toFixed(1)}" y1="${a[1].toFixed(1)}" x2="${b[0].toFixed(1)}" y2="${b[1].toFixed(1)}" stroke="${speedCol(trk.speed[i])}" stroke-width="${width}" stroke-linecap="round"/>`; }
  } else {
    [[sidx[0], sidx[1]], [sidx[1], sidx[2]], [sidx[2], sidx[0]]].forEach(([a, b], k) => {
      body += `<polyline points="${poly(a, b)}" fill="none" stroke="${SECTOR_COL[k]}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round" style="filter:drop-shadow(0 0 6px ${SECTOR_COL[k]}88)"/>`;
    });
  }
  // start/finish line
  const s0 = Q[sidx[0]], s1 = Q[(sidx[0] + 2) % n], ang = Math.atan2(s1[1] - s0[1], s1[0] - s0[0]) + Math.PI / 2;
  body += `<line x1="${(s0[0] + Math.cos(ang) * 9).toFixed(1)}" y1="${(s0[1] + Math.sin(ang) * 9).toFixed(1)}" x2="${(s0[0] - Math.cos(ang) * 9).toFixed(1)}" y2="${(s0[1] - Math.sin(ang) * 9).toFixed(1)}" stroke="#fff" stroke-width="3"/>`;
  if (corners && trk.corners) {
    for (const c of trk.corners) {
      const [x, y] = T([c.x, c.y]), a = (c.angle || 0) * Math.PI / 180, d = 16;
      const lx = x + Math.cos(a) * d, ly = y - Math.sin(a) * d;
      body += `<g><circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="8" fill="#0b1020" stroke="rgba(255,255,255,.35)"/><text x="${lx.toFixed(1)}" y="${(ly + 3.2).toFixed(1)}" text-anchor="middle" font-size="9" font-family="JetBrains Mono" fill="#cfd6e6">${c.n}</text></g>`;
    }
  }
  const id = "car" + Math.random().toString(36).slice(2, 8);
  if (car) body += `<g id="${id}"><circle r="9" fill="#ffc906" opacity=".25"/><circle r="4.5" fill="#ffc906" stroke="#0b1020" stroke-width="1.5"/></g>`;
  const html = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Track map">${body}</svg>`;
  // car timing along the outline from the pole-lap speed trace (or uniform speed)
  const cum = [0];
  for (let i = 1; i <= n; i++) {
    const a = P[i - 1], b = P[i % n], dm = Math.hypot(b[0] - a[0], b[1] - a[1]) / 10;
    const v = Math.max(((trk.speed?.[i - 1] ?? 200) / 3.6), 15);
    cum.push(cum[i - 1] + dm / v);
  }
  const lapT = cum[n], real = trk.pole_lap?.lap_s || lapT, start0 = sidx[0];
  return {
    html,
    start(root, speedup = 6) {
      if (!car) return () => {};
      const g = root.querySelector("#" + id);
      if (!g) return () => {};
      let raf, t0 = performance.now(), off = cum[start0];
      const step = now => {
        const t = (off + ((now - t0) / 1000) * speedup * (lapT / real)) % lapT;
        let lo = 0, hi = n;
        while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= t) lo = m; else hi = m; }
        const u = (t - cum[lo]) / Math.max(cum[lo + 1] - cum[lo], 1e-9), a = Q[lo], b = Q[(lo + 1) % n];
        g.setAttribute("transform", `translate(${(a[0] + (b[0] - a[0]) * u).toFixed(1)} ${(a[1] + (b[1] - a[1]) * u).toFixed(1)})`);
        raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
      return () => cancelAnimationFrame(raf);
    },
  };
}
export { SECTOR_COL, speedCol };
