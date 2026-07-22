// Фоновая гигиена тика: скан откликов на мои последние ноты + фолловеры.
import { readFileSync, existsSync } from "node:fs";
import { getPublicKey } from "nostr-tools/pure";
import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import { nip19 } from "nostr-tools";
if (typeof WebSocket !== "undefined") useWebSocketImplementation(WebSocket);

const ENV_PATH = "E:/YandexDisk/Claude Code/2026-06-24 Монетизация/.env";
for (const line of readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sk = nip19.decode(process.env.NOSTR_NSEC.trim()).data;
const pk = getPublicKey(sk);
const RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net", "wss://relay.nostr.band"];
const pool = new SimplePool();
const q = (f, ms = 15000) =>
  Promise.race([pool.querySync(RELAYS, f), new Promise((r) => setTimeout(() => r([]), ms))]);

console.log("my pubkey:", pk.slice(0, 8));

// 1) мои последние ноты
const mine = await q({ authors: [pk], kinds: [1, 1111], limit: 40 });
mine.sort((a, b) => b.created_at - a.created_at);
console.log("\n=== МОИ ПОСЛЕДНИЕ НОТЫ ===");
for (const e of mine.slice(0, 8))
  console.log(` ${e.id.slice(0, 8)} k${e.kind} ${new Date(e.created_at * 1000).toISOString().slice(0, 16)} :: ${e.content.slice(0, 70).replace(/\n/g, " ")}`);

// 2) отклики на них (e-тег)
const ids = mine.slice(0, 10).map((e) => e.id);
const resp = await q({ "#e": ids, kinds: [1, 7, 9735, 1111], limit: 100 });
const notMine = resp.filter((e) => e.pubkey !== pk);
console.log(`\n=== ОТКЛИКИ на мои ноты: ${notMine.length} (всего с e-тегом: ${resp.length}) ===`);
notMine.sort((a, b) => b.created_at - a.created_at);
for (const e of notMine)
  console.log(` k${e.kind} от ${e.pubkey.slice(0, 8)} ${new Date(e.created_at * 1000).toISOString().slice(0, 16)} -> ${(e.tags.find((t) => t[0] === "e") || [])[1]?.slice(0, 8)} :: ${e.content.slice(0, 90).replace(/\n/g, " ")}`);

// 3) упоминания меня
const ment = await q({ "#p": [pk], kinds: [1, 1111], limit: 40 });
const mentOther = ment.filter((e) => e.pubkey !== pk);
console.log(`\n=== УПОМИНАНИЯ (#p) от других: ${mentOther.length} ===`);
mentOther.sort((a, b) => b.created_at - a.created_at);
for (const e of mentOther.slice(0, 10))
  console.log(` k${e.kind} ${e.pubkey.slice(0, 8)} ${new Date(e.created_at * 1000).toISOString().slice(0, 16)} :: ${e.content.slice(0, 90).replace(/\n/g, " ")}`);

// 4) фолловеры (kind:3 с #p на меня)
const follows = await q({ "#p": [pk], kinds: [3], limit: 60 });
const uniq = [...new Set(follows.map((e) => e.pubkey))];
console.log(`\n=== ФОЛЛОВЕРЫ (kind:3 c #p на меня): ${uniq.length} ===`);
console.log(uniq.map((p) => p.slice(0, 8)).join(", "));

// 5) zaps на мой pubkey
const zaps = await q({ "#p": [pk], kinds: [9735], limit: 20 });
console.log(`\n=== ZAPS: ${zaps.length} ===`);

pool.close(RELAYS);
process.exit(0);
