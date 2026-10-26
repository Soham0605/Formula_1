/* Season record: load actual results, compare with localStorage predictions. */
import { h } from "./ui.js";
import { COMP } from "./engine.js";

const PRED_KEY = (season, round, driverId, obj = "points") =>
  `pitwall:pred:v1:${season}:${round}:${driverId}:${obj}`;

function loadPred(season, round, driverId) {
  for (const obj of ["points", "position", "win"]) {
    try {
      const v = localStorage.getItem(PRED_KEY(season, round, driverId, obj));
      if (v) return JSON.parse(v);
    } catch { /* storage unavailable */ }
  }
  return null;
}

function posArrow(delta) {
  if (delta < 0) return `<span class="pos-up">▲${Math.abs(delta)}</span>`;
  if (delta > 0) return `<span class="pos-down">▼${delta}</span>`;
  return `<span class="pos-eq">=</span>`;
}

function stratStr(strategy) {
  if (!strategy) return "—";
  const c = (strategy.compounds || []).join("→");
  const stops = (strategy.stop_laps || []).map(l => `L${l}`).join(", ");
  return stops ? `${c} (${stops})` : c;
}

function eventBadges(events) {
  if (!events?.length) return `<span class="ev-badge green">Clean</span>`;
  return events.map(ev => {
    const cls = ev.type === "RED" ? "red" : ev.type === "SC" ? "sc" : "vsc";
    const span = ev.end_lap && ev.end_lap !== ev.lap ? `L${ev.lap}-${ev.end_lap}` : `L${ev.lap}`;
    return `<span class="ev-badge ${cls}">${ev.type} ${span}</span>`;
  }).join(" ");
}

function driverName(driverId) {
  return { max_verstappen: "Verstappen", hadjar: "Hadjar" }[driverId] || driverId;
}

function renderRaceRow(actual, pred, driverId) {
  const drv = actual.drivers[driverId];
  if (!drv) return "";
  const qPos = drv.qualifying_pos;
  const aPos = drv.finish_pos;
  const hasPred = !!pred;
  const pPos = pred ? pred.e_pos : null;
  const pMode = pred ? pred.mode_pos : null;
  const errRaw = (hasPred && pPos != null && aPos != null) ? (aPos - pPos) : null;
  const err = errRaw != null ? errRaw.toFixed(1) : null;
  const errCls = err == null ? "" : Math.abs(errRaw) <= 1 ? "acc-good" : Math.abs(errRaw) <= 2.5 ? "acc-ok" : "acc-bad";

  return `
  <tr class="rec-driver-row">
    <td><span class="rec-code">${drv.code}</span> ${driverName(driverId)}</td>
    <td class="num center">P${qPos}</td>
    <td class="center">${hasPred
      ? `<span class="num">P${pMode}</span><small class="dim"> avg P${Number(pPos).toFixed(1)}</small>`
      : `<span class="dim">—</span>`
    }</td>
    <td class="num center ${aPos <= 3 ? "pod-cell" : ""}">P${aPos ?? "DNF"}</td>
    <td class="center ${errCls}">${err != null ? (errRaw >= 0 ? "+" : "") + err : "—"}</td>
    <td class="rec-strat">${hasPred ? stratStr(pred?.top_strategy) : "—"}</td>
    <td class="rec-strat">${stratStr(drv.strategy)}</td>
    <td class="num center">${drv.points}</td>
  </tr>`;
}

function renderRaceCard(actual) {
  const drivers = Object.keys(actual.drivers);
  const preds = Object.fromEntries(drivers.map(id => [id, loadPred(actual.season, actual.round, id)]));
  const anyPred = drivers.some(id => preds[id]);
  const events = actual.race_events || [];

  return h("div", { class: "glass rec-race", html: `
    <div class="rec-head">
      <span class="rec-rd">R${actual.round}</span>
      <span class="rec-name">${actual.race_name.replace("Grand Prix", "GP")}</span>
      <span class="rec-winner">Winner: <b>${actual.winner?.code ?? "—"}</b></span>
      <span class="rec-events">${eventBadges(events)}</span>
    </div>
    <div class="rec-table-wrap">
      <table class="rec-table">
        <thead>
          <tr>
            <th>Driver</th><th>Q</th>
            <th>Predicted${!anyPred ? " <span class='dim' title='Run pre-race analysis to save predictions'>?</span>" : ""}</th>
            <th>Actual</th><th>Error</th>
            <th>Pred strategy</th><th>Actual strategy</th><th>Pts</th>
          </tr>
        </thead>
        <tbody>
          ${drivers.map(id => renderRaceRow(actual, preds[id], id)).join("")}
        </tbody>
      </table>
    </div>
    ${!anyPred ? `<p class="rec-no-pred">No prediction saved for this race. Run the pre-race strategy analysis before the next race to build your record.</p>` : ""}
  `});
}

function seasonStats(races) {
  const rows = [];
  for (const actual of races) {
    for (const [dId, drv] of Object.entries(actual.drivers)) {
      const pred = loadPred(actual.season, actual.round, dId);
      if (!pred || drv.finish_pos == null) continue;
      const err = drv.finish_pos - pred.e_pos;
      rows.push({ driver: dId, code: drv.code, round: actual.round, err, predMode: pred.mode_pos, actual: drv.finish_pos });
    }
  }
  if (!rows.length) return null;
  const mae = rows.reduce((s, r) => s + Math.abs(r.err), 0) / rows.length;
  const exact = rows.filter(r => r.actual === r.predMode).length;
  return { mae, exact, total: rows.length, rows };
}

export async function loadSeasonTracker(season, container, asideEl) {
  container.innerHTML = `<p class="dim" style="padding:20px">Loading season record…</p>`;
  let idx;
  try {
    const r = await fetch(`data/actuals/season_${season}.json`, { cache: "no-store" });
    if (!r.ok) throw new Error("no season index");
    idx = await r.json();
  } catch {
    container.innerHTML = `<p class="dim" style="padding:20px">No season record yet. Run <code>python fetch_actual.py --round N</code> after each race.</p>`;
    return;
  }

  const actuals = [];
  await Promise.all(idx.races.map(async entry => {
    try {
      const r = await fetch(`data/actuals/${entry.file}`, { cache: "no-store" });
      if (r.ok) actuals.push(await r.json());
    } catch { /* skip missing file */ }
  }));
  actuals.sort((a, b) => a.round - b.round);

  if (!actuals.length) {
    container.innerHTML = `<p class="dim" style="padding:20px">Season index exists but race files are missing.</p>`;
    return;
  }

  const stats = seasonStats(actuals);
  container.innerHTML = "";

  if (stats) {
    const bar = h("div", { class: "rec-stats glass", html: `
      <div class="rec-stat"><b class="num">${stats.mae.toFixed(2)}</b><small>avg position error</small></div>
      <div class="rec-stat"><b class="num">${stats.exact}/${stats.total}</b><small>exact mode hit</small></div>
      <div class="rec-stat"><b class="num">${stats.total}</b><small>predictions logged</small></div>
      <div class="rec-note dim">Lower avg error = better model; a P1/P2 driver has a natural floor around 1-2 positions.</div>
    ` });
    container.append(bar);
  }

  for (const actual of actuals) {
    container.append(renderRaceCard(actual));
  }

  if (asideEl) asideEl.textContent = `${actuals.length} race${actuals.length !== 1 ? "s" : ""} tracked · ${season} season`;
}

export function savePrediction(meta, driverId, objective, grid, res, blendStats, bestPlan) {
  try {
    const key = PRED_KEY(meta.season, meta.round, driverId, objective);
    const pred = {
      season: meta.season,
      round: meta.round,
      slug: meta.slug,
      driver_id: driverId,
      qualifying_pos: grid,
      predicted_at: new Date().toISOString(),
      objective,
      e_pos: +blendStats.e.toFixed(2),
      e_points: +bestPlan.m.e_points.toFixed(2),
      p_win: +blendStats.win.toFixed(3),
      p_podium: +blendStats.pod.toFixed(3),
      p_dnf: +blendStats.dnf.toFixed(3),
      mode_pos: blendStats.mode,
      top_strategy: {
        compounds: bestPlan.plan.comps.map(c => COMP[c]),
        stop_laps: [...bestPlan.plan.stops],
        n_stops: bestPlan.plan.n,
      },
    };
    localStorage.setItem(key, JSON.stringify(pred));
  } catch { /* storage full or blocked */ }
}
