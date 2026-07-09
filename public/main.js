/**
 * Brand Solar System — a realistic 3D visualization of a company's presence
 * across the internet.
 *
 * VISUAL CODEX (all mappings are data-driven):
 *   SUN size + glow        = overall popularity
 *   SUN color temperature  = overall sentiment (red = hostile, white-hot = loved)
 *   ORBIT distance         = discussion heat (most active platforms orbit closest — and are drier)
 *   PLANET size            = reach (followers / views, log scale)
 *   PLANET type            = gas giant (massive reach), lava/desert (hot+dry inner),
 *                            terran/ocean (water = positive sentiment), ice (calm outer)
 *   RINGS                  = top-3 platforms by topic diversity
 *   MOONS                  = dominant keywords
 *   CITY LIGHTS            = high absolute engagement (night side)
 *   SATELLITES             = very active platform (artificial constellation)
 *   SHIPS                  = live traffic arriving from deep space
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { buildUniverse, slugify, whoami, DEFAULT_API_BASE, API_BASES } from "./pipeline.js";
import { beginConnect, completeConnect, connected, disconnect, accessToken, userInfo, configureOAuth } from "./oauth.js";

// Stage defaults to production. The local dev server may expose ./env.json
// with a different stage; the file 404s on static hosting, so deployed
// sites always run against prod.
let API_BASE = DEFAULT_API_BASE;
try {
  const cfg = await fetch("./env.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (cfg?.STAGE && API_BASES[cfg.STAGE]) {
    API_BASE = API_BASES[cfg.STAGE];
    configureOAuth({ stage: cfg.STAGE });
  }
} catch { /* static hosting */ }
const WALLET_URL = "https://app.monid.ai/wallet";

// low-power mode: half pixel ratio + 30fps cap (persisted)
const LOW_POWER = localStorage.getItem("lowPower") === "1";

// --------------------------------------------------------------- utilities
const fmt = (n) => {
  if (n == null) return "—";
  if (typeof n !== "number") return String(n);
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(Math.round(n * 10) / 10);
};
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// simple tileable-ish value noise (edge-blended later)
function makeFbm(seed) {
  const rnd = mulberry32(seed);
  const N = 64;
  const grid = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) grid[i] = rnd();
  const g = (x, y) => grid[((y % N + N) % N) * N + ((x % N + N) % N)];
  const smooth = (t) => t * t * (3 - 2 * t);
  const noise = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = smooth(x - xi), yf = smooth(y - yi);
    const a = g(xi, yi), b = g(xi + 1, yi), c = g(xi, yi + 1), d = g(xi + 1, yi + 1);
    return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
  };
  return (x, y, oct = 4, lac = 2.1, gain = 0.5) => {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < oct; o++) {
      sum += amp * noise(x * freq, y * freq);
      norm += amp; amp *= gain; freq *= lac;
    }
    return sum / norm;
  };
}

function canvasTexture(w, h, draw) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  draw(c.getContext("2d"), w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const glowTex = canvasTexture(256, 256, (ctx, s) => {
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.25, "rgba(255,255,255,0.5)");
  g.addColorStop(0.6, "rgba(255,255,255,0.1)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
});

// sun corona: exponential falloff — no visible banding, fades out fast
const coronaTex = canvasTexture(512, 512, (ctx, s) => {
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    const a = Math.exp(-t * 6.5) * (1 - t); // bright core, quick smooth tail
    g.addColorStop(t, `rgba(255,255,255,${a.toFixed(4)})`);
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
});

// -------------------------------------------------- procedural planet skins
const P = {
  lava:   { deep: [26, 16, 18],  low: [58, 38, 34],   high: [96, 70, 58],  accent: [255, 96, 20] },
  desert: { deep: [92, 62, 38],  low: [146, 104, 62], high: [196, 158, 108], accent: [120, 82, 50] },
  barren: { deep: [58, 55, 54],  low: [96, 92, 90],   high: [142, 138, 134], accent: [70, 66, 64] },
  ice:    { deep: [136, 158, 178], low: [186, 205, 220], high: [235, 242, 248], accent: [160, 190, 215] },
};

function blendSeam(ctx, w, h) {
  // soften the horizontal wrap seam
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const B = 10;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < B; x++) {
      const k = x / B;
      const i0 = (y * w + x) * 4, i1 = (y * w + (w - 1 - x)) * 4;
      for (let c = 0; c < 3; c++) {
        const avg = (d[i0 + c] + d[i1 + c]) / 2;
        d[i0 + c] = d[i0 + c] * k + avg * (1 - k);
        d[i1 + c] = d[i1 + c] * k + avg * (1 - k);
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

function rockySkin(seed, palette, { craters = 14, cracks = 0, cities = 0 } = {}) {
  const fbm = makeFbm(seed);
  const rnd = mulberry32(seed ^ 0x9e3779b9);
  const W = 512, H = 256;
  const cityPts = [];
  const map = canvasTexture(W, H, (ctx, w, h) => {
    const img = ctx.createImageData(w, h);
    const d = img.data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const n = fbm(x / 46, y / 46, 5);
        const n2 = fbm(x / 12 + 40, y / 12 + 40, 3);
        const v = clamp(n * 0.75 + n2 * 0.25, 0, 1);
        const c = v < 0.42 ? palette.deep : v < 0.62 ? palette.low : palette.high;
        const shade = 0.82 + v * 0.3;
        const i = (y * w + x) * 4;
        d[i] = c[0] * shade; d[i + 1] = c[1] * shade; d[i + 2] = c[2] * shade; d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    // craters
    for (let i = 0; i < craters; i++) {
      const cx = rnd() * w, cy = h * (0.12 + rnd() * 0.76), r = 3 + rnd() * 13;
      const g = ctx.createRadialGradient(cx, cy, r * 0.2, cx, cy, r);
      g.addColorStop(0, "rgba(0,0,0,0.34)");
      g.addColorStop(0.75, "rgba(0,0,0,0.13)");
      g.addColorStop(0.9, "rgba(255,255,255,0.12)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fill();
    }
    // lava cracks
    for (let i = 0; i < cracks; i++) {
      let x = rnd() * w, y = rnd() * h;
      ctx.strokeStyle = `rgba(255,${90 + rnd() * 70 | 0},20,${0.5 + rnd() * 0.4})`;
      ctx.lineWidth = 0.8 + rnd() * 1.4;
      ctx.beginPath(); ctx.moveTo(x, y);
      for (let s = 0; s < 22; s++) { x += (rnd() - 0.5) * 26; y += (rnd() - 0.5) * 12; ctx.lineTo(x, y); }
      ctx.stroke();
    }
    blendSeam(ctx, w, h);
  });
  let emissiveMap = null;
  if (cracks || cities) {
    emissiveMap = canvasTexture(W, H, (ctx, w, h) => {
      ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, h);
      const r2 = mulberry32(seed ^ 0x51ab);
      for (let i = 0; i < cracks; i++) {
        let x = r2() * w, y = r2() * h;
        ctx.strokeStyle = `rgba(255,${70 + r2() * 80 | 0},15,${0.7 + r2() * 0.3})`;
        ctx.lineWidth = 1 + r2() * 1.6;
        ctx.beginPath(); ctx.moveTo(x, y);
        for (let s = 0; s < 22; s++) { x += (r2() - 0.5) * 26; y += (r2() - 0.5) * 12; ctx.lineTo(x, y); }
        ctx.stroke();
      }
      for (let i = 0; i < cities; i++) {
        // city clusters
        const cx = r2() * w, cy = h * (0.2 + r2() * 0.6);
        for (let j = 0; j < 26; j++) {
          const a = r2() * Math.PI * 2, rr = r2() * r2() * 15;
          ctx.fillStyle = `rgba(255,214,140,${0.35 + r2() * 0.55})`;
          ctx.fillRect(cx + Math.cos(a) * rr * 1.6, cy + Math.sin(a) * rr, 1.1, 1.1);
        }
      }
    });
  }
  return { map, emissiveMap };
}

function terranSkin(seed, water, { cities = 0 } = {}) {
  const fbm = makeFbm(seed);
  const W = 512, H = 256;
  const landMask = new Uint8Array(W * H);
  const map = canvasTexture(W, H, (ctx, w, h) => {
    const img = ctx.createImageData(w, h);
    const d = img.data;
    const sea = clamp(water, 0.12, 0.88);
    for (let y = 0; y < h; y++) {
      const lat = Math.abs(y / h - 0.5) * 2; // 0 equator → 1 pole
      for (let x = 0; x < w; x++) {
        const e = fbm(x / 58, y / 58, 5) * 0.72 + fbm(x / 15 + 90, y / 15 + 90, 3) * 0.28;
        const i = (y * w + x) * 4;
        let r, g, b;
        if (e < sea) {
          const depth = clamp((sea - e) / sea, 0, 1);
          r = 12 + 30 * (1 - depth); g = 48 + 60 * (1 - depth); b = 96 + 80 * (1 - depth);
        } else {
          const alt = clamp((e - sea) / (1 - sea), 0, 1);
          landMask[y * w + x] = 1;
          if (alt < 0.28) { r = 70; g = 112; b = 58; }          // lowland green
          else if (alt < 0.6) { r = 116; g = 118; b = 66; }     // plains
          else if (alt < 0.85) { r = 128; g = 102; b = 72; }    // highlands
          else { r = 220; g = 218; b = 214; }                   // peaks
          const rough = fbm(x / 6 + 300, y / 6 + 300, 2);
          r *= 0.85 + rough * 0.3; g *= 0.85 + rough * 0.3; b *= 0.85 + rough * 0.3;
        }
        // polar caps
        const cap = clamp((lat - 0.78) / 0.16, 0, 1);
        r = r * (1 - cap) + 238 * cap; g = g * (1 - cap) + 244 * cap; b = b * (1 - cap) + 250 * cap;
        d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    blendSeam(ctx, w, h);
  });
  let emissiveMap = null;
  if (cities) {
    emissiveMap = canvasTexture(W, H, (ctx, w, h) => {
      ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, h);
      const r2 = mulberry32(seed ^ 0xc17);
      let placed = 0, guard = 0;
      while (placed < cities && guard++ < cities * 40) {
        const cx = (r2() * w) | 0, cy = (h * (0.15 + r2() * 0.7)) | 0;
        if (!landMask[cy * w + cx]) continue;
        placed++;
        for (let j = 0; j < 34; j++) {
          const a = r2() * Math.PI * 2, rr = r2() * r2() * 13;
          const px = cx + Math.cos(a) * rr * 1.7, py = cy + Math.sin(a) * rr;
          if (landMask[(py | 0) * w + (px | 0)]) {
            ctx.fillStyle = `rgba(255,208,130,${0.3 + r2() * 0.6})`;
            ctx.fillRect(px, py, 1.1, 1.1);
          }
        }
      }
    });
  }
  return { map, emissiveMap };
}

function gasSkin(seed, tintHex) {
  const fbm = makeFbm(seed);
  const rnd = mulberry32(seed ^ 0x77);
  const tint = new THREE.Color(tintHex);
  const W = 512, H = 256;
  const map = canvasTexture(W, H, (ctx, w, h) => {
    const img = ctx.createImageData(w, h);
    const d = img.data;
    // muted band palette derived from the source color
    const hsl = {}; tint.getHSL(hsl);
    const bands = [];
    for (let i = 0; i < 7; i++) {
      const c = new THREE.Color().setHSL(hsl.h + (rnd() - 0.5) * 0.07, 0.16 + rnd() * 0.2, 0.42 + rnd() * 0.3);
      bands.push([c.r * 255, c.g * 255, c.b * 255]);
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const turb = fbm(x / 34, y / 22, 4) * 26;
        const bandIdx = Math.abs(Math.floor(((y + turb) / h) * bands.length * 1.6)) % bands.length;
        const c = bands[bandIdx];
        const streak = 0.86 + fbm(x / 90, y / 7 + 50, 3) * 0.28;
        const i = (y * w + x) * 4;
        d[i] = c[0] * streak; d[i + 1] = c[1] * streak; d[i + 2] = c[2] * streak; d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    // great storm oval
    const sx = rnd() * w, sy = h * (0.32 + rnd() * 0.36);
    const grad = ctx.createRadialGradient(sx, sy, 1, sx, sy, 26);
    grad.addColorStop(0, "rgba(255,235,215,0.55)");
    grad.addColorStop(0.55, "rgba(200,150,120,0.28)");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grad;
    ctx.save(); ctx.translate(sx, sy); ctx.scale(1.8, 1); ctx.translate(-sx, -sy);
    ctx.beginPath(); ctx.arc(sx, sy, 26, 0, 7); ctx.fill(); ctx.restore();
    blendSeam(ctx, w, h);
  });
  return { map };
}

function cloudSkin(seed, coverage = 0.5) {
  const fbm = makeFbm(seed ^ 0xabcd);
  return canvasTexture(512, 256, (ctx, w, h) => {
    const img = ctx.createImageData(w, h);
    const d = img.data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const n = fbm(x / 40, y / 26, 5);
        const a = clamp((n - (1 - coverage * 0.72)) * 3.2, 0, 1);
        const i = (y * w + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = 255;
        d[i + 3] = a * 210;
      }
    }
    ctx.putImageData(img, 0, 0);
  });
}

function moonSkin(seed) {
  return rockySkin(seed, P.barren, { craters: 22 }).map;
}

// ------------------------------------------------------------------- scene
const canvas = document.getElementById("scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
// clamp: full retina (2x) quadruples the pixels pushed through bloom — the
// main GPU/fan cost. 1.5 is visually indistinguishable at these contrasts.
renderer.setPixelRatio(LOW_POWER ? 1 : Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.1, 6000);
camera.position.set(0, 120, 260);

const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(innerWidth, innerHeight);
document.getElementById("labels").appendChild(labelRenderer.domElement);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.045;
controls.rotateSpeed = 0.55;
controls.zoomSpeed = 0.9;
controls.minDistance = 6;
controls.maxDistance = 1400;

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
// bloom at half resolution: the blur pyramid doesn't need full-res input
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth / 2, innerHeight / 2), 0.7, 0.62, 0.32);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// low ambient so night sides stay dark but planets remain readable
scene.add(new THREE.AmbientLight(0x445577, 0.42));
const fill = new THREE.HemisphereLight(0x35476b, 0x0c0c14, 0.26);
scene.add(fill);

// ------------------------------------------------- deep sky: milky way etc
function makeStars(count, spread, size, opacity, tint) {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(rand(spread * 0.4, spread));
    pos.set([v.x, v.y, v.z], i * 3);
    c.setHSL(tint + rand(-0.09, 0.09), rand(0.05, 0.5), rand(0.5, 0.95));
    col.set([c.r, c.g, c.b], i * 3);
  }
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return new THREE.Points(g, new THREE.PointsMaterial({
    size, map: glowTex, vertexColors: true, transparent: true, opacity,
    depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
  }));
}
scene.add(makeStars(3800, 2400, 2.4, 0.8, 0.6));
scene.add(makeStars(2000, 1800, 1.3, 0.55, 0.09));
const twinkle = makeStars(420, 1500, 3.8, 0.6, 0.55);
scene.add(twinkle);

// galactic band — dense star lane + dust, tilted like the reference shots
(function milkyWay() {
  const bandGroup = new THREE.Group();
  const N = 9000;
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(N * 3);
  const col = new Float32Array(N * 3);
  const c = new THREE.Color();
  for (let i = 0; i < N; i++) {
    const a = rand(0, Math.PI * 2);
    const R = rand(1500, 2300);
    const spreadY = Math.pow(Math.random(), 2.4) * 320 * (Math.random() > 0.5 ? 1 : -1);
    pos.set([Math.cos(a) * R, spreadY, Math.sin(a) * R], i * 3);
    const warm = Math.random();
    c.setHSL(warm > 0.75 ? 0.08 : 0.6, rand(0.1, 0.45), rand(0.45, 0.9));
    col.set([c.r, c.g, c.b], i * 3);
  }
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  bandGroup.add(new THREE.Points(g, new THREE.PointsMaterial({
    size: 2.6, map: glowTex, vertexColors: true, transparent: true, opacity: 0.5,
    depthWrite: false, blending: THREE.AdditiveBlending,
  })));
  // dust clouds along the band — blue + rust like the NASA imagery
  const dust = [0x24408f, 0x5b2a3c, 0x1c4f5e, 0x6b3320, 0x2c2f6e, 0x4a1f2e];
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2 + rand(-0.2, 0.2);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color: dust[i % dust.length], transparent: true,
      opacity: rand(0.05, 0.1), depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    sp.position.set(Math.cos(a) * rand(1500, 2100), rand(-140, 140), Math.sin(a) * rand(1500, 2100));
    sp.scale.setScalar(rand(700, 1300));
    bandGroup.add(sp);
  }
  bandGroup.rotation.set(0.9, 0, 0.45); // tilt the galactic plane
  scene.add(bandGroup);
})();

// ------------------------------------------------------------------ state
const clockEl = document.getElementById("clock");
const planets = [];
let sun, sunLight, sunHalo = [], sunBaseScale = 1, solarFlare = 0;
let focused = null, hovered = null, DATA = null;
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2(-2, -2);

// ?stats — live perf/memory overlay for tuning
if (new URLSearchParams(location.search).has("stats")) {
  const el = document.createElement("div");
  el.style.cssText = "position:fixed;left:12px;top:40%;z-index:90;font:10px/1.7 monospace;color:#8fff9f;background:rgba(0,0,0,.6);padding:8px 10px;border:1px solid #2a4;border-radius:4px;pointer-events:none;white-space:pre";
  document.body.appendChild(el);
  setInterval(() => {
    const heap = performance.memory ? `${(performance.memory.usedJSHeapSize / 1048576).toFixed(0)}MB / ${(performance.memory.jsHeapSizeLimit / 1048576).toFixed(0)}MB` : "n/a";
    const i = renderer.info;
    el.textContent =
      `fps        ${statsFrames}\n` +
      `draw calls ${i.render.calls}\n` +
      `triangles  ${i.render.triangles.toLocaleString()}\n` +
      `geometries ${i.memory.geometries}\n` +
      `textures   ${i.memory.textures}\n` +
      `js heap    ${heap}\n` +
      `pixelRatio ${renderer.getPixelRatio()}`;
    statsFrames = 0;
  }, 1000);
}
const tmpV = new THREE.Vector3();

let tween = null;
let flightScale = 1; // tour speed multiplier (1/speed)
function flyTo(pos, target, dur = 1.6) {
  // orbit around the sun instead of cutting straight through it:
  // interpolate direction (slerp about origin) and radius separately
  const p0 = camera.position.clone(), p1 = pos.clone();
  const d0 = p0.clone().normalize(), d1 = p1.clone().normalize();
  tween = {
    p0, p1, d0,
    r0: p0.length(), r1: p1.length(),
    q: new THREE.Quaternion().setFromUnitVectors(d0, d1),
    qt: new THREE.Quaternion(),
    t0: controls.target.clone(), t1: target.clone(),
    start: performance.now(), dur: dur * 1000 * flightScale,
  };
}

// -------------------------------------------------------------------- sun
function sunColor(sent) {
  // temperature by sentiment: hostile → angry red dwarf, loved → white-hot
  const stops = [
    [-1, new THREE.Color(0xff5a30)],
    [-0.25, new THREE.Color(0xffa04a)],
    [0.15, new THREE.Color(0xffd27a)],
    [0.6, new THREE.Color(0xfff3d6)],
    [1, new THREE.Color(0xffffff)],
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [a, ca] = stops[i], [b, cb] = stops[i + 1];
    if (sent <= b) return ca.clone().lerp(cb, clamp((sent - a) / (b - a), 0, 1));
  }
  return stops.at(-1)[1].clone();
}

function buildSun(company) {
  const pop = company.popularity ?? 0.5;
  const sent = company.sentiment ?? 0;
  const r = 6.5 + pop * 6.5;
  sunBaseScale = r;
  solarFlare = clamp((company.trend?.delta ?? 0) / 2, 0, 1); // rising interest → livelier star
  const col = sunColor(sent);

  // uniform white-hot photosphere with granulation — glow comes from coronas + bloom
  const tex = canvasTexture(512, 256, (ctx, w, h) => {
    ctx.fillStyle = `rgb(${col.r * 255 | 0},${col.g * 255 | 0},${col.b * 255 | 0})`;
    ctx.fillRect(0, 0, w, h);
    const rnd = mulberry32(7);
    for (let i = 0; i < 900; i++) {
      const bright = rnd() > 0.5;
      ctx.fillStyle = bright
        ? `rgba(255,255,255,${rnd() * 0.2})`
        : `rgba(${col.r * 210 | 0},${col.g * 140 | 0},40,${rnd() * 0.25})`;
      ctx.beginPath(); ctx.arc(rnd() * w, rnd() * h, 1.5 + rnd() * 10, 0, 7); ctx.fill();
    }
  });
  sun = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 48), new THREE.MeshBasicMaterial({ map: tex }));
  sun.scale.setScalar(r);
  scene.add(sun);

  const coronaSpecs = [
    [r * 5.2, 0.5 + pop * 0.25],   // tight glow hugging the limb
    [r * 13, 0.3 + pop * 0.16],    // broad smooth falloff
  ];
  for (const [size, op] of coronaSpecs) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: coronaTex, color: col, transparent: true, opacity: op, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    sp.scale.setScalar(size);
    scene.add(sp);
    sunHalo.push(sp);
  }

  sunLight = new THREE.PointLight(col, 2100 + pop * 1400, 0, 1.5);
  scene.add(sunLight);

  const div = document.createElement("div");
  div.className = "lbl sun-lbl";
  div.textContent = company.name.toUpperCase();
  const lbl = new CSS2DObject(div);
  lbl.position.set(0, r + 5.5, 0);
  sun.add(lbl);
}

// ----------------------------------------------------- planet classification
function classify(source, orbitFrac) {
  const seed = hashStr(source.id);
  const rnd = mulberry32(seed);
  const mag = source.magnitude ?? 3;
  const sent = source.sentiment ?? 0;
  const eng = source.metrics?.engagement ?? source.metrics?.upvotes ?? source.metrics?.points ?? source.metrics?.likes ?? 0;

  const isGas = mag >= 6.4;
  let type, waterAmt = 0;
  if (isGas) type = "gas";
  else if (orbitFrac < 0.3) type = sent < -0.15 ? "lava" : "desert";  // close to the sun = dry
  else if (orbitFrac < 0.68) {
    if (sent > 0.5) { type = "ocean"; waterAmt = 0.82; }
    else if (sent > 0.05) { type = "terran"; waterAmt = 0.42 + sent * 0.45; }
    else if (sent < -0.3) type = "barren";
    else { type = "terran"; waterAmt = 0.3; }
  } else type = "ice";

  const size = isGas
    ? 4.1 + clamp(mag - 6.2, 0, 1.6) * 1.5
    : 1.25 + clamp(mag / 7, 0, 1) * 2.1;

  return {
    seed, type, waterAmt, size,
    tilt: (rnd() - 0.5) * 0.75,
    cities: !isGas && type !== "lava" && type !== "ice" && eng > 20000,
    satellites: (source.activity ?? 0) >= 0.85 ? 2 + Math.round(rnd() * 3) : 0,
    moonCount: clamp(Math.round((source.kwDiversity ?? 20) / 110) + 1, 1, 4),
    clouds: type === "terran" || type === "ocean" ? 0.45 + (source.activity ?? 0.3) * 0.3 : 0,
  };
}

// -------------------------------------------------------------- build planet
function buildPlanet(source, orbitIdx, total, ringed) {
  const orbitFrac = total > 1 ? orbitIdx / (total - 1) : 0;
  const k = classify(source, orbitFrac);
  const group = new THREE.Group();
  scene.add(group);

  const orbitR = 27 + orbitIdx * 9.5 + k.size * 1.8;

  // skin
  let skin;
  if (k.type === "gas") skin = gasSkin(k.seed, source.color || "#8899bb");
  else if (k.type === "lava") skin = rockySkin(k.seed, P.lava, { craters: 6, cracks: 26 });
  else if (k.type === "desert") skin = rockySkin(k.seed, P.desert, { craters: 18, cities: k.cities ? 5 : 0 });
  else if (k.type === "barren") skin = rockySkin(k.seed, P.barren, { craters: 26, cities: k.cities ? 4 : 0 });
  else if (k.type === "ice") skin = rockySkin(k.seed, P.ice, { craters: 10 });
  else skin = terranSkin(k.seed, k.waterAmt, { cities: k.cities ? 7 : 0 });

  const matOpts = {
    map: skin.map,
    roughness: k.type === "ice" ? 0.55 : k.type === "gas" ? 0.9 : 0.92,
    metalness: 0.02,
  };
  if (skin.emissiveMap) {
    matOpts.emissiveMap = skin.emissiveMap;
    matOpts.emissive = new THREE.Color(k.type === "lava" ? 0xff5a1e : 0xffd990);
    matOpts.emissiveIntensity = k.type === "lava" ? 1.5 : 1.15;
  }
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(k.size, 48, 48), new THREE.MeshStandardMaterial(matOpts));
  mesh.rotation.z = k.tilt;
  mesh.userData.planetIdx = planets.length;
  group.add(mesh);

  // cloud layer
  let cloudMesh = null;
  if (k.clouds) {
    cloudMesh = new THREE.Mesh(
      new THREE.SphereGeometry(k.size * 1.018, 48, 48),
      new THREE.MeshStandardMaterial({
        map: cloudSkin(k.seed, k.clouds), transparent: true, opacity: 0.85,
        roughness: 1, depthWrite: false,
      })
    );
    cloudMesh.rotation.z = k.tilt;
    group.add(cloudMesh);
  }

  // thin atmosphere rim (subtle, type-tinted)
  const atmoColor = { gas: 0xaabbdd, terran: 0x6fa8ff, ocean: 0x5fb8ff, ice: 0xbcd8ee, lava: 0xff7a40, desert: 0xd9a066, barren: 0x8a8f99 }[k.type];
  const atmo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, color: atmoColor, transparent: true, opacity: k.type === "gas" ? 0.11 : 0.1,
    depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  atmo.scale.setScalar(k.size * 2.75);
  group.add(atmo);

  // orbit path — barely-there
  const pts = [];
  for (let i = 0; i <= 220; i++) {
    const a = (i / 220) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * orbitR, 0, Math.sin(a) * orbitR));
  }
  const orbit = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: 0x8fb8d8, transparent: true, opacity: 0.05 })
  );
  scene.add(orbit);

  // ring system — only for the most topic-diverse worlds
  let ring = null;
  if (ringed) {
    const rnd = mulberry32(k.seed ^ 0xf00d);
    const inner = k.size * 1.45, outer = k.size * (2.1 + rnd() * 0.5);
    const ringTex = canvasTexture(256, 8, (ctx, w, h) => {
      for (let x = 0; x < w; x++) {
        const t = x / w;
        const bandNoise = Math.sin(t * 40 + rnd() * 9) * 0.5 + Math.sin(t * 90) * 0.3;
        const a = clamp(0.3 + bandNoise * 0.22, 0.03, 0.6) * (t < 0.06 || t > 0.94 ? 0.35 : 1);
        const shade = 148 + bandNoise * 40;
        ctx.fillStyle = `rgba(${shade | 0},${shade * 0.92 | 0},${shade * 0.8 | 0},${a})`;
        ctx.fillRect(x, 0, 1, h);
      }
    });
    const rg = new THREE.RingGeometry(inner, outer, 96, 1);
    // remap uv radially for the band texture
    const uv = rg.attributes.uv, p3 = rg.attributes.position;
    for (let i = 0; i < uv.count; i++) {
      const px = p3.getX(i), py = p3.getY(i);
      uv.setXY(i, (Math.hypot(px, py) - inner) / (outer - inner), 0.5);
    }
    ring = new THREE.Mesh(rg, new THREE.MeshBasicMaterial({
      map: ringTex, side: THREE.DoubleSide, transparent: true, opacity: 0.95,
      depthWrite: false,
    }));
    ring.rotation.x = Math.PI / 2 + k.tilt * 0.8;
    group.add(ring);
  }

  // moons = dominant keywords (real rocky moons)
  const moons = [];
  const kws = (source.keywords || []).slice(0, k.moonCount);
  const maxCount = Math.max(1, ...kws.map((kw) => kw.count));
  kws.forEach((kw, i) => {
    const mr = 0.16 + 0.34 * (kw.count / maxCount);
    const moon = new THREE.Mesh(
      new THREE.SphereGeometry(mr, 20, 20),
      new THREE.MeshStandardMaterial({ map: moonSkin(k.seed + i * 7), roughness: 0.95 })
    );
    const div = document.createElement("div");
    div.className = "lbl kw-lbl";
    div.textContent = kw.text;
    const lbl = new CSS2DObject(div);
    lbl.position.set(0, mr + 0.45, 0);
    lbl.visible = false;
    moon.add(lbl);
    group.add(moon);
    moons.push({
      mesh: moon, label: lbl,
      r: k.size * 2.1 + i * (0.85 + k.size * 0.22),
      speed: rand(0.35, 0.9) * (i % 2 ? -1 : 1),
      angle: rand(0, Math.PI * 2),
      incl: rand(-0.4, 0.4),
    });
  });

  // artificial satellite constellation (very active platforms)
  const sats = [];
  for (let i = 0; i < k.satellites; i++) {
    const sat = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.09, 0.05, 0.05),
      new THREE.MeshStandardMaterial({ color: 0xcfd6e0, metalness: 0.8, roughness: 0.35 })
    );
    const panel = new THREE.Mesh(
      new THREE.BoxGeometry(0.3, 0.005, 0.1),
      new THREE.MeshStandardMaterial({ color: 0x2255cc, metalness: 0.6, roughness: 0.3, emissive: 0x112244, emissiveIntensity: 0.4 })
    );
    sat.add(body, panel);
    const blink = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color: 0xff4444, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    blink.scale.setScalar(0.16);
    sat.add(blink);
    group.add(sat);
    sats.push({
      mesh: sat, blink,
      r: k.size * (1.32 + i * 0.13),
      speed: rand(1.6, 3.2) * (i % 2 ? -1 : 1),
      angle: rand(0, Math.PI * 2),
      incl: rand(-1, 1),
      phase: rand(0, 9),
    });
  }

  // planet name label
  const div = document.createElement("div");
  div.className = "lbl planet";
  div.textContent = source.name.toUpperCase();
  const lbl = new CSS2DObject(div);
  lbl.position.set(0, k.size + 1.9, 0);
  group.add(lbl);

  const p = {
    group, mesh, cloudMesh, atmo, ring, orbit, moons, sats, source, k,
    size: k.size, orbitR,
    angle: rand(0, Math.PI * 2),
    speed: (0.045 + (source.activity ?? 0.4) * 0.13) / Math.sqrt(orbitR / 30),
    spin: 0.1 + (source.activity ?? 0.3) * 0.5,
    ships: [],
    labelEl: div,
    label: lbl,
    lblFs: 0,
  };
  const shipCount = Math.round((source.activity ?? 0) * 3 + (source.engagementRate ? 2 : 0));
  for (let i = 0; i < shipCount; i++) spawnShip(p, true);
  planets.push(p);
  return p;
}

// --------------------------------------------------------------- ships ✈
const shipMat = new THREE.SpriteMaterial({ map: glowTex, color: 0xbfe9ff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
function spawnShip(p, randomT = false) {
  const head = new THREE.Sprite(shipMat.clone());
  head.scale.setScalar(rand(0.5, 0.9));
  const trail = new THREE.Sprite(shipMat.clone());
  trail.material.opacity = 0.3;
  trail.scale.setScalar(0.3);
  scene.add(head, trail);
  const from = new THREE.Vector3().randomDirection().multiplyScalar(rand(260, 460));
  from.y *= 0.35;
  p.ships.push({
    head, trail, from,
    ctrl: from.clone().multiplyScalar(0.5).add(new THREE.Vector3(rand(-60, 60), rand(20, 70), rand(-60, 60))),
    t: randomT ? Math.random() : 0,
    speed: rand(0.05, 0.14),
    wait: 0,
  });
}

function updateShips(p, planetPos, dt) {
  for (const s of p.ships) {
    if (s.wait > 0) {
      s.wait -= dt;
      s.head.material.opacity = 0; s.trail.material.opacity = 0;
      continue;
    }
    s.t += s.speed * dt;
    if (s.t >= 1) {
      s.t = 0;
      s.wait = rand(1, 9) / Math.max(0.15, p.source.activity ?? 0.3);
      s.from.copy(new THREE.Vector3().randomDirection().multiplyScalar(rand(260, 460)));
      s.from.y *= 0.35;
      s.ctrl.copy(s.from).multiplyScalar(0.5).add(new THREE.Vector3(rand(-60, 60), rand(20, 70), rand(-60, 60)));
      continue;
    }
    const t = easeInOut(s.t);
    const a = tmpV.copy(s.from).lerp(s.ctrl, t);
    const b = s.ctrl.clone().lerp(planetPos, t);
    a.lerp(b, t);
    s.head.position.copy(a);
    const fade = Math.min(1, (1 - s.t) * 4) * Math.min(1, s.t * 8);
    s.head.material.opacity = 0.8 * fade;
    const tb = Math.max(0, t - 0.03);
    const a2 = s.trail.position.copy(s.from).lerp(s.ctrl, tb);
    const b2 = s.ctrl.clone().lerp(planetPos, tb);
    a2.lerp(b2, tb);
    s.trail.material.opacity = 0.25 * fade;
  }
}

// ---------------------------------------------------------- asteroid belt
let beltGroup = null;
function buildAsteroidBelt(innerCount, total) {
  // belt sits between the inner (hot) worlds and the mid system
  const rMid = 27 + (innerCount - 0.5) * 9.5 + 6;
  const N = 1500;
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(N * 3);
  const col = new Float32Array(N * 3);
  const c = new THREE.Color();
  for (let i = 0; i < N; i++) {
    const a = rand(0, Math.PI * 2);
    const r = rMid + rand(-4.5, 4.5) + Math.pow(Math.random(), 3) * 5;
    pos.set([Math.cos(a) * r, rand(-1.4, 1.4), Math.sin(a) * r], i * 3);
    c.setHSL(0.07, rand(0.05, 0.2), rand(0.18, 0.42));
    col.set([c.r, c.g, c.b], i * 3);
  }
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  beltGroup = new THREE.Points(g, new THREE.PointsMaterial({
    size: 0.5, map: glowTex, vertexColors: true, transparent: true, opacity: 0.8,
    depthWrite: false, sizeAttenuation: true,
  }));
  scene.add(beltGroup);
}

// --------------------------------------------------------------- comets ☄
const comets = [];
function buildComets(n = 2) {
  for (let i = 0; i < n; i++) {
    const hue = i % 2 ? 0x9fffe0 : 0xb9e2ff;
    const head = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color: hue, transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    head.scale.setScalar(2.1);
    const N = 90;
    const trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    const trail = new THREE.Points(trailGeo, new THREE.PointsMaterial({
      color: hue, size: 1.5, map: glowTex, transparent: true, opacity: 0.4,
      depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
    }));
    scene.add(head, trail);
    comets.push({
      head, trail, N, hist: [],
      a: rand(190, 330), b: rand(70, 150),
      tilt: rand(-0.7, 0.7), phase: rand(0, Math.PI * 2),
      speed: rand(0.04, 0.09),
      angle: rand(0, Math.PI * 2),
    });
  }
}

function updateComets(t, dt) {
  for (const c of comets) {
    c.angle += c.speed * dt;
    const x = Math.cos(c.angle) * c.a;
    const z = Math.sin(c.angle) * c.b;
    const p = new THREE.Vector3(x, 0, z);
    p.applyAxisAngle(new THREE.Vector3(0, 0, 1), c.tilt);
    p.applyAxisAngle(new THREE.Vector3(0, 1, 0), c.phase);
    c.head.position.copy(p);
    c.hist.unshift(p.clone());
    if (c.hist.length > c.N) c.hist.pop();
    const attr = c.trail.geometry.attributes.position;
    for (let i = 0; i < c.N; i++) {
      const h = c.hist[Math.min(i, c.hist.length - 1)] || p;
      attr.setXYZ(i, h.x, h.y, h.z);
    }
    attr.needsUpdate = true;
  }
}

// ------------------------------------------------------------------- HUD
const TYPE_LABEL = {
  gas: "GAS GIANT", terran: "TERRAN WORLD", ocean: "OCEAN WORLD",
  desert: "DESERT WORLD", lava: "VOLCANIC WORLD", barren: "BARREN ROCK", ice: "ICE WORLD",
};

function buildHud(data) {
  const c = data.company;
  const isTopic = c.subjectType === "topic";
  document.querySelector(".hud-eyebrow").textContent =
    `${isTopic ? "TOPIC" : "BRAND"} UNIVERSE // LIVE TELEMETRY`;
  document.getElementById("company-name-text").textContent = c.name;
  document.getElementById("company-desc").textContent = c.description || "";
  const pop100 = Math.round((c.popularity ?? 0) * 100);
  const sent = c.sentiment ?? 0;
  document.getElementById("gauge-pop").style.width = `${pop100}%`;
  document.getElementById("gauge-pop-val").textContent = `${pop100}/100`;
  document.getElementById("gauge-sent").style.left = `${50 + sent * 48}%`;
  document.getElementById("gauge-sent-val").textContent =
    `${sent > 0.15 ? "POSITIVE" : sent < -0.15 ? "NEGATIVE" : "NEUTRAL"} ${sent >= 0 ? "+" : ""}${sent.toFixed(2)}`;
  const trendTxt = c.trend
    ? ` · SEARCH INTEREST <b>${c.trend.interest}</b>/100 ${c.trend.delta > 0.05 ? "▲" : c.trend.delta < -0.05 ? "▼" : "◆"}`
    : "";
  const reachTxt = c.totalFollowers > 0 ? `REACH <b>${fmt(c.totalFollowers)}</b> followers · ` : "";
  document.getElementById("hud-stats").innerHTML =
    `${reachTxt}<b>${data.sources.length}</b> worlds${trendTxt}<br>` +
    `${c.industry ? `SECTOR <b>${String(c.industry).toUpperCase()}</b> · ` : ""}` +
    `${c.employees ? `CREW <b>${fmt(c.employees)}</b>` : ""}`;

  const legend = document.getElementById("legend");
  const core = document.createElement("button");
  core.className = "legend-item";
  core.id = "legend-core";
  core.innerHTML = `<span class="legend-dot" style="color:#ffd25e;background:#ffd25e"></span>☀ ${c.name.toUpperCase()} CORE`;
  core.onclick = () => focusSun();
  legend.appendChild(core);
  planets.forEach((p, i) => {
    const el = document.createElement("button");
    el.className = "legend-item";
    el.innerHTML = `<span class="legend-dot" style="color:${p.source.color};background:${p.source.color}"></span>${p.source.name.toUpperCase()}`;
    el.onclick = () => focusPlanet(p);
    el.id = `legend-${i}`;
    legend.appendChild(el);
  });

  // codex toggle
  const codexBtn = document.getElementById("codex-btn");
  const codex = document.getElementById("codex");
  codexBtn.onclick = () => codex.classList.toggle("open");

  // low-power mode toggle
  const lp = document.getElementById("low-power-btn");
  lp.textContent = LOW_POWER ? "⚡ LOW POWER ON · tap for full quality" : "⚡ LOW POWER OFF · tap to save battery";
  lp.onclick = () => { localStorage.setItem("lowPower", LOW_POWER ? "0" : "1"); location.reload(); };

  // tour stop checkboxes
  const stopsEl = document.getElementById("tour-stops");
  stopsEl.innerHTML = "";
  const mkStop = (id, label, color) => {
    const l = document.createElement("label");
    l.innerHTML = `<input type="checkbox" checked data-stop="${id}"> <span style="color:${color}">●</span> ${label}`;
    stopsEl.appendChild(l);
  };
  mkStop("core", `${c.name.toUpperCase()} CORE`, "#ffd25e");
  planets.forEach((p, i) => mkStop(i, p.source.name.toUpperCase(), p.source.color));
}

function openPanel(p) {
  const s = p.source;
  document.getElementById("panel-title").textContent = s.name;
  const cls = [TYPE_LABEL[p.k.type]];
  if (p.ring) cls.push("RING SYSTEM");
  if (p.k.cities) cls.push("CITY LIGHTS");
  if (p.k.satellites) cls.push(`${p.k.satellites} SATELLITES`);
  document.getElementById("panel-class").textContent = cls.join(" · ");
  const sent = s.sentiment ?? 0;
  const mood = sent > 0.15 ? ["POSITIVE ATMOSPHERE", "#6effa0"] : sent < -0.15 ? ["HOSTILE ATMOSPHERE", "#ff6a6a"] : ["NEUTRAL ATMOSPHERE", "#7ff7ff"];
  document.getElementById("panel-sent").innerHTML = `<span style="color:${mood[1]}">◉ ${mood[0]}</span> · SENTIMENT ${sent >= 0 ? "+" : ""}${sent.toFixed(2)}`;

  const metrics = document.getElementById("panel-metrics");
  metrics.innerHTML = "";
  Object.entries(s.metrics || {}).forEach(([k, v]) => {
    if (v == null) return;
    const d = document.createElement("div");
    d.className = "metric";
    d.innerHTML = `<div class="v">${typeof v === "boolean" ? (v ? "YES" : "NO") : fmt(v)}</div><div class="k">${k}</div>`;
    metrics.appendChild(d);
  });

  const kwEl = document.getElementById("panel-keywords");
  kwEl.innerHTML = "";
  (s.keywords || []).forEach((kw) => {
    const el = document.createElement("span");
    el.className = "kw";
    el.textContent = `${kw.text} ×${kw.count}`;
    kwEl.appendChild(el);
  });
  document.getElementById("panel-kw-wrap").style.display = s.keywords?.length ? "" : "none";

  const items = document.getElementById("panel-items");
  items.innerHTML = "";
  (s.items || []).forEach((it) => {
    const li = document.createElement("li");
    const text = document.createElement(it.url ? "a" : "span");
    text.textContent = it.title;
    if (it.url) {
      text.href = it.url;
      text.target = "_blank";
      text.rel = "noreferrer";
      text.title = "open source ↗";
    }
    li.appendChild(text);
    if (it.engagement) {
      const b = document.createElement("b");
      b.textContent = ` · ${fmt(it.engagement)} ⚡`;
      li.appendChild(b);
    }
    items.appendChild(li);
  });
  document.getElementById("panel-items-wrap").style.display = s.items?.length ? "" : "none";

  const link = document.getElementById("panel-link");
  if (s.url) { link.href = s.url; link.style.display = ""; } else link.style.display = "none";

  document.getElementById("panel").classList.add("open");
}

function closePanel() { document.getElementById("panel").classList.remove("open"); }

// ------------------------------------------------- sun = company core scan
function openCompanyPanel() {
  const c = DATA.company;
  const intel = c.intel || {};
  document.getElementById("panel-title").textContent = c.name;
  document.getElementById("panel-class").textContent = c.subjectType === "topic"
    ? "TOPIC CORE · LIVE DISCOURSE"
    : "STELLAR CORE · PDL + AKTA INTEL";
  const sent = c.sentiment ?? 0;
  const mood = sent > 0.15 ? ["RADIANT STAR", "#6effa0"] : sent < -0.15 ? ["UNSTABLE STAR", "#ff6a6a"] : ["STABLE STAR", "#7ff7ff"];
  document.getElementById("panel-sent").innerHTML =
    `<span style="color:${mood[1]}">◉ ${mood[0]}</span> · MOOD ${sent >= 0 ? "+" : ""}${sent.toFixed(2)} · LUMINOSITY ${Math.round((c.popularity ?? 0) * 100)}%`;

  const metrics = document.getElementById("panel-metrics");
  metrics.innerHTML = "";
  const compact = (v) => String(v)
    .replace(/\s*billion/i, "B").replace(/\s*million/i, "M").replace(/\s*trillion/i, "T")
    .replace(/\s*per month/i, "/mo").replace(/\s*per year/i, "/yr")
    .replace(/\s*weekly active users/i, " WAU").replace(/\s*week(ly)?/i, "/wk")
    .slice(0, 14);
  const rows = {
    valuation: intel.valuation && compact(intel.valuation),
    revenue: intel.revenue && compact(intel.revenue),
    users: intel.users && compact(intel.users),
    funding: intel.funding && compact(intel.funding),
    employees: c.employees && fmt(c.employees),
    founded: c.founded && String(c.founded),
    "search interest": c.trend ? `${c.trend.interest}/100` : null,
    reach: c.totalFollowers > 0 ? fmt(c.totalFollowers) : null,
  };
  Object.entries(rows).forEach(([k, v]) => {
    if (v == null) return;
    const d = document.createElement("div");
    d.className = "metric";
    d.innerHTML = `<div class="v">${v}</div><div class="k">${k}</div>`;
    metrics.appendChild(d);
  });

  const kwEl = document.getElementById("panel-keywords");
  kwEl.innerHTML = "";
  (c.tags || []).forEach((tag) => {
    const el = document.createElement("span");
    el.className = "kw";
    el.textContent = tag;
    kwEl.appendChild(el);
  });
  document.getElementById("panel-kw-wrap").style.display = c.tags?.length ? "" : "none";

  const items = document.getElementById("panel-items");
  items.innerHTML = "";
  if (intel.marketPosition) {
    const li = document.createElement("li");
    li.innerHTML = intel.marketPosition + "…";
    items.appendChild(li);
  }
  (intel.strengths || []).forEach((s) => {
    const li = document.createElement("li");
    li.innerHTML = `▲ <b>${s}</b>`;
    items.appendChild(li);
  });
  document.getElementById("panel-items-wrap").style.display = (intel.marketPosition || intel.strengths?.length) ? "" : "none";

  const link = document.getElementById("panel-link");
  if (c.website) { link.href = c.website; link.style.display = ""; } else link.style.display = "none";

  document.getElementById("panel").classList.add("open");
}

function focusSun() {
  focused = null;
  document.querySelectorAll(".legend-item").forEach((e) => e.classList.remove("active"));
  document.getElementById("legend-core")?.classList.add("active");
  planets.forEach((q) => q.moons.forEach((m) => (m.label.visible = false)));
  const r = sunBaseScale;
  flyTo(new THREE.Vector3(r * 4.2, r * 1.6, r * 4.2), new THREE.Vector3(-r * 0.8, 0, 0), 1.7);
  openCompanyPanel();
}

// ------------------------------------------------------------ interaction
function planetWorldPos(p) {
  return new THREE.Vector3(Math.cos(p.angle) * p.orbitR, 0, Math.sin(p.angle) * p.orbitR);
}

function focusPlanet(p) {
  if (!p) return;
  focused = p;
  document.querySelectorAll(".legend-item").forEach((e) => e.classList.remove("active"));
  document.getElementById(`legend-${planets.indexOf(p)}`)?.classList.add("active");
  planets.forEach((q) => q.moons.forEach((m) => (m.label.visible = q === p)));
  const pos = planetWorldPos(p);
  const dir = pos.clone().normalize(); // sun -> planet
  const tangent = new THREE.Vector3(-dir.z, 0, dir.x);
  // approach from whichever side the camera already is (shorter, no flip)
  if (tangent.dot(tmpV.copy(camera.position).sub(pos)) < 0) tangent.negate();
  // tilt the viewpoint sunward (~46 deg) so most of the disc is day side
  const A = 0.8;
  const off = tangent.multiplyScalar(Math.cos(A)).addScaledVector(dir, -Math.sin(A)).normalize();
  const camPos = pos.clone()
    .addScaledVector(off, p.size * 9.0)
    .add(new THREE.Vector3(0, p.size * 2.6, 0));
  // center the planet in the part of the screen the scan panel doesn't cover
  const viewDir = pos.clone().sub(camPos).normalize();
  const screenRight = viewDir.clone().cross(camera.up).normalize();
  const camDist = camPos.distanceTo(pos);
  const halfTan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const target = pos.clone();
  if (innerWidth <= 900) {
    // phone: panel is a bottom sheet — lift the planet into the top 2/3
    const panelH = Math.min(innerHeight * 0.34, 340);
    const screenUp = screenRight.clone().cross(viewDir).normalize();
    target.addScaledVector(screenUp, -halfTan * camDist * (panelH / innerHeight));
  } else {
    // desktop: panel docks right — nudge the planet left of it
    const panelW = document.getElementById("panel").offsetWidth || 380;
    target.addScaledVector(screenRight, halfTan * camDist * camera.aspect * (panelW / innerWidth));
  }
  flyTo(camPos, target, 1.7);
  openPanel(p);
}

function clearFocus() {
  focused = null;
  closePanel();
  document.querySelectorAll(".legend-item").forEach((e) => e.classList.remove("active"));
  planets.forEach((q) => q.moons.forEach((m) => (m.label.visible = false)));
}

function unfocus() {
  clearFocus();
  flyTo(new THREE.Vector3(0, 120, 260), new THREE.Vector3(0, 0, 0), 1.6);
}

addEventListener("pointermove", (e) => {
  pointer.x = (e.clientX / innerWidth) * 2 - 1;
  pointer.y = -(e.clientY / innerHeight) * 2 + 1;
});

// iOS Safari ignores user-scalable=no: block page pinch-zoom explicitly so
// pinch always zooms the orbit, never the layout
for (const ev of ["gesturestart", "gesturechange", "gestureend"]) {
  document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
}

let downAt = -1;
addEventListener("pointerdown", () => (downAt = performance.now()));
addEventListener("pointerup", (e) => {
  if (downAt < 0 || performance.now() - downAt > 240) return;
  downAt = -1;
  // read coords from the event itself: touch taps never fire pointermove,
  // so the hover-tracked pointer vector is stale/unset on phones
  pointer.x = (e.clientX / innerWidth) * 2 - 1;
  pointer.y = -(e.clientY / innerHeight) * 2 + 1;
  if (Math.abs(pointer.x) > 1 || Math.abs(pointer.y) > 1) return;
  if (tourState.running) return;
  if (e.target.closest("#panel") || e.target.closest("#legend") || e.target.closest("#codex-wrap") || e.target.closest("#tour-ctrl") || e.target.closest("#tour-menu") || e.target.closest("#subject-modal") || e.target.closest("#company-name")) return;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects([...planets.map((p) => p.mesh), sun].filter(Boolean));
  if (hits.length) {
    if (hits[0].object === sun) focusSun();
    else focusPlanet(planets[hits[0].object.userData.planetIdx]);
    return;
  }
  // fat-finger fallback: snap to the nearest planet within ~30px (touch slop)
  const slop = e.pointerType === "touch" ? 40 : 26;
  let best = null;
  for (const p of planets) {
    const sp = planetWorldPos(p).project(camera);
    if (sp.z > 1) continue; // behind the camera
    const dx = ((sp.x - pointer.x) * innerWidth) / 2;
    const dy = ((sp.y - pointer.y) * innerHeight) / 2;
    const d = Math.hypot(dx, dy);
    if (d < slop && (!best || d < best.d)) best = { p, d };
  }
  if (best) focusPlanet(best.p);
});

addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const modal = document.getElementById("subject-modal");
  if (!modal.hidden) { closeSubjectModal(); return; }
  if (tourState.running) { tourState.abort = true; return; }
  unfocus();
});
document.getElementById("panel-close").onclick = unfocus;

// -------------------------------------------------------- cinematic tour
const tourState = { running: false, abort: false };
const FAR_POS = new THREE.Vector3(45, 280, 760);
const OVERVIEW_POS = new THREE.Vector3(0, 120, 260);
const ORIGIN = new THREE.Vector3(0, 0, 0);

function tourWait(ms) {
  return new Promise((res) => {
    const t0 = performance.now();
    (function chk() {
      if (tourState.abort || performance.now() - t0 >= ms) return res();
      requestAnimationFrame(chk);
    })();
  });
}

async function runTour() {
  const btn = document.getElementById("tour-play");
  if (tourState.running) { tourState.abort = true; return; }

  const speed = Number(document.getElementById("tour-speed").value) || 1;
  const stops = [...document.querySelectorAll("#tour-stops input:checked")].map((el) => el.dataset.stop);
  if (!stops.length) return;

  tourState.running = true;
  tourState.abort = false;
  btn.textContent = "■ STOP TOUR";
  btn.classList.add("running");
  document.getElementById("tour-menu").hidden = true;
  document.getElementById("codex").classList.remove("open");

  const s = 1 / speed;
  flightScale = s;
  controls.enabled = false;
  const homePos = camera.position.clone(), homeTgt = controls.target.clone();

  // 1. open far out, drift in to the full system
  clearFocus();
  tween = null;
  camera.position.copy(FAR_POS);
  controls.target.copy(ORIGIN);
  await tourWait(800 * s);
  if (!tourState.abort) { flyTo(OVERVIEW_POS, ORIGIN, 7); await tourWait(7000 * s + 300); }
  if (!tourState.abort) await tourWait(2600 * s); // hold the overview

  // 2. visit each selected stop, dwell on its scan panel
  for (const stop of stops) {
    if (tourState.abort) break;
    if (stop === "core") focusSun();
    else focusPlanet(planets[Number(stop)]);
    await tourWait(1700 * s + 300); // flight
    if (!tourState.abort) await tourWait(5200 * s); // read the panel
  }

  // 3. pull back to overview, then retreat to the far shot
  if (!tourState.abort) { clearFocus(); flyTo(OVERVIEW_POS, ORIGIN, 2.2); await tourWait(2200 * s + 1200 * s); }
  if (!tourState.abort) { flyTo(FAR_POS, ORIGIN, 7); await tourWait(7000 * s + 300); }

  flightScale = 1;
  controls.enabled = true;
  if (tourState.abort) {
    clearFocus();
    tween = null;
    camera.position.copy(homePos);
    controls.target.copy(homeTgt);
  } else {
    flyTo(OVERVIEW_POS, ORIGIN, 2);
  }
  tourState.running = false;
  tourState.abort = false;
  btn.textContent = "▶ CINEMATIC TOUR";
  btn.classList.remove("running");
}

// ------------------------------------------------ IndexedDB (client cache)
function idbOpen() {
  return new Promise((res, rej) => {
    const req = indexedDB.open("signal-solar", 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("runs");       // `${slug}:${label}` -> raw run
      req.result.createObjectStore("universes");  // slug -> {snapshot, meta}
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
async function idbGet(store, key) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const r = db.transaction(store).objectStore(store).get(key);
    r.onsuccess = () => res(r.result ?? null);
    r.onerror = () => rej(r.error);
  });
}
async function idbSet(store, key, val) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(val, key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function idbAll(store) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction(store);
    const os = tx.objectStore(store);
    const keys = os.getAllKeys(), vals = os.getAll();
    tx.oncomplete = () => res(keys.result.map((k, i) => [k, vals.result[i]]));
    tx.onerror = () => rej(tx.error);
  });
}

// ------------------------------------------------------- subject switcher
const subjModal = document.getElementById("subject-modal");
const subjList = document.getElementById("subject-list");
const subjInput = document.getElementById("subject-input");
const subjStatus = document.getElementById("subject-status");
const keyStep = document.getElementById("key-step");
const keyInput = document.getElementById("key-input");
const keyError = document.getElementById("key-error");
let switching = false;
let pendingSubject = null;
let SHIPPED = []; // manifest of committed demo universes (set in init)

const getKey = () => localStorage.getItem("monidKey") || null;

// resolve credentials: OAuth first (token acts like a scoped API key),
// manual API key as fallback. Returns null when neither is available.
async function resolveAuth() {
  const token = await accessToken();
  if (token) {
    let workspaceId = localStorage.getItem("monidWorkspace");
    if (!workspaceId) {
      const res = await fetch(`${API_BASE}/v1/auth/workspaces`, { headers: { Authorization: `Bearer ${token}` } });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error?.message || `could not list workspaces (HTTP ${res.status})`);
      const ws = body?.workspaces ?? body ?? [];
      workspaceId = ws[0]?.workspaceId || ws[0]?.id;
      if (!workspaceId) throw new Error("no Monid workspace on this account");
      localStorage.setItem("monidWorkspace", workspaceId);
    }
    return { apiKey: token, workspaceId };
  }
  const key = getKey();
  return key ? { apiKey: key, workspaceId: null } : null;
}

async function updateKeyFooter() {
  const footer = document.getElementById("key-footer");
  const badge = document.getElementById("key-badge");
  const key = getKey();
  if (connected()) {
    footer.hidden = false;
    badge.textContent = "◈ MONID CONNECTED";
    userInfo().then((u) => { if (u?.email) badge.textContent = `◈ CONNECTED · ${u.email}`; }).catch(() => {});
  } else if (key) {
    footer.hidden = false;
    badge.textContent = `◈ ACCESS KEY •••• ${key.slice(-4)}`;
  } else {
    footer.hidden = true;
  }
}

async function listUniverses() {
  const local = await idbAll("universes").catch(() => []);
  const bySlug = new Map();
  for (const s of SHIPPED) bySlug.set(s.slug, { ...s, name: s.subject, tier: "demo" });
  for (const [slug, rec] of local) bySlug.set(slug, { slug, ...rec.meta, name: rec.meta.subject, tier: "yours" });
  return [...bySlug.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function timeAgo(iso) {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!isFinite(s) || s < 0) return "";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

async function openSubjectModal() {
  subjModal.hidden = false;
  subjStatus.hidden = true;
  subjStatus.classList.remove("error");
  subjStatus.innerHTML = "";
  keyStep.hidden = true;
  keyError.hidden = true;
  document.getElementById("key-manual").hidden = true;
  subjInput.value = "";
  subjInput.disabled = false;
  subjInput.focus();
  updateKeyFooter();
  const universes = await listUniverses();
  const activeSlug = localStorage.getItem("activeUniverse") || SHIPPED[0]?.slug;
  subjList.innerHTML = "";
  universes.forEach((s) => {
    const b = document.createElement("button");
    b.className = "subject-item" + (s.slug === activeSlug ? " current" : "");
    const meta = [s.sources ? `${s.sources} worlds` : "", s.updatedAt ? timeAgo(s.updatedAt) : ""]
      .filter(Boolean).join(" · ");
    b.innerHTML =
      `<span class="s-main"><span class="s-name">${s.name}</span>` +
      (s.subjectType ? `<span class="s-type">${s.subjectType.toUpperCase()}</span>` : "") +
      (s.tier === "demo" ? `<span class="s-type s-demo">DEMO</span>` : "") +
      `</span>` +
      `<span class="s-meta">${meta}</span>`;
    b.onclick = () => activateUniverse(s.slug);
    // delete (your universes only — shipped demos are static files)
    if (s.tier === "yours") {
      const del = document.createElement("span");
      del.className = "s-del";
      del.textContent = "✕";
      del.title = "delete this universe from your browser";
      del.onclick = async (e) => {
        e.stopPropagation();
        if (!del.classList.contains("arm")) {
          // two-tap confirm — it also wipes the paid endpoint cache
          del.classList.add("arm");
          del.textContent = "sure?";
          setTimeout(() => { del.classList.remove("arm"); del.textContent = "✕"; }, 2600);
          return;
        }
        await deleteUniverse(s.slug);
        openSubjectModal();
      };
      b.appendChild(del);
    }
    // fresh re-scan: re-pays every endpoint, updates the universe in place
    const re = document.createElement("span");
    re.className = "s-refresh";
    re.textContent = "↻";
    re.title = "re-scan now — refetches everything (re-pays all endpoints)";
    re.onclick = (e) => {
      e.stopPropagation();
      scanSubject(s.name, { fresh: true });
    };
    b.appendChild(re);
    subjList.appendChild(b);
  });
  if (!universes.length) subjList.innerHTML = `<div class="subject-hint">no universes yet — type one above</div>`;
}

function closeSubjectModal() { if (!switching) subjModal.hidden = true; }

function activateUniverse(slug) {
  localStorage.setItem("activeUniverse", slug);
  location.reload();
}

async function deleteUniverse(slug) {
  // remove the universe AND its raw endpoint cache from this browser
  const db = await idbOpen();
  await new Promise((res, rej) => {
    const tx = db.transaction(["universes", "runs"], "readwrite");
    tx.objectStore("universes").delete(slug);
    tx.objectStore("runs").delete(IDBKeyRange.bound(`${slug}:`, `${slug}:\uffff`));
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
  if (localStorage.getItem("activeUniverse") === slug) localStorage.removeItem("activeUniverse");
}

function scanLine(text, cls = "") {
  const el = document.createElement("span");
  el.className = `scan-line ${cls}`;
  el.textContent = text;
  subjStatus.appendChild(el);
  subjStatus.scrollTop = subjStatus.scrollHeight;
  return el;
}

async function scanSubject(subject, { fresh = false } = {}) {
  if (switching) return;
  let auth;
  try {
    auth = await resolveAuth();
  } catch (err) {
    subjStatus.hidden = false;
    subjStatus.classList.add("error");
    scanLine(`✕ ${err.message}`, "err");
    return;
  }
  if (!auth) {
    // reveal the connect step; the scan resumes after auth
    pendingSubject = subject;
    keyStep.hidden = false;
    return;
  }
  switching = true;
  subjInput.disabled = true;
  keyStep.hidden = true;
  subjStatus.hidden = false;
  subjStatus.classList.remove("error");
  subjStatus.innerHTML = "";
  const header = scanLine(`◈ ${fresh ? "RE-SCANNING" : "SCANNING"} "${subject.toUpperCase()}" UNIVERSE${fresh ? " (FRESH DATA)" : ""}…`);
  header.classList.add("ok");

  const slug = slugify(subject);
  const cache = {
    get: (label) => idbGet("runs", `${slug}:${label}`),
    set: (label, run) => idbSet("runs", `${slug}:${label}`, run),
  };
  let spent = 0;
  const onProgress = (ev) => {
    if (ev.phase === "cached") scanLine(`  ${ev.label} · cached · free`, ev.ok ? "ok" : "err");
    else if (ev.phase === "done") {
      if (ev.cost) spent += Number(ev.cost) || 0;
      scanLine(`  ${ev.label} · ${(ev.ms / 1000).toFixed(1)}s${ev.cost ? ` · $${ev.cost}` : ""}`, ev.ok ? "ok" : "err");
    } else if (ev.phase === "error") scanLine(`  ${ev.label} · ${ev.error}`, "err");
    else if (ev.phase === "normalized") scanLine(`◈ ${ev.sources} WORLDS DETECTED · ${ev.subjectType.toUpperCase()} MODE`, "ok");
  };

  try {
    const { snapshot, subjectType, balance } = await buildUniverse({
      subject, apiKey: auth.apiKey, workspaceId: auth.workspaceId, apiBase: API_BASE, cache, fresh, onProgress,
    });
    if (!snapshot.sources.length) throw new Error("no data found for this subject");
    await idbSet("universes", slug, {
      snapshot,
      meta: {
        subject: snapshot.company.name,
        subjectType,
        sources: snapshot.sources.length,
        updatedAt: new Date().toISOString(),
      },
    });
    if (spent) scanLine(`◈ SCAN COST $${spent.toFixed(4)}${balance != null ? ` · WALLET $${balance}` : ""}`, "ok");
    scanLine(`◈ UNIVERSE READY — ENTERING…`, "ok");
    localStorage.setItem("activeUniverse", slug);
    setTimeout(() => location.reload(), 600);
  } catch (err) {
    switching = false;
    subjInput.disabled = false;
    subjStatus.classList.add("error");
    if (err.payment) {
      // 402: wallet is empty — send them to top up
      const line = scanLine("", "err");
      line.innerHTML = `✕ MONID BALANCE EMPTY — <a href="${WALLET_URL}" target="_blank" rel="noreferrer">top up your wallet ↗</a> then scan again (cached endpoints stay free)`;
    } else {
      scanLine(`SCAN FAILED — ${err.message}`, "err");
      if (/key|401|unauthorized|whoami/i.test(String(err.message))) {
        keyStep.hidden = false;
      }
    }
  }
}

async function linkKey(raw) {
  const key = raw.trim();
  if (!key) return;
  keyError.hidden = true;
  keyInput.disabled = true;
  try {
    await whoami({ apiKey: key, apiBase: API_BASE }); // validates + resolves workspace
    localStorage.setItem("monidKey", key);
    keyInput.value = "";
    keyInput.disabled = false;
    keyStep.hidden = true;
    updateKeyFooter();
    if (pendingSubject) { const s = pendingSubject; pendingSubject = null; scanSubject(s); }
  } catch (err) {
    keyInput.disabled = false;
    keyError.hidden = false;
    keyError.textContent = `✕ ${err.message} — check the key and try again`;
  }
}

document.getElementById("company-name").onclick = openSubjectModal;
document.getElementById("subject-close").onclick = closeSubjectModal;
subjModal.addEventListener("pointerdown", (e) => { if (e.target === subjModal) closeSubjectModal(); });
subjInput.addEventListener("keydown", (e) => {
  e.stopPropagation();
  if (e.key === "Enter" && subjInput.value.trim()) scanSubject(subjInput.value.trim());
});
keyInput.addEventListener("keydown", (e) => {
  e.stopPropagation();
  if (e.key === "Enter") linkKey(keyInput.value);
});
document.getElementById("oauth-connect").onclick = () => {
  // subject survives the login round-trip via sessionStorage
  beginConnect({ pendingSubject: pendingSubject || subjInput.value.trim() || null });
};
document.getElementById("key-alt-toggle").onclick = () => {
  const m = document.getElementById("key-manual");
  m.hidden = !m.hidden;
  if (!m.hidden) keyInput.focus();
};
document.getElementById("key-change").onclick = () => {
  keyStep.hidden = false;
  document.getElementById("key-manual").hidden = false;
  keyInput.focus();
};
document.getElementById("key-remove").onclick = () => {
  disconnect();
  localStorage.removeItem("monidKey");
  updateKeyFooter();
};

// returning from the Monid login redirect: finish the exchange and, if a
// scan was pending, resume it automatically
async function handleOAuthCallback() {
  let result = null;
  try {
    result = await completeConnect();
  } catch (err) {
    openSubjectModal();
    subjStatus.hidden = false;
    subjStatus.classList.add("error");
    scanLine(`✕ CONNECT FAILED — ${err.message}`, "err");
    return;
  }
  if (!result) return; // not an OAuth callback
  await openSubjectModal();
  const carry = result.carry || {};
  if (carry.pendingSubject) scanSubject(carry.pendingSubject);
}

document.getElementById("tour-play").onclick = runTour;
document.getElementById("tour-cfg-btn").onclick = () => {
  const m = document.getElementById("tour-menu");
  m.hidden = !m.hidden;
};
document.getElementById("tour-speed").oninput = (e) => {
  document.getElementById("tour-speed-val").textContent = `${Number(e.target.value).toFixed(2).replace(/\.?0+$/, "")}×`;
};

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  labelRenderer.setSize(innerWidth, innerHeight);
});

// ------------------------------------------------------------------ main
async function init() {
  let data = null;
  try {
    SHIPPED = await fetch("./data/index.json").then((r) => (r.ok ? r.json() : [])).catch(() => []);
    const active = localStorage.getItem("activeUniverse");

    // 1. the user's own scanned universe (IndexedDB)
    if (active) {
      const rec = await idbGet("universes", active).catch(() => null);
      if (rec) data = rec.snapshot;
      // 2. a shipped demo universe
      if (!data) {
        const m = SHIPPED.find((s) => s.slug === active);
        if (m) data = await fetch(`./data/${m.file}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      }
    }
    // 3. default: first shipped demo, else any local universe
    if (!data && SHIPPED.length) {
      data = await fetch(`./data/${SHIPPED[0].file}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    }
    if (!data) {
      const all = await idbAll("universes").catch(() => []);
      if (all.length) data = all[0][1].snapshot;
    }
    if (!data) throw new Error("no universes available — click the title to scan one");
  } catch (err) {
    document.querySelector(".loader-text").textContent = String(err.message || err).toUpperCase();
    document.getElementById("loader").classList.add("done");
    openSubjectModal();
    return;
  }
  DATA = data;

  buildSun(data.company);

  // orbit order: hottest discussion first (closest to the sun)
  const heat = (s) => (s.activity ?? 0.3) * 0.7 + (s.engagementRate ? clamp(s.engagementRate * 8, 0, 1) : 0) * 0.3;
  const ordered = [...data.sources].sort((a, b) => heat(b) - heat(a));

  // rings: top-3 topic diversity
  const ringIds = new Set(
    [...data.sources].sort((a, b) => (b.kwDiversity ?? 0) - (a.kwDiversity ?? 0)).slice(0, 3).map((s) => s.id)
  );

  const innerCount = Math.ceil(ordered.length * 0.3);
  ordered.forEach((s, i) => buildPlanet(s, i, ordered.length, ringIds.has(s.id)));
  buildAsteroidBelt(innerCount, ordered.length);
  buildComets(2);
  buildHud(data);

  bloom.strength = 0.5 + (data.company.popularity ?? 0.5) * 0.55;

  document.getElementById("loader").classList.add("done");
  camera.position.set(0, 300, 500);
  flyTo(new THREE.Vector3(0, 120, 260), new THREE.Vector3(0, 0, 0), 2.6);
}

const clk = new THREE.Clock();
let lastFrameAt = 0, statsFrames = 0;
function animate(now = 0) {
  requestAnimationFrame(animate);
  if (LOW_POWER && now - lastFrameAt < 31) return; // ~30fps cap
  lastFrameAt = now;
  statsFrames++;
  const dt = Math.min(clk.getDelta(), 0.05);
  const t = clk.elapsedTime;

  if (tween) {
    const k = Math.min(1, (performance.now() - tween.start) / tween.dur);
    const e = easeInOut(k);
    tween.qt.identity().slerp(tween.q, e);
    camera.position
      .copy(tween.d0)
      .applyQuaternion(tween.qt)
      .multiplyScalar(tween.r0 + (tween.r1 - tween.r0) * e);
    controls.target.lerpVectors(tween.t0, tween.t1, e);
    if (k >= 1) tween = null;
  }

  if (sun) {
    sun.rotation.y += dt * 0.03;
    const pulse = 1 + Math.sin(t * (1.2 + solarFlare * 1.6)) * (0.01 + solarFlare * 0.012);
    sun.scale.setScalar(sunBaseScale * pulse);
  }

  // label LOD: px height of half the fov at 1 unit distance
  const pxPerUnit = innerHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));

  for (const p of planets) {
    p.angle += p.speed * dt;
    const pos = planetWorldPos(p);
    const prev = p.group.position.clone();
    p.group.position.copy(pos);
    p.mesh.rotation.y += p.spin * dt;
    if (p.cloudMesh) p.cloudMesh.rotation.y += p.spin * dt * 1.35;

    // planet-name label: hide when tiny on screen, scale font with apparent size
    const pxR = (p.size / Math.max(camera.position.distanceTo(pos), 1e-3)) * pxPerUnit;
    p.label.visible = focused === p || (p.label.visible ? pxR >= 5.4 : pxR >= 6.4);
    if (p.label.visible) {
      const fs = clamp(11 * (0.68 + pxR / 55), 8, 14.5);
      if (Math.abs(fs - p.lblFs) > 0.25) {
        p.lblFs = fs;
        p.labelEl.style.fontSize = `${fs.toFixed(1)}px`;
        p.labelEl.style.opacity = String(clamp(0.45 + pxR / 20, 0.45, 1));
      }
    }

    for (const m of p.moons) {
      m.angle += m.speed * dt;
      m.mesh.position.set(
        Math.cos(m.angle) * m.r,
        Math.sin(m.angle * 0.7) * m.r * m.incl * 0.4,
        Math.sin(m.angle) * m.r
      );
      m.mesh.rotation.y += dt * 0.2;
    }

    for (const sat of p.sats) {
      sat.angle += sat.speed * dt;
      const sp = new THREE.Vector3(Math.cos(sat.angle) * sat.r, 0, Math.sin(sat.angle) * sat.r);
      sp.applyAxisAngle(new THREE.Vector3(1, 0, 0), sat.incl);
      sat.mesh.position.copy(sp);
      sat.mesh.lookAt(p.group.position.clone().add(sp).add(new THREE.Vector3(0, 1, 0)));
      sat.blink.material.opacity = Math.max(0, Math.sin(t * 4 + sat.phase)) > 0.86 ? 0.9 : 0.06;
    }

    updateShips(p, pos, dt);

    if (focused === p) {
      const delta = pos.clone().sub(prev);
      if (tween) {
        // planet keeps orbiting mid-flight: drag the destination along with it
        tween.p1.add(delta);
        tween.t1.add(delta);
        tween.r1 = tween.p1.length();
        tween.q.setFromUnitVectors(tween.d0, tmpV.copy(tween.p1).normalize());
      } else {
        camera.position.add(delta);
        controls.target.add(delta);
      }
    }

    const targetEm = hovered === p ? 0.35 : (p.mesh.material.emissiveMap ? (p.k.type === "lava" ? 1.5 : 1.15) : 0);
    if (hovered === p && !p.mesh.material.emissiveMap) {
      p.mesh.material.emissive = new THREE.Color(p.source.color || "#88aacc");
      p.mesh.material.emissiveIntensity += (0.18 - p.mesh.material.emissiveIntensity) * Math.min(1, dt * 8);
    } else if (!p.mesh.material.emissiveMap) {
      p.mesh.material.emissiveIntensity += (0 - p.mesh.material.emissiveIntensity) * Math.min(1, dt * 8);
    }
  }

  if (beltGroup) beltGroup.rotation.y += dt * 0.008;

  if (Math.abs(pointer.x) <= 1 && Math.abs(pointer.y) <= 1) {
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(planets.map((p) => p.mesh));
    hovered = hits.length ? planets[hits[0].object.userData.planetIdx] : null;
    document.body.style.cursor = hovered ? "pointer" : "default";
  }

  updateComets(t, dt);
  twinkle.material.opacity = 0.4 + Math.sin(t * 2.3) * 0.2;

  if (clockEl && (animate._f = (animate._f || 0) + 1) % 30 === 0) {
    clockEl.textContent = `T+${t.toFixed(0)}s · ${new Date().toUTCString().slice(17, 25)} UTC`;
  }

  controls.update();
  composer.render();
  labelRenderer.render(scene, camera);
}

init().then(handleOAuthCallback);
animate();
