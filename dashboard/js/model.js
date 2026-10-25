/* Turns the event bundle + live weather into simulator inputs, and evaluates the statistical finish model. */

/* Parameters with provenance. "sourced" = from data/APIs; "calibrated" = fitted to a real number;
   "assumed" = engineering prior (Barcelona study priors rescaled to COTA's 18 % longer lap). */
export function buildConfig(ev, opts = {}) {
  const laps = ev.meta.laps, pole = ev.grid.length ? Math.min(...ev.grid.map(g => g.best_s).filter(Boolean)) : 94.0;
  const pit = ev.track?.pit_loss || { normal: 21.0, sc: 13.5, vsc: 14.5 };
  const inc = ev.incidents?.per_lap || {};
  const hScLap1 = 0.03;
  const cfg = {
    seed: opts.seed ?? 2026, laps,
    baseLap: pole + 5.0,            // assumed race-mode offset (fresh soft, zero fuel, clean air)
    startLoss: 4.5, outlapPen: 1.0, lapSigma: 0.16, paceSigma: 0.05, degkSigma: 0.08,
    startGap: 0.25, startNoise: 0.30,
    fuel0: 92, burn: 92 / laps * 0.985, fuelK: 0.038, // model: same race distance as Barcelona (~309 km)
    compOff: [0, 0.65, 1.30], wearLin: [0.10, 0.065, 0.042], wearCliff: [9, 15, 24], wearQuad: [0.035, 0.021, 0.013],
    maxLife: [19, 28, 38], minStint: 5, degScale: opts.degScale ?? 1.0,
    tempBase: [104, 99, 94], tempTrackK: 0.55, refTrack: 40, thermalK: 0.05, tempDirty: 5, wearDirty: 0.25, winLo: 86, winHi: 108,
    airC: opts.airC ?? 27, trackOffset: opts.trackOffset ?? 12,
    pitLoss: pit.normal, scPit: pit.sc, vscPit: pit.vsc, pitSigma: 0.5, slowP: 0.04,
    zone: 1.2, followGap: 0.6, passDelta: opts.passDelta ?? 0.55, passScale: 0.30, passCost: 0.25,
    hScLap1, hSc: Math.max((inc.sc ?? 0.01) - hScLap1 / laps, 0.002) * (opts.scMult ?? 1),
    hVsc: (inc.vsc ?? 0.01) * (opts.scMult ?? 1), hRed: Math.max(inc.red ?? 0, 0.0005) * (opts.scMult ?? 1),
    scLap: (pole + 5) * 1.40, vscLap: (pole + 5) * 1.30, scGap: 0.9, redGap: 0.5,
    scWear: 0.30, vscWear: 0.60, scFuel: 0.50, vscFuel: 0.75, reactMinAge: 8, reactAI: 0.75,
    uncDeg: 0.15, uncPit: 1.0, uncPass: 0.12, uncHaz: 0.35,
  };
  cfg.provenance = {
    "Laps, length, compounds C2/C3/C4": "sourced", "Pit loss green / SC / VSC": "sourced",
    "SC & VSC rate (2026 season + COTA 2023-25)": "sourced", "Retirement rate per team (2026)": "sourced",
    "Grid and pace gaps (qualifying)": "sourced", "Air temperature (forecast)": "sourced",
    "Race-mode offset, fuel effect": "assumed", "Tyre wear and cliff": "assumed", "Overtaking threshold": "assumed",
    "Track temp = air + offset": "assumed",
  };
  return cfg;
}

/* Field: car 0 is our driver; the rest in qualifying order. pace = s/lap slower than the pole car. */
export function buildField(ev, ourId, archetypes, opts = {}) {
  const retire = ev.retirement?.by_team || {}, prior = ev.retirement?.prior ?? 0.15;
  const grid = opts.grid || ev.grid;
  const us = grid.find(g => g.driver_id === ourId);
  const order = [us, ...grid.filter(g => g !== us)];
  const cars = order.map(g => ({
    code: g.code, name: g.name, team: g.team, team_id: g.team_id, colour: g.colour || "#888", grid: g.pos,
    pace: 0.85 * (g.gap_s ?? 1.5) + (opts.paceAdj?.[g.team_id] || 0),
    pdnf: (opts.dnfOverride?.[g.code] ?? retire[g.team_id] ?? prior) * (opts.dnfMult ?? 1),
  }));
  if (opts.startPos && opts.startPos !== us.pos) {
    // move our car to another start slot; everyone else shifts
    const others = cars.slice(1).sort((a, b) => a.grid - b.grid);
    others.forEach((c, i) => { c.grid = i + 1 >= opts.startPos ? i + 2 : i + 1; });
    cars[0].grid = opts.startPos;
  }
  return { cars, archetypes };
}

/* Ordered-logit finish model (train_finish_model.py). x = feature vector in model order. */
export function finishProbs(model, x) {
  const eta = model.beta.reduce((s, b, i) => s + b * x[i], 0);
  const cdf = model.theta.map(t => 1 / (1 + Math.exp(-(t - eta))));
  cdf.push(1);
  return cdf.map((c, i) => c - (i ? cdf[i - 1] : 0));
}
export function driverFeatures(model, id, startPos) {
  const f = model.target.drivers[id];
  if (!f) return null;
  const g = startPos || f.grid;
  return model.features.map(k => (k === "log_grid" ? Math.log(g) : f[k]));
}

/* Hourly forecast for race day, live from Open-Meteo (CORS-enabled), with the bundled snapshot as fallback. */
export async function loadWeather(ev) {
  const { lat, lon, tz, race_utc } = ev.meta, day = race_utc.slice(0, 10);
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&start_date=${day}&end_date=${day}` +
    `&timezone=${encodeURIComponent(tz)}&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,` +
    `precipitation_probability,precipitation,weather_code,cloud_cover`;
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    const d = await r.json();
    return { live: true, retrieved_at: new Date().toISOString(), hourly: d.hourly, source: "Open-Meteo (live)" };
  } catch (e) {
    if (ev.weather_snapshot) return { live: false, ...ev.weather_snapshot, source: "Open-Meteo snapshot (offline)" };
    return null;
  }
}
export function weatherAt(wx, iso) {
  if (!wx) return null;
  const h = wx.hourly, local = iso.slice(0, 13);
  let i = h.time.findIndex(t => t.slice(0, 13) === local);
  if (i < 0) i = 0;
  return { i, temp: h.temperature_2m[i], rh: h.relative_humidity_2m[i], wind: h.wind_speed_10m[i], dir: h.wind_direction_10m?.[i],
    rain: h.precipitation_probability[i], code: h.weather_code[i], cloud: h.cloud_cover[i] };
}
/* WMO weather code -> icon key */
export function wxKind(code, cloud) {
  if (code >= 95) return "storm";
  if (code >= 51) return "rain";
  if (code >= 45 && code <= 48) return "fog";
  if (code === 0 || cloud < 20) return "sun";
  if (code <= 2 || cloud < 60) return "partly";
  return "cloud";
}
