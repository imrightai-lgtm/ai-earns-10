// Ре-чек публикации: жива ли нота на релеях СПУСТЯ ВРЕМЯ, а не в момент публикации.
//
// Урок тика 54: "принято 3/4 релея + read-back 8/8" — это проверка МОМЕНТА, а не мира.
// Через 3 дня та же нота не читалась ни с одного релея. Этот скрипт делает поздний ре-чек
// и печатает результат по каждому релею отдельно (агрегированный запрос маскирует правду:
// один живой релей делает вид, что всё в порядке).
//
// Использование:
//   node tools/recheck-note.mjs                      — мои последние ноты по всем релеям
//   node tools/recheck-note.mjs <event-id-64hex>      — жив ли конкретный евент
//   node tools/recheck-note.mjs --author <pubkey-hex> — то же для чужого ключа
//
// Зависимости: nostr-tools (уже в проекте). NOSTR_NSEC читается только чтобы вывести
// СВОЙ публичный ключ; ничего не публикует.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getPublicKey } from "nostr-tools/pure";
import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import { nip19 } from "nostr-tools";
if (typeof WebSocket !== "undefined") useWebSocketImplementation(WebSocket);

const ENV_PATH = fileURLToPath(new URL("../.env", import.meta.url));
try {
  for (const line of readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch { /* .env необязателен, если передан --author */ }

// Ре-чек намеренно опрашивает и «плохие» релеи тоже: смысл проверки — увидеть РАЗБРОС,
// а не получить зелёную галочку. Порядок и состав сверены с аудитом тика 55.
const RELAYS = [
  "wss://relay.damus.io",
  "wss://relay.primal.net",
  "wss://relay.snort.social",
  "wss://relay.ditto.pub",
  "wss://offchain.pub",
  "wss://nostr.oxtr.dev",
  "wss://nostr.bitcoiner.social",
  "wss://relay.mostr.pub",
  "wss://purplerelay.com",
  "wss://nos.lol",          // отказывает этому ключу — контроль
  "wss://nostr.mom",        // говорит OK и выбрасывает — контроль
  "wss://relay.noswhere.com", // говорит OK и выбрасывает — контроль
];

const args = process.argv.slice(2);
const authorFlag = args.indexOf("--author");
let author = authorFlag >= 0 ? args[authorFlag + 1] : null;
const eventId = args.find((a) => /^[0-9a-f]{64}$/i.test(a) && a !== author);

if (!author) {
  if (!process.env.NOSTR_NSEC) {
    console.error("✗ Нет NOSTR_NSEC и не передан --author <pubkey>.");
    process.exit(1);
  }
  author = getPublicKey(nip19.decode(process.env.NOSTR_NSEC.trim()).data);
}

const ask = (relay, filter, ms = 15000) => {
  const pool = new SimplePool();
  return Promise.race([
    pool.querySync([relay], filter),
    new Promise((r) => setTimeout(() => r("TIMEOUT"), ms)),
  ])
    .catch((e) => "ERR:" + e.message)
    .finally(() => { try { pool.close([relay]); } catch { /* noop */ } });
};

console.log(`Ре-чек по ${RELAYS.length} релеям · автор ${author.slice(0, 8)}…` +
            (eventId ? ` · евент ${eventId.slice(0, 8)}…` : ""));
console.log("(проверка ПОЗДНЯЯ: успех означает, что нота ещё извлекаема, а не что её приняли)\n");

let alive = 0;
let reachable = 0;

for (const relay of RELAYS) {
  const notes = await ask(relay, { authors: [author], kinds: [1, 1111], limit: 100 });
  if (!Array.isArray(notes)) { console.log(`  ✗ ${relay}: ${notes}`); continue; }
  reachable++;
  const newest = notes.length
    ? new Date(Math.max(...notes.map((e) => e.created_at)) * 1000).toISOString().slice(0, 16)
    : "—";
  let verdict = `${String(notes.length).padStart(3)} нот, свежая ${newest}`;
  if (eventId) {
    const hit = notes.some((e) => e.id === eventId) ||
      (Array.isArray(await ask(relay, { ids: [eventId] })) &&
       (await ask(relay, { ids: [eventId] })).length > 0);
    if (hit) alive++;
    verdict += hit ? "  · ЕВЕНТ ЖИВ" : "  · ЕВЕНТА НЕТ";
  }
  console.log(`  ${notes.length ? "✓" : "·"} ${relay}: ${verdict}`);
}

console.log(`\nОтветили: ${reachable}/${RELAYS.length} релеев.`);
if (eventId) {
  console.log(alive
    ? `✓ Евент найден на ${alive} релеях — публикация пережила время.`
    : "✗ Евента нет НИ НА ОДНОМ отвечавшем релее. «Принято» ≠ «доставлено»: считать недоставленным.");
}
process.exit(0);
