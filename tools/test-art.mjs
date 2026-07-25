// Local sanity checks for the /art SVG engine (no deploy needed).
//   node tools/test-art.mjs
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const modUrl = pathToFileURL(path.join(here, "..", "functions", "art", "[seed].js")).href;
const { renderArtSVG } = await import(modUrl);

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log("  ✗ " + msg); } };

const seeds = ["ai-earns-10", "alice", "fiatjaf", "npub1hxuvea8", "", "a", "заяц", "<script>", "very-long-name-that-exceeds-the-thirty-char-cap-for-sure"];

for (const s of seeds) {
  const svg = renderArtSVG(s, { label: s });
  const tag = JSON.stringify(s);
  ok(svg.startsWith("<svg "), tag + " starts with <svg");
  ok(svg.trimEnd().endsWith("</svg>"), tag + " ends with </svg>");
  ok(svg.includes("<defs>"), tag + " has <defs>");
  ok(svg.includes('xmlns="http://www.w3.org/2000/svg"'), tag + " has xmlns");
  ok(!/NaN|undefined|Infinity/.test(svg), tag + " has no NaN/undefined/Infinity");
  ok(!svg.includes("<script"), tag + " did not inject a raw <script> tag (escaped)");
  // crude tag balance for the few container tags we emit
  const openSvg = (svg.match(/<svg\b/g) || []).length, closeSvg = (svg.match(/<\/svg>/g) || []).length;
  ok(openSvg === 1 && closeSvg === 1, tag + " exactly one svg element");
  const g1 = (svg.match(/<g\b/g) || []).length, g2 = (svg.match(/<\/g>/g) || []).length;
  ok(g1 === g2, tag + " balanced <g> tags (" + g1 + "/" + g2 + ")");
  const t1 = (svg.match(/<text\b/g) || []).length, t2 = (svg.match(/<\/text>/g) || []).length;
  ok(t1 === t2 && t1 >= 1, tag + " balanced <text> tags and >=1");
  ok(svg.includes("made by an autonomous AI"), tag + " carries the signature");
  ok(svg.length > 400 && svg.length < 200000, tag + " reasonable size (" + svg.length + ")");
}

// determinism: same seed -> identical bytes
ok(renderArtSVG("alice", { label: "alice" }) === renderArtSVG("alice", { label: "alice" }), "deterministic for same seed");
// distinctness: different seeds -> different output
ok(renderArtSVG("alice", { label: "alice" }) !== renderArtSVG("bob", { label: "bob" }), "different seeds differ");

// size clamping
const big = renderArtSVG("x", { w: "99999", h: "99999", label: "x" });
ok(/width="1600"/.test(big) && /height="640"/.test(big), "size clamped to max 1600x640");
const small = renderArtSVG("x", { w: "1", h: "1", label: "x" });
ok(/width="320"/.test(small) && /height="120"/.test(small), "size clamped to min 320x120");
const bad = renderArtSVG("x", { w: "abc", h: null, label: "x" });
ok(/width="1200"/.test(bad) && /height="300"/.test(bad), "bad/missing size -> defaults 1200x300");

// XSS in label must be escaped, not raw
const xss = renderArtSVG('"><script>alert(1)</script>', { label: '"><script>alert(1)</script>' });
ok(!xss.includes("<script>alert"), "label XSS escaped");
ok(xss.includes("&lt;script&gt;") || xss.includes("&quot;"), "label entities present");

console.log("\n" + (fail === 0 ? "✓ ALL PASS" : "✗ FAIL") + "  (" + pass + " passed, " + fail + " failed)");
process.exit(fail === 0 ? 0 : 1);
