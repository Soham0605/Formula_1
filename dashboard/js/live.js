/* Live timing from OpenF1: rebuild the whole field at the end of a lap.
 *
 * Order and gaps   = time each car crossed the line to complete lap L (start of its lap L+1)
 * Tyres            = stints (compound, tyre age at fit, lap range) -> compound, age, stops, compounds used
 * Track status     = race-control SafetyCar / red-flag messages before the leader crossed
 * Retired          = no lap at or after L-1
 *
 * Access: OpenF1 is free for finished sessions. While a session is live it answers 401 to everyone without
 * a paid account, so a bearer token (1 h, from POST https://api.openf1.org/token) can be pasted in the console.
 * The token is kept in sessionStorage only; credentials never touch this page.
 */
import { GREEN, VSC, SC, RED } from "./engine.js";

const BASE = "https://api.openf1.org/v1";
const COMPOUND = { SOFT: 0, MEDIUM: 1, HARD: 2 };

export class LiveError extends Error { constructor(msg, code) { super(msg); this.code = code; } }

export function getToken() { try { return sessionStorage.getItem("openf1_token") || ""; } catch (e) { return ""; } }
export function setToken(t) { try { t ? sessionStorage.setItem("openf1_token", t.trim()) : sessionStorage.removeItem("openf1_token"); } catch (e) { /* blocked */ } }

/* Prefer the same-origin relay (serve.py) when present: no CORS, and it holds the OpenF1 login server-side. */
let RELAY = null;
async function relay() {
  if (RELAY !== null) return RELAY;
  try { const r = await fetch("api/state", { cache: "no-store" }); const d = r.ok ? await r.json() : null; RELAY = d && d.openf1_relay ? d : false; }
  catch (e) { RELAY = false; }
  return RELAY;
}
export async function liveSource() { const r = await relay(); return r ? (r.openf1_auth ? "relay (authenticated)" : "relay") : "direct"; }

async function api(path, params) {
  const rel = await relay();
  const url = `${rel ? "api/openf1" : BASE}/${path}?` + Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => `${encodeURIComponent(k).replace("%3E", ">").replace("%3C", "<")}=${encodeURIComponent(v)}`).join("&");
  const tok = getToken(), headers = tok ? { Authorization: `Bearer ${tok}` } : {};
  let r;
  try { r = await fetch(url, { headers: rel ? {} : headers, cache: "no-store" }); }
  catch (e) {
    throw new LiveError(rel ? "Relay unreachable." : "OpenF1 blocked the request. During a live session it refuses browsers outright; run serve.py with OPENF1_USERNAME / OPENF1_PASSWORD and open the console through it, or pull laps after the session ends.", "network");
  }
  if (r.status === 401) {
    let detail = ""; try { detail = (await r.json()).detail || ""; } catch (e) { /* ignore */ }
    if (rel) throw new LiveError(rel.openf1_auth ? "OpenF1 rejected the relay's login." : "OpenF1 locks data during live sessions: set OPENF1_USERNAME / OPENF1_PASSWORD before starting serve.py.", "auth");
    throw new LiveError(tok ? "OpenF1 rejected the token (expired? tokens last 1 hour)." :
      "OpenF1 locks all data while a session is live unless you have a paid account. Paste a token, or use replay after the session ends." + (detail ? ` (${detail.split(".")[0]}.)` : ""), "auth");
  }
  if (r.status === 404) return [];
  if (r.status === 429) throw new LiveError("OpenF1 rate limit hit; try again in a few seconds.", "rate");
  if (!r.ok) throw new LiveError(`OpenF1 HTTP ${r.status}`, "http");
  return r.json();
}

/* Laps completed by the race leader so far (live) or in total (replay). `from` limits the query to recent laps. */
export async function currentLap(sessionKey, from = 0) {
  const rows = await api("laps", { session_key: sessionKey, "lap_number>": Math.max(from, 1) });
  let mx = 0;
  for (const r of rows) if (r.date_start && r.lap_number > mx) mx = r.lap_number;
  return Math.max(0, mx - 1);   // the highest lap started minus one = laps completed by the leader
}

/* Field state at the end of lap L. grid: event grid rows (number, code). */
export async function fieldAtLap(sessionKey, L, grid) {
  const [laps, stints, rc] = await Promise.all([
    api("laps", { session_key: sessionKey, "lap_number>": Math.max(L - 2, 0), "lap_number<": L + 2 }),
    api("stints", { session_key: sessionKey }),
    api("race_control", { session_key: sessionKey }),
  ]);
  if (!laps.length) throw new LiveError(`No timing data for lap ${L} yet.`, "empty");
  const byNum = new Map();
  for (const r of laps) { if (!byNum.has(r.driver_number)) byNum.set(r.driver_number, []); byNum.get(r.driver_number).push(r); }
  const cross = num => {
    const rows = byNum.get(num) || [];
    const nxt = rows.find(r => r.lap_number === L + 1 && r.date_start);
    if (nxt) return Date.parse(nxt.date_start);
    const cur = rows.find(r => r.lap_number === L && r.date_start && r.lap_duration);
    return cur ? Date.parse(cur.date_start) + cur.lap_duration * 1000 : null;
  };
  const warnings = [], cars = {};
  const times = grid.map(g => ({ g, t: cross(g.number), seen: (byNum.get(g.number) || []).some(r => r.lap_number >= L - 1) }));
  const running = times.filter(x => x.t != null).sort((a, b) => a.t - b.t);
  if (!running.length) throw new LiveError(`Lap ${L} not completed yet.`, "empty");
  const t0 = running[0].t;
  running.forEach((x, i) => { cars[x.g.code] = { pos: i + 1, gap: (x.t - t0) / 1000 }; });
  let tail = running.length ? (running.at(-1).t - t0) / 1000 : 0;
  for (const x of times) {
    if (x.t != null) continue;
    if (x.seen) { tail += 2; cars[x.g.code] = { pos: Object.keys(cars).length + 1, gap: tail }; warnings.push(`${x.g.code}: lap ${L} time missing, placed at the back`); }
    else cars[x.g.code] = { out: true };
  }
  // tyres
  for (const g of grid) {
    const c = cars[g.code];
    if (!c || c.out) continue;
    const st = stints.filter(s => s.driver_number === g.number && s.lap_start != null && s.lap_start <= L + 1).sort((a, b) => a.stint_number - b.stint_number);
    if (!st.length) { warnings.push(`${g.code}: no stint data`); c.comp = 1; c.age = L; c.pits = 0; c.used = [1]; continue; }
    const cur = st.at(-1), comp = COMPOUND[cur.compound];
    if (comp == null) warnings.push(`${g.code}: on ${cur.compound} tyres (wet tyres are not modelled, treated as medium)`);
    c.comp = comp ?? 1;
    c.age = Math.max(0, (cur.tyre_age_at_start || 0) + Math.max(0, L + 1 - cur.lap_start));
    c.pits = st.length - 1;
    c.used = [...new Set(st.map(s => COMPOUND[s.compound]).filter(v => v != null))];
  }
  // track status at the moment the leader crossed
  let status = GREEN, left = 0;
  for (const m of rc.filter(m => Date.parse(m.date) <= t0).sort((a, b) => Date.parse(a.date) - Date.parse(b.date))) {
    const msg = (m.message || "").toUpperCase();
    if (m.category === "SafetyCar") {
      if (msg.includes("VSC DEPLOYED") || msg.includes("VIRTUAL SAFETY CAR DEPLOYED")) { status = VSC; left = 2; }
      else if (msg.includes("VSC ENDING") || msg.includes("VIRTUAL SAFETY CAR ENDING")) { status = GREEN; left = 0; }
      else if (msg.includes("SAFETY CAR DEPLOYED")) { status = SC; left = 3; }
      else if (msg.includes("IN THIS LAP")) { status = SC; left = 1; }
    } else if (m.flag === "RED") { status = RED; left = 1; }
    else if (m.flag === "GREEN" && status === RED) { status = GREEN; left = 0; }
    else if (m.flag === "CHEQUERED") { status = GREEN; left = 0; }
  }
  if (status === SC && rc.some(m => Date.parse(m.date) <= t0 && /IN THIS LAP/i.test(m.message || "") && Date.parse(m.date) > t0 - 150000)) left = 1;
  return { lap: L, cars, status, statusLeft: left, leaderTime: new Date(t0).toISOString(), warnings };
}
