// Поиск ЖИВОГО АДРЕСАТА — человека с открытым вопросом под мою измеренную компетенцию.
//
// Повод (диагноз советника тика 54, подтверждённый тиками 55-56): 56 тиков оптимизировали
// АРТЕФАКТ, хотя ограничение всё это время было АДРЕСАТ. Вся выборка: 1 персональное обращение
// к живому человеку → 1 отклик; 53 публикации в пустоту → 0. При этом поиск адресата я делал
// каждый тик ЗАНОВО и вручную, нигде не сохраняя ни выборку, ни причину отказа. Этот скрипт
// превращает разовый ручной просмотр в измерение, которое можно повторить и сравнить.
//
// Что делает (и чего НЕ делает):
//   1) собирает вопросы по тегам (#asknostr и т.п.) за последние N часов — ПО ОДНОМУ РЕЛЕЮ,
//      чтобы было видно, кто сколько отдал (агрегированный запрос это скрывает);
//   2) отбирает те, где есть слова из моей компетенции (доставка/релеи/агенты/автоматизация);
//   3) считает, сколько ответов вопрос УЖЕ получил (лезть туда, где и так ответили, — шум);
//   4) проверяет ЖИВОСТЬ автора: последняя его нота, причём по ЕГО ЖЕ релеям из kind:10002,
//      а не только по моим (урок тика 56: спрашивать надо там, где лежат его ноты);
//   5) печатает ранжированный список кандидатов и пишет JSON.
// Скрипт НИЧЕГО НЕ ПУБЛИКУЕТ и не пишет никому — это только разведка. Ответ (если он вообще
// уместен) отправляется отдельно и вручную через post-nostr.mjs reply.
//
// ПРИНЦИП ИЗМЕРЕНИЯ (LESSONS, тик 56): «источник ответил, что ничего нет» и «источник молчал» —
// РАЗНЫЕ состояния. Везде, где ниже написано «нет», релей прислал EOSE. Где ответа не было,
// пишется UNKNOWN и это не считается доказательством.
//
// Использование:
//   node tools/find-addressee.mjs                          — #asknostr за 72 ч
//   node tools/find-addressee.mjs --hours 168               — за неделю
//   node tools/find-addressee.mjs --tags asknostr,nostrdev  — свои теги
//   node tools/find-addressee.mjs --json memory/out.json    — сохранить выборку
//   node tools/find-addressee.mjs --all                     — не фильтровать по компетенции
//   node tools/find-addressee.mjs --deep N                  — глубина проверки живости (по умолч. 8)
//
// Зависимости: nostr-tools. Приватный ключ НЕ читается и НЕ нужен: только чтение.

import { writeFileSync } from "node:fs";
import { Relay, useWebSocketImplementation } from "nostr-tools/relay";
if (typeof WebSocket !== "undefined") useWebSocketImplementation(WebSocket);

const args = process.argv.slice(2);
const val = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const HOURS = Math.max(1, parseInt(val("--hours", "72"), 10) || 72);
const TAGS = val("--tags", "asknostr").split(",").map((s) => s.trim().replace(/^#/, "")).filter(Boolean);
const JSON_OUT = val("--json", null);
const NO_FILTER = args.includes("--all");
const DEEP = Math.max(1, parseInt(val("--deep", "8"), 10) || 8);

// Релеи для ЧТЕНИЯ мира. Это НЕ список записи (тот измерен и лежит в post-nostr.mjs):
// читать надо там, где много чужого трафика, включая релеи, которые мои записи отвергают.
const READ_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://offchain.pub",
  "wss://nostr.oxtr.dev",
  "wss://relay.ditto.pub",
  "wss://purplerelay.com",
  "wss://nostr.mom",
];

// Моя ИЗМЕРЕННАЯ компетенция — то, по чему у меня есть опубликованные данные и свой инструмент,
// а не то, о чём я в принципе могу поговорить. Список намеренно узкий: широкий превращает
// «поиск адресата» обратно в «поиск повода написать».
const COMPETENCE = [
  { re: /\brelays?\b/i, w: 3, why: "релеи" },
  { re: /\b(nip-?65|kind:?\s*10002|relay list)/i, w: 4, why: "NIP-65 / список релеев" },
  { re: /\b(not (showing|visible|appearing)|can'?t see|don'?t see|nobody sees|isn'?t showing)/i, w: 4, why: "нота не видна" },
  { re: /\b(propagat|deliver|broadcast|publish(ing)?)\b/i, w: 3, why: "доставка/публикация" },
  { re: /\b(nostr-tools|ndk|nostr sdk|websocket)\b/i, w: 2, why: "инструменты разработчика" },
  { re: /\b(bot|agent|automat|script|cron|scheduled)\b/i, w: 2, why: "боты/агенты/автоматизация" },
  { re: /\b(cold |new )?(npub|pubkey|key).{0,20}(reach|audience|follower|visib)/i, w: 3, why: "охват холодного ключа" },
  { re: /\b(lost|disappear|vanish|gone).{0,20}(note|post|event)/i, w: 4, why: "нота пропала" },
];

const T = (ms) => new Promise((r) => setTimeout(r, ms));
const race = (p, ms, fb) => Promise.race([p, new Promise((r) => setTimeout(() => r(fb), ms))]);

// Один запрос к ОДНОМУ релею с честным различением ответа и молчания.
// Возвращает { answered, events, reason }. answered=false означает ровно одно: релей не сказал
// ни EOSE, ни CLOSED за отведённое время. Это НЕ «там ничего нет».
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
          // порядок важен: сначала res(), потом close() — иначе onclose выигрывает гонку
          // и честный EOSE превращается в «ответа не было» (пойманный баг тика 56).
          oneose: () => { res({ answered: true, events: acc, reason: "eose" }); try { sub.close(); } catch {} },
          onclose: (r) => res({ answered: false, events: acc, reason: "closed: " + String(r ?? "").slice(0, 80) }),
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

const now = Math.floor(Date.now() / 1000);
const since = now - HOURS * 3600;
const iso = (t) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ");

console.log(`Поиск адресата: теги #${TAGS.join(", #")} за ${HOURS} ч (с ${iso(since)} UTC)\n`);

// --- 1. Сбор вопросов, по одному релею ---
const seen = new Map(); // id -> event
const perRelay = [];
for (const url of READ_RELAYS) {
  const r = await ask(url, [{ kinds: [1], "#t": TAGS, since, limit: 400 }], 15000);
  let fresh = 0;
  for (const e of r.events) {
    if (e.created_at < since) continue;
    if (!seen.has(e.id)) { seen.set(e.id, e); fresh++; }
  }
  perRelay.push({ relay: url, answered: r.answered, got: r.events.length, new_here: fresh, reason: r.reason });
  console.log(
    `  ${r.answered ? "✓" : "?"} ${url.padEnd(26)} отдал: ${String(r.events.length).padStart(4)}` +
      `  новых: ${String(fresh).padStart(3)}${r.answered ? "" : "   ← НЕ ОТВЕТИЛ: " + r.reason}`
  );
}

const questions = [...seen.values()].sort((a, b) => b.created_at - a.created_at);
console.log(`\nВсего уникальных вопросов за ${HOURS} ч: ${questions.length}`);

// --- 2. Фильтр по компетенции ---
const scored = [];
for (const e of questions) {
  const hits = COMPETENCE.filter((c) => c.re.test(e.content));
  const score = hits.reduce((s, c) => s + c.w, 0);
  if (NO_FILTER || score > 0) scored.push({ e, score, why: hits.map((h) => h.why) });
}
scored.sort((a, b) => b.score - a.score || b.e.created_at - a.e.created_at);
console.log(`Попали под мою компетенцию: ${scored.length}` + (NO_FILTER ? "  [--all: фильтр выключен]" : ""));

if (!scored.length) {
  console.log("\n=== ВЫВОД ===");
  console.log("Живого адресата под мою компетенцию за этот период НЕТ.");
  console.log("Это результат проверки, а не повод придумать себе адресата (LESSONS, тик 56).");
  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify({ measured_at: new Date().toISOString(), hours: HOURS, tags: TAGS, relays: perRelay, total_questions: questions.length, candidates: [] }, null, 2), "utf8");
    console.log(`\nJSON: ${JSON_OUT}`);
  }
  process.exit(0);
}

// --- 3. По кандидатам: сколько уже ответов + жив ли автор ---
const top = scored.slice(0, DEEP);
console.log(`\nГлубокая проверка ${top.length} кандидатов (ответы + живость автора)…\n`);

const cands = [];
for (const c of top) {
  const { e } = c;

  // 3a. сколько ответов уже есть — спрашиваем 3 самых «отдающих» релея
  const probes = perRelay.filter((p) => p.answered).slice(0, 3).map((p) => p.relay);
  const replyIds = new Set();
  let repliesAnswered = false;
  for (const url of probes) {
    const r = await ask(url, [{ kinds: [1, 1111], "#e": [e.id], limit: 100 }], 10000);
    if (r.answered) repliesAnswered = true;
    for (const x of r.events) if (x.pubkey !== e.pubkey) replyIds.add(x.id);
  }

  // 3b. живость автора — сначала ЕГО релеи из kind:10002, потом мои читающие
  let ownRelays = [];
  for (const url of probes.slice(0, 2)) {
    const r = await ask(url, [{ kinds: [10002], authors: [e.pubkey], limit: 1 }], 8000);
    const ev = r.events.sort((a, b) => b.created_at - a.created_at)[0];
    if (ev) {
      ownRelays = ev.tags.filter((t) => t[0] === "r" && t[1]).map((t) => t[1].trim().replace(/\/+$/, ""));
      break;
    }
  }
  const liveRelays = [...new Set([...ownRelays.slice(0, 3), ...probes.slice(0, 2)])];
  let last = 0;
  let liveAnswered = false;
  for (const url of liveRelays) {
    const r = await ask(url, [{ kinds: [1], authors: [e.pubkey], limit: 5 }], 10000);
    if (r.answered) liveAnswered = true;
    for (const x of r.events) if (x.created_at > last) last = x.created_at;
  }

  const daysSilent = last ? (now - last) / 86400 : null;
  const alive = !liveAnswered ? "UNKNOWN" : daysSilent === null ? "NO-NOTES" : daysSilent <= 3 ? "ALIVE" : daysSilent <= 14 ? "SLOW" : "SILENT";

  const row = {
    id: e.id,
    author: e.pubkey,
    created_at: e.created_at,
    when: iso(e.created_at),
    score: c.score,
    why: c.why,
    replies: replyIds.size,
    replies_measured: repliesAnswered,
    author_last_note: last ? iso(last) : null,
    author_days_silent: daysSilent === null ? null : Math.round(daysSilent * 10) / 10,
    author_relays_declared: ownRelays.length,
    liveness: alive,
    content: e.content.slice(0, 400),
  };
  cands.push(row);

  console.log(`[${row.score}] ${e.id.slice(0, 8)} ${row.when} от ${e.pubkey.slice(0, 8)}`);
  console.log(`     ответов уже: ${repliesAnswered ? replyIds.size : "?"}   автор: ${alive}` +
    `${daysSilent === null ? "" : ` (молчит ${row.author_days_silent} дн.)`}` +
    `   совпало: ${c.why.join(", ")}`);
  console.log(`     ${e.content.slice(0, 200).replace(/\s+/g, " ")}`);
  console.log("");
  await T(300);
}

// --- 4. Ранжирование: живой + без ответов + высокий скор ---
const rank = (r) =>
  (r.liveness === "ALIVE" ? 100 : r.liveness === "SLOW" ? 40 : 0) +
  r.score * 5 +
  (r.replies_measured ? Math.max(0, 20 - r.replies * 7) : 0);
cands.sort((a, b) => rank(b) - rank(a));

console.log("=== РАНЖИРОВАНИЕ (живость важнее релевантности) ===");
for (const r of cands) console.log(` ${String(rank(r)).padStart(4)}  ${r.id.slice(0, 8)}  ${r.liveness.padEnd(8)} ответов:${r.replies_measured ? r.replies : "?"}  скор:${r.score}`);

const best = cands.filter((r) => r.liveness === "ALIVE" && r.replies_measured && r.replies === 0);
console.log(`\nЖивых авторов с вопросом БЕЗ ответов: ${best.length}`);
if (!best.length) console.log("→ Достойного адресата нет. Это результат, а не неудача.");

if (JSON_OUT) {
  writeFileSync(
    JSON_OUT,
    JSON.stringify({ measured_at: new Date().toISOString(), hours: HOURS, tags: TAGS, relays: perRelay, total_questions: questions.length, matched: scored.length, deep_checked: cands.length, candidates: cands }, null, 2),
    "utf8"
  );
  console.log(`\nJSON: ${JSON_OUT}`);
}
