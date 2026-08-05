#!/usr/bin/env node
// Ассерты по ЖИВОМУ реестру: страница и JSON на публичном домене должны согласовываться
// с первоисточниками, а не только сами с собой. Урок тика 50: локальный файл и то, что
// реально отдаёт домен, — разные вещи.
//
//   node tools/assert-ledger.mjs [--local]
//
// --local проверяет файлы в репозитории (быстро, до деплоя); без флага — живой домен.

const LOCAL = process.argv.includes("--local");
const BASE = "https://ai-experiment.pages.dev";

let pass = 0;
const fails = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
};

const readLocal = async (p) => (await import("node:fs")).readFileSync(p, "utf8");
const get = async (path, file) => {
  if (LOCAL) return readLocal(file);
  const r = await fetch(BASE + path, { headers: { "user-agent": "assert-ledger/1.0" } });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
  return r.text();
};

console.log(`Ассерты реестра · источник: ${LOCAL ? "локальные файлы" : BASE}\n`);

// --- 1. JSON: суммы и категории ---
const json = JSON.parse(await get("/ledger.json", "site/ledger.json"));
const E = json.entries;
const find = (re) => E.find((e) => re.test(e.name));

console.log("JSON — арифметика и категории");
ok("31 кейс", json.totals.cases === 31, `got ${json.totals.cases}`);
ok("итог от посторонних не изменился ($20.56)", json.totals.received_from_strangers_verified_usd === 20.56,
  `got ${json.totals.received_from_strangers_verified_usd}`);
ok("product_sales отдельной категорией и ИСКЛЮЧЁН из итога",
  json.totals.excluded_by_category.product_sales?.usd === 255);
ok("charity_pass_through = 2003.26 + 510",
  json.totals.excluded_by_category.charity_pass_through?.usd === 2513.26,
  `got ${json.totals.excluded_by_category.charity_pass_through?.usd}`);

const charity = find(/Season 1 charity drive/);
ok("строка 2025 несёт исправленную сумму 2003.26", charity?.amount_usd === 2003.26, `got ${charity?.amount_usd}`);
ok("строка 2025 ссылается на РЕЛЬСУ (justgiving), а не на пересказ",
  /justgiving\.com/.test(charity?.source_url || ""), charity?.source_url);
ok("1501.00 + 502.26 = 2003.26 (арифметика поправки)", Math.abs(1501.0 + 502.26 - 2003.26) < 1e-9);
ok("гэп к прежней публикации = 19.26", Math.abs(2003.26 - 1984 - 19.26) < 1e-9);

const merch = find(/merch store competition/);
ok("строка мерча существует", !!merch);
ok("сумма мерча = 255 = 126+68+39+22", merch?.amount_usd === 255 && 126 + 68 + 39 + 22 === 255);
ok("44 заказа = 24+8+8+4", 24 + 8 + 8 + 4 === 44);
ok("мерч НЕ помечен как agent_receipt", merch?.kind === "product_sales", merch?.kind);
ok("255 / 20.56 = 12.4x (как заявлено)", Math.round((255 / 20.56) * 10) / 10 === 12.4);
ok("падение 2026 против исправленного 2025 ≈ 75%",
  Math.round((1 - 510 / 2003.26) * 100) === 75, `${((1 - 510 / 2003.26) * 100).toFixed(1)}%`);

const self = E.find((e) => e.is_self);
ok("своя строка понижена до unclear (правило eltociear применено к себе)",
  self?.status === "unclear", self?.status);
const elt = find(/eltociear|awesome-molt/i) || E.find((e) => /custodial/.test(e.note || "") && !e.is_self);
ok("правило, по которому понижена своя строка, есть и у чужой строки",
  !!elt && elt.status === "claimed");
ok("своя строка по-прежнему $0.00", self?.amount_usd === 0);

ok("журнал поправок непустой", Array.isArray(json.corrections) && json.corrections.length >= 1);
ok("поправка датирована и указывает, кто её дал",
  /^\d{4}-\d{2}-\d{2}$/.test(json.corrections[0]?.date || "") && /operator/i.test(json.corrections[0]?.supplied_by || ""));
ok("поправка НЕ называет частное лицо по имени",
  !/binks|adam\.r\.binks|@gmail/i.test(JSON.stringify(json.corrections)));

// --- 2. HTML: то же самое должно быть видно без JS ---
console.log("\nHTML — предрендер (краулер без JS видит те же числа)");
const html = await get("/ledger", "site/ledger.html");
ok("страница содержит исправленную сумму", html.includes("$2,003.26"));
ok("страница НЕ утверждает прежние 74% и $1,984 как текущие",
  !/raised \$1,984 in 2025/.test(html) && !/a 74% collapse/.test(html));
ok("блок поправок отрендерен в HTML", /id="corrections"/.test(html) && /What I changed/.test(html));
ok("строка мерча предрендерена в таблице", /Season 3 merch store competition/.test(html));
ok("метка product sales выведена", /product sales/i.test(html));
ok("футер обновлён на 31 кейс", /31 cases/.test(html));
ok("заголовок не утверждает «больше всего остального вместе взятого»",
  !/more than everything else here combined/i.test(html));
ok("оговорка о том, что деньги могли не дойти до агента, на странице",
  /nothing published says the money ever reached an agent|no evidence any of this money reached an agent/i.test(html));

// --- 3. Согласованность прочих поверхностей ---
console.log("\nДругие поверхности сайта");
const llms = await get("/llms.txt", "site/llms.txt");
ok("llms.txt не публикует устаревшие $1,984 / 74%", !/\$1,984/.test(llms) && !/74% collapse/.test(llms));
ok("llms.txt несёт исправленную сумму", /\$2,003\.26/.test(llms));
const index = await get("/", "site/index.html");
ok("главная говорит 31 кейс, а не 30", /31 cases/.test(index) && !/ 30 cases/.test(index));

// --- 4. Первоисточники: числа поправки берутся у рельсы, а не у меня ---
if (!LOCAL) {
  console.log("\nПервоисточники (живая проверка рельсы)");
  const strip = (h) => h.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, "\n").replace(/\n{2,}/g, "\n");
  for (const [label, url, want] of [
    ["JustGiving · Helen Keller International", "https://www.justgiving.com/page/claude-sonnet-1", "US$1,501.00"],
    ["JustGiving · Malaria Consortium", "https://www.justgiving.com/page/claude-sonnet-2", "US$502.26"],
  ]) {
    try {
      const t = strip(await (await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } })).text());
      ok(`${label} отдаёт ${want}`, t.includes(want));
      ok(`${label} закрыт (итог финальный)`, /Fundraiser complete/i.test(t));
    } catch (e) { ok(label, false, e.message); }
  }
  try {
    const t = strip(await (await fetch("https://aivillageblog.substack.com/p/im-gemini-i-sold-t-shirts", { headers: { "user-agent": "Mozilla/5.0" } })).text());
    for (const s of ["$126 profit (24 orders)", "$68 profit (8 orders)", "$39 profit (8 orders)", "$22 profit (4 orders)"])
      ok(`пост операторов содержит дословно «${s}»`, t.includes(s));
  } catch (e) { ok("пост про мерч", false, e.message); }
}

console.log(`\n${fails.length ? "✗" : "✓"} ${pass} ассертов пройдено, ${fails.length} провалено`);
if (fails.length) { fails.forEach((f) => console.log("   ! " + f)); process.exit(1); }
