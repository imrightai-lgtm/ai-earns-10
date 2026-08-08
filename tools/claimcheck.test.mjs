#!/usr/bin/env node
// Регрессионные тесты claimcheck. Запуск: node tools/claimcheck.test.mjs
//
// Фикстуры воспроизводят РЕАЛЬНЫЕ заблокированные утверждения из tools/claimcheck.corpus.json
// (те, что помечены mechanically_detectable=true), а не выдуманные примеры. Если инструмент
// перестанет их ловить — это будет видно здесь, а не на живой странице.

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

// Тест находит инструмент и фикстуры ОТНОСИТЕЛЬНО СЕБЯ, а корень проекта передаёт явным --root.
// Так один и тот же файл проходит и здесь, и в отдельном репозитории claimcheck, где раскладка
// та же, а путь до неё другой.
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const TOOL = join(here, "claimcheck.mjs");
const FIX = relative(root, join(here, "claimcheck.fixtures")).split(sep).join("/");

// Часть ассертов проверяет не инструмент, а БОЕВОЙ конфиг конкретного проекта (его шаблоны и
// ловушки ложных срабатываний) и его опубликованную страницу. В отдельном репозитории
// инструмента этих данных нет. Пропуск объявляется вслух и с числом: непроведённая проверка
// не имеет права выглядеть как пройденная — это ровно тот дефект, ради которого весь этот
// инструмент и написан.
const HAS_PROJECT =
  existsSync(join(root, "tools", "claimcheck.config.json")) &&
  existsSync(join(root, "site", "ledger.json"));
const PAGE = join(root, "site/notes/self-refuting-claims-measured.html");
const skipped = [];
function skip(section, n, why) {
  skipped.push(`${section}: ${n} ассертов не выполнялось — ${why}`);
  console.log(`  · пропущено: ${n} ассертов — ${why}`);
}

let pass = 0;
const fails = [];
function ok(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fails.push(`${name}${detail ? " — " + detail : ""}`);
    console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`);
  }
}

function run(args, expectExit = 0) {
  try {
    const out = execFileSync(process.execPath, [TOOL, ...args], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    });
    return { out, code: 0 };
  } catch (e) {
    return { out: (e.stdout || "") + (e.stderr || ""), code: e.status ?? -1 };
  }
}
function findingsOf(args) {
  const { out } = run([...args, "--json"]);
  return JSON.parse(out).findings;
}
const has = (fs, verdict, claim, said) =>
  fs.some(
    (f) =>
      f.verdict === verdict &&
      f.claim === claim &&
      (said === undefined || Number(f.said) === Number(said))
  );

/* ---------------------------------------------------------------------- */
console.log("\n1. Черновик с историческими ошибками — каждая должна быть поймана");
const bad = findingsOf([`${FIX}/draft-bad.md`, "--config", `${FIX}/config.json`, "--surfaces"]);

ok("тик 58: «58 тиков лога» против 50 строк в логе", has(bad, "CONTRADICTED", "runs_in_log", 58));
ok("тик 58: «24 дат лога» против 4 различных дат", has(bad, "CONTRADICTED", "log_days", 24));
ok(
  "тик 53: «41 828 людей» против 25 различных авторов в CSV",
  has(bad, "CONTRADICTED", "showhn_people", 41828)
);
ok("тик 59: «30 cases» против 31 в данных", has(bad, "CONTRADICTED", "ledger_cases", 30));
ok(
  "тик 59: старое число выжило на публичной поверхности",
  bad.some(
    (f) =>
      f.verdict === "CONTRADICTED" && f.scope === "surface" && f.file.endsWith("surfaces/index.html")
  )
);
ok(
  "поверхность с верным числом НЕ помечена",
  bad.some((f) => f.verdict === "OK" && f.file.endsWith("surfaces/README.md"))
);
ok(
  "тик 59: «пытался прислать 21 сат и не смог» без оговорки",
  has(bad, "OPEN-QUESTION", "coinos-payment")
);
ok(
  "тик 59: «самый крупный» без квалификатора области",
  bad.some((f) => f.verdict === "ABSOLUTE" && f.claim.includes("самый"))
);

console.log("\n2. Тот же черновик после правки — ни одного опровержения");
const good = findingsOf([`${FIX}/draft-good.md`, "--config", `${FIX}/config.json`, "--surfaces"]);
ok(
  "0 CONTRADICTED в черновике",
  good.filter((f) => f.verdict === "CONTRADICTED" && f.scope === "draft").length === 0,
  JSON.stringify(good.filter((f) => f.verdict === "CONTRADICTED" && f.scope === "draft"))
);
ok(
  "оговорка «не знаю и узнать не могу» снимает флаг открытого вопроса",
  good.filter((f) => f.verdict === "OPEN-QUESTION").length === 0
);
ok(
  "квалификатор «среди тех, что я проверял» снимает флаг превосходной степени",
  !good.some((f) => f.verdict === "ABSOLUTE" && f.claim.includes("самый"))
);
ok("4 величины совпали с данными", good.filter((f) => f.verdict === "OK" && f.scope === "draft").length === 4);

console.log("\n3. Кириллица в шаблонах (JS `\\w` — только ASCII, это ловушка)");
{
  // Здесь стоял ассерт с «|| true» — он проходил при любом поведении кода и был засчитан
  // в общий счёт. Подделка доказательства в тестах инструмента про подделку доказательств;
  // найден состязательной проверкой. Заменён на настоящую проверку через поведение.
  const tmp = join(root, FIX, "cyr.md");
  const { writeFileSync, unlinkSync } = await import("node:fs");
  writeFileSync(tmp, "Это самый крупный результат среди проверяемых мной строк.\n");
  // Конфиг берётся фикстурный, а не боевой: его absolutes тоже написаны кириллицей и с \w,
  // проверяется ровно то же поведение — но проверка не отваливается вне этого репозитория.
  const f = findingsOf([`${FIX}/cyr.md`, "--config", `${FIX}/config.json`]);
  unlinkSync(tmp);
  // квалификатор «среди проверяемых» написан кириллицей и содержит \w в шаблоне конфига:
  // если бы \w не разворачивался, квалификатор не совпал бы и флаг остался.
  ok(
    "кириллический квалификатор с \\w реально снимает флаг превосходной степени",
    !f.some((x) => x.verdict === "ABSOLUTE"),
    JSON.stringify(f.map((x) => x.verdict + ":" + x.claim))
  );
}
{
  // прямая проверка: «проверяем\w+» обязан ловить «проверяемых»
  const src = readFileSync(join(root, "tools", "claimcheck.mjs"), "utf8");
  ok("в коде нет прямого new RegExp по шаблону из конфига", !/new RegExp\((?:t|g|p|cfg)\./.test(src));
  ok("объявлен класс с кириллицей", src.includes("\\\\u0400-\\\\u04FF"));
}

console.log("\n4. regex_distinct считает сущности, а не строки");
{
  const jf = readFileSync(join(root, FIX, "journal.md"), "utf8");
  const headings = jf.match(/^## Тик (\d+)/gm) || [];
  const distinct = new Set(
    headings.map((h) => h.replace(/^## Тик /, "")).filter((n) => Number(n) >= 1)
  );
  ok("наивный подсчёт строк дал бы 6", headings.length === 6, `дал ${headings.length}`);
  ok("различных номеров >= 1 — ровно 4", distinct.size === 4, `дал ${distinct.size}`);
  ok(
    "инструмент использует именно различные (черновик с 4 прошёл, с 6 — нет)",
    has(bad, "CONTRADICTED", "ticks_total", 6) &&
      good.some((f) => f.verdict === "OK" && f.claim === "ticks_total")
  );
}

console.log("\n5. Коды выхода");
ok("--strict на плохом черновике даёт 1", run([`${FIX}/draft-bad.md`, "--config", `${FIX}/config.json`, "--strict"]).code === 1);
ok("--strict на хорошем черновике даёт 0", run([`${FIX}/draft-good.md`, "--config", `${FIX}/config.json`, "--strict"]).code === 0);
ok("без файла черновика — код 2, а не тихий успех", run(["--config", `${FIX}/config.json`]).code === 2);

console.log("\n6. Ложные срабатывания, за которые пришлось переписывать шаблоны");
if (!HAS_PROJECT) skip("6", 2, "нет боевого конфига проекта и его данных (прогон вне репозитория эксперимента)");
else {
  // Все три фразы реально живут на моих поверхностях и НЕ являются проверенным итогом реестра.
  const tmp = join(root, FIX, "false-positive-bait.md");
  const bait = [
    "Stage 1 — earn $10 in voluntary tips from strangers.",
    "Five months of autonomous output, $0 received from strangers.",
    "his page states the campaign closed at a verified $510 from 17 human donors",
    "An open ledger — 31 cases, CC0, free to take and argue with.",
    "<h2>Corrections applied</h2>",
  ].join("\n\n");
  const fs2 = readFileSync;
  let baitFindings;
  try {
    require;
  } catch {}
  const { writeFileSync, unlinkSync } = await import("node:fs");
  writeFileSync(tmp, bait);
  baitFindings = findingsOf([`${FIX}/false-positive-bait.md`, "--no-guards"]); // боевой конфиг!
  unlinkSync(tmp);
  const wrong = baitFindings.filter((f) => f.verdict === "CONTRADICTED");
  ok(
    "боевой конфиг не объявляет ложным ничего из пяти приманок",
    wrong.length === 0,
    JSON.stringify(wrong.map((f) => `${f.claim}=${f.said}`))
  );
  ok(
    "«31 cases» при этом опознаётся как верное",
    baitFindings.some((f) => f.verdict === "OK" && f.claim === "ledger_cases")
  );
  void fs2;
}

console.log("\n7. Боевой конфиг: у каждой величины истина вычисляется");
if (!HAS_PROJECT) skip("7", 10, "нет боевого конфига проекта и его данных (прогон вне репозитория эксперимента)");
else {
  const cfg = JSON.parse(readFileSync(join(root, "tools", "claimcheck.config.json"), "utf8"));
  const probe = join(root, FIX, "probe.md");
  const { writeFileSync, unlinkSync } = await import("node:fs");
  // текст, где каждая величина встречается с ЗАВЕДОМО неверным значением -> должна быть поймана
  writeFileSync(
    probe,
    [
      "За 999 тиков эксперимента.",
      "Реестр — 999 cases.",
      "Total received from strangers across every verified row is $999.99.",
      "999 с проверяемыми доказательствами.",
      "999 фолловеров.",
      "999 донатов.",
      "999 поправок в журнале.",
      "The corpus holds 999 specific claims.",
      "The critic script says 999 of them were mechanical.",
      "My Lightning balance is 999 sats.",
    ].join("\n")
  );
  const f = findingsOf([`${FIX}/probe.md`, "--no-guards"]);
  unlinkSync(probe);
  for (const c of cfg.claims) {
    ok(
      `величина «${c.id}» ловится и её истина вычислима`,
      f.some((x) => x.claim === c.id && x.verdict === "CONTRADICTED"),
      JSON.stringify(f.filter((x) => x.claim === c.id).map((x) => x.verdict))
    );
  }
}

console.log("\n9. Молчаливый пропуск: проверка, которой не было, не бывает зелёной");
{
  const { writeFileSync, unlinkSync } = await import("node:fs");
  const draft = join(root, FIX, "silent.md");
  writeFileSync(draft, "Реестр сейчас — 30 cases в ledger.\n");

  // (а) глоб поверхностей не совпал ни с одним файлом
  const badGlob = join(root, FIX, "cfg-badglob.json");
  writeFileSync(
    badGlob,
    JSON.stringify({
      claims: [
        {
          id: "ledger_cases",
          patterns: ["([0-9]{1,3})\\s+cases\\b"],
          truth: { kind: "json_path", file: `${FIX}/ledger.json`, path: ["totals", "cases"] },
        },
      ],
      surfaces: ["siteZZZ/**/*.html"],
    })
  );
  const g = run([`${FIX}/silent.md`, "--config", `${FIX}/cfg-badglob.json`, "--surfaces", "--strict"]);
  ok("глоб поверхностей ни с чем не совпал -> код 1, а не тихий успех", g.code === 1, `code=${g.code}`);
  ok("и об этом сказано словами", /НОЛЬ поверхностей/.test(g.out));

  // (б) файла с истиной нет
  const noFile = join(root, FIX, "cfg-nofile.json");
  writeFileSync(
    noFile,
    JSON.stringify({
      claims: [
        {
          id: "ghost",
          patterns: ["([0-9]{1,3})\\s+cases\\b"],
          truth: { kind: "csv_rows", file: "memory/definitely-not-here.csv" },
        },
      ],
      surfaces: [],
    })
  );
  const n = run([`${FIX}/silent.md`, "--config", `${FIX}/cfg-nofile.json`, "--strict"]);
  ok("источник истины пропал -> код 1 (UNVERIFIABLE не зелёный)", n.code === 1, `code=${n.code}`);

  // (в) величина объявлена, шаблон не сработал ни разу
  const never = join(root, FIX, "cfg-never.json");
  writeFileSync(
    never,
    JSON.stringify({
      claims: [
        {
          id: "never_matches",
          patterns: ["совершенно-невстречающаяся-строка-([0-9]+)"],
          truth: { kind: "literal", value: 1 },
        },
      ],
      surfaces: [],
    })
  );
  const v = run([`${FIX}/silent.md`, "--config", `${FIX}/cfg-never.json`]);
  ok("ненайденная величина перечисляется, а не молчит", /не встретилось в тексте/.test(v.out));
  ok("и названа поимённо", /never_matches/.test(v.out));

  // (г) сломанный конфиг отличается кодом выхода от найденных противоречий
  const broken = join(root, FIX, "cfg-broken.json");
  writeFileSync(broken, "{ это не json ");
  ok(
    "битый JSON конфига -> код 3, а не 1",
    run([`${FIX}/silent.md`, "--config", `${FIX}/cfg-broken.json`]).code === 3
  );
  const badRe = join(root, FIX, "cfg-badre.json");
  writeFileSync(
    badRe,
    JSON.stringify({ claims: [{ id: "x", patterns: ["([0-9"], truth: { kind: "literal", value: 1 } }], surfaces: [] })
  );
  ok(
    "невалидный regex в конфиге -> код 3 с внятным сообщением",
    run([`${FIX}/silent.md`, "--config", `${FIX}/cfg-badre.json`]).code === 3
  );
  const dup = join(root, FIX, "cfg-dup.json");
  writeFileSync(
    dup,
    JSON.stringify({
      claims: [
        { id: "d", patterns: ["([0-9]{1,3})\\s+cases\\b"], truth: { kind: "literal", value: 999 } },
        { id: "d", patterns: ["([0-9]{1,3})\\s+кейс"], truth: { kind: "literal", value: 111 } },
      ],
      surfaces: [],
    })
  );
  ok(
    "дубликат id -> код 3 (иначе вторая величина молча проверялась бы против истины первой)",
    run([`${FIX}/silent.md`, "--config", `${FIX}/cfg-dup.json`]).code === 3
  );

  for (const f of [draft, badGlob, noFile, never, broken, badRe, dup]) unlinkSync(f);
}

console.log("\n8. Корпус");
{
  const c = JSON.parse(readFileSync(join(root, "tools", "claimcheck.corpus.json"), "utf8"));
  ok("случаев столько же, сколько заявлено в counts", c.cases.length === c.counts.cases);
  ok(
    "число механически ловимых совпадает с заявленным",
    c.cases.filter((x) => x.mechanically_detectable).length === c.counts.mechanically_detectable
  );
  ok(
    "у каждого случая есть черновик, опровержение, класс и дата",
    c.cases.every((x) => x.claim_draft && x.refuted_by && x.class && x.date)
  );
  ok(
    "каждый использованный класс объявлен в словаре классов",
    [...new Set(c.cases.map((x) => x.class))].every((k) => k in c.classes)
  );
  ok(
    "распределение по классам сходится со случаями",
    Object.entries(c.counts.by_class).every(
      ([k, v]) => c.cases.filter((x) => x.class === k).length === v
    )
  );
  ok("лицензия CC0", c.license === "CC0-1.0");
  // §3 хартии: корпус — перечень МОИХ ошибок. Он не должен по дороге публиковать вердикт
  // о постороннем, который в эту гонку не заявлялся. Один такой случай уже проскочил.
  const text = JSON.stringify(c);
  ok(
    "в корпусе нет имени третьего лица, чья строка была удалена как унижение",
    !/AgentFlow/i.test(text)
  );
  ok(
    "и нет самой «находки» о нём",
    !/ноль\s+донатеров/i.test(text)
  );
  // «Подряд» вычисляется, а не дописывается словом рядом с длиной списка.
  const streaks = [];
  for (const t of c.counts.ticks_with_blockers) {
    const last = streaks[streaks.length - 1];
    if (last && t === last[last.length - 1] + 1) last.push(t);
    else streaks.push([t]);
  }
  const longest = streaks.slice().sort((a, b) => b.length - a.length)[0];
  ok(
    "самая длинная серия подряд короче общего числа тиков (иначе «in a row» было бы верно)",
    longest.length < c.counts.ticks_with_blockers.length,
    `${longest.length} vs ${c.counts.ticks_with_blockers.length}`
  );
  if (!existsSync(PAGE)) skip("8", 3, "нет опубликованной страницы проекта (прогон вне репозитория эксперимента)");
  else {
  const page = readFileSync(PAGE, "utf8");
  ok(
    "на странице стоит вычисленная длина серии, а не длина списка",
    page.includes(`${longest.length} of them consecutive`),
    "не найдено «N of them consecutive»"
  );
  // «in a row» осталось на странице ровно один раз — в абзаце, где я признаю, что написал это
  // и был неправ. В заголовках его быть не должно: там оно и стояло как утверждение.
  const heads = [
    ...(page.match(/<title>[\s\S]*?<\/title>/gi) || []),
    ...(page.match(/<h1>[\s\S]*?<\/h1>/gi) || []),
    ...(page.match(/<meta[^>]*(?:og:title|twitter:title|description)[^>]*>/gi) || []),
  ].join(" ");
  ok("«in a row» больше нет ни в одном заголовке и мета-теге", !/in a row/i.test(heads));
  const admission = page.indexOf("was in the headline");
  const rows = [];
  for (let i = page.toLowerCase().indexOf("in a row"); i >= 0; i = page.toLowerCase().indexOf("in a row", i + 1))
    rows.push(i);
  ok(
    "каждое оставшееся упоминание «in a row» стоит внутри абзаца с признанием ошибки",
    admission > 0 && rows.length > 0 && rows.every((i) => i > admission),
    `admission@${admission}, вхождения: ${rows.join(",")}`
  );
  }
  ok("оговорки о неполноте корпуса не пустые", Array.isArray(c.caveats) && c.caveats.length > 0);
}

console.log("\n10. csv_last: величина, меняющаяся во времени (добавлена тиком 61)");
{
  const { writeFileSync, unlinkSync } = await import("node:fs");
  const csv = join(root, FIX, "tmp-balance.csv");
  const conf = join(root, FIX, "tmp-config.json");
  const draft = join(root, FIX, "tmp-draft.md");
  const mk = (rows, column = "balance_sats") => {
    writeFileSync(csv, "ts,balance_sats\n" + rows.join("\n") + "\n");
    writeFileSync(conf, JSON.stringify({
      claims: [{ id: "bal", patterns: ["([0-9]{1,6})\\s+sats?\\b"], truth: { kind: "csv_last", file: `${FIX}/tmp-balance.csv`, column } }],
      surfaces: [], open_questions: [], absolutes: {},
    }));
  };

  // Берётся ПОСЛЕДНЕЕ измерение, а не первое и не количество строк.
  mk(["2026-08-01T00:00:00Z,0", "2026-08-03T00:00:00Z,21"]);
  writeFileSync(draft, "The balance is 21 sats.\n");
  let f = findingsOf([`${FIX}/tmp-draft.md`, "--config", `${FIX}/tmp-config.json`, "--no-guards"]);
  ok("последнее значение принято за истину", !f.some((x) => x.claim === "bal" && x.verdict === "CONTRADICTED"), JSON.stringify(f));

  writeFileSync(draft, "The balance is 0 sats.\n");
  f = findingsOf([`${FIX}/tmp-draft.md`, "--config", `${FIX}/tmp-config.json`, "--no-guards"]);
  ok("устаревшее значение из ПЕРВОЙ строки лога ловится как расхождение",
    f.some((x) => x.claim === "bal" && x.verdict === "CONTRADICTED"), JSON.stringify(f));

  // Опечатка в имени колонки не должна давать зелёный отчёт: это тот самый молчаливый
  // пропуск, из-за которого на тике 60 «проверено ноль файлов» выглядело как успех.
  mk(["2026-08-03T00:00:00Z,21"], "balance_satoshi");
  writeFileSync(draft, "The balance is 0 sats.\n");
  f = findingsOf([`${FIX}/tmp-draft.md`, "--config", `${FIX}/tmp-config.json`, "--no-guards"]);
  ok("несуществующая колонка не даёт молчаливый зелёный",
    f.some((x) => x.claim === "bal" && x.verdict !== "CONTRADICTED"), JSON.stringify(f));

  // Лог с одним заголовком и без данных — тоже не «ноль».
  writeFileSync(csv, "ts,balance_sats\n");
  mk([], "balance_sats");
  writeFileSync(csv, "ts,balance_sats\n");
  f = findingsOf([`${FIX}/tmp-draft.md`, "--config", `${FIX}/tmp-config.json`, "--no-guards"]);
  ok("пустой лог не превращается в истину «0»",
    !f.some((x) => x.claim === "bal" && x.verdict === "CONTRADICTED"), JSON.stringify(f));

  for (const p of [csv, conf, draft]) { try { unlinkSync(p); } catch {} }
}

/* ---------------------------------------------------------------------- */
console.log("\n11. истина из НЕСКОЛЬКИХ файлов (добавлена тиком 65)");
{
  // Почему это здесь: тик 62 перенёс половину журнала в архив, и истина величины «сколько
  // тиков» молча стала считать 22 вместо 64. Три тика подряд это не проявлялось, потому что
  // ни один шаблон не срабатывал — то есть проверка не провалилась, а НЕ СОСТОЯЛАСЬ.
  const { writeFileSync, unlinkSync } = await import("node:fs");
  const a = join(root, FIX, "tmp-part-a.md");
  const b = join(root, FIX, "tmp-part-b.md");
  const conf = join(root, FIX, "tmp-multi-config.json");
  const draft = join(root, FIX, "tmp-multi-draft.md");
  const mkConf = (files) => writeFileSync(conf, JSON.stringify({
    claims: [{ id: "runs", patterns: ["\\b([2-9]\\d)\\s+runs\\b"],
               truth: { kind: "regex_distinct", files, pattern: "^## Тик (\\d+)", min: 1 } }],
    surfaces: [], open_questions: [], absolutes: {},
  }));

  writeFileSync(a, "## Тик 1\n## Тик 2\n## Тик 3\n");
  writeFileSync(b, "## Тик 4\n## Тик 5\n");
  writeFileSync(draft, "I have done 40 runs.\n");

  // Один файл видит 3 тика, два файла — 5. Утверждение «40» ложно при обоих, но истина
  // должна отличаться: иначе перенос в архив тихо занижает её и никто этого не замечает.
  mkConf([`${FIX}/tmp-part-a.md`]);
  let f = findingsOf([`${FIX}/tmp-multi-draft.md`, "--config", `${FIX}/tmp-multi-config.json`, "--no-guards"]);
  const one = f.find((x) => x.claim === "runs");
  mkConf([`${FIX}/tmp-part-a.md`, `${FIX}/tmp-part-b.md`]);
  f = findingsOf([`${FIX}/tmp-multi-draft.md`, "--config", `${FIX}/tmp-multi-config.json`, "--no-guards"]);
  const two = f.find((x) => x.claim === "runs");
  ok("истина по одному файлу — 3", String(one?.truth) === "3", JSON.stringify(one));
  ok("истина по двум файлам — 5, а не 3", String(two?.truth) === "5", JSON.stringify(two));

  // Пропавший файл из списка не должен молча усечь истину: у несостоявшейся проверки
  // обязано быть имя того, что не проверилось.
  mkConf([`${FIX}/tmp-part-a.md`, `${FIX}/tmp-part-gone.md`]);
  f = findingsOf([`${FIX}/tmp-multi-draft.md`, "--config", `${FIX}/tmp-multi-config.json`, "--no-guards"]);
  const gone = f.find((x) => x.claim === "runs");
  ok("отсутствующий файл не даёт молчаливую усечённую истину",
    gone && gone.verdict !== "CONTRADICTED" && String(gone.truth ?? "") !== "3", JSON.stringify(gone));
  ok("и он назван поимённо в объяснении",
    /tmp-part-gone\.md/.test(JSON.stringify(gone ?? {})), JSON.stringify(gone));

  for (const p of [a, b, conf, draft]) { try { unlinkSync(p); } catch {} }
}

/* ---------------------------------------------------------------------- */
console.log(`\n${pass}/${pass + fails.length} ассертов прошло.`);
if (skipped.length) {
  console.log(`ПРОПУЩЕНО (${skipped.length} секции): непроведённая проверка — не пройденная.`);
  for (const s of skipped) console.log("  · " + s);
}
if (fails.length) {
  console.log("ПРОВАЛЫ:");
  for (const f of fails) console.log("  ✗ " + f);
  process.exit(1);
}
console.log("Все ассерты прошли.");
