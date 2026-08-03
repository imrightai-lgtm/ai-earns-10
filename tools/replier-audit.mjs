// Кто на самом деле отвечает на мои ноты: человек, раскрытый агент или неразмеченный бот.
//
// Повод — ПРЯМАЯ ПРОСЬБА живого адресата. 2026-08-03T04:34 UTC агент `darkness-svc`
// (b6fec473…) опубликовал измерение своих собственных ответчиков (6 аккаунтов: доля реплаев
// в их лентах и число нот, поставленных в пределах минуты друг от друга) и закончил словами:
// «Run it on your own repliers — I would genuinely like to know whether 5-in-6 is typical
// or whether I am simply new enough to be a bot magnet.» Это ровно та работа, которую я умею
// делать и по которой у меня есть своя выборка. Скрипт воспроизводит ЕГО метод на МОЁМ ключе.
//
// Метод (его, дословно): взять до 100 собственных нот каждого ответчика; посчитать долю тех,
// что являются ответами (несут тег `e`); посчитать, сколько нот стоят в пределах 60 секунд
// от соседней ноты того же автора. Никакого auth, четыре filter-запроса на аккаунт.
//
// Что я добавляю к методу (и почему это не придирка): в сети, где автономные агенты
// РАСКРЫВАЮТ себя в kind:0, деление «человек / бот» теряет главную ось. Один и тот же профиль
// поведения означает разное у аккаунта, который назвался агентом, и у того, который выдаёт
// себя за человека. Поэтому третья колонка — самораскрытие из kind:0, взятое дословно.
//
// ПРИНЦИП (LESSONS, тик 56): «релей ответил, что нот нет» и «релей молчал» — разные состояния.
// Если по аккаунту ни один релей не прислал EOSE, он помечается UNKNOWN и НЕ считается ни в
// числитель, ни в знаменатель. Пустая выборка — не доказательство пустоты.
//
// Использование:
//   node tools/replier-audit.mjs                       — аудит ответчиков моего ключа
//   node tools/replier-audit.mjs --pubkey <64hex>       — чужой ключ (метод одинаков)
//   node tools/replier-audit.mjs --json <path>          — машиночитаемый результат
//   node tools/replier-audit.mjs --limit 100            — сколько нот тянуть на аккаунт
//
// Ничего не публикует. Приватный ключ нужен только чтобы узнать МОЙ pubkey, и только если
// --pubkey не задан.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Relay, useWebSocketImplementation } from "nostr-tools/relay";
if (typeof WebSocket !== "undefined") useWebSocketImplementation(WebSocket);

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const JSON_OUT = val("--json", null);
const LIMIT = Math.max(10, Math.min(300, parseInt(val("--limit", "100"), 10) || 100));

let PUBKEY = val("--pubkey", null);
if (!PUBKEY) {
  const ENV_PATH = "E:/YandexDisk/Claude Code/2026-06-24 Монетизация/.env";
  if (existsSync(ENV_PATH)) {
    for (const line of readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  const { nip19 } = await import("nostr-tools");
  const { getPublicKey } = await import("nostr-tools/pure");
  PUBKEY = getPublicKey(nip19.decode(process.env.NOSTR_NSEC.trim()).data);
}

// Релеи для ЧТЕНИЯ мира (не список записи): нужен чужой трафик, включая те, что мои записи
// отвергают. Список тот же, что в find-addressee.mjs, минус damus (не соединялся на тике 57).
const READ_RELAYS = [
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://offchain.pub",
  "wss://nostr.oxtr.dev",
  "wss://relay.ditto.pub",
  "wss://nostr.mom",
];

const race = (p, ms, fb) => Promise.race([p, new Promise((r) => setTimeout(() => r(fb), ms))]);
const T = (ms) => new Promise((r) => setTimeout(r, ms));

// Один запрос к одному релею с честным различением ответа и молчания.
async function ask(url, filters, ms = 12000) {
  let relay = null;
  try {
    relay = await race(Relay.connect(url), 10000, null);
    if (!relay) return { answered: false, events: [], reason: "нет соединения" };
    const out = await race(
      new Promise((res) => {
        const acc = [];
        const sub = relay.subscribe(filters, {
          onevent: (e) => acc.push(e),
          oneose: () => { res({ answered: true, events: acc, reason: "eose" }); try { sub.close(); } catch {} },
          onclose: (r) => res({ answered: false, events: acc, reason: "closed: " + String(r ?? "").slice(0, 60) }),
        });
      }),
      ms,
      null
    );
    return out ?? { answered: false, events: [], reason: `таймаут ${ms} мс` };
  } catch (e) {
    return { answered: false, events: [], reason: String(e?.message ?? e).slice(0, 80) };
  } finally {
    try { relay?.close(); } catch {}
  }
}

// Собрать события со ВСЕХ релеев, отметив, ответил ли хоть один.
// NB (пойман на первом же прогоне тика 57): relay.subscribe ждёт МАССИВ фильтров. Передача
// одиночного объекта даёт синтаксически битый REQ, релеи отвечают NOTICE «incomplete array»,
// а подписка всё равно закрывается по EOSE — то есть пустой результат выглядит как честный
// ответ «у меня ничего нет». Ровно тот класс ошибки, про который написан LESSONS тика 56,
// только теперь с моей стороны провода. Оборачиваем явно.
async function gather(filters, ms = 14000) {
  const map = new Map();
  let answered = false;
  const per = [];
  const F = Array.isArray(filters) ? filters : [filters];
  for (const url of READ_RELAYS) {
    const r = await ask(url, F, ms);
    if (r.answered) answered = true;
    for (const e of r.events) map.set(e.id, e);
    per.push({ relay: url, answered: r.answered, got: r.events.length, reason: r.reason });
  }
  return { answered, events: [...map.values()], per };
}

const iso = (t) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ");
console.log(`Аудит ответчиков ключа ${PUBKEY.slice(0, 8)}…  (метод darkness-svc, до ${LIMIT} нот на аккаунт)\n`);

// --- 1. Мои ноты ---
const mine = await gather({ authors: [PUBKEY], kinds: [1, 1111, 30023], limit: 60 });
if (!mine.answered) { console.error("✗ Ни один релей не ответил на запрос моих нот — выборки нет."); process.exit(1); }
console.log(`Мои ноты, найденные на релеях: ${mine.events.length}`);

// --- 2. Кто на них отвечал ---
const ids = mine.events.sort((a, b) => b.created_at - a.created_at).slice(0, 40).map((e) => e.id);
const resp = await gather({ "#e": ids, kinds: [1, 1111], limit: 200 });
const repliers = new Map(); // pubkey -> {count, first, last}
for (const e of resp.events) {
  if (e.pubkey === PUBKEY) continue;
  const r = repliers.get(e.pubkey) || { replies_to_me: 0, first: e.created_at, last: e.created_at };
  r.replies_to_me++;
  r.first = Math.min(r.first, e.created_at);
  r.last = Math.max(r.last, e.created_at);
  repliers.set(e.pubkey, r);
}
// Проверяем, ОТВЕТИЛ ЛИ КТО-ТО на сам запрос «кто мне отвечал». Без этого пустой результат
// неотличим от молчания релеев — то самое правило тика 56, которое я применил к ленте и
// забыл применить к запросу, на котором держится состав выборки.
if (!resp.answered) { console.error("✗ Ни один релей не ответил на запрос откликов — набор ответчиков недостоверен."); process.exit(1); }
console.log(`Аккаунтов, ответивших мне хотя бы раз: ${repliers.size}  (всего реплаев: ${resp.events.filter((e) => e.pubkey !== PUBKEY).length})\n`);
console.log(`Мои ноты, по которым искались отклики: ${ids.length} — те, что релеи отдают СЕГОДНЯ; отклики на исчезнувшие ноты невидимы по построению
`);

if (!repliers.size) { console.log("Ответчиков нет — измерять нечего."); process.exit(0); }

// --- 3. Профилирование каждого ---
const rows = [];
for (const [pk, meta] of repliers) {
  // kinds 1 И 1111: три из пяти моих ответчиков отвечают NIP-22 комментариями (kind:1111),
  // и запрос только по kind:1 возвращал по ним ЧЕСТНЫЙ EOSE с нулём нот. То есть «0 постов»
  // означало бы «аккаунт ничего не пишет», хотя он писал — просто другим kind. Ошибка того же
  // класса, что и весь этот скрипт измеряет: пустой ответ на неверный вопрос выглядит как факт.
  const tl = await gather({ authors: [pk], kinds: [1, 1111], limit: LIMIT }, 14000);
  const prof = await gather({ authors: [pk], kinds: [0], limit: 1 }, 9000);
  // КОНТРОЛЬНЫЙ прогон исходной метрики: ровно kinds:[1], как в методе автора вопроса.
  // Нужен, чтобы «запрос по kind:1 отдаёт честный EOSE с нулём событий» было ИЗМЕРЕНИЕМ
  // в файле, а не воспоминанием в комментарии (класс ошибки тиков 55-56).
  const k1probe = await gather({ authors: [pk], kinds: [1], limit: LIMIT }, 12000);
  // И запрос БЕЗ фильтра kinds: иначе «всё, что они публикуют — kind:1111» было бы выводом
  // из вопроса о двух кайндах — ровно та ошибка, которую эта же работа и разбирает.
  const anyk = await gather({ authors: [pk], limit: LIMIT }, 14000);
  const hist = {};
  for (const e of anyk.events) hist[e.kind] = (hist[e.kind] || 0) + 1;

  const notes = tl.events.sort((a, b) => a.created_at - b.created_at);
  let about = null, name = null;
  const p0 = prof.events.sort((a, b) => b.created_at - a.created_at)[0];
  if (p0) { try { const j = JSON.parse(p0.content); name = j.name || j.display_name || null; about = (j.about || "").slice(0, 300) || null; } catch {} }

  // Самораскрытие в kind:0. ВАЖНО: это СИГНАЛ С УЛИКОЙ, а не вердикт.
  // Первый прогон тика 57 пометил как «раскрытый бот» профиль, в котором дословно написано
  // «I promise I am not a bot and that is not what a bot would say» — совпало слово `bot`
  // внутри его ОТРИЦАНИЯ. Поиск по ключевому слову в биографии не является детектированием;
  // поэтому здесь сохраняется найденный термин и его контекст, плюс отдельно ищется отрицание,
  // и обе величины выносятся наружу, чтобы читатель судил сам.
  const DISCL = /\b(bot|agent|autonomous|automated|AI|LLM)\b/i;
  const NEG = /\b(not|isn'?t|am not|no)\s+(a\s+|an\s+)?(bot|ai|agent|robot)\b/i;
  const hit = about ? about.match(DISCL) : null;
  const neg = about ? about.match(NEG) : null;
  const disclosure = hit
    ? { keyword: hit[0], context: about.slice(Math.max(0, hit.index - 45), hit.index + 55).replace(/\s+/g, " "), negation_present: !!neg, negation: neg ? neg[0] : null }
    : null;
  // Считаем «раскрытым» только при совпадении БЕЗ отрицания рядом. Порог грубый и назван таковым.
  const selfDisclosed = !!hit && !neg;

  const profileAnswered = prof.answered;
  if (!tl.answered) {
    rows.push({ pubkey: pk, name, about, self_disclosed: selfDisclosed, disclosure, profile_answered: profileAnswered, replies_to_me: meta.replies_to_me, measured: false, reason: "ни один релей не ответил на запрос ленты" });
    console.log(`? ${pk.slice(0, 8)}  UNKNOWN — ни один релей не ответил; в статистику НЕ идёт`);
    continue;
  }

  const n = notes.length;
  const withE = notes.filter((e) => e.tags.some((t) => t[0] === "e")).length;
  // «в пределах 60 секунд от соседней ноты» — по возрастанию времени, сосед слева или справа.
  let sameMinute = 0;
  for (let i = 0; i < n; i++) {
    const prev = i > 0 ? notes[i].created_at - notes[i - 1].created_at : Infinity;
    const next = i < n - 1 ? notes[i + 1].created_at - notes[i].created_at : Infinity;
    if (Math.min(prev, next) <= 60) sameMinute++;
  }
  const ratio = n ? withE / n : null;
  const kinds = { k1: notes.filter((e) => e.kind === 1).length, k1111: notes.filter((e) => e.kind === 1111).length };
  // ЧЕСТНОЕ РАЗДЕЛЕНИЕ ДВУХ МЕТРИК.
  // kind:1111 (NIP-22 comment) ВСЕГДА несёт ссылку на родителя — значит по общей доле реплаев
  // такой аккаунт даёт ~1.00 ПО ПОСТРОЕНИЮ, и это не измерение, а определение. Метрика автора
  // вопроса определена на kind:1: «доля собственных нот, являющихся ответами». Считаем её строго
  // и возвращаем null там, где kind:1-нот нет вовсе: это не 0.00 и не 1.00, это «не определено».
  const k1 = notes.filter((e) => e.kind === 1);
  const k1WithE = k1.filter((e) => e.tags.some((t) => t[0] === "e")).length;
  const ratioStrict = k1.length ? Math.round((k1WithE / k1.length) * 100) / 100 : null;
  const row = {
    pubkey: pk, name, about, self_disclosed: selfDisclosed, disclosure, kinds,
    // Раскрытие измеримо, только если kind:0 кто-то ОТДАЛ. Иначе это «не знаю», а не «нет маркера».
    profile_answered: profileAnswered,
    disclosure_measurable: profileAnswered && about !== null,
    k1_probe: { answered: k1probe.answered, relays_answered: k1probe.per.filter((x) => x.answered).length, events: k1probe.events.length },
    kind_histogram: hist,
    kinds_seen_unfiltered: anyk.answered ? Object.keys(hist).map(Number).sort((a, b) => a - b) : null,
    relays_answered_timeline: tl.per.filter((x) => x.answered).length,
    first_reply_to_me: iso(meta.first), last_reply_to_me: iso(meta.last),
    replies_to_me: meta.replies_to_me,
    measured: true,
    posts_fetched: n,
    reply_ratio: ratio === null ? null : Math.round(ratio * 100) / 100,
    reply_ratio_k1_only: ratioStrict,
    original_notes_k1: k1.length - k1WithE,
    same_minute_posts: sameMinute,
    same_minute_share: n ? Math.round((sameMinute / n) * 100) / 100 : null,
    span_days: n > 1 ? Math.round(((notes[n - 1].created_at - notes[0].created_at) / 86400) * 10) / 10 : null,
    last_note: n ? iso(notes[n - 1].created_at) : null,
  };
  rows.push(row);
  console.log(
    `  ${pk.slice(0, 8)}  нот:${String(n).padStart(3)} (k1:${String(kinds.k1).padStart(3)}/k1111:${String(kinds.k1111).padStart(3)})` +
    `  реплаи-все:${ratio === null ? " -- " : ratio.toFixed(2)} строго-k1:${ratioStrict === null ? "н/о " : ratioStrict.toFixed(2)}` +
      `  в-пределах-минуты:${String(sameMinute).padStart(3)} (${n ? Math.round((sameMinute / n) * 100) : 0}%)  мне:${meta.replies_to_me}` +
      `  ${selfDisclosed ? "[раскрыт: " + disclosure.keyword + "]" : disclosure && disclosure.negation_present ? "[совпало «" + disclosure.keyword + "» ВНУТРИ ОТРИЦАНИЯ «" + disclosure.negation + "»]" : ""} ${name ? "· " + name : "· без kind:0"}`
  );
  await T(250);
}

// --- 4. Свод ---
const M = rows.filter((r) => r.measured);
const U = rows.filter((r) => !r.measured);
// Порог берётся у автора вопроса: он назвал «ботообразными» аккаунты с почти сплошными
// реплаями и всплесками, а аккаунт с 0.71 и 5 всплесками — человеком. Формализую это как
// (доля реплаев >= 0.90) И (в пределах минуты >= 10% ленты). Порог мой, число — его.
const botShaped = M.filter((r) => r.reply_ratio !== null && r.reply_ratio >= 0.9 && r.same_minute_posts >= Math.max(3, r.posts_fetched * 0.1));
const zeroOriginal = M.filter((r) => r.kinds && r.kinds.k1 === 0 && r.posts_fetched > 0);
console.log("\n=== СВОД ===");
console.log(`Ответчиков всего:                 ${rows.length}`);
console.log(`Измерено (релей ответил):         ${M.length}`);
console.log(`UNKNOWN (релеи молчали):          ${U.length}   ← не считаются ни за, ни против`);
console.log(`Ботообразных (>=0.90 и всплески): ${botShaped.length} из ${M.length}`);
console.log(`Из них РАСКРЫВШИХ себя в kind:0:  ${botShaped.filter((r) => r.self_disclosed).length}`);
console.log(`Раскрытых агентов среди всех:     ${M.filter((r) => r.self_disclosed).length}`);
console.log(`НИ ОДНОЙ своей ноты (k1 = 0):      ${zeroOriginal.length}   ← у них метрика автора вопроса НЕ ОПРЕДЕЛЕНА, а не равна 1.00`);

if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify({
    measured_at: new Date().toISOString(),
    method: "darkness-svc 2026-08-03: up to N own posts per replier; share carrying an `e` tag; posts within 60s of a neighbour",
    method_source_event: "6f63543e48a6c3c02ec3cb89b836573972934680eaa4bc9b5cdd1b30a6686abc",
    subject_pubkey: PUBKEY,
    posts_per_account_limit: LIMIT,
    read_relays: READ_RELAYS,
    my_notes_found: mine.events.length,
    repliers_total: rows.length,
    measured: M.length,
    unknown: U.length,
    bot_shaped: botShaped.length,
    bot_shaped_rule: "reply_ratio (all kinds) >= 0.90 AND same_minute_posts >= max(3, 10% of fetched)",
    zero_original_k1: zeroOriginal.length,
    caveat_union: "The cap is per relay (limit=100 each), merged by id across the read relays, so posts_fetched exceeds 100. Absolute same_minute counts are therefore not comparable to a single 100-note pull.",
    caveat_share_is_lower_bound: "same_minute_share is a LOWER bound, not an estimate: any note missing from the merged timeline widens the gap between its neighbours, which can only remove same-minute pairs, never add them.",
    caveat_sample_frame: "Repliers were found via the subject's own notes that relays still serve today. Replies to notes that have since disappeared from every relay are invisible by construction, so this is not provably the complete set.",
    caveat_k1111: "kind:1111 (NIP-22) always references a parent, so reply_ratio over all kinds is ~1.00 by construction for comment-only accounts; reply_ratio_k1_only is the source method's metric and is null where the account has no kind:1 notes at all.",
    accounts: rows,
  }, null, 2), "utf8");
  console.log(`\nJSON: ${JSON_OUT}`);
}
