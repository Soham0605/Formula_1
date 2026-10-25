/* Strategy search on a pool of Web Workers: staged screening, then top-3 with diversity. */
import { candidates, OBJECTIVES, pickTop3 } from "./engine.js";

let POOL = null;
function pool() {
  if (POOL) return POOL;
  const n = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));
  POOL = Array.from({ length: n }, () => new Worker(new URL("./worker.js", import.meta.url), { type: "module" }));
  return POOL;
}
let JOB = 0;
function runChunk(w, msg, onProgress) {
  return new Promise((resolve, reject) => {
    const id = ++JOB;
    const h = e => {
      if (e.data.id !== id) return;
      if (e.data.progress != null) { onProgress && onProgress(e.data.progress); return; }
      w.removeEventListener("message", h);
      e.data.error ? reject(new Error(e.data.error)) : resolve(e.data.out);
    };
    w.addEventListener("message", h);
    w.postMessage({ id, ...msg });
  });
}
/* Evaluate `plans` with `reps` races each, split across the pool. Returns metrics in plan order. */
export async function evaluate(cfg, field, state, plans, reps, onProgress, record = false) {
  const ws = pool(), n = ws.length, per = Math.ceil(plans.length / n), parts = [], prog = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const sub = plans.slice(i * per, (i + 1) * per);
    if (!sub.length) continue;
    parts.push(runChunk(ws[i], { cfg, field, state, plans: sub, reps, record }, p => {
      prog[i] = p * sub.length; onProgress && onProgress(prog.reduce((a, b) => a + b, 0) / plans.length);
    }));
  }
  return (await Promise.all(parts)).flat();
}

export const QUALITY = {
  fast: { s1: 12, s2: 80, s3: 400, keep1: 40, keep2: 10 },
  standard: { s1: 14, s2: 110, s3: 600, keep1: 50, keep2: 12 },
};

/* Full search. onStage(label, fraction 0..1) drives the loading screen. */
export async function search(cfg, field, state, opts = {}) {
  const q = QUALITY[opts.quality || "fast"], obj = OBJECTIVES[opts.objective || "points"];
  const all = candidates(cfg, state);
  if (!all.length) throw new Error("No legal strategy from this state (check tyre age / compounds used).");
  const t0 = performance.now(), stage = opts.onStage || (() => {});
  const run = async (plans, reps, a, b, label, record) => evaluate(cfg, field, state, plans, reps, p => stage(label, a + (b - a) * p), record);
  const r1 = await run(all, q.s1, 0.0, 0.35, `Screening ${all.length} plans`);
  let order = all.map((p, i) => [p, r1[i]]).sort((x, y) => obj.f(y[1]) - obj.f(x[1]));
  let keep = order.slice(0, q.keep1).map(x => x[0]);
  for (const n of new Set(all.map(p => p.n))) keep.push(...order.filter(x => x[0].n === n).slice(0, 4).map(x => x[0]));
  keep = [...new Set(keep)];
  const r2 = await run(keep, q.s2, 0.35, 0.65, `Refining ${keep.length} plans`);
  order = keep.map((p, i) => [p, r2[i]]).sort((x, y) => obj.f(y[1]) - obj.f(x[1]));
  let fin = order.slice(0, q.keep2).map(x => x[0]);
  for (const n of new Set(keep.map(p => p.n))) fin.push(...order.filter(x => x[0].n === n).slice(0, 2).map(x => x[0]));
  // the best plan of each distinct tyre sequence, so the final round can always offer three different calls
  const seen = new Set();
  for (const [p] of order) { const k = p.n + ":" + p.comps.join(""); if (!seen.has(k)) { seen.add(k); fin.push(p); } if (seen.size >= 8) break; }
  fin = [...new Set(fin)];
  const r3 = await run(fin, q.s3, 0.65, 1.0, `Final ${fin.length} plans × ${q.s3} races`, true);
  const ranked = fin.map((p, i) => ({ plan: p, m: r3[i] })).sort((x, y) => obj.f(y.m) - obj.f(x.m));
  const top = pickTop3(ranked, m => obj.f(m), opts.tol ?? obj.tol);
  return { top, ranked, n_candidates: all.length, races: all.length * q.s1 + keep.length * q.s2 + fin.length * q.s3,
    ms: performance.now() - t0, objective: opts.objective || "points" };
}
