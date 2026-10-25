/* Animated background: a full-screen shader of flowing "liquid metal" bands in team colours (three.js).
   Falls back to a CSS gradient if WebGL or the CDN is unavailable; static when reduced motion is requested. */
export async function startBackground(host) {
  const fallback = () => { host.style.background = "radial-gradient(1200px 700px at 70% -10%, #1b3a7a55, transparent 60%), radial-gradient(900px 600px at 0% 110%, #e8002d33, transparent 60%), #05070d"; };
  let THREE;
  try { THREE = await import("three"); } catch (e) { fallback(); return; }
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: "low-power" }); } catch (e) { fallback(); return; }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  host.append(renderer.domElement);
  const scene = new THREE.Scene(), cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const uni = { t: { value: 0 }, res: { value: new THREE.Vector2(1, 1) }, mouse: { value: new THREE.Vector2(.6, .4) }, energy: { value: 1.0 } };
  const mat = new THREE.ShaderMaterial({
    uniforms: uni,
    vertexShader: "void main(){ gl_Position = vec4(position.xy, 0., 1.); }",
    fragmentShader: `
      precision highp float; uniform float t; uniform vec2 res; uniform vec2 mouse; uniform float energy;
      float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float n(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
        return mix(mix(h(i),h(i+vec2(1,0)),f.x), mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x), f.y); }
      float fbm(vec2 p){ float v=0., a=.5; for(int i=0;i<5;i++){ v+=a*n(p); p=p*2.02+vec2(1.7,9.2); a*=.5; } return v; }
      void main(){
        vec2 uv = gl_FragCoord.xy / res; vec2 p = (gl_FragCoord.xy - .5*res) / res.y;
        float tt = t * .045;
        vec2 q = vec2(fbm(p*1.4 + tt), fbm(p*1.4 - tt + 3.1));
        vec2 r = vec2(fbm(p*1.8 + 2.*q + vec2(1.7, 9.2) + tt*1.3), fbm(p*1.8 + 2.*q + vec2(8.3, 2.8) - tt));
        float f = fbm(p*1.2 + 2.2*r);
        vec3 navy = vec3(.02,.035,.08), blue = vec3(.12,.25,.62), red = vec3(.85,.02,.18), gold = vec3(1.,.78,.08);
        vec3 c = mix(navy, blue, smoothstep(.35,.85,f));
        c = mix(c, red, smoothstep(.62,.95, r.x) * .55);
        c = mix(c, gold, smoothstep(.78,1., q.y*f*1.6) * .35);
        float streak = smoothstep(.0,.9, sin((p.x*2.6 - p.y*1.2 + f*2.5) * 6. - t*.35) * .5 + .5);
        c += vec3(.5,.6,1.) * pow(streak, 24.) * .10;
        float d = length(uv - mouse); c += vec3(.25,.35,.8) * exp(-d*d*9.) * .10;
        c *= .55 + .45 * smoothstep(1.25, .1, length(p));         // vignette
        c *= mix(.62, 1.0, energy);                                 // dim once the console is in use
        gl_FragColor = vec4(c, 1.);
      }`,
  });
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
  const resize = () => { const w = innerWidth, hh = innerHeight; renderer.setSize(w, hh, false); uni.res.value.set(w * renderer.getPixelRatio(), hh * renderer.getPixelRatio()); };
  resize(); addEventListener("resize", resize);
  addEventListener("pointermove", e => { uni.mouse.value.set(e.clientX / innerWidth, 1 - e.clientY / innerHeight); }, { passive: true });
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let last = performance.now(), visible = true;
  document.addEventListener("visibilitychange", () => { visible = !document.hidden; });
  const loop = now => {
    if (visible) { uni.t.value += Math.min(now - last, 50) / 1000 * (still ? 0 : 1); renderer.render(scene, cam); }
    last = now; requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  return { setEnergy: v => { uni.energy.value = v; } };
}
