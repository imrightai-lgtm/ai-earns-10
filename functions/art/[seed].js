// GET /art/<seed>  ->  a unique generative "dawn" banner as an SVG image.
//
// Made to be *embedded on other people's pages* (GitHub READMEs, Nostr/Git
// profiles) exactly like a shields.io badge:
//
//     ![my banner](https://ai-experiment.pages.dev/art/<your-name>)
//
// The seed can be anything — a handle, a repo name, an npub. The same seed
// always paints the same dawn (deterministic), a different seed a different one.
// Each embed renders on its host's traffic, carrying a small signature back to
// the experiment. Built by an autonomous AI. No tracking, nothing stored.
//
// Optional query params:  ?w=1200&h=300   (size, clamped)   ?label=Text (caption)
//
// The renderer is a dependency-free, self-contained SVG string builder so it
// runs in this Cloudflare Pages Function AND under Node for local tests
// (see tools/test-art.mjs). renderArtSVG is exported for that reason.

export function onRequest(context) {
  const { request, params } = context;
  const url = new URL(request.url);
  let seed = params && params.seed ? params.seed : "";
  try { seed = decodeURIComponent(seed); } catch (e) { /* keep raw */ }
  seed = seed.replace(/\.svg$/i, "").trim();
  const hasLabel = url.searchParams.has("label");
  const svg = renderArtSVG(seed || "anon", {
    w: url.searchParams.get("w"),
    h: url.searchParams.get("h"),
    label: hasLabel ? url.searchParams.get("label") : (seed || "anon"),
  });
  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      // Deterministic output -> safe to cache hard (GitHub camo caches anyway).
      "cache-control": "public, max-age=86400, s-maxage=86400",
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
    },
  });
}

// ---------------------------------------------------------------- engine ----

const PALETTES = [
  { top: "#0b1026", mid: "#3b3f72", bottom: "#f1a564", water: "#11132b", sun: "#ffe6b8" },
  { top: "#0a0f24", mid: "#4a2f63", bottom: "#e57a8c", water: "#160f24", sun: "#ffd9c2" },
  { top: "#04121f", mid: "#16566b", bottom: "#e8c873", water: "#06141c", sun: "#fff0c0" },
  { top: "#0c0a1f", mid: "#5b3a5f", bottom: "#f0925e", water: "#120a1a", sun: "#ffe2b0" },
  { top: "#071226", mid: "#2c4a73", bottom: "#cfe0e8", water: "#0a1420", sun: "#f2f6ff" },
];

// string -> 32-bit seed (xmur3), then mulberry32 PRNG — same family as card.html.
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function num(x) { return Math.round(x * 100) / 100; }
function hx(h) {
  h = String(h).replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const v = parseInt(h, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
function mixHex(a, b, t) {
  const x = hx(a), y = hx(b);
  return "rgb(" + Math.round(x[0] + (y[0] - x[0]) * t) + "," +
    Math.round(x[1] + (y[1] - x[1]) * t) + "," +
    Math.round(x[2] + (y[2] - x[2]) * t) + ")";
}
function clampInt(v, def, lo, hi) {
  let x = parseInt(v, 10);
  if (!Number.isFinite(x)) x = def;
  return Math.max(lo, Math.min(hi, x));
}
function branch(out, x, y, ang, len, wid, rng) {
  if (len < 3.5 || out.length > 1200) return;
  const x2 = x + Math.cos(ang) * len, y2 = y + Math.sin(ang) * len;
  out.push('<line x1="' + num(x) + '" y1="' + num(y) + '" x2="' + num(x2) +
    '" y2="' + num(y2) + '" stroke-width="' + num(Math.max(0.6, wid)) + '"/>');
  branch(out, x2, y2, ang - (0.3 + rng() * 0.3), len * (0.66 + rng() * 0.12), wid * 0.66, rng);
  branch(out, x2, y2, ang + (0.3 + rng() * 0.3), len * (0.66 + rng() * 0.12), wid * 0.66, rng);
  if (rng() > 0.62) branch(out, x2, y2, ang + (rng() - 0.5) * 0.3, len * 0.6, wid * 0.6, rng);
}

export function renderArtSVG(seedStr, opts) {
  opts = opts || {};
  seedStr = seedStr == null ? "" : String(seedStr);
  const W = clampInt(opts.w, 1200, 320, 1600);
  const H = clampInt(opts.h, 300, 120, 640);
  const label = opts.label == null ? seedStr : String(opts.label);

  const seed = xmur3(seedStr || "anon")();
  const r = mulberry32(seed);
  const p = PALETTES[Math.floor(r() * PALETTES.length)];
  const horizonY = H * 0.66;

  const defs = [];
  const body = [];
  let idc = 0;
  const id = () => "d" + (idc++);

  // --- sky ---
  const skyId = id();
  defs.push('<linearGradient id="' + skyId + '" x1="0" y1="0" x2="0" y2="' + num(horizonY) +
    '" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="' + p.top +
    '"/><stop offset="0.62" stop-color="' + p.mid + '"/><stop offset="1" stop-color="' + p.bottom + '"/></linearGradient>');
  body.push('<rect x="0" y="0" width="' + W + '" height="' + num(horizonY + 1) + '" fill="url(#' + skyId + ')"/>');

  // --- stars ---
  const starCount = Math.floor(30 + r() * 60);
  const starLim = horizonY * 0.85;
  let stars = "";
  for (let i = 0; i < starCount; i++) {
    const x = r() * W, y = r() * starLim, rr = r() * 1.1 + 0.25;
    const a = Math.max(0, 0.9 * (1 - y / starLim)) * (0.5 + r() * 0.5);
    if (a < 0.05) continue;
    stars += '<circle cx="' + num(x) + '" cy="' + num(y) + '" r="' + num(rr) + '" fill="#fff" opacity="' + num(a) + '"/>';
  }
  if (stars) body.push(stars);

  // --- sun + glow ---
  const sunCx = (0.18 + r() * 0.34) * W, sunCy = (0.42 + r() * 0.12) * H, sunR = (0.03 + r() * 0.02) * W;
  const glowId = id();
  defs.push('<radialGradient id="' + glowId + '" cx="' + num(sunCx) + '" cy="' + num(sunCy) + '" r="' + num(sunR * 6) +
    '" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="' + p.bottom + '" stop-opacity="0.85"/><stop offset="0.18" stop-color="' +
    p.bottom + '" stop-opacity="0.5"/><stop offset="1" stop-color="' + p.bottom + '" stop-opacity="0"/></radialGradient>');
  body.push('<circle cx="' + num(sunCx) + '" cy="' + num(sunCy) + '" r="' + num(sunR * 6) + '" fill="url(#' + glowId + ')"/>');
  body.push('<circle cx="' + num(sunCx) + '" cy="' + num(sunCy) + '" r="' + num(sunR) + '" fill="' + p.sun + '"/>');

  // --- mountains ---
  const ridges = 2 + Math.floor(r() * 3);
  const step = Math.max(6, W / 140);
  for (let k = 0; k < ridges; k++) {
    const crest = horizonY * (0.80 + 0.066 * k), amp = 9 + 4 * k, ph = r() * 6.283, ph2 = r() * 6.283;
    const col = mixHex("#8085b5", "#23243f", ridges > 1 ? k / (ridges - 1) : 0);
    let d = "M0," + num(horizonY);
    for (let x = 0; x <= W; x += step) {
      const t = x / W;
      const y = crest - amp * Math.sin(t * Math.PI * (2 + k) + ph) - amp * 0.5 * Math.sin(t * Math.PI * (5 + k) + ph2);
      d += "L" + num(x) + "," + num(y);
    }
    d += "L" + W + "," + num(horizonY) + "Z";
    body.push('<path d="' + d + '" fill="' + col + '" opacity="0.97"/>');
  }

  // --- water ---
  const waterId = id();
  defs.push('<linearGradient id="' + waterId + '" x1="0" y1="' + num(horizonY) + '" x2="0" y2="' + H +
    '" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="' + p.water + '"/><stop offset="1" stop-color="#05060f"/></linearGradient>');
  body.push('<rect x="0" y="' + num(horizonY) + '" width="' + W + '" height="' + num(H - horizonY) + '" fill="url(#' + waterId + ')"/>');
  let refl = "";
  for (let yy = horizonY + 3; yy < H; yy += 5) {
    const f = (yy - horizonY) / (H - horizonY);
    const w = sunR * (1.2 + f * 2.4);
    const a = Math.max(0, 0.42 * (1 - f));
    if (a < 0.03) continue;
    refl += '<rect x="' + num(sunCx - w / 2) + '" y="' + num(yy) + '" width="' + num(w) + '" height="1.8" fill="' + p.sun + '" opacity="' + num(a) + '"/>';
  }
  if (refl) body.push(refl);

  // --- birds ---
  if (r() > 0.35) {
    const nb = 2 + Math.floor(r() * 4), bcx = (0.5 + r() * 0.35) * W, bcy = (0.2 + r() * 0.15) * H, sp = 0.1 + r() * 0.1;
    let bd = "";
    for (let b = 0; b < nb; b++) {
      const bx = bcx + (r() - 0.5) * sp * W, by = bcy + (r() - 0.5) * sp * H * 0.7, ww = 4 + r() * 4;
      bd += '<path d="M' + num(bx - ww) + "," + num(by) + " Q" + num(bx) + "," + num(by - ww * 0.7) + " " + num(bx) + "," + num(by) +
        " Q" + num(bx) + "," + num(by - ww * 0.7) + " " + num(bx + ww) + "," + num(by) + '"/>';
    }
    body.push('<g fill="none" stroke="#1a1730" stroke-width="1.4" stroke-linecap="round">' + bd + "</g>");
  }

  // --- lone tree ---
  if (r() > 0.4) {
    const tx = (0.74 + r() * 0.18) * W, sc = 0.8 + r() * 0.5;
    const seg = [];
    branch(seg, tx, horizonY, -Math.PI / 2 - 0.12, 40 * sc, 4 * sc, r);
    body.push('<g stroke="#0d0b1c" stroke-linecap="round" fill="none">' + seg.join("") + "</g>");
  }

  // --- bottom scrim + caption + signature ---
  const scrimId = id();
  defs.push('<linearGradient id="' + scrimId + '" x1="0" y1="' + num(H * 0.5) + '" x2="0" y2="' + H +
    '" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.55"/></linearGradient>');
  body.push('<rect x="0" y="' + num(H * 0.48) + '" width="' + W + '" height="' + num(H * 0.52) + '" fill="url(#' + scrimId + ')"/>');

  const pad = Math.round(H * 0.11);
  let lab = String(label).trim();
  if (lab.length > 30) lab = lab.slice(0, 29) + "…";
  const labSize = Math.round(H * 0.15);
  const sigSize = Math.max(9, Math.round(H * 0.05));
  const FONT = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
  if (lab) {
    body.push('<text x="' + pad + '" y="' + num(H - pad - sigSize * 1.5) + '" font-family="' + FONT +
      '" font-size="' + labSize + '" font-weight="700" fill="#ffffff">' + esc(lab) + "</text>");
  }
  body.push('<text x="' + pad + '" y="' + num(H - pad) + '" font-family="' + FONT +
    '" font-size="' + sigSize + '" font-weight="600" fill="#ffffff" fill-opacity="0.82">' +
    "generative art · made by an autonomous AI · ai-experiment.pages.dev</text>");

  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + " " + H +
    '" role="img" aria-label="' + esc((lab || "a dawn") + " — a generative dawn made by an autonomous AI") + '">' +
    "<defs>" + defs.join("") + "</defs>" +
    body.join("") +
    "</svg>";
}
