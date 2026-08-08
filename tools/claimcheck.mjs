#!/usr/bin/env node
// claimcheck — ловит в черновике утверждения, которые опровергаются СОБСТВЕННЫМИ файлами автора.
// Только чтение. Ничего не публикует, никуда не ходит по сети, не требует LLM и API-ключей.
//
// ЗАЧЕМ ЭТО ВООБЩЕ НАПИСАНО
// Состязательный критик заблокировал у меня 8 публикаций (тик 47 и подряд тики 53-59), и самый
// частый разряд находок был не «спорное мнение», а буквальный: число в тексте не совпадало
// с числом в моём же логе; исправив цифру в одном месте, я оставлял старую в трёх других;
// вопрос, который мои же файлы держат открытым, публиковался как установленный факт.
// Всё это ловится механически — и всё это восемь раз ловил не скрипт, а читатель.
// Корпус разобранных случаев лежит рядом: tools/claimcheck.corpus.json
//
// ЧТО ЭТОТ ИНСТРУМЕНТ ДЕЛАЕТ (три проверки, все детерминированные)
//   claims     объявленные величины: число в тексте сверяется с числом, ВЫЧИСЛЕННЫМ из данных
//              (строки CSV, совпадения regex в логе, поле JSON). Ловит «58 тиков» при 57 строках.
//   surfaces   те же величины ищутся во ВСЕХ публичных поверхностях репозитория. Ловит старое
//              значение, пережившее правку в README/llms.txt/на главной.
//   guards     объявленные открытые вопросы: если черновик говорит на эту тему без оговорки,
//              это флаг. Ловит «пытался и не смог» при открытом вопросе в собственных файлах.
//              Плюс абсолютные утверждения («самый», «впервые», «ни разу») без квалификатора.
//
// ЧЕГО ОН НЕ ДЕЛАЕТ И НЕ БУДЕТ (честная граница)
//   Он не понимает смысл. Приписанную кому-то мысль, которой человек не высказывал, ложный
//   вывод из верных цифр и двойной стандарт «к чужой строке правило применил, к своей нет»
//   скрипт не поймает — для этого нужен читатель. В корпусе такие случаи помечены
//   mechanically_detectable=false, и их доля — оценка потолка этого инструмента. Именно оценка:
//   состязательная проверка нашла в этой разметке шесть ошибок сразу, все исправлены и подписаны.
//
// ЗАПУСК
//   node tools/claimcheck.mjs draft.md [ещё-файлы...] [--config <файл>] [--root <папка>]
//                             [--surfaces] [--json] [--strict] [--no-guards]
//   --root      корень проверяемого проекта (по умолчанию — текущая папка). Все пути данных
//               и поверхностей в конфиге считаются от него.
//   --surfaces  проверить ещё и все публичные поверхности из конфига (медленнее, но это ровно
//               та проверка, которой мне не хватило на тике 59)
//   --strict    выход с кодом 1, если что-то не прошло: CONTRADICTED, UNPARSED или UNVERIFIABLE
//               (последнее — «истину вычислить не удалось»: непроведённая проверка не бывает зелёной)
// КОДЫ ВЫХОДА: 0 чисто · 1 есть непрошедшее (--strict) · 2 неверный вызов · 3 конфиг сломан
//
// КОНФИГ — обычный JSON, см. tools/claimcheck.config.json. Инструмент ничего не знает про мой
// проект: все величины, поверхности и открытые вопросы объявляются в конфиге.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/* ---------------------------------------------------------------- аргументы */
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const VALUE_OPTS = ["--config", "--root"];
const AS_JSON = flag("--json");
const STRICT = flag("--strict");
const WITH_SURFACES = flag("--surfaces");
const NO_GUARDS = flag("--no-guards");

// Корень проекта, относительно которого читаются данные и поверхности, — это ПРОВЕРЯЕМЫЙ проект,
// а не место, где лежит скрипт. Раньше он вычислялся как «папка над скриптом», и это работало
// ровно до первой попытки положить инструмент в другой репозиторий: там `tools/..` указывал уже
// не на проект пользователя, а на родителя его репозитория, и все истины молча становились
// UNVERIFIABLE. Тот же класс ошибки, что и опечатка в глобе: проверка не проваливается, она
// просто ничего не проверяет. Поэтому корень — cwd (или явный --root), и он печатается в шапке.
const root = opt("--root", process.cwd());

// Конфиг по умолчанию ищется в двух местах: <root>/claimcheck.config.json (обычный проект)
// и <root>/tools/claimcheck.config.json (раскладка этого репозитория).
const DEFAULT_CONFIGS = [
  join(root, "claimcheck.config.json"),
  join(root, "tools", "claimcheck.config.json"),
];
const CONFIG_PATH = opt("--config", DEFAULT_CONFIGS.find((p) => existsSync(p)) || DEFAULT_CONFIGS[0]);

const drafts = argv.filter((a, i) => {
  if (a.startsWith("--")) return false;
  if (i > 0 && VALUE_OPTS.includes(argv[i - 1])) return false;
  return true;
});

/* ------------------------------------------------------------------ утилиты */
// «41 828», «41,828», «2 003.26», «$20.56» -> число. Разделители разрядов бывают тонким
// и неразрывным пробелом — именно на них ломаются наивные парсеры.
function normNum(raw) {
  const s = String(raw)
    .replace(/[   \s]/g, "")
    .replace(/[$€£]/g, "")
    .replace(/[.,;:!?)\]]+$/, "")
    .replace(/,(?=\d{3}(?:\D|$))/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
const eqNum = (a, b, tol = 0) => a !== null && b !== null && Math.abs(a - b) <= tol;

// В JavaScript `\w` — это [A-Za-z0-9_] и НИЧЕГО больше: на кириллице он не совпадает никогда.
// Нашёл это первым же прогоном инструмента по себе: шаблон «проверенн\w*\s+итог\w*» молча не
// срабатывал ни разу, и вместо ошибки я получал тишину — то есть инструмент, ищущий ложные
// утверждения, сам сообщал «всё чисто» на непроверенном тексте. Молчащая проверка хуже
// отсутствующей: отсутствующую видно. Поэтому `\w` из конфига разворачивается в явный класс
// с кириллицей — и внутри [...] тоже, иначе получится сломанный вложенный класс.
const WORD = "0-9A-Za-z_\\u0400-\\u04FF";
function reFromConfig(src, flags) {
  let out = "";
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\" && src[i + 1] === "w") {
      out += inClass ? WORD : `[${WORD}]`;
      i++;
      continue;
    }
    // `\b` — та же ловушка, что и `\w`: граница слова считается по ASCII, поэтому между
    // «донатов» и точкой её нет, и шаблон «донат(?:ов)?\b» не срабатывает никогда.
    // Разворачивается в пару взаимных lookaround по тому же классу.
    if (c === "\\" && src[i + 1] === "b" && !inClass) {
      out += `(?:(?<=[${WORD}])(?![${WORD}])|(?<![${WORD}])(?=[${WORD}]))`;
      i++;
      continue;
    }
    if (c === "\\") {
      out += c + (src[i + 1] ?? "");
      i++;
      continue;
    }
    if (c === "[") inClass = true;
    if (c === "]") inClass = false;
    out += c;
  }
  return new RegExp(out, flags);
}

function readIfExists(p) {
  const abs = join(root, p);
  return existsSync(abs) ? readFileSync(abs, "utf8") : null;
}

// Истина, собранная из НЕСКОЛЬКИХ файлов (`files: [...]` вместо `file`).
//
// Написано не для красоты. Тик 62 перенёс тики 0-42 из JOURNAL.md в memory/archive/, и истина
// величины `ticks` — «сколько различных номеров тиков в журнале» — молча стала считать 22 вместо
// 64. Три тика подряд это никак не проявлялось ровно потому, что ни один шаблон по-английски
// не срабатывал: проверка не провалилась, она не состоялась. Тот же класс, что корень «папка над
// скриптом» (тик 62) и опечатка в глобе (тик 60).
//
// Отсутствующий файл здесь НЕ пропускается молча: у любой несостоявшейся проверки должно быть
// имя того, что не проверилось, иначе усечённая истина выглядит как измеренная.
function readTruthSources(t) {
  const list = Array.isArray(t.files) && t.files.length ? t.files : [t.file];
  const parts = [];
  const missing = [];
  for (const p of list) {
    const txt = readIfExists(p);
    if (txt === null) missing.push(p);
    else parts.push(txt);
  }
  if (missing.length) return { text: null, how: `нет файла ${missing.join(", ")}` };
  return { text: parts.join("\n"), how: list.join(" + ") };
}

// мини-glob: поддерживает ** и * в пути. Без зависимостей — их тут не будет.
function globToRe(pattern) {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") { out += "(?:[^/]+/)*"; i += 2; }
      else { out += ".*"; i += 1; }
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += "\\^$.|?*+()[]{}".includes(c) ? "\\" + c : c;
  }
  return new RegExp("^" + out + "$");
}
function walk(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e === "node_modules" || e === ".git" || e === "__pycache__") continue;
    const p = join(dir, e);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, acc);
    else acc.push(relative(root, p).split(sep).join("/"));
  }
  return acc;
}
let ALL_FILES = null;
function expand(patterns) {
  if (!patterns || !patterns.length) return [];
  if (!ALL_FILES) ALL_FILES = walk(root);
  const res = patterns.map(globToRe);
  const out = [];
  for (const f of ALL_FILES) if (res.some((r) => r.test(f))) out.push(f);
  return out.sort();
}

/* ------------------------------------------- вычисление истинного значения */
// Истина берётся ИЗ ДАННЫХ, а не из другого текста. Иначе это сверка пересказа с пересказом.
function truthOf(spec) {
  const t = spec.truth || {};
  switch (t.kind) {
    case "literal":
      return { value: Number(t.value), how: `объявлено в конфиге: ${t.value}` };

    case "csv_rows": {
      const txt = readIfExists(t.file);
      if (txt === null) return { value: null, how: `нет файла ${t.file}` };
      let rows = txt.split(/\r?\n/).filter((l) => l.trim().length);
      if (t.has_header !== false) rows = rows.slice(1);
      if (t.where) {
        const re = reFromConfig(t.where, "");
        rows = rows.filter((l) => re.test(l));
      }
      return {
        value: rows.length,
        how: `строк данных в ${t.file}${t.where ? ` по фильтру /${t.where}/` : ""}`,
      };
    }

    // Последнее ИЗМЕРЕНИЕ в логе, а не количество измерений. Для величин, которые меняются
    // во времени и о которых текст говорит в настоящем времени: баланс, курс, остаток.
    // Добавлено на тике 61: 60 тиков публичные страницы утверждали «$0.00» в настоящем
    // времени, и после первого доната ни одна из них не стала неправдой автоматически —
    // потому что величины «сколько денег есть сейчас» в конфиге просто не существовало.
    case "csv_last": {
      const txt = readIfExists(t.file);
      if (txt === null) return { value: null, how: `нет файла ${t.file}` };
      const lines = txt.split(/\r?\n/).filter((l) => l.trim().length);
      if (lines.length < 2) return { value: null, how: `в ${t.file} нет ни одной строки данных` };
      const header = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
      const idx = header.indexOf(t.column);
      if (idx < 0) return { value: null, how: `нет колонки ${t.column} в ${t.file}` };
      const cell = (lines[lines.length - 1].split(",")[idx] || "").trim().replace(/^"|"$/g, "");
      const value = Number(cell);
      if (!Number.isFinite(value)) return { value: null, how: `последнее значение ${t.column} в ${t.file} не число: «${cell}»` };
      return { value, how: `последнее измерение ${t.column} в ${t.file}` };
    }

    case "csv_distinct": {
      const txt = readIfExists(t.file);
      if (txt === null) return { value: null, how: `нет файла ${t.file}` };
      const lines = txt.split(/\r?\n/).filter((l) => l.trim().length);
      const header = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
      const idx = header.indexOf(t.column);
      if (idx < 0) return { value: null, how: `нет колонки ${t.column} в ${t.file}` };
      const seen = new Set();
      for (const l of lines.slice(1)) {
        const cell = (l.split(",")[idx] || "").trim().replace(/^"|"$/g, "");
        if (cell) seen.add(t.take === "date" ? cell.slice(0, 10) : cell);
      }
      return { value: seen.size, how: `различных ${t.column} в ${t.file}` };
    }

    case "regex_count": {
      const src = readTruthSources(t);
      if (src.text === null) return { value: null, how: src.how };
      const m = src.text.match(reFromConfig(t.pattern, "gm"));
      return { value: m ? m.length : 0, how: `совпадений /${t.pattern}/ в ${src.how}` };
    }

    // Сколько РАЗЛИЧНЫХ значений захвачено группой. Написан не «на всякий случай»: наивный
    // regex_count по «## Тик N» в моём же журнале даёт 61 при 59 тиках — там есть «Тик 0» и
    // задвоенный заголовок «Тик 47». Инструмент, который считает строки вместо сущностей,
    // сам производит ровно тот разряд ошибки, который призван ловить.
    case "regex_distinct": {
      const src = readTruthSources(t);
      if (src.text === null) return { value: null, how: src.how };
      const txt = src.text;
      const re = reFromConfig(t.pattern, "gm");
      const seen = new Set();
      let m;
      while ((m = re.exec(txt)) !== null) {
        const cap = m[1] ?? m[0];
        if (t.min !== undefined && Number(cap) < t.min) continue;
        seen.add(String(cap).trim());
        if (m.index === re.lastIndex) re.lastIndex++;
      }
      return {
        value: seen.size,
        how: `различных значений /${t.pattern}/ в ${src.how}${t.min !== undefined ? ` (>= ${t.min})` : ""}`,
      };
    }

    case "json_path": {
      const txt = readIfExists(t.file);
      if (txt === null) return { value: null, how: `нет файла ${t.file}` };
      let cur;
      try {
        cur = JSON.parse(txt);
      } catch {
        return { value: null, how: `${t.file} не парсится как JSON` };
      }
      for (const key of t.path) {
        if (cur == null) break;
        cur = Array.isArray(cur) && key === "length" ? cur.length : cur[key];
      }
      const v = normNum(cur);
      return { value: v, how: `${t.file} -> ${t.path.join(".")}` };
    }

    case "json_count_where": {
      const txt = readIfExists(t.file);
      if (txt === null) return { value: null, how: `нет файла ${t.file}` };
      let cur;
      try {
        cur = JSON.parse(txt);
      } catch {
        return { value: null, how: `${t.file} не парсится как JSON` };
      }
      for (const key of t.path || []) cur = cur?.[key];
      if (!Array.isArray(cur)) return { value: null, how: `${t.file} -> не массив` };
      const re = t.where ? reFromConfig(t.where, "") : null;
      const n = re ? cur.filter((x) => re.test(JSON.stringify(x))).length : cur.length;
      return {
        value: n,
        how: `элементов ${t.file}:${(t.path || []).join(".")}${t.where ? ` по /${t.where}/` : ""}`,
      };
    }

    default:
      return { value: null, how: `неизвестный вид истины: ${t.kind}` };
  }
}

/* ------------------------------------------------------ поиск числа в тексте */
// Величина, опознаваемая только по нарицательному слову («31 cases»), сталкивается с любым
// другим употреблением этого слова: страница про 61 случай критика тут же объявлялась
// расхождением с реестром на 31 кейс. Поэтому у величины может быть обязательный контекст —
// слово, которое должно стоять рядом, чтобы это была ОНА, а не однофамилец.
function inContext(text, index, spec) {
  if (!spec.context) return true;
  const w = spec.context_window || 300;
  const around = text.slice(Math.max(0, index - w), index + w);
  return reFromConfig(spec.context, "i").test(around);
}

function findClaims(text, spec) {
  const hits = [];
  for (const p of spec.patterns) {
    const re = reFromConfig(p, "gmi");
    let m;
    while ((m = re.exec(text)) !== null) {
      if (!inContext(text, m.index, spec)) { if (m.index === re.lastIndex) re.lastIndex++; continue; }
      const raw = m[1] ?? m[0];
      const v = normNum(raw);
      const line = text.slice(0, m.index).split(/\n/).length;
      // v === null НЕ означает «пропустить»: это значит «шаблон сработал, а число прочитать
      // не удалось». Молчаливый пропуск здесь и был первым дефектом инструмента.
      hits.push({ value: v, raw: String(raw).trim(), line, excerpt: excerptAt(text, m.index) });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  return hits;
}
// Страница, которая ЦИТИРУЕТ прошлые ложные утверждения, обязана их содержать — и тогда
// проверка сработает на цитате. Нужна не поблажка целому файлу, а точная область:
//   <!-- claimcheck:ignore-start -->  …  <!-- claimcheck:ignore-end -->
// Область заменяется пробелами той же длины, чтобы номера строк в отчёте не поехали.
function maskIgnored(text) {
  const re = /claimcheck:ignore-start([\s\S]*?)claimcheck:ignore-end/g;
  return text.replace(re, (m) => m.replace(/[^\n]/g, " "));
}
function excerptAt(text, i, pad = 60) {
  const s = text.slice(Math.max(0, i - pad), i + pad).replace(/\s+/g, " ").trim();
  return s.length > 130 ? s.slice(0, 127) + "…" : s;
}

/* ----------------------------------------------------------------- проверки */
const cfgRaw = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf8") : null;
if (cfgRaw === null) {
  console.error(`claimcheck: не найден конфиг ${CONFIG_PATH}`);
  process.exit(2);
}
// Битый конфиг и невалидный regex внутри него не должны выходить тем же кодом, что и
// найденные противоречия: CI обязан отличать «нашёл проблемы» от «проверка не запустилась».
let cfg;
try {
  cfg = JSON.parse(cfgRaw);
} catch (e) {
  console.error(`claimcheck: ${CONFIG_PATH} не парсится как JSON — ${e.message}`);
  process.exit(3);
}
{
  const seen = new Set();
  for (const spec of cfg.claims || []) {
    if (!spec.id) {
      console.error("claimcheck: у величины в конфиге нет поля id");
      process.exit(3);
    }
    // Дубликат id молча делил бы кэш истины первого: две разные величины проверялись бы
    // против одного значения, и обе показывали бы ✓.
    if (seen.has(spec.id)) {
      console.error(`claimcheck: id «${spec.id}» объявлен дважды — истина второго была бы взята от первого`);
      process.exit(3);
    }
    seen.add(spec.id);
    for (const p of spec.patterns || []) {
      try {
        reFromConfig(p, "gmi");
      } catch (e) {
        console.error(`claimcheck: невалидный шаблон у «${spec.id}»: ${p}\n  ${e.message}`);
        process.exit(3);
      }
    }
  }
}
if (!drafts.length) {
  console.error(
    "claimcheck: не указан ни один файл черновика.\n" +
      "  node tools/claimcheck.mjs <файл...> [--surfaces] [--strict] [--json]"
  );
  process.exit(2);
}

const findings = [];
const truthCache = new Map();
function truthCached(spec) {
  if (!truthCache.has(spec.id)) truthCache.set(spec.id, truthOf(spec));
  return truthCache.get(spec.id);
}

function checkNumbersIn(file, text, scope) {
  for (const spec of cfg.claims || []) {
    const hits = findClaims(text, spec);
    if (!hits.length) continue;
    const t = truthCached(spec);
    for (const h of hits) {
      if (h.value === null) {
        findings.push({
          verdict: "UNPARSED",
          scope,
          file,
          line: h.line,
          claim: spec.id,
          said: h.raw,
          truth: t.value,
          how: t.how,
          excerpt: h.excerpt,
          why: `шаблон сработал, но «${h.raw}» не читается как число — проверка не состоялась`,
        });
      } else if (t.value === null) {
        findings.push({
          verdict: "UNVERIFIABLE",
          scope,
          file,
          line: h.line,
          claim: spec.id,
          said: h.value,
          truth: null,
          how: t.how,
          excerpt: h.excerpt,
          why: "истину вычислить не удалось — утверждение осталось непроверенным",
        });
      } else if (!eqNum(h.value, t.value, spec.tolerance || 0)) {
        findings.push({
          verdict: "CONTRADICTED",
          scope,
          file,
          line: h.line,
          claim: spec.id,
          said: h.value,
          truth: t.value,
          how: t.how,
          excerpt: h.excerpt,
          why: `в тексте ${h.raw}, в данных ${t.value}`,
        });
      } else {
        findings.push({
          verdict: "OK",
          scope,
          file,
          line: h.line,
          claim: spec.id,
          said: h.value,
          truth: t.value,
          how: t.how,
          excerpt: h.excerpt,
          why: "совпало с данными",
        });
      }
    }
  }
}

function checkGuardsIn(file, text) {
  // 1. Объявленные открытые вопросы: тема упомянута — оговорка обязана быть рядом.
  for (const g of cfg.open_questions || []) {
    const topic = reFromConfig(g.topic, "gmi");
    let m;
    while ((m = topic.exec(text)) !== null) {
      const around = text.slice(Math.max(0, m.index - (g.window || 400)), m.index + (g.window || 400));
      const hedged = reFromConfig(g.hedge, "i").test(around);
      if (!hedged) {
        findings.push({
          verdict: "OPEN-QUESTION",
          scope: "guard",
          file,
          line: text.slice(0, m.index).split(/\n/).length,
          claim: g.id,
          excerpt: excerptAt(text, m.index),
          why: g.why || "тема открыта в собственных файлах, а в тексте нет оговорки",
        });
      }
      if (m.index === topic.lastIndex) topic.lastIndex++;
    }
  }
  // 2. Абсолютные утверждения без квалификатора. Это флаг, а не приговор: скрипт не знает,
  //    правда ли «самый крупный», — он знает, что три из моих блокеров были ровно такими.
  const abs = reFromConfig(cfg.absolutes?.pattern || "", "gmi");
  if (cfg.absolutes?.pattern) {
    const qual = reFromConfig(cfg.absolutes.qualifier || "$^", "i");
    let m;
    while ((m = abs.exec(text)) !== null) {
      const around = text.slice(Math.max(0, m.index - 160), m.index + 160);
      if (!qual.test(around)) {
        findings.push({
          verdict: "ABSOLUTE",
          scope: "guard",
          file,
          line: text.slice(0, m.index).split(/\n/).length,
          claim: `absolute:${m[0].trim().toLowerCase()}`,
          excerpt: excerptAt(text, m.index),
          why: "абсолютное утверждение без квалификатора области — назови, среди чего оно верно",
        });
      }
      if (m.index === abs.lastIndex) abs.lastIndex++;
    }
  }
}

/* ------------------------------------------------------------------- запуск */
for (const d of drafts) {
  const abs = existsSync(d) ? d : join(root, d);
  if (!existsSync(abs)) {
    console.error(`claimcheck: нет файла ${d}`);
    process.exit(2);
  }
  const text = maskIgnored(readFileSync(abs, "utf8"));
  const rel = relative(root, abs).split(sep).join("/");
  checkNumbersIn(rel, text, "draft");
  if (!NO_GUARDS) checkGuardsIn(rel, text);
}

if (WITH_SURFACES) {
  const files = expand(cfg.surfaces || []);
  // Опечатка в глобе давала «поверхности проверены» при нуле проверенных файлов, зелёный
  // отчёт и код 0 — ровно та конфигурация, в которой старое число выживает на трёх страницах.
  if (!files.length) {
    findings.push({
      verdict: "CONTRADICTED",
      scope: "config",
      file: CONFIG_PATH,
      line: 0,
      claim: "surfaces",
      said: 0,
      truth: null,
      how: `шаблоны: ${(cfg.surfaces || []).join(", ") || "не заданы"}`,
      excerpt: "",
      why: "запрошена проверка поверхностей, но под шаблоны не попал ни один файл — проверено НОЛЬ поверхностей",
    });
  }
  for (const f of files) {
    if (drafts.some((d) => relative(root, existsSync(d) ? d : join(root, d)).split(sep).join("/") === f))
      continue;
    const raw = readIfExists(f);
    if (raw === null) continue;
    checkNumbersIn(f, maskIgnored(raw), "surface");
    // Тик 61: сторожа тоже гоняются по поверхностям. До этого дня они работали ТОЛЬКО
    // по черновику — то есть самая сильная часть проверки применялась к тексту, который
    // я собираюсь опубликовать, и ни разу к тексту, который уже опубликован. Ровно поэтому
    // «receive-only wallet» и «Balance: $0.00» простояли на живых страницах после того, как
    // перестали быть правдой: ни один прогон физически не мог их увидеть.
    if (!NO_GUARDS) checkGuardsIn(f, maskIgnored(raw));
  }
}

/* -------------------------------------------------------------------- вывод */
// Проверка, которая НЕ СОСТОЯЛАСЬ, не должна давать зелёный код выхода: переименуй файл
// с данными — и все зависящие от него величины перестанут проверяться, а CI останется чистым.
const FAIL = ["CONTRADICTED", "UNPARSED", "UNVERIFIABLE"];
const bad = findings.filter((f) => FAIL.includes(f.verdict));
const warn = findings.filter((f) => !FAIL.includes(f.verdict) && f.verdict !== "OK");
const ok = findings.filter((f) => f.verdict === "OK");

if (AS_JSON) {
  console.log(JSON.stringify({ checked: drafts, surfaces: WITH_SURFACES, findings }, null, 2));
} else {
  const mark = { CONTRADICTED: "✗", UNPARSED: "✗", "OPEN-QUESTION": "!", ABSOLUTE: "?", UNVERIFIABLE: "·", OK: "✓" };
  console.log(`claimcheck · ${drafts.join(", ")}${WITH_SURFACES ? " + поверхности" : ""}`);
  // Корень и конфиг печатаются всегда: если инструмент смотрит не туда, это должно быть видно
  // в первой же строке, а не выясняться из того, что проверок почему-то ноль.
  console.log(`  корень: ${root}\n  конфиг: ${relative(root, CONFIG_PATH) || CONFIG_PATH}\n`);
  if (!findings.length) console.log("  ничего из объявленного в конфиге в тексте не встретилось.");
  for (const grp of ["CONTRADICTED", "UNPARSED", "OPEN-QUESTION", "ABSOLUTE", "UNVERIFIABLE", "OK"]) {
    const list = findings.filter((f) => f.verdict === grp);
    if (!list.length) continue;
    console.log(`${mark[grp]} ${grp} — ${list.length}`);
    for (const f of list) {
      console.log(`    ${f.file}:${f.line}  [${f.claim}]  ${f.why}`);
      if (f.how && grp !== "OK") console.log(`        истина: ${f.how}`);
      console.log(`        «${f.excerpt}»`);
    }
    console.log("");
  }
  // Величина объявлена, но ни один её шаблон не сработал — это НЕ «чисто». Именно так вёл
  // себя сломанный `\w`: тишина, неотличимая от успеха. Теперь ненайденное перечисляется.
  const touched = new Set(findings.map((f) => f.claim));
  const untouched = (cfg.claims || []).map((s) => s.id).filter((id) => !touched.has(id));
  if (untouched.length) {
    console.log(
      `· не встретилось в тексте (${untouched.length} из ${(cfg.claims || []).length}): ${untouched.join(", ")}`
    );
    console.log("    это не «проверено и верно» — это «шаблон не сработал ни разу».\n");
  }
  console.log(
    `Итог: ${bad.length} не прошло (опровергнуто данными или проверка не состоялась), ` +
      `${warn.length} под вопросом, ${ok.length} совпало.`
  );
  if (!bad.length && !warn.length)
    console.log("Напоминание: скрипт проверяет только объявленное. Смысл он не понимает — см. корпус.");
}

process.exit(STRICT && bad.length ? 1 : 0);
