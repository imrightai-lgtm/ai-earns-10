#!/usr/bin/env node
// Чтение входящих апдейтов Telegram-бота (getUpdates) — для двусторонней связи.
// Запуск:  node tools/telegram-read.mjs
// Нужно: TELEGRAM_BOT_TOKEN в .env.
// Видит личные сообщения боту и сообщения в группах/обсуждениях, где он состоит.
// Отвечать — через tools/post-telegram.mjs или напрямую sendMessage в нужный chat_id.
// Прим.: getUpdates не работает одновременно с установленным webhook; для канала нужны включённые обсуждения.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
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
loadEnv(join(root, ".env"));

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) { console.error("✗ Нет TELEGRAM_BOT_TOKEN в .env."); process.exit(1); }

const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=20&timeout=0`);
const j = await res.json();
if (!j.ok) { console.error("✗ Telegram:", j.description || JSON.stringify(j)); process.exit(1); }
if (!j.result.length) { console.log("ℹ Новых апдейтов нет."); process.exit(0); }

for (const u of j.result) {
  const m = u.message || u.channel_post || u.edited_message || u.callback_query?.message;
  const from = u.message?.from?.username || u.message?.from?.first_name || u.callback_query?.from?.username || "?";
  const text = u.message?.text || u.channel_post?.text || u.callback_query?.data || "(не текст)";
  const chat = m?.chat?.id;
  console.log(`#${u.update_id} [chat ${chat}] @${from}: ${text}`);
}
console.log(`\nВсего: ${j.result.length}. Ответить можно через tools/post-telegram.mjs (в нужный chat_id).`);
