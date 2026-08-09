// ПРОВЕРКА: оставит ли платёж на этот Lightning-адрес ПУБЛИЧНУЮ расписку.
//
// Повод (тик 66). У эксперимента есть ровно один приход — 21 сат, 2026-08-03. В моём же реестре
// заработков агентов эта строка стоит как `claimed`, потому что кастодиальный баланс третьей
// стороной не проверяется. Я считал это свойством кошелька. Это свойство МАРШРУТА:
//   • обычный LNURL-pay на адрес     → публичного следа не остаётся вообще;
//   • zap (NIP-57) на ноту           → провайдер публикует ПОДПИСАННУЮ расписку kind:9735.
// Адрес при этом один и тот же. Выбирает маршрут плательщик, а склоняет к нему получатель —
// тем, о чём просит: адрес зовёт невидимый маршрут, нота зовёт расписку.
//
// Что делает скрипт (только чтение, ничего не платит и ничего не публикует):
//   1) читает /.well-known/lnurlp/<user> и печатает allowsNostr / commentAllowed / nostrPubkey;
//   2) подписывает СВОИМ ключом настоящий zap-запрос kind:9734 и запрашивает счёт у callback;
//   3) декодирует bolt11 и достаёт тег 23 (description hash);
//   4) сверяет его с sha256 сериализованного zap-запроса.
// Совпадение = счёт криптографически привязан к zap-запросу, то есть при оплате провайдер
// обязан выпустить расписку, содержащую именно этот запрос. Это и есть проверяемость.
//
// Чего проверка НЕ доказывает (и это написано в выводе, а не только здесь):
//   • что деньги на счету остались — расписка говорит о факте платежа, а не об остатке;
//   • что ключ провайдера действительно стоит за этим адресом, — доверие переносится, а не исчезает.
//
// Использование:
//   node --env-file=.env tools/zap-receipt-check.mjs                 — адрес из config.json
//   node --env-file=.env tools/zap-receipt-check.mjs --lud16 a@b.io  — чужой адрес
//   node --env-file=.env tools/zap-receipt-check.mjs --json out.json
// Ключ NOSTR_NSEC нужен ТОЛЬКО чтобы подписать zap-запрос (подпись, не деньги). Счёт не платится.
//
// Коды возврата: 0 — маршрут расписки работает; 1 — не работает или недоказуем; 2 — неверный вызов.

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { bech32 } from "@scure/base";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { nip19 } from "nostr-tools";

const args = process.argv.slice(2);
const val = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

let cfgLud16 = null;
try {
  cfgLud16 = JSON.parse(readFileSync("config.json", "utf8")).wallet?.lightning_address ?? null;
} catch {
  /* конфиг может отсутствовать при запуске из чужого каталога — тогда нужен --lud16 */
}
const LUD16 = val("--lud16", cfgLud16);
const AMOUNT_SATS = Math.max(1, parseInt(val("--sats", "21"), 10) || 21);
const JSON_OUT = val("--json", null);

if (!LUD16 || !LUD16.includes("@")) {
  console.error("Нужен Lightning-адрес: --lud16 user@host (или wallet.lightning_address в config.json)");
  process.exit(2);
}
const [user, host] = LUD16.split("@");

// bolt11 → значение тега (5-битные слова bech32). Возвращает hex или null.
function bolt11Tag(invoice, tagType) {
  const { words } = bech32.decode(invoice, 4000);
  const bits = [];
  for (const w of words) for (let i = 4; i >= 0; i--) bits.push((w >> i) & 1);
  let p = 35; // timestamp
  const read = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | bits[p++];
    return v;
  };
  const SIGNATURE_BITS = 520; // 512 бит подписи + 8 бит recovery, в конце
  let found = null;
  while (p + 15 <= bits.length - SIGNATURE_BITS) {
    const type = read(5);
    const nbits = read(10) * 5;
    const start = p;
    p += nbits;
    if (type !== tagType) continue;
    const bytes = [];
    let acc = 0, nb = 0;
    for (let i = start; i < start + nbits; i++) {
      acc = (acc << 1) | bits[i];
      if (++nb === 8) { bytes.push(acc); acc = 0; nb = 0; }
    }
    found = bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  return found;
}

const out = { measured: new Date().toISOString(), lud16: LUD16, sats: AMOUNT_SATS };
console.log(`Проверка маршрута расписки · ${out.measured} · ${LUD16}`);

// 1. lnurlp
const lnurlpUrl = `https://${host}/.well-known/lnurlp/${user}`;
let lnurlp;
try {
  const r = await fetch(lnurlpUrl);
  out.lnurlp_http = r.status;
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  lnurlp = await r.json();
} catch (e) {
  console.log(`  ✗ ${lnurlpUrl} — ${e.message}`);
  console.log("  Вывод: маршрут недоказуем — сама точка входа не ответила.");
  out.verdict = "lnurlp_failed";
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
  process.exit(1);
}
out.allows_nostr = lnurlp.allowsNostr === true;
out.comment_allowed = lnurlp.commentAllowed ?? 0;
out.nostr_pubkey = lnurlp.nostrPubkey ?? null;
console.log(`  ✓ lnurlp ${out.lnurlp_http} · allowsNostr: ${out.allows_nostr} · commentAllowed: ${out.comment_allowed}` +
  (out.nostr_pubkey ? ` · nostrPubkey: ${out.nostr_pubkey.slice(0, 8)}…` : ""));

if (!out.allows_nostr || !out.nostr_pubkey) {
  console.log("  Вывод: провайдер не объявляет поддержку zap — расписки не будет, приход останется claimed.");
  out.verdict = "no_nostr_support";
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
  process.exit(1);
}

// 2. подписанный zap-запрос
const nsec = process.env.NOSTR_NSEC;
if (!nsec) {
  console.error("  ✗ NOSTR_NSEC не задан — нечем подписать zap-запрос (нужен --env-file=.env)");
  process.exit(2);
}
const { data: sk } = nip19.decode(nsec);
const pk = getPublicKey(sk);
const relays = ["wss://relay.damus.io", "wss://relay.primal.net", "wss://nos.lol"];
const amountMsat = AMOUNT_SATS * 1000;
const zapReq = finalizeEvent({
  kind: 9734,
  created_at: Math.floor(Date.now() / 1000),
  content: "zap-receipt-check (проба маршрута, счёт не оплачивается)",
  tags: [["relays", ...relays], ["amount", String(amountMsat)], ["lnurl", "lnurl"], ["p", pk]],
}, sk);
const serialized = JSON.stringify(zapReq);
out.zap_request_id = zapReq.id;

// 3. счёт
let body;
try {
  const r = await fetch(`${lnurlp.callback}?amount=${amountMsat}&nostr=${encodeURIComponent(serialized)}`);
  out.callback_http = r.status;
  body = await r.json();
} catch (e) {
  console.log(`  ✗ callback — ${e.message}`);
  out.verdict = "callback_failed";
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
  process.exit(1);
}
if (!body?.pr) {
  console.log(`  ✗ callback ${out.callback_http} — счёт не выдан: ${JSON.stringify(body).slice(0, 160)}`);
  out.verdict = "no_invoice";
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
  process.exit(1);
}
console.log(`  ✓ callback ${out.callback_http} · счёт на ${AMOUNT_SATS} сат: ${body.pr.slice(0, 24)}…`);
out.has_verify_url = Boolean(body.verify);

// 4. сверка
const inInvoice = bolt11Tag(body.pr, 23);
const expected = createHash("sha256").update(serialized).digest("hex");
out.description_hash_in_invoice = inInvoice;
out.sha256_zap_request = expected;
out.bound = inInvoice === expected;

console.log(`  description_hash в счёте : ${inInvoice ?? "(тега нет)"}`);
console.log(`  sha256(zap-запрос)       : ${expected}`);
if (!out.bound) {
  console.log("  ✗ НЕ СОВПАЛО — счёт не привязан к zap-запросу, расписка не гарантируется.");
  out.verdict = "not_bound";
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
  process.exit(1);
}
out.verdict = "receipt_route_works";
console.log("  ✓ СОВПАЛО — счёт криптографически привязан к zap-запросу (NIP-57).");
console.log("");
console.log("  Что это значит: платёж по такому счёту обязывает провайдера опубликовать");
console.log("  подписанную расписку kind:9735, содержащую именно этот запрос, — её проверит");
console.log("  посторонний, не веря мне на слово.");
console.log("  Чего это НЕ значит: что средства на счету остались, и что ключ провайдера");
console.log("  действительно стоит за этим адресом. Доверие переносится, а не исчезает.");
if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
  console.log(`  JSON: ${JSON_OUT}`);
}
process.exit(0);
