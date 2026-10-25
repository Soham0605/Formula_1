/* DOM helpers, icons and formatting. */
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const NS = "http://www.w3.org/2000/svg";

export function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (k === "style" && typeof v === "object") Object.assign(e.style, v);
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat(9)) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
export function s(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
  if (parent) parent.append(e);
  return e;
}
export const pct = (x, d = 0) => (x == null ? "–" : (x * 100).toFixed(d) + "%");
export const fx = (x, d = 1) => (x == null || !isFinite(x) ? "–" : Number(x).toFixed(d));
export const fmtLap = sec => `${Math.floor(sec / 60)}:${(sec % 60).toFixed(3).padStart(6, "0")}`;
export const ordinal = n => "P" + n;

export function timeIn(iso, tz, opts = {}) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false, ...opts }).format(new Date(iso));
}
export function dayIn(iso, tz) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(new Date(iso));
}
/* "YYYY-MM-DDTHH" of an instant in a time zone (matches Open-Meteo local hourly keys) */
export function localHourKey(iso, tz) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false })
    .formatToParts(new Date(iso)).reduce((o, x) => (o[x.type] = x.value, o), {});
  return `${p.year}-${p.month}-${p.day}T${p.hour === "24" ? "00" : p.hour}`;
}
export function countdown(ms) {
  if (ms <= 0) return null;
  const d = Math.floor(ms / 864e5), hh = Math.floor(ms / 36e5) % 24, mm = Math.floor(ms / 6e4) % 60, ss = Math.floor(ms / 1e3) % 60;
  return { d, hh, mm, ss };
}

const ISO = { Australia: "au", China: "cn", Japan: "jp", USA: "us", "United States": "us", Canada: "ca", Monaco: "mc", Spain: "es",
  Austria: "at", UK: "gb", "United Kingdom": "gb", Belgium: "be", Hungary: "hu", Netherlands: "nl", Italy: "it", Azerbaijan: "az",
  Singapore: "sg", Mexico: "mx", Brazil: "br", Qatar: "qa", UAE: "ae", "United Arab Emirates": "ae", Bahrain: "bh",
  "Saudi Arabia": "sa", Malaysia: "my", Portugal: "pt", France: "fr", Germany: "de" };
export const CHEQUER = `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 22V3" stroke="currentColor" stroke-width="2"/><path d="M5 4h15v10H5z" fill="#fff"/><path d="M5 4h3.75v2.5H5zm7.5 0h3.75v2.5H12.5zM8.75 6.5h3.75V9H8.75zm7.5 0H20V9h-3.75zM5 9h3.75v2.5H5zm7.5 0h3.75v2.5H12.5zM8.75 11.5h3.75V14H8.75zm7.5 0H20V14h-3.75z" fill="#111"/></svg>`;
export const flag = (country, cls = "") => ISO[country] ? `<span class="fi fi-${ISO[country]} ${cls}" role="img" aria-label="${country}"></span>` : CHEQUER;

/* ---------------- tyre icon ---------------- */
export const TYRE_COL = { S: "#ff2d3c", M: "#ffd43b", H: "#f4f6fa" };
export function tyreSVG(code, label) {
  const c = TYRE_COL[code];
  return `<svg class="tyre" viewBox="0 0 40 40" role="img" aria-label="${code === "S" ? "Soft" : code === "M" ? "Medium" : "Hard"}${label ? " " + label : ""}">
    <circle cx="20" cy="20" r="19" fill="#15171d"/><circle cx="20" cy="20" r="15.5" fill="none" stroke="${c}" stroke-width="3.2"/>
    <circle cx="20" cy="20" r="11.5" fill="#22252d"/>
    <text x="20" y="25" text-anchor="middle" font-family="Titillium Web, sans-serif" font-weight="900" font-size="14" fill="${c}">${code}</text></svg>`;
}

/* ---------------- weather icons (animated SVG) ---------------- */
const SUN = `<g class="sun"><circle cx="32" cy="30" r="11" fill="url(#sg)"/>
  <g stroke="#ffd23f" stroke-width="3" stroke-linecap="round">${[...Array(8)].map((_, i) => {
    const a = i * Math.PI / 4, x1 = 32 + Math.cos(a) * 16, y1 = 30 + Math.sin(a) * 16, x2 = 32 + Math.cos(a) * 21, y2 = 30 + Math.sin(a) * 21;
    return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`; }).join("")}</g>
  <animateTransform attributeName="transform" type="rotate" from="0 32 30" to="360 32 30" dur="24s" repeatCount="indefinite"/></g>`;
const CLOUD = (x = 0, y = 0, op = 1) => `<g transform="translate(${x} ${y})" opacity="${op}"><path d="M20 50h30a11 11 0 0 0 0-22 15 15 0 0 0-28.5 4A9 9 0 0 0 20 50z" fill="url(#cg)"/>
  <animateTransform attributeName="transform" type="translate" values="${x} ${y};${x + 2.5} ${y};${x} ${y}" dur="6s" repeatCount="indefinite"/></g>`;
const DEFS = `<defs><radialGradient id="sg"><stop offset="0" stop-color="#fff6c2"/><stop offset=".55" stop-color="#ffd23f"/><stop offset="1" stop-color="#ff9f1c"/></radialGradient>
  <linearGradient id="cg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4f7ff"/><stop offset="1" stop-color="#9aa8c4"/></linearGradient></defs>`;
const RAIN = `<g stroke="#5cb8ff" stroke-width="2.6" stroke-linecap="round">${[24, 34, 44].map((x, i) =>
  `<line x1="${x}" y1="54" x2="${x - 3}" y2="61"><animate attributeName="opacity" values="0;1;0" dur="1.1s" begin="${i * .3}s" repeatCount="indefinite"/></line>`).join("")}</g>`;
export function wxSVG(kind) {
  const body = {
    sun: SUN,
    partly: `<g transform="translate(-6 -6) scale(.9)">${SUN}</g>${CLOUD(4, 4)}`,
    cloud: `${CLOUD(-6, -6, .55)}${CLOUD(4, 2)}`,
    rain: `${CLOUD(0, -4)}${RAIN}`,
    storm: `${CLOUD(0, -4)}<path d="M33 46l-6 10h6l-3 8 10-12h-6l3-6z" fill="#ffd23f"/>`,
    fog: `${CLOUD(0, -6, .7)}<g stroke="#9aa8c4" stroke-width="3" stroke-linecap="round"><line x1="14" y1="52" x2="50" y2="52"/><line x1="18" y1="58" x2="46" y2="58"/></g>`,
  }[kind] || SUN;
  return `<svg viewBox="0 0 64 64" role="img" aria-label="${kind}">${DEFS}${body}</svg>`;
}
export const ICON = {
  drop: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11z"/></svg>`,
  wind: dir => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="transform:rotate(${(dir ?? 0) + 180}deg)"><path d="M12 3v18M12 3l-5 6M12 3l5 6"/></svg>`,
  rain: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 0 1 18 0z"/><path d="M12 12v7a2 2 0 0 1-4 0"/></svg>`,
  temp: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z"/></svg>`,
  flag: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 21V4h11l-1.5 4L16 12H5"/></svg>`,
  sc: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 16l2-6h14l2 6M5 16h14v3H5zM9 10V7h6v3"/></svg>`,
  pit: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 7l-5 5 5 5M5 4v16"/></svg>`,
  up: `<svg width="10" height="10" viewBox="0 0 10 10"><path d="M5 1l4 6H1z" fill="currentColor"/></svg>`,
  down: `<svg width="10" height="10" viewBox="0 0 10 10"><path d="M5 9l4-6H1z" fill="currentColor"/></svg>`,
};

/* cursor-following sheen + gentle tilt for glass cards */
export function glassify(el, tilt = 3) {
  el.addEventListener("pointermove", e => {
    const r = el.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    el.style.setProperty("--mx", (x * 100).toFixed(1) + "%");
    el.style.setProperty("--my", (y * 100).toFixed(1) + "%");
    if (tilt && matchMedia("(hover: hover)").matches) el.style.transform = `perspective(900px) rotateX(${((.5 - y) * tilt).toFixed(2)}deg) rotateY(${((x - .5) * tilt).toFixed(2)}deg)`;
  });
  el.addEventListener("pointerleave", () => { el.style.transform = ""; });
}

/* small line chart (positions by lap, inverted y) */
export function traceSVG(log, laps, maxPos = 12, colour = "#ffc906", fromLap = 0) {
  const W = 300, H = 90, pad = 4;
  const X = l => pad + (l - fromLap) / Math.max(laps - fromLap, 1) * (W - 2 * pad);
  const Y = p => pad + (Math.min(p, maxPos) - 1) / (maxPos - 1) * (H - 2 * pad);
  let d = "";
  log.laps.forEach((l, i) => { const p = log.pos[i]; if (p == null) return; d += (d ? "L" : "M") + X(l).toFixed(1) + "," + Y(p).toFixed(1); });
  const sc = log.laps.map((l, i) => log.status[i] >= 2 ? `<rect x="${X(l - 1).toFixed(1)}" y="0" width="${Math.max(X(l) - X(l - 1), 1).toFixed(1)}" height="${H}" fill="${log.status[i] === 3 ? "#ff3b55" : "#ffd21f"}" opacity=".22"/>` : log.status[i] === 1 ? `<rect x="${X(l - 1).toFixed(1)}" y="0" width="${Math.max(X(l) - X(l - 1), 1).toFixed(1)}" height="${H}" fill="#ffb020" opacity=".12"/>` : "").join("");
  const grid = [1, 3, 5, 10].filter(p => p <= maxPos).map(p => `<line x1="0" x2="${W}" y1="${Y(p)}" y2="${Y(p)}" stroke="rgba(255,255,255,.07)"/><text x="${W - 2}" y="${Math.max(Y(p) + 3, 9)}" text-anchor="end" font-size="8" fill="#6b7590" font-family="JetBrains Mono">P${p}</text>`).join("");
  const pits = log.pitLaps.map(l => `<circle cx="${X(l)}" cy="${H - 5}" r="3" fill="#fff"/>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="position by lap">${sc}${grid}<path d="${d}" fill="none" stroke="${colour}" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>${pits}</svg>`;
}
