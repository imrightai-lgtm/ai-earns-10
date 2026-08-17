// Проверки движка гербов (/crest/<key> и tools/crest.mjs). Без сети и без деплоя.
//   node tools/crest.test.mjs
//
// Что здесь проверяется в первую очередь — не «рисуется ли картинка», а те три
// утверждения, которые страница делает публично и за которые с меня можно
// спросить:
//   1. рисунок — ФУНКЦИЯ ключа: тот же ключ даёт байт в байт тот же SVG;
//   2. npub и его hex — ОДИН ключ, значит один герб (иначе «проверьте сами»
//      разойдётся с тем, что человек видит у себя в клиенте);
//   3. правило тинктур соблюдено ВСЕГДА, а не «обычно»: металл не ложится
//      на металл, цвет на цвет. Инвариант гоняется по случайным ключам.
// Плюс отдельно: контрольный хеш считается независимо (node:crypto), а не тем же
// кодом, который его же и вычисляет, — проверка, не способная провалиться, не
// проверка (урок тика 60).

import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
const modUrl = pathToFileURL(path.join(here, "..", "functions", "crest", "[key].js")).href;
const M = await import(modUrl);

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log("  ✗ " + msg); } };
const eq = (a, b, msg) => ok(a === b, msg + " (получено " + JSON.stringify(a) + ", ждали " + JSON.stringify(b) + ")");

// ---------------------------------------------------------------- bech32 ----
const MY_NPUB = "npub1hxuvea8gsy3sccs8wguz34cksdhw26qrlqepazg8fak82l849h6s5xsyg6";
const realHex = M.bech32ToHex(MY_NPUB, "npub");
ok(/^[0-9a-f]{64}$/.test(realHex || ""), "npub декодируется в 64 hex-знака: " + realHex);

// Ключ из state.json — контроль, что декодируется именно мой ключ, а не что-то похожее.
ok(realHex.startsWith("b9b8ccf4"), "декодированный npub начинается с b9b8ccf4 (мой pubkey из scan-nostr)");

// Испорченная контрольная сумма обязана быть отвергнута, иначе опечатка в npub
// молча нарисует ЧУЖОЙ герб — самый дорогой из возможных отказов этого продукта.
const broken = MY_NPUB.slice(0, -1) + (MY_NPUB.endsWith("6") ? "7" : "6");
eq(M.bech32ToHex(broken, "npub"), null, "npub с испорченной контрольной суммой отвергнут");
eq(M.bech32ToHex("npub1qqqq", "npub"), null, "слишком короткий npub отвергнут");
eq(M.bech32ToHex("nsec1hxuvea8gsy3sccs8wguz34cksdhw26qrlqepazg8fak82l849h6s5xsyg6", "npub"), null, "чужой hrp (nsec) отвергнут");
eq(M.bech32ToHex("NPUB1hxuvea8gsy3sccs8wguz34cksdhw26qrlqepazg8fak82l849h6s5xsyG6", "npub"), null, "смешанный регистр отвергнут (правило bech32)");
ok(M.bech32ToHex(MY_NPUB.toUpperCase(), "npub") === realHex, "полностью верхний регистр даёт тот же hex");

// ----------------------------------------------------- нормальная форма ----
const forms = [
  [MY_NPUB, "nostr-pubkey"],
  [realHex, "nostr-pubkey"],
  [realHex.toUpperCase(), "nostr-pubkey"],
  ["experiment@coinos.io", "lightning-address"],
  ["Experiment@Coinos.IO", "lightning-address"],
  ["0x6de6F0149173b791c1d0da0BAe5C46e15E9f2F56", "evm-address"],
  ["TYpy2dsP5LRPKVXVhhB3sqcw7366UUK1yq", "tron-address"],
  ["npub1notavalidkeyatall", "rejected-npub"],
  ["just-a-name", "opaque-string"],
];
for (const [input, kind] of forms) {
  eq(M.canonicalizeKey(input).kind, kind, JSON.stringify(input) + " распознан как " + kind);
}

// Главное свойство: три записи ОДНОГО ключа дают один и тот же герб.
const a = await M.deriveCrest(MY_NPUB);
const b = await M.deriveCrest(realHex);
const c = await M.deriveCrest(realHex.toUpperCase());
eq(a.canonical, b.canonical, "npub и hex сходятся в одну нормальную форму");
eq(b.canonical, c.canonical, "регистр hex не влияет на нормальную форму");
eq(M.renderCrestSVG(a), M.renderCrestSVG(b), "npub и hex дают байт-идентичный SVG");
eq((await M.deriveCrest("Experiment@Coinos.IO")).digestHex, (await M.deriveCrest("experiment@coinos.io")).digestHex,
  "регистр в lightning-адресе не меняет герб");

// Разные ключи — разный отпечаток (SHA-256 на 16 знаках).
ok(a.fingerprint !== (await M.deriveCrest("experiment@coinos.io")).fingerprint, "разные ключи — разные отпечатки");

// ------------------------------------------- хеш, посчитанный НЕ мной же ----
// Независимая реализация: node:crypto против crypto.subtle в движке.
for (const key of [MY_NPUB, "experiment@coinos.io", "just-a-name", ""]) {
  const spec = await M.deriveCrest(key);
  const control = crypto.createHash("sha256").update(spec.material, "utf8").digest("hex");
  eq(spec.digestHex, control, "SHA-256 движка совпал с node:crypto для " + JSON.stringify(key));
  eq(spec.material, "crest/v1:" + spec.canonical, "материал хеша ровно такой, как обещано на странице");
  eq(spec.fingerprint, control.slice(0, 16), "отпечаток — первые 16 знаков того же хеша");
}

// ------------------------------------------------ правило тинктур: всегда ----
const metalNames = new Set(M.METALS.map((t) => t.name));
const classOf = (t) => (metalNames.has(t.name) ? "metal" : "colour");
const N = 3000;
// Ключи выводятся из счётчика, а не из crypto.randomBytes: при случайных ключах
// число ассертов пляшет от прогона к прогону (делённое поле даёт 3 проверки, цельное 1-2),
// и «8507 ассертов» становится нестабильным числом, которое нельзя вынести в публикацию.
const probeKey = (i) => crypto.createHash("sha256").update("crest-probe/" + i).digest("hex");
let divided = 0, plainWithBordure = 0;
const seenDesign = new Map();
for (let i = 0; i < N; i++) {
  const key = probeKey(i);
  const spec = await M.deriveCrest(key);
  const d = spec.design;
  if (d.counterchanged) {
    divided++;
    // На делённом поле обе половины обязаны быть разных классов: тогда фигура,
    // перекрашенная в тинктуру другой половины, лежит по правилу на обеих.
    ok(classOf(d.field) !== classOf(d.second), "делённое поле: половины разных классов (" + spec.fingerprint + ")");
    ok(d.chargeTincture === null, "делённое поле: фигура перекрашена, отдельной тинктуры нет");
    ok(d.bordure === "none", "делённое поле: каймы нет (иначе она коснулась бы своего класса)");
  } else {
    ok(classOf(d.chargeTincture) !== classOf(d.field),
      "цельное поле: фигура другого класса, чем поле (" + spec.fingerprint + ")");
    if (d.bordure !== "none") {
      plainWithBordure++;
      ok(classOf(d.bordureTincture) !== classOf(d.field), "цельное поле: кайма другого класса, чем поле");
    }
  }
  const sig = M.designSignature(d);
  seenDesign.set(sig, (seenDesign.get(sig) || 0) + 1);
}
ok(divided > 0 && divided < N, "в выборке есть и делённые, и цельные поля (делённых " + divided + " из " + N + ")");
ok(plainWithBordure > 0, "в выборке встретилась кайма на цельном поле (" + plainWithBordure + ")");

// ------------------------------------------------------------ SVG-вывод ----
const keys = [MY_NPUB, "experiment@coinos.io", "", "a", "заяц", "<script>alert(1)</script>",
  "0x6de6F0149173b791c1d0da0BAe5C46e15E9f2F56", "TYpy2dsP5LRPKVXVhhB3sqcw7366UUK1yq"];
for (const k of keys) {
  const spec = await M.deriveCrest(k);
  const svg = M.renderCrestSVG(spec);
  const tag = JSON.stringify(k);
  ok(svg.startsWith("<svg "), tag + " начинается с <svg");
  ok(svg.trimEnd().endsWith("</svg>"), tag + " кончается на </svg>");
  ok(!/NaN|undefined|Infinity/.test(svg), tag + " без NaN/undefined/Infinity");
  ok(!/<script/i.test(svg), tag + " не содержит <script (экранирование сработало)");
  const g1 = (svg.match(/<g\b/g) || []).length, g2 = (svg.match(/<\/g>/g) || []).length;
  eq(g1, g2, tag + " сбалансированные <g>");
  const t1 = (svg.match(/<text\b/g) || []).length, t2 = (svg.match(/<\/text>/g) || []).length;
  eq(t1, t2, tag + " сбалансированные <text>");
  ok(svg.includes(spec.fingerprint), tag + " отпечаток напечатан на картинке");
  ok(svg.includes("ai-experiment.pages.dev/crest"), tag + " подпись на месте");
  // каждый clipPath, на который ссылаются, объявлен
  const refs = [...svg.matchAll(/clip-path="url\(#([^)]+)\)"/g)].map((m) => m[1]);
  const decl = new Set([...svg.matchAll(/<clipPath id="([^"]+)"/g)].map((m) => m[1]));
  ok(refs.length > 0 && refs.every((r) => decl.has(r)), tag + " все clip-path объявлены (" + refs.length + " ссылок)");
  ok(svg.length > 500 && svg.length < 200000, tag + " разумный размер (" + svg.length + ")");
  // детерминизм на уровне байтов
  eq(M.renderCrestSVG(spec), svg, tag + " рендер детерминирован");
}

// --bare убирает подпись и отпечаток, и это должно быть видно в байтах.
{
  const spec = await M.deriveCrest(MY_NPUB);
  const bare = M.renderCrestSVG(spec, { bare: true });
  ok(!bare.includes("ai-experiment.pages.dev"), "--bare: подписи нет");
  ok(!bare.includes("<text"), "--bare: текста нет вообще");
  ok(bare.includes("<svg "), "--bare: это по-прежнему SVG");
  ok(bare.length < M.renderCrestSVG(spec).length, "--bare короче обычного");
}

// размеры зажимаются, а не ломаются
{
  const spec = await M.deriveCrest("size-probe");
  for (const [given, want] of [["512", 512], ["1", 128], ["99999", 2048], ["не-число", 512], [null, 512]]) {
    const svg = M.renderCrestSVG(spec, { size: given });
    ok(svg.includes('width="' + want + '"'), "size=" + JSON.stringify(given) + " → " + want);
  }
}

// ------------------------------------------------------------- блазон ----
{
  const spec = await M.deriveCrest(MY_NPUB);
  ok(/^[A-Z]/.test(spec.blazon), "блазон начинается с заглавной: " + spec.blazon);
  ok(!/undefined|null|NaN/.test(spec.blazon), "в блазоне нет мусора");
  const d = spec.design;
  ok(spec.blazon.includes(d.field.name), "блазон называет тинктуру поля");
  if (d.counterchanged) ok(/counterchanged/.test(spec.blazon), "делённое поле → в блазоне counterchanged");
  if (d.bordure !== "none") ok(/bordure/.test(spec.blazon), "кайма → в блазоне bordure");
}


// ------------------------------------- то, что нашёл критик (каждый пункт — ассерт) ----
// Каждая проверка ниже поставлена на конкретный блокер 22-го прогона критика, чтобы тот же
// дефект не вернулся молча.

// (1) Подпись не должна обещать ключ там, где ключа не было.
for (const [input, mustSayString] of [
  ["заяц", true], ["npub1notavalidkeyatall", true], ["", true], ["myname.svg", true],
  [MY_NPUB, false], ["experiment@coinos.io", false], [realHex, false],
  ["0x6de6F0149173b791c1d0da0BAe5C46e15E9f2F56", false], ["TYpy2dsP5LRPKVXVhhB3sqcw7366UUK1yq", false],
]) {
  const spec = await M.deriveCrest(input);
  const svg = M.renderCrestSVG(spec);
  const saysString = /derived from a string, not a key/.test(svg);
  const saysKey = /derived from a public key/.test(svg);
  eq(saysString, mustSayString, JSON.stringify(input) + ": подпись про строку = " + mustSayString);
  eq(saysKey, !mustSayString, JSON.stringify(input) + ": подпись про ключ = " + !mustSayString);
  ok(/aria-label="Coat of arms derived from a (?:public key|string, not a key)/.test(svg),
    JSON.stringify(input) + ": aria-label согласован с подписью");
}

// (2) Одна нормальная форма для всех записей ОДНОГО ключа, включая те, что раньше срезал
//     слой URL, а не canonicalizeKey (из-за этого CLI и эндпоинт расходились на `x.svg`).
for (const form of [MY_NPUB, "nostr:" + MY_NPUB, "NOSTR:" + MY_NPUB, "web+nostr:" + MY_NPUB,
                    MY_NPUB + ".svg", "  " + MY_NPUB + "  "]) {
  const spec = await M.deriveCrest(form);
  eq(spec.canonical, realHex, JSON.stringify(form) + " → тот же ключ");
  eq(M.renderCrestSVG(spec), M.renderCrestSVG(a), JSON.stringify(form) + " → байт-идентичный SVG");
}

// (3) byteMap перечисляет только байты, которые ДЕЙСТВИТЕЛЬНО решали на этом щите,
//     и каждый названный байт обязан менять дизайн хотя бы при одном значении.
for (let i = 0; i < 250; i++) {
  const spec = await M.deriveCrest(probeKey(10000 + i));
  const names = Object.keys(spec.byteMap);
  eq(names.length, spec.bytesUsed, "bytesUsed совпадает с числом полей byteMap");
  if (spec.design.counterchanged) {
    ok(names.includes("secondTincture"), "делённое поле: secondTincture в byteMap");
    ok(!names.includes("chargeTincture") && !names.includes("bordure") && !names.includes("bordureTincture"),
      "делённое поле: мёртвых строк про фигуру и кайму нет");
    eq(spec.bytesUsed, 6, "делённое поле: решали 6 байт");
  } else {
    ok(!names.includes("secondTincture"), "цельное поле: secondTincture не решал");
    ok(names.includes("chargeTincture") && names.includes("bordure"), "цельное поле: фигура и кайма в byteMap");
    eq(spec.bytesUsed, spec.design.bordure === "none" ? 7 : 8, "цельное поле: 7 байт без каймы, 8 с каймой");
  }
  const bytes = spec.digestHex.match(/../g).map((h) => parseInt(h, 16));
  const mine = M.designSignature(spec.design);
  for (const [name, idx] of Object.entries(spec.byteMap)) {
    let changed = false;
    for (let v = 0; v < 256 && !changed; v++) {
      if (v === bytes[idx]) continue;
      const alt = bytes.slice(); alt[idx] = v;
      if (M.designSignature(M.designFromBytes(alt)) !== mine) changed = true;
    }
    ok(changed, "байт " + idx + " (" + name + ") действительно влияет на дизайн");
  }
}

// (4) Кайма: engrailed убрана; orle рисуется отдельным контуром; полупрозрачных заливок нет.
ok(!M.BORDURES.includes("bordure engrailed"), "bordure engrailed убрана из словаря");
ok(M.BORDURES.includes("orle"), "orle в словаре");
{
  let sawBordure = 0, sawOrle = 0;
  for (let i = 0; i < 400; i++) {
    const spec = await M.deriveCrest(probeKey(20000 + i));
    const svg = M.renderCrestSVG(spec);
    ok(!/opacity="0\.9/.test(svg), "полупрозрачных заливок нет (смешанный цвет — не тинктура)");
    if (spec.design.bordure === "bordure") {
      sawBordure++;
      ok(svg.includes(spec.design.bordureTincture.hex), "кайма нарисована своей тинктурой");
    }
    if (spec.design.bordure === "orle") {
      sawOrle++;
      ok(svg.includes(spec.design.bordureTincture.hex), "orle нарисован своей тинктурой");
      ok((svg.match(/stroke="/g) || []).length >= 2, "orle добавляет отдельный контур");
    }
  }
  ok(sawBordure > 0, "в выборке встретилась кайма (" + sawBordure + ")");
  ok(sawOrle > 0, "в выборке встретился orle (" + sawOrle + ")");
}

// (5) Полумесяц: ненулевая площадь и рога вверх. 8000+ ассертов не замечали, что фигуры нет.
{
  const base = await M.deriveCrest("crescent-probe");
  const one = { ...base, design: { ...base.design, charge: "crescent", chargeCount: 1,
    counterchanged: false, chargeTincture: M.COLOURS[0], division: "plain", second: null,
    bordure: "none", bordureTincture: null } };
  const svg = M.renderCrestSVG(one);
  ok(svg.includes('fill-rule="evenodd"'), "полумесяц вырезается evenodd, а не дугой с малым радиусом");
  const subs = [...svg.matchAll(/M([\d.]+),([\d.]+)A([\d.]+),([\d.]+) 0 1 0 ([\d.]+),([\d.]+)A/g)].map((m) => m.slice(1).map(Number));
  ok(subs.length >= 2, "полумесяц: два подконтура (" + subs.length + ")");
  if (subs.length >= 2) {
    const rOuter = subs[0][2], rInner = subs[1][2];
    const cxOuter = subs[0][0] + rOuter, cxInner = subs[1][0] + rInner;
    const cyOuter = subs[0][1], cyInner = subs[1][1];
    ok(rInner < rOuter, "внутренний диск меньше внешнего (" + rInner + " < " + rOuter + ")");
    ok(Math.abs(cxInner - cxOuter) < 0.5, "внутренний диск не смещён по горизонтали (иначе increscent)");
    ok(cyInner < cyOuter, "внутренний диск смещён вверх → рога вверх");
  }
}

// (6) per bend: линия из dexter chief в sinister base, первая тинктура — над ней.
{
  const regions = [];
  const seen = new Set();
  for (let i = 0; i < 400 && regions.length === 0; i++) {
    const spec = await M.deriveCrest(probeKey(40000 + i));
    if (spec.design.division !== "per bend") continue;
    const svg = M.renderCrestSVG(spec);
    const clips = [...svg.matchAll(/<clipPath id="[^"]+"><path d="M([\d.]+),([\d.]+)L([\d.]+),([\d.]+)L([\d.]+),([\d.]+)Z"/g)]
      .map((m) => m.slice(1).map(Number));
    if (clips.length >= 2) regions.push(clips);
    seen.add(spec.design.division);
  }
  ok(regions.length > 0, "per bend встретился в выборке и дал два региона");
  if (regions.length) {
    const first = regions[0][0];
    const xs = [first[0], first[2], first[4]], ys = [first[1], first[3], first[5]];
    const maxX = Math.max(...xs), minY = Math.min(...ys);
    const hasTopRight = xs.some((x, i) => x === maxX && ys[i] === minY);
    ok(hasTopRight, "per bend: регион первой тинктуры содержит верхний ПРАВЫЙ угол (иначе это per bend sinister)");
  }
}

// (7) Блазон называет то, что нарисовано.
for (let i = 0; i < 200; i++) {
  const spec = await M.deriveCrest(probeKey(30000 + i));
  ok(!/engrailed/.test(spec.blazon), "в блазоне нет engrailed");
  if (spec.design.bordure === "orle") ok(/an orle/.test(spec.blazon), "orle назван: " + spec.blazon);
  if (spec.design.bordure === "bordure") ok(/a bordure/.test(spec.blazon), "кайма названа: " + spec.blazon);
  if (spec.design.bordure === "none") ok(!/bordure|orle/.test(spec.blazon), "без каймы блазон о ней молчит");
}


// (8) Платный девиз: он добавляется под щитом и НЕ меняет сами гербы (иначе развалилась бы
//     вся проверяемость страницы), обрезается, экранируется и не пролезает в ?bare=1.
{
  const spec = await M.deriveCrest("experiment@coinos.io");
  const plain = M.renderCrestSVG(spec);
  const withMotto = M.renderCrestSVG(spec, { motto: "Nothing here is unmeasured" });
  ok(!plain.includes("Nothing here is unmeasured"), "без девиза его в SVG нет");
  ok(withMotto.includes("Nothing here is unmeasured"), "девиз попал в SVG");
  // Девиз занимает место под щитом, поэтому щит масштабируется — это ожидаемо. Проверяем
  // то, что обещано на странице: САМИ ГЕРБА те же, то есть тинктуры, фигуры и их число
  // не изменились, а изменилась только геометрия.
  const shieldOf = (svg) => svg.slice(svg.indexOf("<defs>"), svg.indexOf("<text"));
  const fillsOf = (svg) => (svg.match(/fill="[^"]+"/g) || []).join(",");
  const shapesOf = (svg) => [(svg.match(/<circle/g) || []).length, (svg.match(/<path/g) || []).length,
                             (svg.match(/<rect/g) || []).length, (svg.match(/<clipPath/g) || []).length].join("/");
  eq(fillsOf(shieldOf(withMotto)), fillsOf(shieldOf(plain)), "девиз не меняет ни одной тинктуры");
  eq(shapesOf(shieldOf(withMotto)), shapesOf(shieldOf(plain)), "девиз не добавляет и не убирает ни одной фигуры");
  ok(shieldOf(withMotto) !== shieldOf(plain), "щит с девизом масштабирован (место под текст) — и это единственное отличие");
  eq((await M.deriveCrest("experiment@coinos.io")).blazon, spec.blazon, "блазон от девиза не зависит");
  eq(M.renderCrestSVG(spec, { motto: "   " }), plain, "девиз из одних пробелов игнорируется");
  eq(M.renderCrestSVG(spec, { motto: "x", bare: true }), M.renderCrestSVG(spec, { bare: true }),
    "?bare=1 не печатает девиз");
  const long = M.renderCrestSVG(spec, { motto: "q".repeat(200) });
  const m = long.match(/>(q+)</);
  ok(m && m[1].length === 60, "девиз обрезан до 60 знаков (получено " + (m ? m[1].length : "нет") + ")");
  const xss = M.renderCrestSVG(spec, { motto: "</text><script>alert(1)</script>" });
  ok(!/<script/i.test(xss), "девиз экранирован");
  ok(!/NaN|undefined/.test(withMotto), "с девизом нет NaN/undefined");
  const t1 = (withMotto.match(/<text\b/g) || []).length, t2 = (withMotto.match(/<\/text>/g) || []).length;
  eq(t1, t2, "с девизом теги <text> сбалансированы");
  eq(t1, 3, "с девизом три текстовых строки: девиз, отпечаток, подпись");
}

// --------------------------------------------------- измеренные совпадения ----
const distinct = seenDesign.size;
const sharedKeys = [...seenDesign.values()].filter((n) => n > 1).reduce((s, n) => s + n, 0);
console.log("\nИзмерено на " + N + " выведенных из счётчика ключах: различных дизайнов " + distinct +
  ", ключей с не-уникальным дизайном " + sharedKeys + " (" + ((sharedKeys / N) * 100).toFixed(1) + "%).");
console.log("Это и есть причина, по которой страница НЕ обещает уникальность рисунка.");

console.log("\n" + (fail === 0 ? "✓" : "✗") + " crest: " + pass + "/" + (pass + fail) + " ассертов");
process.exit(fail === 0 ? 0 : 1);
