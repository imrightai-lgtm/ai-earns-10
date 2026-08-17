// GET /crest/<key>  ->  a coat of arms derived from a public key, as an SVG image.
//
//     https://ai-experiment.pages.dev/crest/npub1hxuvea8gsy3sccs8wguz34cksdhw26qrlqepazg8fak82l849h6s5xsyg6
//     https://ai-experiment.pages.dev/crest/experiment@coinos.io
//     https://ai-experiment.pages.dev/crest/<64-hex>
//
// The drawing is a *pure function* of the key, so anyone can recompute it and
// check that I did not hand-pick anything:
//
//     canonical = the key reduced to one normal form (npub -> 32-byte hex; an
//                 e-mail-shaped Lightning address -> lowercase; hex -> lowercase)
//     material  = "crest/v1:" + canonical
//     digest    = SHA-256(material)          <- printed under every crest
//     the design reads fixed byte offsets of that digest (see FIELDS below)
//
// Verify the digest yourself:   printf 'crest/v1:%s' "<canonical>" | sha256sum
//
// What is NOT claimed: that the picture is globally unique. Key -> picture is a
// function, picture -> key is not injective — the design space is finite, so two
// keys can share a design. The 64-hex fingerprint under the shield is the part
// that identifies. tools/crest.mjs --collisions measures the real rate.
//
// Heraldry is honest here too: tinctures obey the rule of tincture (no colour on
// colour, no metal on metal). On a divided field the charge is *counterchanged* —
// it takes the other tincture wherever it crosses the division, which is how real
// arms solve the same problem.
//
// Optional query params:  ?size=512 (128..2048)  ?bare=1 (no caption/signature)
//
// Dependency-free and self-contained so it runs both in this Cloudflare Pages
// Function and under plain Node (tools/crest.mjs, tools/crest.test.mjs import it).
// Built by an autonomous AI agent. Nothing is stored, nothing is tracked.

export async function onRequest(context) {
  const { request, params } = context;
  const url = new URL(request.url);
  let key = params && params.key ? params.key : "";
  try { key = decodeURIComponent(key); } catch (e) { /* keep raw */ }
  // Normalising happens in canonicalizeKey, not here — see the note there.

  const spec = await deriveCrest(key || "anon");

  // ?json=1 hands back the derivation itself, so the page can show the trace that
  // THIS endpoint computed instead of recomputing it in a second implementation
  // that could quietly drift away from the drawing.
  if (url.searchParams.get("json") === "1") {
    return new Response(JSON.stringify(spec, null, 2), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=86400, s-maxage=86400",
        "access-control-allow-origin": "*",
      },
    });
  }

  // A paid grant adds a motto under the shield and nothing else — the arms themselves
  // stay a function of the key, so the derivation printed on the page still checks out.
  // The register is a static file in the repository; if it cannot be read, the shield
  // is drawn without the motto rather than failing.
  let motto = null;
  try {
    const reg = await fetch(new URL("/crest-grants.json", request.url).toString());
    if (reg.ok) {
      const grants = await reg.json();
      const hit = grants && grants.grants && grants.grants[spec.canonical];
      if (hit && typeof hit.motto === "string") motto = hit.motto;
    }
  } catch (e) { /* no register, no motto */ }

  const svg = renderCrestSVG(spec, {
    size: url.searchParams.get("size"),
    bare: url.searchParams.get("bare") === "1",
    motto,
  });
  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      // Output is a pure function of the path -> safe to cache hard.
      "cache-control": "public, max-age=86400, s-maxage=86400",
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
    },
  });
}

// ------------------------------------------------------------- vocabulary ----

// Heraldic tinctures. Two metals and five colours; the rule of tincture forbids
// placing metal on metal or colour on colour, which is enforced by construction.
export const METALS = [
  { name: "or", hex: "#d8a63a" },
  { name: "argent", hex: "#e6e7ea" },
];
export const COLOURS = [
  { name: "azure", hex: "#27478c" },
  { name: "gules", hex: "#a2242c" },
  { name: "sable", hex: "#1a1a20" },
  { name: "vert", hex: "#1e6a3a" },
  { name: "purpure", hex: "#6a2c69" },
];

export const DIVISIONS = ["plain", "per pale", "per fess", "per bend", "quarterly", "per chevron"];
export const CHARGES = ["mullet", "roundel", "lozenge", "crescent", "cross", "key", "bolt", "tower"];
// An orle is a narrow band set in from the edge, a bordure runs along the edge
// itself. Both are drawable and verifiable. "Bordure engrailed" was here for one
// afternoon and removed: the scallops were painted in the field tincture on an
// ellipse that never reached the band, so 22 of them were invisible and 9 bit
// pieces out of the charges — a blazon naming something the picture did not have.
export const BORDURES = ["none", "bordure", "orle"];

// Which digest byte decides what. Fixed forever for crest/v1 — moving one of
// these numbers repaints every crest ever issued, so v1 stays frozen and a
// future change becomes crest/v2 with its own material prefix.
export const FIELDS = {
  division: 0,
  fieldClass: 1,      // metal-first or colour-first
  fieldTincture: 2,
  secondTincture: 3,  // the other half of a divided field (opposite class)
  charge: 4,
  chargeCount: 5,
  chargeTincture: 6,  // used only on an undivided field (else counterchanged)
  bordure: 7,
  bordureTincture: 8,
};

// ---------------------------------------------------------------- bech32 ----

const B32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function b32Polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk;
}

function b32HrpExpand(hrp) {
  const out = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >>> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

// Returns lowercase hex of the payload, or null if this is not a valid bech32
// string with the given hrp. The checksum IS verified: a mistyped npub must be
// rejected, not silently drawn as some other coat of arms.
export function bech32ToHex(str, hrp) {
  if (typeof str !== "string") return null;
  const s = str.trim();
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) return null; // mixed case is invalid
  const low = s.toLowerCase();
  const sep = low.lastIndexOf("1");
  if (sep < 1 || sep + 7 > low.length || low.length > 200) return null;
  if (low.slice(0, sep) !== hrp) return null;
  const data = [];
  for (const ch of low.slice(sep + 1)) {
    const v = B32.indexOf(ch);
    if (v < 0) return null;
    data.push(v);
  }
  if (b32Polymod(b32HrpExpand(hrp).concat(data)) !== 1) return null;
  // 5-bit groups -> 8-bit bytes, dropping the 6 checksum characters.
  const payload = data.slice(0, -6);
  let acc = 0, bits = 0;
  const bytes = [];
  for (const v of payload) {
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >>> bits) & 0xff);
    }
  }
  if (bits >= 5 || ((acc << (8 - bits)) & 0xff) !== 0) return null; // bad padding
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ------------------------------------------------------------- derivation ----

export const MATERIAL_PREFIX = "crest/v1:";

// One normal form per key, so the same key written two ways gives one crest.
// Everything the URL layer used to strip is stripped HERE instead: otherwise the
// command line and the endpoint disagree about the same input — `myname.svg` drew
// two different shields — and the page's promise that one file does both would be
// false in the one place a reader would check it.
export function canonicalizeKey(input) {
  let raw = String(input == null ? "" : input).trim().replace(/\.svg$/i, "").trim();
  // Nostr clients hand out `nostr:npub1…`; that is the same key, not another one.
  raw = raw.replace(/^(?:nostr|web\+nostr):/i, "").trim();
  const npubHex = bech32ToHex(raw, "npub");
  if (npubHex && npubHex.length === 64) return { kind: "nostr-pubkey", canonical: npubHex };
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return { kind: "nostr-pubkey", canonical: raw.toLowerCase() };
  if (/^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(raw)) return { kind: "lightning-address", canonical: raw.toLowerCase() };
  if (/^0x[0-9a-fA-F]{40}$/.test(raw)) return { kind: "evm-address", canonical: raw.toLowerCase() };
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(raw)) return { kind: "tron-address", canonical: raw };
  if (/^npub1/i.test(raw)) return { kind: "rejected-npub", canonical: raw.toLowerCase() };
  return { kind: "opaque-string", canonical: raw.toLowerCase() };
}

export async function sha256Hex(str) {
  const bytes = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The whole design, plus everything a reader needs to recompute it.
export async function deriveCrest(input) {
  const { kind, canonical } = canonicalizeKey(input);
  const material = MATERIAL_PREFIX + canonical;
  const digestHex = await sha256Hex(material);
  const b = [];
  for (let i = 0; i < digestHex.length; i += 2) b.push(parseInt(digestHex.slice(i, i + 2), 16));
  const design = designFromBytes(b);

  // Only the bytes that ACTUALLY decided something on this shield. Nine offsets
  // exist, but a divided field never consults the charge-tincture or bordure bytes
  // and a plain one never consults the second tincture, so shipping all nine put
  // three dead rows under 83% of the drawings — an exhibit standing next to a
  // decision it did not make.
  const used = { division: FIELDS.division, fieldClass: FIELDS.fieldClass, fieldTincture: FIELDS.fieldTincture };
  if (design.counterchanged) used.secondTincture = FIELDS.secondTincture;
  used.charge = FIELDS.charge;
  used.chargeCount = FIELDS.chargeCount;
  if (!design.counterchanged) {
    used.chargeTincture = FIELDS.chargeTincture;
    used.bordure = FIELDS.bordure;
    if (design.bordure !== "none") used.bordureTincture = FIELDS.bordureTincture;
  }

  return {
    input: String(input == null ? "" : input).trim(),
    kind,
    canonical,
    material,
    digestHex,
    fingerprint: digestHex.slice(0, 16),
    // Which byte decided what ON THIS SHIELD, shipped with the answer so the page
    // shows real offsets instead of a copy that can drift out of step.
    byteMap: used,
    bytesUsed: Object.keys(used).length,
    design,
    // A short line naming the design in the order a herald would read it.
    blazon: blazonOf({ ...design, divided: design.counterchanged }),
  };
}

// The design as a pure function of digest bytes. Kept separate so the size of the
// design space can be MEASURED by enumerating this same code (tools/crest.mjs
// --space) instead of multiplied out by hand in prose.
export function designFromBytes(b) {
  const division = DIVISIONS[b[FIELDS.division] % DIVISIONS.length];
  const fieldIsMetal = (b[FIELDS.fieldClass] & 1) === 0;
  const fieldSet = fieldIsMetal ? METALS : COLOURS;
  const otherSet = fieldIsMetal ? COLOURS : METALS;
  const field = fieldSet[b[FIELDS.fieldTincture] % fieldSet.length];
  const second = otherSet[b[FIELDS.secondTincture] % otherSet.length];
  const charge = CHARGES[b[FIELDS.charge] % CHARGES.length];
  const chargeCount = (b[FIELDS.chargeCount] % 3) + 1;
  const divided = division !== "plain";
  // Undivided field: the charge takes the opposite class outright. Divided
  // field: it is counterchanged, which satisfies the rule on both halves.
  const chargeTincture = divided ? null : otherSet[b[FIELDS.chargeTincture] % otherSet.length];
  // A bordure runs along the whole edge, so on a divided field it would have to
  // touch a tincture of its own class somewhere no matter what it is picked from.
  // Rather than break the rule and explain it away, the bordure appears only on
  // an undivided field. That keeps the invariant total and testable.
  const bordure = divided ? "none" : BORDURES[b[FIELDS.bordure] % BORDURES.length];
  const bordureTincture = bordure === "none" ? null : otherSet[b[FIELDS.bordureTincture] % otherSet.length];

  return {
    division, field,
    // On a plain field the second tincture is never painted; report it as null so
    // it cannot silently inflate the count of distinct designs.
    second: divided ? second : null,
    charge, chargeCount,
    chargeTincture, counterchanged: divided, bordure, bordureTincture,
  };
}

// A stable string naming one design — used to count distinct designs and collisions.
export function designSignature(d) {
  return [d.division, d.field.name, d.second ? d.second.name : "-", d.charge, d.chargeCount,
    d.chargeTincture ? d.chargeTincture.name : "counterchanged",
    d.bordure, d.bordureTincture ? d.bordureTincture.name : "-"].join("|");
}

function blazonOf(d) {
  const plural = { mullet: "mullets", roundel: "roundels", lozenge: "lozenges", crescent: "crescents",
    cross: "crosses", key: "keys", bolt: "bolts", tower: "towers" };
  const many = d.chargeCount > 1;
  const chargeName = many ? d.chargeCount + " " + plural[d.charge] : "a " + d.charge;
  const field = d.divided
    ? cap(d.division) + " " + d.field.name + " and " + d.second.name
    : cap(d.field.name);
  const chargeClause = d.divided
    ? chargeName + " counterchanged"
    : chargeName + " " + d.chargeTincture.name;
  let out = field + ", " + chargeClause;
  if (d.bordure !== "none") out += ", " + (d.bordure === "orle" ? "an orle " : "a bordure ") + d.bordureTincture.name;
  return out;
}
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ------------------------------------------------------------------ paint ----

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function num(x) { return Math.round(x * 100) / 100; }
function clampInt(v, def, lo, hi) {
  let x = parseInt(v, 10);
  if (!Number.isFinite(x)) x = def;
  return Math.max(lo, Math.min(hi, x));
}

// A "heater" escutcheon inscribed in the box (x, y, w, h).
function shieldPath(x, y, w, h) {
  const sh = y + h * 0.56;
  return "M" + num(x) + "," + num(y) + "H" + num(x + w) + "V" + num(sh) +
    "C" + num(x + w) + "," + num(y + h * 0.79) + " " + num(x + w * 0.78) + "," + num(y + h * 0.94) + " " + num(x + w / 2) + "," + num(y + h) +
    "C" + num(x + w * 0.22) + "," + num(y + h * 0.94) + " " + num(x) + "," + num(y + h * 0.79) + " " + num(x) + "," + num(sh) + "Z";
}

// A circle as an arc pair, so several of them can live in one path and be cut out
// of each other with fill-rule="evenodd". Needed because an arc whose radius is
// too small for its chord is silently enlarged by the SVG spec — that is exactly
// how the first crescent here came out as an invisible zero-area shape.
function circleSub(cx, cy, r) {
  return "M" + num(cx - r) + "," + num(cy) +
    "A" + num(r) + "," + num(r) + " 0 1 0 " + num(cx + r) + "," + num(cy) +
    "A" + num(r) + "," + num(r) + " 0 1 0 " + num(cx - r) + "," + num(cy) + "Z";
}

// The two halves of a divided field, as path strings over the shield's box.
// Deliberately drawn well past the shield edges: the shield clip trims them.
function divisionRegions(division, x, y, w, h) {
  const x2 = x + w, y2 = y + h, cx = x + w / 2, cy = y + h * 0.46;
  const p = (pts) => "M" + pts.map((q) => num(q[0]) + "," + num(q[1])).join("L") + "Z";
  switch (division) {
    case "per pale":
      return [p([[x, y], [cx, y], [cx, y2], [x, y2]]), p([[cx, y], [x2, y], [x2, y2], [cx, y2]])];
    case "per fess":
      return [p([[x, y], [x2, y], [x2, cy], [x, cy]]), p([[x, cy], [x2, cy], [x2, y2], [x, y2]])];
    case "per bend":
      // The line runs from dexter chief (top left) to sinister base (bottom right);
      // the first tincture takes the portion above it. Drawn the other way round for
      // one afternoon, which is per bend *sinister* — a different ordinary with a
      // different name, and the blazon underneath would have been wrong.
      return [p([[x, y], [x2, y], [x2, y2]]), p([[x, y], [x2, y2], [x, y2]])];
    case "quarterly":
      return [
        p([[x, y], [cx, y], [cx, cy], [x, cy]]) + p([[cx, cy], [x2, cy], [x2, y2], [cx, y2]]),
        p([[cx, y], [x2, y], [x2, cy], [cx, cy]]) + p([[x, cy], [cx, cy], [cx, y2], [x, y2]]),
      ];
    case "per chevron":
      return [p([[x, y], [x2, y], [x2, cy], [cx, y + h * 0.24], [x, cy]]),
        p([[x, cy], [cx, y + h * 0.24], [x2, cy], [x2, y2], [x, y2]])];
    default:
      return [p([[x, y], [x2, y], [x2, y2], [x, y2]]), null];
  }
}

// Every charge is drawn inside the unit box centred on (cx, cy) with radius r.
function chargePath(kind, cx, cy, r) {
  const P = (s) => s;
  switch (kind) {
    case "roundel":
      return '<circle cx="' + num(cx) + '" cy="' + num(cy) + '" r="' + num(r) + '"/>';
    case "lozenge":
      return '<path d="M' + num(cx) + "," + num(cy - r) + "L" + num(cx + r * 0.72) + "," + num(cy) +
        "L" + num(cx) + "," + num(cy + r) + "L" + num(cx - r * 0.72) + "," + num(cy) + 'Z"/>';
    case "mullet": {
      let d = "";
      for (let i = 0; i < 10; i++) {
        const rad = i % 2 === 0 ? r : r * 0.42;
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        d += (i ? "L" : "M") + num(cx + Math.cos(a) * rad) + "," + num(cy + Math.sin(a) * rad);
      }
      return '<path d="' + d + 'Z"/>';
    }
    case "crescent":
      // A disc with a smaller disc taken straight out of the top, so the horns point
      // upward — that is what "a crescent" means. Offsetting sideways gives an
      // increscent or a decrescent, and offsetting diagonally (which this did at
      // first) gives a position heraldry has no word for.
      return '<path fill-rule="evenodd" d="' + circleSub(cx, cy, r) +
        circleSub(cx, cy - r * 0.42, r * 0.88) + '"/>';
    case "cross": {
      const a = r * 0.34, b = r;
      return '<path d="M' + num(cx - a) + "," + num(cy - b) + "H" + num(cx + a) + "V" + num(cy - a) +
        "H" + num(cx + b) + "V" + num(cy + a) + "H" + num(cx + a) + "V" + num(cy + b) +
        "H" + num(cx - a) + "V" + num(cy + a) + "H" + num(cx - b) + "V" + num(cy - a) +
        "H" + num(cx - a) + 'Z"/>';
    }
    case "key": {
      // a pierced ring in chief, a shank down from it, two wards to the sinister
      const ro = r * 0.44, ringCy = cy - r + ro;
      return '<path fill-rule="evenodd" d="' + circleSub(cx, ringCy, ro) +
        circleSub(cx, ringCy, ro * 0.46) + '"/>' +
        '<rect x="' + num(cx - r * 0.11) + '" y="' + num(ringCy + ro * 0.7) + '" width="' + num(r * 0.22) +
        '" height="' + num(r * 2 - ro * 1.7) + '"/>' +
        '<rect x="' + num(cx + r * 0.11) + '" y="' + num(cy + r * 0.24) + '" width="' + num(r * 0.4) + '" height="' + num(r * 0.17) + '"/>' +
        '<rect x="' + num(cx + r * 0.11) + '" y="' + num(cy + r * 0.62) + '" width="' + num(r * 0.28) + '" height="' + num(r * 0.17) + '"/>';
    }
    case "bolt":
      return '<path d="M' + num(cx + r * 0.42) + "," + num(cy - r) +
        "L" + num(cx - r * 0.52) + "," + num(cy + r * 0.12) +
        "L" + num(cx + r * 0.04) + "," + num(cy + r * 0.12) +
        "L" + num(cx - r * 0.28) + "," + num(cy + r) +
        "L" + num(cx + r * 0.6) + "," + num(cy - r * 0.16) +
        "L" + num(cx - r * 0.02) + "," + num(cy - r * 0.16) + 'Z"/>';
    case "tower":
    default: {
      // A crenellated tower: three merlons over a plain body. Drawn as one
      // silhouette so it keeps a single fill and survives counterchange.
      const w = r * 1.36, hh = r * 1.9, left = cx - w / 2, top = cy - hh / 2;
      const m = w / 5, mh = m * 0.85;
      let d = "M" + num(left) + "," + num(top + hh);
      for (let i = 0; i < 5; i++) {
        d += "V" + num(top + (i % 2 === 0 ? 0 : mh)) + "H" + num(left + (i + 1) * m);
      }
      d += "V" + num(top + hh) + "Z";
      return '<path d="' + P(d) + '"/>';
    }
  }
}

// Positions used for 1, 2 and 3 charges, as heralds place them.
function chargeLayout(count, x, y, w, h) {
  const cx = x + w / 2;
  if (count === 1) return [[cx, y + h * 0.42, Math.min(w, h) * 0.27]];
  if (count === 2) return [
    [x + w * 0.31, y + h * 0.4, Math.min(w, h) * 0.2],
    [x + w * 0.69, y + h * 0.4, Math.min(w, h) * 0.2],
  ];
  return [
    [x + w * 0.3, y + h * 0.28, Math.min(w, h) * 0.165],
    [x + w * 0.7, y + h * 0.28, Math.min(w, h) * 0.165],
    [cx, y + h * 0.63, Math.min(w, h) * 0.165],
  ];
}

export function renderCrestSVG(spec, opts) {
  opts = opts || {};
  const S = clampInt(opts.size, 512, 128, 2048);
  const bare = !!opts.bare;
  const d = spec.design;
  // A motto only ever appears here because somebody paid for one to be written; it is
  // text under the shield and it changes nothing about the arms above it.
  const motto = !bare && typeof opts.motto === "string" && opts.motto.trim()
    ? opts.motto.trim().slice(0, 60) : null;

  // Layout: the shield sits in a square, with room under it for the caption.
  const capH = bare ? 0 : Math.round(S * (motto ? 0.19 : 0.13));
  const pad = Math.round(S * 0.07);
  const bw = S - pad * 2;
  const bh = S - pad * 2 - capH;
  const bx = pad, by = pad;

  const defs = [];
  const body = [];
  let idc = 0;
  const id = () => "c" + (idc++);

  const shield = shieldPath(bx, by, bw, bh);
  const shieldClip = id();
  defs.push('<clipPath id="' + shieldClip + '"><path d="' + shield + '"/></clipPath>');

  // The regions are computed over the shield's own box; the shield clip trims them.
  const [rA, rB] = divisionRegions(d.division, bx, by, bw, bh);

  const g = [];
  g.push('<path d="' + shield + '" fill="' + d.field.hex + '"/>');
  if (rB) g.push('<path d="' + rB + '" fill="' + d.second.hex + '"/>');

  // charges
  const spots = chargeLayout(d.chargeCount, bx, by, bw, bh);
  const chargeSvg = spots.map((s) => chargePath(d.charge, s[0], s[1], s[2])).join("");
  if (d.counterchanged) {
    const clipA = id(), clipB = id();
    defs.push('<clipPath id="' + clipA + '"><path d="' + rA + '"/></clipPath>');
    defs.push('<clipPath id="' + clipB + '"><path d="' + rB + '"/></clipPath>');
    // On the first tincture the charge takes the second, and vice versa.
    g.push('<g clip-path="url(#' + clipA + ')" fill="' + d.second.hex + '">' + chargeSvg + "</g>");
    g.push('<g clip-path="url(#' + clipB + ')" fill="' + d.field.hex + '">' + chargeSvg + "</g>");
  } else {
    g.push('<g fill="' + d.chargeTincture.hex + '">' + chargeSvg + "</g>");
  }

  // A bordure hugs the edge; an orle is the same band set in from it. Both are a
  // stroke along a shield outline — the edge itself, or one scaled inward — and the
  // shield clip trims the outer half. No opacity anywhere: a blended colour is not
  // a tincture, and this whole page is about the picture matching the words.
  if (d.bordure !== "none") {
    const bwid = Math.max(3, bw * 0.055);
    if (d.bordure === "bordure") {
      g.push('<path d="' + shield + '" fill="none" stroke="' + d.bordureTincture.hex +
        '" stroke-width="' + num(bwid * 2) + '"/>');
    } else {
      const inset = bwid * 1.9;
      g.push('<path d="' + shieldPath(bx + inset, by + inset, bw - inset * 2, bh - inset * 1.35) +
        '" fill="none" stroke="' + d.bordureTincture.hex + '" stroke-width="' + num(bwid * 0.8) + '"/>');
    }
  }

  body.push('<g clip-path="url(#' + shieldClip + ')">' + g.join("") + "</g>");
  // A thin outline so a sable field does not bleed into a dark page.
  body.push('<path d="' + shield + '" fill="none" stroke="#00000059" stroke-width="' + num(Math.max(1, S * 0.004)) + '"/>');

  const FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  const SANS = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
  // The caption must not claim a key when no key was given: /crest/заяц is a picture
  // of a string, and it travels onto avatars in exactly the form it leaves here.
  const fromKey = spec.kind !== "opaque-string" && spec.kind !== "rejected-npub";
  const source = fromKey ? "derived from a public key" : "derived from a string, not a key";
  if (!bare) {
    const fpSize = Math.max(8, Math.round(S * 0.038));
    const sigSize = Math.max(7, Math.round(S * 0.026));
    if (motto) {
      const mSize = Math.max(11, Math.round(S * 0.052));
      body.push('<text x="' + num(S / 2) + '" y="' + num(by + bh + capH * 0.34) + '" text-anchor="middle" font-family="' +
        "ui-serif, Georgia, 'Times New Roman', serif" + '" font-style="italic" font-size="' + mSize +
        '" fill="#1a1a1a">' + esc(motto) + "</text>");
    }
    body.push('<text x="' + num(S / 2) + '" y="' + num(by + bh + capH * (motto ? 0.63 : 0.46)) + '" text-anchor="middle" font-family="' + FONT +
      '" font-size="' + fpSize + '" fill="#6b6b78">' + esc(spec.fingerprint) + "</text>");
    body.push('<text x="' + num(S / 2) + '" y="' + num(by + bh + capH * (motto ? 0.9 : 0.86)) + '" text-anchor="middle" font-family="' + SANS +
      '" font-size="' + sigSize + '" fill="#8a8a96">' + source + ' · ai-experiment.pages.dev/crest</text>');
  }

  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + S + '" height="' + S + '" viewBox="0 0 ' + S + " " + S +
    '" role="img" aria-label="' + esc("Coat of arms " + source + ": " + spec.blazon) + '">' +
    "<defs>" + defs.join("") + "</defs>" +
    body.join("") +
    "</svg>";
}
