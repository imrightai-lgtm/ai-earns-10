// Аудит РЕЛЕЕВ: кто на самом деле ХРАНИТ ноты холодного ключа, а кто говорит "OK" и молча выбрасывает.
//
// Повод (тик 54, измерено): ответ, ПРИНЯТЫЙ 4 релеями минуту назад, при ре-чеке по 7 релеям
// читается ровно с ОДНОГО — включая два релея, которые только что ответили "OK".
// "Принято" — расписка одного сервера об одном моменте, не доставка (LESSONS.md).
//
// Что делает скрипт (по КАЖДОМУ релею отдельно, никаких агрегированных запросов):
//   1) connect            — соединяется ли вообще;
//   2) has_before         — лежит ли евент там УЖЕ (до нашей отправки);
//   3) publish            — принимает ли (OK true/false + дословная причина релея);
//   4) read_back_now      — отдаёт ли его ОБРАТНО сразу после приёма (тот же сокет);
//   5) verdict            — STORES / ACCEPTS-BUT-DROPS / REJECTS / UNREACHABLE.
//
// Публикуется ТОТ ЖЕ САМЫЙ подписанный евент (идемпотентно по id): это не новый пост
// и не рассылка — это повторная доставка уже существующей работы. Ничего нового не создаётся.
//
// Использование:
//   node tools/relay-audit.mjs <event-id-64hex>            — аудит на реальном евенте
//   node tools/relay-audit.mjs <id> --dry-run              — только чтение, без publish
//   node tools/relay-audit.mjs <id> --json <path>          — сохранить машиночитаемый результат
//   node tools/relay-audit.mjs <id> --relays a,b,c         — целевая доставка на конкретные релеи
//                                                            (например, объявленные адресатом в kind:10002)
//   node tools/relay-audit.mjs <id> --attempts N           — N попыток соединения перед вердиктом
//                                                            UNREACHABLE (1..5, по умолчанию 1)
//
// Зависимости: nostr-tools. Приватный ключ НЕ нужен и НЕ читается: евент уже подписан.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { verifyEvent } from "nostr-tools/pure";
import { Relay, useWebSocketImplementation } from "nostr-tools/relay";
import { SimplePool } from "nostr-tools/pool";
if (typeof WebSocket !== "undefined") useWebSocketImplementation(WebSocket);

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const jsonIdx = args.indexOf("--json");
const JSON_OUT = jsonIdx >= 0 ? args[jsonIdx + 1] : null;
const EVENT_ID = args.find((a) => /^[0-9a-f]{64}$/i.test(a));

if (!EVENT_ID) {
  console.error("Нужен полный 64-hex id евента: node tools/relay-audit.mjs <event-id>");
  process.exit(2);
}

const relaysIdx = args.indexOf("--relays");
const CUSTOM = relaysIdx >= 0 ? args[relaysIdx + 1] : null;

// Сколько раз пробовать соединиться, прежде чем записать релей в UNREACHABLE (см. тик 56).
const attIdx = args.indexOf("--attempts");
const ATTEMPTS = Math.max(1, Math.min(5, attIdx >= 0 ? parseInt(args[attIdx + 1], 10) || 1 : 1));

// Широкий список публичных релеев. Цель — не «побольше», а измерить, кто РЕАЛЬНО хранит.
const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://relay.nostr.band",
  "wss://nostr.wine",
  "wss://relay.snort.social",
  "wss://onlynostr.club",
  "wss://relay.ditto.pub",
  "wss://offchain.pub",
  "wss://nostr.mom",
  "wss://relay.nostr.bg",
  "wss://nostr.oxtr.dev",
  "wss://relay.noswhere.com",
  "wss://nostr.bitcoiner.social",
  "wss://relay.mostr.pub",
  "wss://purplerelay.com",
  "wss://nostr21.com",
  "wss://relay.nostrplebs.com",
  "wss://nostr.land",
  "wss://relay.wellorder.net",
];

// Нормализация: релеи в kind:10002 часто записаны с хвостовым слэшем — для WebSocket это
// другой URL, и половина проверок молча падает (измерено тиком 55).
const norm = (u) => u.trim().replace(/\/+$/, "");
const RELAYS = [...new Set((CUSTOM ? CUSTOM.split(",") : DEFAULT_RELAYS).map(norm).filter(Boolean))];

const T = (ms) => new Promise((r) => setTimeout(r, ms));
const race = (p, ms, fallback) =>
  Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]);

// --- 1. Достаём сам подписанный евент (с любого релея, где он ещё жив) ---
console.log(`Аудит релеев по евенту ${EVENT_ID.slice(0, 8)}…${DRY ? "  [DRY-RUN: без publish]" : ""}`);
const pool = new SimplePool();
// Достаём с ШИРОКОГО списка, даже если аудит идёт по узкому: иначе восстановить нечего.
const SEED = DEFAULT_RELAYS.slice(0, 8);
const found = await race(pool.querySync(SEED, { ids: [EVENT_ID] }), 20000, []);
pool.close(SEED);

if (!found.length) {
  console.error("✗ Евент не найден НИ НА ОДНОМ из опрошенных релеев — восстановить нечего.");
  console.error("  (Это само по себе результат: публикация исчезла полностью.)");
  process.exit(1);
}
const ev = found[0];
if (!verifyEvent(ev)) {
  console.error("✗ Подпись евента не проходит проверку — публиковать это нельзя.");
  process.exit(1);
}
console.log(
  `✓ Евент восстановлен и подпись верна: kind ${ev.kind}, автор ${ev.pubkey.slice(0, 8)}…, ` +
    `создан ${new Date(ev.created_at * 1000).toISOString().slice(0, 16)}, ${ev.content.length} симв.\n`
);

// --- 2. По одному релею: has_before → publish → read_back ---
const results = [];

async function probe(url) {
  const row = { relay: url, connect: false, has_before: null, accepted: null, note: "", read_back: null, verdict: "" };
  let relay = null;
  try {
    relay = await race(Relay.connect(url), 12000, null);
    if (!relay) throw new Error("timeout при подключении");
    row.connect = true;

    // 2a. лежит ли уже.
    // ВАЖНО (найдено критиком на тике 56): раньше таймаут запроса и честный пустой ответ
    // давали ОДИН И ТОТ ЖЕ вердикт NOT-THERE — то есть «релей сказал: нет» было неотличимо
    // от «релей молчал 10 секунд». На этом держался вывод статьи, поэтому теперь различаем:
    //   EOSE + 0 событий  -> релей ЯВНО ответил, что евента нет  (has_before=false, eose=true)
    //   CLOSED <причина>  -> релей отказал в чтении (например auth-required)
    //   таймаут           -> ответа не было вовсе                (has_before=null, eose=false)
    const before = await race(
      new Promise((res) => {
        const acc = [];
        const sub = relay.subscribe([{ ids: [EVENT_ID] }], {
          onevent: (e) => acc.push(e),
          // ПОРЯДОК ВАЖЕН: сначала res(eose), потом close(). sub.close() синхронно дёргает
          // onclose («closed by caller»), и если резолвить после закрытия, то ЧЕСТНЫЙ EOSE
          // приходит в промис как «релей закрыл подписку» — ровно та подмена, которую
          // этот код и должен устранять.
          oneose: () => { res({ kind: "eose", events: acc }); try { sub.close(); } catch {} },
          onclose: (reason) => res({ kind: "closed", events: acc, reason: String(reason ?? "") }),
        });
      }),
      10000,
      null
    );
    if (before === null) {
      row.has_before = null;
      row.read_answered = false;
      row.read_note = "таймаут: релей не прислал ни EOSE, ни CLOSED за 10 с";
    } else if (before.kind === "closed" && !before.events.length) {
      row.has_before = null;
      row.read_answered = false;
      row.read_note = "релей закрыл подписку: " + (before.reason || "без причины").slice(0, 120);
    } else {
      row.has_before = before.events.length > 0;
      row.read_answered = true;
      row.read_note = before.events.length ? "" : "EOSE без событий: релей явно ответил, что евента нет";
    }

    // 2b. отправка того же подписанного евента
    if (!DRY) {
      const pub = await race(
        relay.publish(ev).then((m) => ({ ok: true, msg: String(m ?? "") })).catch((e) => ({ ok: false, msg: String(e?.message ?? e) })),
        15000,
        { ok: null, msg: "timeout (релей не ответил OK/NOTICE)" }
      );
      row.accepted = pub.ok;
      row.note = pub.msg.slice(0, 160);

      await T(1200); // дать релею записать

      // 2c. отдаёт ли обратно ПО ТОМУ ЖЕ соединению
      const after = await race(
        new Promise((res) => {
          const acc = [];
          const sub = relay.subscribe([{ ids: [EVENT_ID] }], {
            onevent: (e) => acc.push(e),
            oneose: () => { try { sub.close(); } catch {} res(acc); },
          });
        }),
        10000,
        null
      );
      row.read_back = after === null ? null : after.length > 0;
    }
  } catch (e) {
    row.note = String(e?.message ?? e).slice(0, 160);
  } finally {
    try { relay?.close(); } catch {}
  }
  return row;
}

for (const url of RELAYS) {
  // Одиночный проход НЕДООЦЕНИВАЕТ мир: тик 56 записал `relay.damus.io` как UNREACHABLE в общем
  // прогоне по 20 релеям, а две прицельные повторные попытки подряд нашли на нём евент. Отказ
  // соединения бывает мгновенным и случайным, поэтому вердикт UNREACHABLE выносится только после
  // ATTEMPTS неудачных попыток, и в результат пишется, сколько их понадобилось.
  let row = null;
  let used = 0;
  for (let i = 1; i <= ATTEMPTS; i++) {
    used = i;
    row = await probe(url);
    if (row.connect) break;
    if (i < ATTEMPTS) await T(1500);
  }
  row.connect_attempts = used;

  // --- вердикт ---
  if (!row.connect) row.verdict = "UNREACHABLE";
  // NO-ANSWER ≠ NOT-THERE: второе — заявление релея, первое — его молчание. Смешивать нельзя.
  else if (DRY) row.verdict = row.has_before === null ? "NO-ANSWER" : row.has_before ? "HAS-IT" : "NOT-THERE";
  else if (row.accepted === false) row.verdict = "REJECTS";
  else if (row.read_back === true) row.verdict = "STORES";
  else if (row.accepted === true && row.read_back === false) row.verdict = "ACCEPTS-BUT-DROPS";
  else row.verdict = "UNCLEAR";

  const icon = { STORES: "✓", "ACCEPTS-BUT-DROPS": "✗", REJECTS: "·", UNREACHABLE: "·", UNCLEAR: "?", "HAS-IT": "✓", "NOT-THERE": "·", "NO-ANSWER": "?" }[row.verdict] || "?";
  console.log(
    `${icon} ${url.padEnd(32)} было:${row.has_before === null ? "?" : row.has_before ? "да" : "нет"}` +
      ` принял:${row.accepted === null ? "-" : row.accepted ? "да" : "НЕТ"}` +
      ` отдал:${row.read_back === null ? "-" : row.read_back ? "да" : "НЕТ"}` +
      `  ${row.verdict}${row.connect_attempts > 1 ? ` (попыток: ${row.connect_attempts})` : ""}` +
      `${row.read_note ? "  :: " + row.read_note : ""}` +
      `${row.note ? "  :: " + row.note : ""}`
  );
  results.push(row);
}

// --- 3. Сводка ---
const by = (v) => results.filter((r) => r.verdict === v);
console.log("\n=== СВОДКА ===");
console.log(`Всего релеев опрошено:     ${results.length}`);
console.log(`Соединение установлено:    ${results.filter((r) => r.connect).length}`);
if (!DRY) {
  console.log(`Ответили OK (приняли):     ${results.filter((r) => r.accepted === true).length}`);
  console.log(`РЕАЛЬНО ХРАНЯТ (отдали):   ${by("STORES").length}  ← единственное, что означает доставку`);
  console.log(`Сказали OK и выбросили:    ${by("ACCEPTS-BUT-DROPS").length}`);
  console.log(`Явно отказали:             ${by("REJECTS").length}`);
  console.log(`Недоступны:                ${by("UNREACHABLE").length}`);
  const stores = by("STORES").map((r) => r.relay);
  if (stores.length) {
    console.log("\nРелеи, которые хранят ноты этого ключа (список для NOSTR_RELAYS):");
    console.log(stores.join(","));
  }
}

if (JSON_OUT) {
  writeFileSync(
    JSON_OUT,
    JSON.stringify({ event_id: EVENT_ID, pubkey: ev.pubkey, kind: ev.kind, created_at: ev.created_at, dry_run: DRY, relays: results }, null, 2),
    "utf8"
  );
  console.log(`\nМашиночитаемый результат: ${JSON_OUT}`);
}
