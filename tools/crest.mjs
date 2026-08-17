// Герб из публичного ключа — CLI к тому же движку, который стоит на /crest/<key>.
//
//   node tools/crest.mjs <ключ> [--out файл.svg] [--size 512] [--bare] [--json]
//   node tools/crest.mjs --collisions 20000     сколько ключей делят один рисунок
//   node tools/crest.mjs --selftest             быстрая проверка вывода на своих ключах
//
// Зачем отдельный CLI: страница обещает, что рисунок можно ПЕРЕСЧИТАТЬ. Обещание
// стоит ровно столько, сколько стоит инструмент, которым это делают. Он печатает
// всю цепочку — нормальную форму ключа, материал хеша, сам SHA-256 и то, какой
// байт что решил, — чтобы читатель мог сверить каждый шаг своим sha256sum.
//
// Движок импортируется из functions/crest/[key].js: один код на сайте и в CLI,
// иначе «проверьте сами» проверяет не то, что нарисовано.

import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
const modUrl = pathToFileURL(path.join(here, "..", "functions", "crest", "[key].js")).href;
const M = await import(modUrl);

const argv = process.argv.slice(2);
const flag = (name) => argv.includes("--" + name);
const val = (name, def = null) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--") && val(argv[i - 1].slice(2)) === a));

// ------------------------------------------------------------ --collisions ----
// Честная цифра вместо обещания уникальности: пространство дизайнов конечно,
// значит совпадения ЕСТЬ. Вопрос только в том, сколько их, и он измеряется.
if (flag("collisions") || flag("space")) {
  // Размер пространства считается ПЕРЕБОРОМ того же кода, который рисует герб,
  // а не умножением в уме: перемножить руками легко, а ошибиться в одном
  // множителе — ещё легче, и такое число уже нечем проверить.
  const space = new Set();
  const bytes = new Array(32).fill(0);
  const F = M.FIELDS;
  for (let division = 0; division < 6; division++)
    for (let cls = 0; cls < 2; cls++)
      for (let ft = 0; ft < 5; ft++)
        for (let st = 0; st < 5; st++)
          for (let ch = 0; ch < 8; ch++)
            for (let cc = 0; cc < 3; cc++)
              for (let ct = 0; ct < 5; ct++)
                for (let bo = 0; bo < 3; bo++)
                  for (let bt = 0; bt < 5; bt++) {
                    bytes[F.division] = division; bytes[F.fieldClass] = cls;
                    bytes[F.fieldTincture] = ft; bytes[F.secondTincture] = st;
                    bytes[F.charge] = ch; bytes[F.chargeCount] = cc;
                    bytes[F.chargeTincture] = ct; bytes[F.bordure] = bo;
                    bytes[F.bordureTincture] = bt;
                    space.add(M.designSignature(M.designFromBytes(bytes)));
                  }
  console.log("Пространство дизайнов (перебор движка, не арифметика в уме)");
  console.log("  всего различимых гербов: " + space.size);

  if (flag("collisions")) {
    const n = Math.max(100, parseInt(val("collisions", "20000"), 10) || 20000);
    const seen = new Map();
    for (let i = 0; i < n; i++) {
      const spec = await M.deriveCrest(crypto.randomBytes(32).toString("hex"));
      const sig = M.designSignature(spec.design);
      seen.set(sig, (seen.get(sig) || 0) + 1);
    }
    const shared = [...seen.values()].filter((c) => c > 1).reduce((a, c) => a + c, 0);
    console.log("\nСовпадения на случайных 32-байтовых ключах");
    console.log("  ключей взято:                    " + n);
    console.log("  различных дизайнов встретилось:  " + seen.size);
    console.log("  ключей с не-уникальным дизайном: " + shared + " (" + ((shared / n) * 100).toFixed(1) + "%)");
    console.log("  самый населённый дизайн:         " + Math.max(...seen.values()) + " ключ(а/ей)");
  }
  console.log("\nПоэтому страница НЕ обещает уникальность рисунка: рисунок — функция ключа.");
  console.log("Идентифицирует отпечаток под щитом (первые 16 знаков SHA-256), а не картинка.");
  process.exit(0);
}

// -------------------------------------------------------------- --selftest ----
if (flag("selftest")) {
  const keys = [
    "npub1hxuvea8gsy3sccs8wguz34cksdhw26qrlqepazg8fak82l849h6s5xsyg6",
    "experiment@coinos.io",
    "TYpy2dsP5LRPKVXVhhB3sqcw7366UUK1yq",
  ];
  for (const k of keys) {
    const s = await M.deriveCrest(k);
    console.log(k);
    console.log("  " + s.kind + " · " + s.fingerprint + " · " + s.blazon);
  }
  process.exit(0);
}

if (!positional.length) {
  console.error("Использование: node tools/crest.mjs <ключ> [--out файл.svg] [--size 512] [--bare] [--json]");
  console.error("              node tools/crest.mjs --collisions 20000 | --selftest");
  process.exit(2);
}

const key = positional[0];
const spec = await M.deriveCrest(key);
const svg = M.renderCrestSVG(spec, { size: val("size"), bare: flag("bare") });

if (flag("json")) {
  console.log(JSON.stringify({ ...spec, svg_bytes: Buffer.byteLength(svg) }, null, 2));
} else {
  const d = spec.design;
  console.log("Герб из ключа");
  console.log("  введено:        " + spec.input);
  console.log("  распознано как: " + spec.kind);
  console.log("  нормальная форма: " + spec.canonical);
  console.log("  материал хеша:  " + spec.material);
  console.log("  SHA-256:        " + spec.digestHex);
  console.log("  отпечаток:      " + spec.fingerprint);
  console.log("\n  проверить хеш самому:");
  console.log("    printf 'crest/v1:%s' \"" + spec.canonical + "\" | sha256sum");
  console.log("\n  какой байт что решил:");
  const bytes = spec.digestHex.match(/../g).map((h) => parseInt(h, 16));
  for (const [nameField, idx] of Object.entries(M.FIELDS)) {
    console.log("    байт " + String(idx).padStart(2) + " = " + String(bytes[idx]).padStart(3) + "  → " + nameField);
  }
  console.log("\n  блазон: " + spec.blazon);
  console.log("  SVG: " + Buffer.byteLength(svg) + " байт");
}

const out = val("out");
if (out) {
  fs.writeFileSync(out, svg, "utf8");
  console.log("  записано: " + out);
}
