// Ассерты страницы /notes/who-replies-measured — против ЖИВОГО домена и против исходного JSON.
// Проверяется не «страница открылась», а что каждое число совпадает с измерением и что
// на месте оговорки, которые снял состязательный критик тика 57.
//   node tools/assert-replier-note.mjs            — по живому домену
//   node tools/assert-replier-note.mjs --local    — по файлам в site/

import { readFileSync } from "node:fs";

const LOCAL = process.argv.includes("--local");
const BASE = "https://ai-experiment.pages.dev";
const d = JSON.parse(readFileSync("memory/replier-audit-tick57.json", "utf8"));

const html = LOCAL
  ? readFileSync("site/notes/who-replies-measured.html", "utf8")
  : await (await fetch(`${BASE}/notes/who-replies-measured`)).text();
const pub = LOCAL
  ? JSON.parse(readFileSync("site/notes/who-replies-measured.json", "utf8"))
  : await (await fetch(`${BASE}/notes/who-replies-measured.json`)).json();

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`  ✗ ${name}`); } };

const M = d.accounts.filter((r) => r.measured);
const zeroK1 = M.filter((r) => r.kinds && r.kinds.k1 === 0);
const strictDefined = M.filter((r) => r.reply_ratio_k1_only !== null);
const shape = (ratio, burst, posts) => ratio !== null && ratio >= 0.9 && burst >= Math.max(3, posts * 0.1);
const mineShaped = M.filter((r) => shape(r.reply_ratio, r.same_minute_posts, r.posts_fetched));

// --- структура ---
ok("страница отдалась", html.length > 12000);
ok("canonical на месте", html.includes(`${BASE}/notes/who-replies-measured`));
ok("нет незаполненных шаблонов", !html.includes("${"));
ok("нет [object Object]", !html.includes("[object"));
ok("нет NaN", !/\bNaN\b/.test(html));
ok("нет голого null в ячейках", !/>null</.test(html));
// «undefined» здесь — НАМЕРЕННЫЙ термин (метрика не определена), а не сбой шаблона.
// Проверяем не количество, а что каждое вхождение стоит в осмысленном контексте.
{
  const total = (html.match(/undefined/g) || []).length;
  const asPhrase = (html.match(/undefined for |metric undefined/g) || []).length;
  const asCell = (html.match(/<span class="none">undefined<\/span>/g) || []).length;
  ok(`каждое 'undefined' — про метрику, а не сбой шаблона (${asPhrase}+${asCell}=${total})`, total === asPhrase + asCell && total > 0);
}
ok("AI раскрыт в футере", /I am an autonomous AI agent/.test(html));
ok("CC0 указан", /CC0/.test(html));
ok("JSON-LD присутствует", html.includes("application/ld+json"));

// --- БЛОКЕРЫ КРИТИКА: каждый закрыт и проверяется ---
ok("Б1: сказано, что метрика НЕ ОПРЕДЕЛЕНА, а не 1.00", /<strong>undefined for \d+ of my \d+ repliers<\/strong>/.test(html) && /is a definition, not a measurement/.test(html));
ok("Б1: тавтологичность all-kinds правила признана", /partly manufactured by the/.test(html));
ok("Б2: их таблица приведена и правило применено к ОБЕИМ выборкам", html.includes("1cea5b50") && html.includes("c566aa07") && /one rule/i.test(html));
ok("Б2: указано 4 из 6, а не 5 из 6", html.includes("<strong>4 of 6</strong>"));
ok("Б2: расхождение отнесено к порогу, а не к их ошибке", /disagreement with my threshold, not with their/.test(html));
ok("Б3: НЕТ утверждения «всё, что они публикуют — 1111»", !/Everything they publish is <code>kind:1111<\/code>\.<\/p>/.test(html) && /plus reactions/.test(html));
ok("Б3: колонка других кайндов есть", /other kinds seen/i.test(html));
ok("Б4: kind:1-контроль ИЗМЕРЕН и назван", /k1_probe/.test(html) && /control query for exactly/.test(html));
ok("Б5: нет слов complete/all time про выборку", !/complete set of accounts/.test(html) && /not provably complete/.test(html));
ok("Б6: раскрытие подпёрто проверкой ответа профиля", pub.accounts.every((a) => a.profile_answered === true));
ok("Б7: display_name третьих лиц НЕ опубликованы", !html.includes("Kip Ashlynn") && !html.includes("PixelSurvivor") && !html.includes("forgemaster"));
ok("Б7: нет красного вердикта «denies it»", !html.includes("denies it"));
ok("Б7: сказано, что метод берёт всех без согласия", /did not opt in/.test(html));
ok("Б7: человек назван человеком, без намёка на автоматизацию", /thanked me for a note in July/.test(html) && /not because anything about her looked automated/.test(html));
ok("Б7: явная оговорка «это не обвинение»", /should be read as an accusation/.test(html));
ok("Б8: ссылка на репо есть", html.includes("github.com/imrightai-lgtm/ai-earns-10"));
ok("Б8: в Reproduce есть npm install", /npm install/.test(html));
ok("Б8: --pubkey обязателен в примере", /--pubkey &lt;any-64-hex&gt;/.test(html));

// --- ВАЖНОЕ из разбора ---
ok("В: «four filter queries» чужой фразы больше нет", !/four filter queries/i.test(html));
ok("В: противоречие 4-из-5 / 5-из-5 снято", !/carry an AI\/agent marker/.test(html));
ok("В: burst share назван нижней оценкой", /lower bound, not an estimate/.test(html));
ok("В: span назван окном выборки", /sample_span_days/.test(JSON.stringify(pub)));
ok("В: нет непроверенного «no NIP-05»", !/NIP-05/.test(html));
ok("В: нет непроверенной даты since 2026-06-24", !html.includes("since 2026-06-24"));
ok("В: непересечение выборок заявлено", /accounts common to both samples/.test(html) && /genuinely independent draws/.test(html));
ok("В: отвечен тезис про costly signal", /costly signal/.test(html) && /a reply costs nothing/.test(html));
ok("В: кап описан как «на релей»", /100 <em>per relay<\/em>/.test(html));

// --- числа: страница ↔ измерение ---
ok(`заголовок содержит ${zeroK1.length} of ${M.length}`, html.includes(`${zeroK1.length} of ${M.length}`));
ok(`bot-shaped на моей выборке = ${mineShaped.length}`, html.includes(`<strong>${mineShaped.length} of ${M.length}</strong>`) || html.includes(`${mineShaped.length} of ${M.length}`));
ok(`строгая метрика определена у ${strictDefined.length}`, html.includes(`undefined for ${zeroK1.length} of ${M.length}`) || html.includes(`${strictDefined.length} where it is defined`));
for (const r of d.accounts) {
  ok(`строка ${r.pubkey.slice(0, 8)}`, html.includes(r.pubkey.slice(0, 8)));
  if (r.measured) ok(`within60s ${r.pubkey.slice(0, 8)} = ${r.same_minute_posts}`, html.includes(`${r.same_minute_posts} <span class="dim">(≥`));
}
ok("их 6 pubkey-префиксов на месте", ["1cea5b50", "8de3b31e", "36e1a7d8", "d01b460c", "79498097", "c566aa07"].every((p) => html.includes(p)));

// --- хартия ---
ok("нет просьбы денег / обещаний дохода", !/(please donate|send me|pay me|invest|guaranteed|profit)/i.test(html));
ok("нет утверждения о типичности", !/this is typical/i.test(html));

// --- JSON ---
ok("JSON: CC0", pub.license === "CC0-1.0");
ok("JSON: столько же аккаунтов", pub.accounts.length === d.accounts.length);
ok("JSON: источник вопроса указан", pub.question_source.event === d.method_source_event);
ok("JSON: их таблица приложена", Array.isArray(pub.their_sample_transcribed) && pub.their_sample_transcribed.length === 6);
ok("JSON: общее правило и оба результата", pub.shared_rule_on_their_sample === "4 of 6" && pub.shared_rule_on_my_sample === `${mineShaped.length} of ${M.length}`);
ok("JSON: пересечение = 0", pub.samples_overlap === 0);
ok("JSON: кап на релей указан", pub.posts_per_account_limit_per_relay === d.posts_per_account_limit);
ok("JSON: 4 оговорки на месте", ["caveat_union", "caveat_k1111", "caveat_share_is_lower_bound", "caveat_sample_frame"].every((k) => typeof pub[k] === "string" && pub[k].length > 40));
ok("JSON: strict-метрика null там, где k1=0", pub.accounts.filter((a) => a.kinds && a.kinds.k1 === 0).every((a) => a.reply_ratio_k1_only === null));
ok("JSON: k1_probe у всех измеренных", pub.accounts.filter((a) => a.measured).every((a) => a.k1_probe && a.k1_probe.answered === true));
ok("JSON: биографий третьих лиц нет", !JSON.stringify(pub).includes('"about"'));
ok("JSON: имён третьих лиц нет", !JSON.stringify(pub).includes("Kip") && !JSON.stringify(pub).includes("PixelSurvivor"));

console.log(`\n${fail === 0 ? "✓" : "✗"} ассертов пройдено: ${pass}/${pass + fail}  (${LOCAL ? "локально" : BASE})`);
process.exit(fail === 0 ? 0 : 1);
