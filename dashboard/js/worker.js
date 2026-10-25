/* Web Worker: evaluates a chunk of plans on `reps` races each (common random numbers). */
import { initialState, simulateRace, summarise } from "./engine.js";

self.onmessage = e => {
  const { id, cfg, field, state, plans, reps, repOffset = 0, record } = e.data;
  try {
    const st = initialState(cfg, field, state);
    const C = field.cars.length, out = [];
    for (let k = 0; k < plans.length; k++) {
      const res = new Array(reps);
      for (let r = 0; r < reps; r++) res[r] = simulateRace(cfg, field, st, plans[k], r + repOffset);
      const m = summarise(res, C);
      m.ev = [0, 1, 2, 3].map(v => { const sub = res.filter(x => x.ev === v); return { share: sub.length / reps, p_podium: sub.length ? sub.filter(x => x.pos && x.pos <= 3).length / sub.length : null }; });
      if (record) {
        // a representative race: median finishing position, then median gap
        const ok = res.map((x, i) => [x, i]).filter(([x]) => x.pos != null);
        if (ok.length) {
          const med = ok.map(([x]) => x.pos).sort((a, b) => a - b)[ok.length >> 1];
          const pick = ok.filter(([x]) => x.pos === med).sort((a, b) => a[0].gap - b[0].gap);
          m.trace = simulateRace(cfg, field, st, plans[k], pick[pick.length >> 1][1] + repOffset, true).log;
        }
      }
      out.push(m);
      if (k % 8 === 7) self.postMessage({ id, progress: (k + 1) / plans.length });
    }
    self.postMessage({ id, done: true, out });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.stack || err) });
  }
};
