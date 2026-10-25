/* Isometric F1 power-unit background.
 * Canvas 2D, anatomy-repo aesthetic: dark panels, precise edges, Red Bull accents.
 * Azimuth 45°, elevation 30° — same projection as wheresryan22/anatomy iso-kit.
 * Parts assemble from below over 5 s, then crankshaft + exhaust animate continuously.
 */

const AZ = Math.PI / 4;   // 45°
const EL = Math.PI / 6;   // 30°
const sinA = Math.sin(AZ), cosA = Math.cos(AZ);
const sinE = Math.sin(EL), cosE = Math.cos(EL);

function pr(x, y, z, cx, cy, k) {
  return [
    cx + (x * sinA - y * cosA) * k,
    cy + ((x * cosA + y * sinA) * sinE - z * cosE) * k,
  ];
}

function poly(ctx, pts, fill, stroke, lw = 0.6) {
  ctx.beginPath();
  ctx.moveTo(...pts[0]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(...pts[i]);
  ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
}

/* Draw one isometric box. dz = assembly offset (0 = in final position). */
function box(ctx, x, y, z, w, d, h, C, cx, cy, k, dz = 0) {
  const Z = z + dz;
  const p = (px, py, pz) => pr(px, py, pz, cx, cy, k);
  const ed = C.e || "rgba(255,255,255,0.06)";
  // Right face (drawn first so front + top paint over it)
  poly(ctx, [p(x+w,y,Z), p(x+w,y+d,Z), p(x+w,y+d,Z+h), p(x+w,y,Z+h)], C.r, ed);
  // Front face
  poly(ctx, [p(x,y,Z), p(x+w,y,Z), p(x+w,y,Z+h), p(x,y,Z+h)], C.f, ed);
  // Top face
  poly(ctx, [p(x,y,Z+h), p(x+w,y,Z+h), p(x+w,y+d,Z+h), p(x,y+d,Z+h)], C.t, ed);
}

/* Draw a cylinder approximation (octagonal prism). */
function cyl(ctx, cx2, cy2, cz, r, h, C, prj_cx, prj_cy, k, dz = 0) {
  const Z = cz + dz;
  const N = 8;
  const top = [], bot = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const px = cx2 + Math.cos(a) * r, py = cy2 + Math.sin(a) * r;
    top.push(pr(px, py, Z + h, prj_cx, prj_cy, k));
    bot.push(pr(px, py, Z, prj_cx, prj_cy, k));
  }
  // Sides
  for (let i = 0; i < N; i++) {
    const ni = (i + 1) % N;
    poly(ctx, [bot[i], bot[ni], top[ni], top[i]], C.r, C.e || "rgba(255,255,255,0.05)", 0.4);
  }
  // Top cap
  poly(ctx, top, C.t, C.e || "rgba(255,255,255,0.05)", 0.4);
}

const COLS = {
  blk:  { t: "#1e1e1e", f: "#141414", r: "#111111" },
  head: { t: "#262626", f: "#1a1a1a", r: "#171717" },
  pist: { t: "#2e2e2e", f: "#222222", r: "#1c1c1c", e: "rgba(255,255,255,0.1)" },
  pipe: { t: "#191919", f: "#111111", r: "#0e0e0e" },
  sump: { t: "#181818", f: "#101010", r: "#0d0d0d" },
  red:  { t: "rgba(232,0,45,0.38)", f: "rgba(232,0,45,0.18)", r: "rgba(232,0,45,0.12)", e: "rgba(232,0,45,0.2)" },
  gold: { t: "rgba(255,201,6,0.28)", f: "rgba(255,201,6,0.13)", r: "rgba(255,201,6,0.08)", e: "rgba(255,201,6,0.18)" },
  teal: { t: "rgba(47,168,255,0.22)", f: "rgba(47,168,255,0.11)", r: "rgba(47,168,255,0.07)", e: "rgba(47,168,255,0.12)" },
  hot:  { t: "rgba(255,100,30,0.35)", f: "rgba(255,60,10,0.18)", r: "rgba(200,40,5,0.12)", e: "rgba(255,80,20,0.25)" },
};

const ease = t => t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2,3)/2;

export function startIsoEngine(container) {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;opacity:.22;pointer-events:none;";
  container.appendChild(canvas);
  const ctx = canvas.getContext("2d");

  let W, H, k, cx, cy, raf, ro;
  const resize = () => {
    W = canvas.width = container.offsetWidth || innerWidth;
    H = canvas.height = container.offsetHeight || innerHeight;
    k  = Math.min(W, H) / 24;
    cx = W * 0.52;
    cy = H * 0.56;
  };
  resize();
  ro = new ResizeObserver(resize);
  ro.observe(container);

  const t0 = performance.now();
  const B = (x,y,z,w,d,h,C,dz=0) => box(ctx, x,y,z,w,d,h, C, cx,cy,k, dz);
  const CY = (x,y,z,r,h,C,dz=0) => cyl(ctx, x,y,z, r,h, C, cx,cy,k, dz);

  // Assembly easing: part arrives when progress > delay
  const asmDz = (asm, delay) => {
    const p = ease(Math.max(0, Math.min(1, (asm - delay) / Math.max(0.01, 1 - delay))));
    return (p - 1) * 5.5;  // starts 5.5 units below, ends at 0
  };

  function draw(now) {
    const elapsed = (now - t0) / 1000;
    const asm = Math.min(1, elapsed / 5);           // 5-second assembly
    const live = Math.max(0, elapsed - 5);           // animation after fully built
    const ang  = live * 2.4;                         // crankshaft angle
    const FIRE = [0, Math.PI, Math.PI/2, 3*Math.PI/2];

    ctx.clearRect(0, 0, W, H);

    // ── Oil sump / bedplate (bottom) ──────────────────────────────────────────
    const dz_sump = asmDz(asm, 0);
    B(-5.2, -2.2, -2.6, 10.4, 4.4, 0.7, COLS.sump, dz_sump);

    // ── Main engine block ─────────────────────────────────────────────────────
    const dz_blk = asmDz(asm, 0.04);
    B(-5, -2, -1.8, 10, 4, 2.5, COLS.blk, dz_blk);

    // Structural ribs on block
    for (let i = 0; i < 3; i++) {
      B(-5 + (i+1)*2.5, -2.1, -1.8, 0.22, 4.2, 2.2, COLS.pipe, dz_blk);
    }

    // Side window — crankshaft throw visible (right side face)
    if (live > 0) {
      const cr = 0.55, lobe_x = Math.sin(ang) * cr;
      const dz_cr = asmDz(asm, 0.04);
      // 4 crank lobes
      const lobe_y = [-1.2, -0.4, 0.4, 1.2];
      lobe_y.forEach((ly, i) => {
        const lx = Math.sin(ang + FIRE[i]) * cr;
        B(4.6 + lx * 0.35, ly - 0.2, -1.6 + Math.abs(lx)*0.15, 0.35, 0.4, 0.35, COLS.gold, dz_cr);
      });
    }

    // ── Cylinder heads (4 inline) ─────────────────────────────────────────────
    for (let i = 0; i < 4; i++) {
      const hx = -4 + i * 2.4;
      const dz_h = asmDz(asm, 0.1 + i * 0.04);
      B(hx - 0.1, -1.0, 0.7, 1.5, 2.0, 1.6, COLS.head, dz_h);
      // Bore rim detail
      B(hx, -0.85, 2.3, 1.3, 1.7, 0.18, COLS.pipe, dz_h);
      // Head bolt corners
      [[hx-0.05, -0.95],[hx+1.2, -0.95],[hx-0.05, 0.8],[hx+1.2, 0.8]].forEach(([bx, by]) => {
        B(bx, by, 2.3, 0.22, 0.22, 0.28, COLS.pist, dz_h);
      });
    }

    // ── Valve cover (Red Bull red accent stripe) ───────────────────────────────
    const dz_vc = asmDz(asm, 0.3);
    B(-4.7, -1.1, 2.48, 10.2, 2.2, 0.2, COLS.red, dz_vc);
    // Gold detail line on valve cover
    B(-4.4, -1.0, 2.68, 9.6, 0.15, 0.07, COLS.gold, dz_vc);

    // ── Pistons (animated crowns, visible above bore rim) ─────────────────────
    if (live > 0) {
      for (let i = 0; i < 4; i++) {
        const hx = -4 + i * 2.4;
        const pisZ = Math.sin(ang + FIRE[i]) * 0.3 + 1.55;
        B(hx + 0.1, -0.8, pisZ, 1.1, 1.6, 0.35, COLS.pist);
        // Piston top teal ring (crown)
        B(hx + 0.1, -0.8, pisZ + 0.35, 1.1, 1.6, 0.07, COLS.teal);
      }
    }

    // ── Intake plenum (top rear) ───────────────────────────────────────────────
    const dz_ip = asmDz(asm, 0.36);
    B(-4.4, -3.0, 2.7, 9.6, 1.0, 0.9, COLS.blk,  dz_ip);
    B(-4.2, -3.2, 3.6, 9.2, 0.5, 0.6, COLS.head, dz_ip);
    // Air inlet trumpet
    B(-2.5, -3.4, 4.2, 5.5, 0.6, 1.0, COLS.head, asmDz(asm, 0.42));
    B(-1.8, -3.5, 5.2, 4.0, 0.6, 0.7, COLS.blk,  asmDz(asm, 0.46));
    // Teal injection rail accents
    for (let i = 0; i < 4; i++) {
      B(-3.8 + i*2.3, -2.9, 2.7, 0.3, 0.8, 0.9, COLS.teal, dz_ip);
    }

    // ── Exhaust headers (front, y = 2) ────────────────────────────────────────
    const dz_ex = asmDz(asm, 0.26);
    for (let i = 0; i < 4; i++) {
      const ex = -3.6 + i * 2.4;
      B(ex, 2.1, -0.2, 0.8, 0.7, 1.2, COLS.pipe, dz_ex);
    }
    B(-4.0, 2.8, -0.2, 9.8, 0.5, 0.7, COLS.pipe, dz_ex);   // primary collector
    B(-4.2, 3.3, -0.2, 10.2, 0.4, 0.5, COLS.pipe, asmDz(asm, 0.32)); // secondary

    // Exhaust glow (heat after start)
    if (live > 1) {
      for (let i = 0; i < 4; i++) {
        const ex = -3.6 + i * 2.4;
        const pulse = Math.max(0, Math.sin(ang * 2 + FIRE[i])) * 0.7;
        ctx.globalAlpha = pulse * 0.25;
        B(ex, 2.1, -0.2, 0.8, 0.7, 1.2, COLS.hot);
        ctx.globalAlpha = 1;
      }
    }

    // ── Turbocharger (right, drawn late = visually in front) ──────────────────
    const dz_tc = asmDz(asm, 0.44);
    B(5.3, -1.8, -1.0, 2.2, 3.6, 3.2, COLS.blk,  dz_tc);
    B(5.4, -2.0,  2.2, 2.0, 4.0, 0.35, COLS.red,  dz_tc);  // compressor face
    B(5.5, -1.6,  1.1, 0.6, 0.5, 1.1, COLS.pipe, dz_tc);   // wastegate pipe
    // Intercooler pipe
    B(4.2, -2.8, 2.55, 1.4, 0.5, 0.4, COLS.teal, asmDz(asm, 0.5));
    B(2.8, -2.9, 2.65, 2.0, 0.4, 0.35, COLS.teal, asmDz(asm, 0.52));

    // Turbo compressor wheel hint (spinning circle)
    if (live > 0) {
      const angle = live * 8;
      const wcx = pr(6.4, 0, 0.8, cx, cy, k);
      ctx.save();
      ctx.translate(wcx[0], wcx[1]);
      ctx.rotate(angle);
      for (let b = 0; b < 7; b++) {
        const ba = (b / 7) * Math.PI * 2;
        ctx.fillStyle = "rgba(255,255,255,0.07)";
        ctx.fillRect(Math.cos(ba) * 5, Math.sin(ba) * 5, 6, 2);
      }
      ctx.restore();
    }

    // ── Gearbox (left, drawn late) ────────────────────────────────────────────
    const dz_gb = asmDz(asm, 0.38);
    B(-7.4, -2.0, -1.8, 2.6, 4.0, 3.4, COLS.blk,  dz_gb);
    B(-7.1, -2.2,  1.6, 2.0, 4.4, 0.28, COLS.gold, dz_gb); // selector plate
    B(-7.3, -2.1,  1.3, 2.4, 4.2, 0.14, COLS.blk,  dz_gb);
    // Driveshaft output
    B(-7.8, -0.9, -0.5, 0.7, 1.8, 0.7, COLS.blk,  asmDz(asm, 0.43));
    CY(-7.5, 0, 0.4, 0.5, 0.55, COLS.gold, asmDz(asm, 0.46));

    raf = requestAnimationFrame(draw);
  }

  raf = requestAnimationFrame(draw);

  return {
    stop() { cancelAnimationFrame(raf); ro.disconnect(); canvas.remove(); }
  };
}
