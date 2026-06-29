#!/usr/bin/env node
// Постинг в Nostr — свободный открытый протокол: агент ведёт канал САМ из своего ключа,
// без чужого аккаунта/телефона/KYC. Подписи Schnorr/BIP340 — через проверенную nostr-tools.
// Ключ хранится в .env (NOSTR_NSEC) и НИКОГДА не попадает в репозиторий (.env в .gitignore).
//
// Подкоманды:
//   node tools/post-nostr.mjs keygen        — создать ключ (если нет) -> дописать NOSTR_NSEC в .env, напечатать npub
//   node tools/post-nostr.mjs verify        — самопроверка: sign+verifyEvent (локально) + чтение с релеев (connectivity). НЕ публикует.
//   node tools/post-nostr.mjs profile       — опубликовать профиль kind:0 (NOSTR_NAME/ABOUT/WEBSITE/LUD16)
//   node tools/post-nostr.mjs post "текст"  — опубликовать заметку kind:1
//   node tools/post-nostr.mjs post --file p — опубликовать заметку из файла
//
// .env:
//   NOSTR_NSEC    — секретный ключ (nsec...). Создаётся keygen. СЕКРЕТ, не коммитить.
//   NOSTR_RELAYS  — релеи через запятую (опц.; есть дефолты)
//   NOSTR_NAME / NOSTR_ABOUT / NOSTR_WEBSITE / NOSTR_LUD16 — для профиля (опц.)

import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from "nostr-tools/pure";
import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import { nip19 } from "nostr-tools";

// Node 21+ имеет глобальный WebSocket — используем его (без зависимости 'ws').
if (typeof WebSocket !== "undefined") useWebSocketImplementation(WebSocket);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = join(root, ".env");

function loadEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnv(ENV_PATH);
const E = process.env;

const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://relay.nostr.band",
];
const relays = () =>
  E.NOSTR_RELAYS ? E.NOSTR_RELAYS.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_RELAYS;

function getSecretKey() {
  if (!E.NOSTR_NSEC) return null;
  try {
    const dec = nip19.decode(E.NOSTR_NSEC.trim());
    if (dec.type !== "nsec") throw new Error("это не nsec");
    return dec.data; // Uint8Array
  } catch (e) {
    console.error("✗ NOSTR_NSEC некорректен:", e.message);
    process.exit(1);
  }
}

async function publish(event) {
  const pool = new SimplePool();
  const rs = relays();
  const results = await Promise.allSettled(pool.publish(rs, event));
  let ok = 0;
  results.forEach((r, i) => {
    if (r.status === "fulfilled") { ok++; console.log(`  ✓ ${rs[i]}`); }
    else console.log(`  ✗ ${rs[i]}: ${(r.reason && r.reason.message) || r.reason}`);
  });
  pool.close(rs);
  return ok;
}

// Чтение событий с релеев (проверка связи), с таймаутом, без публикации.
async function readSome(filter, ms) {
  const pool = new SimplePool();
  const rs = relays();
  try {
    const events = await Promise.race([
      pool.querySync(rs, filter),
      new Promise((res) => setTimeout(() => res([]), ms)),
    ]);
    return events || [];
  } catch (e) {
    console.log("relay read error:", e.message);
    return [];
  } finally {
    try { pool.close(rs); } catch (e) {}
  }
}

const cmd = process.argv[2];

if (cmd === "keygen") {
  if (E.NOSTR_NSEC) {
    console.log("Ключ уже есть. npub:", nip19.npubEncode(getPublicKey(getSecretKey())));
    process.exit(0);
  }
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const nsec = nip19.nsecEncode(sk);
  const npub = nip19.npubEncode(pk);
  appendFileSync(
    ENV_PATH,
    `\n# Nostr identity (СЕКРЕТ — не коммитить). Создан tools/post-nostr.mjs keygen.\nNOSTR_NSEC=${nsec}\n`,
    "utf8"
  );
  console.log("✓ Создан Nostr-ключ, дописан в .env (NOSTR_NSEC).");
  console.log("  npub (публичный, можно делиться):", npub);
  console.log("  hex pubkey:", pk);
  console.log("  ⚠ nsec лежит в .env (gitignored) — это секрет, не публикуй и не коммить.");
  process.exit(0);
}

if (cmd === "verify") {
  const sk = generateSecretKey(); // эфемерный ключ только для самопроверки
  const ev = finalizeEvent(
    { kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content: "selftest (not broadcast)" },
    sk
  );
  const valid = verifyEvent(ev);
  console.log(`local sign+verifyEvent: ${valid ? "PASS" : "FAIL"}`);

  const events = await readSome({ kinds: [1], limit: 3 }, 9000);
  const got = events.length;
  console.log(`relay read connectivity: ${got > 0 ? "PASS" : "FAIL"} (получено ${got} событий с релеев: ${relays().join(", ")})`);
  console.log("publish path: реализован (kind:0 profile + kind:1 post) — будет задействован после авторизации канала оператором.");
  process.exit(valid && got > 0 ? 0 : 1);
}

if (cmd === "profile") {
  const sk = getSecretKey();
  if (!sk) { console.error("✗ Нет NOSTR_NSEC. Сначала: node tools/post-nostr.mjs keygen"); process.exit(1); }
  const meta = {};
  if (E.NOSTR_NAME) meta.name = E.NOSTR_NAME;
  if (E.NOSTR_ABOUT) meta.about = E.NOSTR_ABOUT;
  if (E.NOSTR_WEBSITE) meta.website = E.NOSTR_WEBSITE;
  if (E.NOSTR_LUD16) meta.lud16 = E.NOSTR_LUD16;
  const ev = finalizeEvent(
    { kind: 0, created_at: Math.floor(Date.now() / 1000), tags: [], content: JSON.stringify(meta) },
    sk
  );
  console.log("Публикую профиль kind:0:", JSON.stringify(meta));
  const ok = await publish(ev);
  console.log(ok > 0 ? `✓ Профиль опубликован на ${ok} релеях.` : "✗ Не принято ни одним релеем.");
  process.exit(ok > 0 ? 0 : 1);
}

if (cmd === "post") {
  const sk = getSecretKey();
  if (!sk) { console.error("✗ Нет NOSTR_NSEC. Сначала: node tools/post-nostr.mjs keygen"); process.exit(1); }
  const a = process.argv.slice(3);
  let text = a[0] === "--file" ? (a[1] ? readFileSync(a[1], "utf8") : "") : a.join(" ");
  text = (text || "").trim();
  if (!text) { console.error("✗ Пустой текст."); process.exit(1); }
  // Инлайн-хэштеги -> "t"-теги (находимость в Nostr-клиентах).
  const htags = [...new Set((text.match(/(?:^|\s)#([\p{L}0-9_]+)/gu) || []).map((h) => h.trim().replace(/^#/, "").toLowerCase()))];
  const tags = htags.map((h) => ["t", h]);
  const ev = finalizeEvent(
    { kind: 1, created_at: Math.floor(Date.now() / 1000), tags, content: text },
    sk
  );
  console.log(`Публикую заметку kind:1 (${text.length} симв.), event id ${ev.id.slice(0, 12)}…`);
  const ok = await publish(ev);
  if (ok > 0) {
    console.log(`✓ Опубликовано на ${ok} релеях.`);
    try {
      const pk = getPublicKey(sk);
      console.log("  Посмотреть:", "https://njump.me/" + nip19.neventEncode({ id: ev.id, relays: relays().slice(0, 2), author: pk }));
    } catch (e) {}
  } else {
    console.log("✗ Не принято ни одним релеем.");
  }
  process.exit(ok > 0 ? 0 : 1);
}

if (cmd === "reply") {
  const sk = getSecretKey();
  if (!sk) { console.error("✗ Нет NOSTR_NSEC. Сначала: node tools/post-nostr.mjs keygen"); process.exit(1); }
  const a = process.argv.slice(3);
  const target = a[0];
  if (!target) { console.error('✗ Укажи родителя: reply <nevent|note|hex> "текст" (или --file)'); process.exit(1); }
  let text = a[1] === "--file" ? (a[2] ? readFileSync(a[2], "utf8") : "") : a.slice(1).join(" ");
  text = (text || "").trim();
  if (!text) { console.error("✗ Пустой текст."); process.exit(1); }
  let pid = null, prelays = [];
  try {
    if (/^[0-9a-f]{64}$/i.test(target)) pid = target.toLowerCase();
    else {
      const d = nip19.decode(target);
      if (d.type === "nevent") { pid = d.data.id; prelays = d.data.relays || []; }
      else if (d.type === "note") pid = d.data;
    }
  } catch (e) {}
  if (!pid) { console.error("✗ Не распознал id родителя (нужен nevent/note/hex)."); process.exit(1); }
  const pool = new SimplePool();
  const rs = relays();
  const parent = (await Promise.race([pool.querySync(rs, { ids: [pid] }), new Promise((r) => setTimeout(() => r([]), 9000))]))[0];
  try { pool.close(rs); } catch (e) {}
  if (!parent) { console.error("✗ Родительское событие не найдено на релеях."); process.exit(1); }
  const htags = [...new Set((text.match(/(?:^|\s)#([\p{L}0-9_]+)/gu) || []).map((h) => h.trim().replace(/^#/, "").toLowerCase()))].map((h) => ["t", h]);
  const tags = [["e", pid, prelays[0] || rs[0], "root"], ["p", parent.pubkey], ...htags];
  const ev = finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags, content: text }, sk);
  console.log(`Отвечаю на ${pid.slice(0, 12)}… (автор ${parent.pubkey.slice(0, 8)}…), ${text.length} симв.`);
  const ok = await publish(ev);
  console.log(ok > 0 ? `✓ Ответ опубликован на ${ok} релеях.` : "✗ Не принято ни одним релеем.");
  process.exit(ok > 0 ? 0 : 1);
}

if (cmd === "article") {
  const sk = getSecretKey();
  if (!sk) { console.error("✗ Нет NOSTR_NSEC. Сначала: node tools/post-nostr.mjs keygen"); process.exit(1); }
  const a = process.argv.slice(3);
  const flag = (n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : null; };
  const file = flag("--file");
  if (!file) { console.error("✗ Нужен --file <path.md>"); process.exit(1); }
  const content = readFileSync(file, "utf8").trim();
  if (!content) { console.error("✗ Пустой файл."); process.exit(1); }
  const title = flag("--title") || "Untitled";
  const slug = flag("--slug") || ("post-" + Math.floor(Date.now() / 1000));
  const summary = flag("--summary") || "";
  const image = flag("--image") || "";
  const topic = flag("--t") || "";
  const now = Math.floor(Date.now() / 1000);
  const tags = [["d", slug], ["title", title], ["published_at", String(now)]];
  if (summary) tags.push(["summary", summary]);
  if (image) tags.push(["image", image]);
  if (topic) tags.push(["t", topic.toLowerCase()]);
  const ev = finalizeEvent({ kind: 30023, created_at: now, tags, content }, sk);
  console.log(`Публикую статью kind:30023 «${title}» (${content.length} симв., slug ${slug})`);
  const ok = await publish(ev);
  if (ok > 0) {
    console.log(`✓ Статья опубликована на ${ok} релеях.`);
    try {
      const pk = getPublicKey(sk);
      console.log("  Читать:", "https://njump.me/" + nip19.naddrEncode({ identifier: slug, pubkey: pk, kind: 30023, relays: relays().slice(0, 2) }));
    } catch (e) {}
  } else console.log("✗ Не принято ни одним релеем.");
  process.exit(ok > 0 ? 0 : 1);
}

if (cmd === "clawstr") {
  const sk = getSecretKey();
  if (!sk) { console.error("✗ Нет NOSTR_NSEC. Сначала: node tools/post-nostr.mjs keygen"); process.exit(1); }
  const a = process.argv.slice(3);
  const sub = a[0];
  if (!sub || sub.startsWith("--")) { console.error('✗ Укажи субклоу: clawstr <subclaw> --file <path>'); process.exit(1); }
  let text = a[1] === "--file" ? (a[2] ? readFileSync(a[2], "utf8") : "") : a.slice(1).join(" ");
  text = (text || "").trim();
  if (!text) { console.error("✗ Пустой текст."); process.exit(1); }
  const url = "https://clawstr.com/c/" + sub;
  // NIP-22 (kind:1111) с тегами Clawstr: scope-субклоу (I/i), K/k=web, NIP-32 AI-метка (L/l).
  const tags = [["I", url], ["K", "web"], ["i", url], ["k", "web"], ["L", "agent"], ["l", "ai", "agent"]];
  const ev = finalizeEvent({ kind: 1111, created_at: Math.floor(Date.now() / 1000), tags, content: text }, sk);
  const rs = ["wss://relay.ditto.pub", "wss://relay.primal.net", "wss://relay.damus.io", "wss://nos.lol"];
  console.log(`Публикую в Clawstr /c/${sub} (kind:1111, ${text.length} симв.)`);
  const pool = new SimplePool();
  const results = await Promise.allSettled(pool.publish(rs, ev));
  let ok = 0;
  results.forEach((r, i) => { if (r.status === "fulfilled") { ok++; console.log("  ✓ " + rs[i]); } else console.log("  ✗ " + rs[i] + ": " + ((r.reason && r.reason.message) || r.reason)); });
  try { pool.close(rs); } catch (e) {}
  if (ok > 0) { try { const pk = getPublicKey(sk); console.log("  Clawstr:", url); console.log("  njump:", "https://njump.me/" + nip19.neventEncode({ id: ev.id, relays: rs.slice(0, 2), author: pk })); } catch (e) {} }
  console.log(ok > 0 ? `✓ Опубликовано на ${ok} релеях.` : "✗ Не принято ни одним релеем.");
  process.exit(ok > 0 ? 0 : 1);
}

if (cmd === "clawstr-reply") {
  const sk = getSecretKey();
  if (!sk) { console.error("✗ Нет NOSTR_NSEC."); process.exit(1); }
  const a = process.argv.slice(3);
  const target = a[0];
  if (!target || target.startsWith("--")) { console.error('✗ Укажи родителя: clawstr-reply <id|nevent> --file <p>'); process.exit(1); }
  let text = a[1] === "--file" ? (a[2] ? readFileSync(a[2], "utf8") : "") : a.slice(1).join(" ");
  text = (text || "").trim();
  if (!text) { console.error("✗ Пустой текст."); process.exit(1); }
  let pid = null;
  try { if (/^[0-9a-f]{64}$/i.test(target)) pid = target.toLowerCase(); else { const d = nip19.decode(target); pid = d.type === "nevent" ? d.data.id : (d.type === "note" ? d.data : null); } } catch (e) {}
  if (!pid) { console.error("✗ Не распознал id родителя."); process.exit(1); }
  const rs = ["wss://relay.ditto.pub", "wss://relay.primal.net", "wss://relay.damus.io", "wss://nos.lol"];
  const pool = new SimplePool();
  const parent = (await Promise.race([pool.querySync(rs, { ids: [pid] }), new Promise((r) => setTimeout(() => r([]), 9000))]))[0];
  if (!parent) { try { pool.close(rs); } catch (e) {} console.error("✗ Родитель не найден на релеях."); process.exit(1); }
  // root scope = родительский (I/K), parent = сам родитель (e/k/p) — NIP-22
  const rootI = parent.tags.find((t) => t[0] === "I");
  const rootK = parent.tags.find((t) => t[0] === "K");
  const tags = [];
  if (rootI) tags.push(["I", rootI[1]]); if (rootK) tags.push(["K", rootK[1]]);
  tags.push(["e", pid, "wss://relay.ditto.pub", parent.pubkey], ["k", String(parent.kind)], ["p", parent.pubkey], ["L", "agent"], ["l", "ai", "agent"]);
  const ev = finalizeEvent({ kind: 1111, created_at: Math.floor(Date.now() / 1000), tags, content: text }, sk);
  console.log(`Отвечаю в Clawstr на ${pid.slice(0, 12)}… (автор ${parent.pubkey.slice(0, 8)}…), ${text.length} симв.`);
  const results = await Promise.allSettled(pool.publish(rs, ev));
  let ok = 0; results.forEach((r, i) => { if (r.status === "fulfilled") { ok++; console.log("  ✓ " + rs[i]); } else console.log("  ✗ " + rs[i]); });
  try { pool.close(rs); } catch (e) {}
  console.log(ok > 0 ? `✓ Ответ опубликован на ${ok} релеях.` : "✗ Не принято.");
  process.exit(ok > 0 ? 0 : 1);
}

if (cmd === "follow") {
  const sk = getSecretKey();
  if (!sk) { console.error("✗ Нет NOSTR_NSEC."); process.exit(1); }
  const pks = process.argv.slice(3).filter((a) => /^[0-9a-f]{64}$/i.test(a)).map((a) => a.toLowerCase());
  if (!pks.length) { console.error("✗ Укажи hex-pubkey(и): follow <hex> [hex...]"); process.exit(1); }
  const tags = pks.map((p) => ["p", p]);
  const ev = finalizeEvent({ kind: 3, created_at: Math.floor(Date.now() / 1000), tags, content: "" }, sk);
  const rs = ["wss://relay.ditto.pub", "wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net", "wss://relay.nostr.band"];
  console.log(`Публикую контакт-лист kind:3 (${pks.length} подписок)`);
  const pool = new SimplePool();
  const results = await Promise.allSettled(pool.publish(rs, ev));
  let ok = 0; results.forEach((r, i) => { if (r.status === "fulfilled") { ok++; console.log("  ✓ " + rs[i]); } else console.log("  ✗ " + rs[i]); });
  try { pool.close(rs); } catch (e) {}
  console.log(ok > 0 ? `✓ Опубликовано на ${ok} релеях.` : "✗ Не принято.");
  process.exit(ok > 0 ? 0 : 1);
}

console.log('Подкоманды: keygen | verify | profile | post | reply <id> txt | article --file <md> .. | clawstr <sub> --file <p> | clawstr-reply <id> --file <p> | follow <hex...>');
process.exit(cmd ? 1 : 0);
