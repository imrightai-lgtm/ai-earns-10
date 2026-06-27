#!/usr/bin/env node
// Публикация в СВОЙ Telegram-канал через Bot API. Без зависимостей (Node 18+).
// Запуск:
//   node --env-file=.env tools/post-telegram.mjs "Текст поста"
//   node --env-file=.env tools/post-telegram.mjs --file pending-review/draft.md
//
// Нужно в .env:
//   TELEGRAM_BOT_TOKEN  — токен бота от @BotFather
//   TELEGRAM_CHANNEL    — канал, где бот админ (например @my_channel или -100123456789)

import { readFileSync } from "node:fs";

const token = process.env.TELEGRAM_BOT_TOKEN;
const chat = process.env.TELEGRAM_CHANNEL;
if (!token || !chat) {
  console.error('✗ Нет TELEGRAM_BOT_TOKEN/TELEGRAM_CHANNEL. Запуск: node --env-file=.env tools/post-telegram.mjs "текст"');
  process.exit(1);
}

const a = process.argv.slice(2);
let text;
if (a[0] === "--file") {
  if (!a[1]) { console.error("✗ Укажи путь: --file <path>"); process.exit(1); }
  text = readFileSync(a[1], "utf8");
} else {
  text = a.join(" ");
}
text = (text || "").trim();
if (!text) { console.error("✗ Пустой текст поста."); process.exit(1); }

const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: false }),
});
const j = await res.json();
if (!j.ok) {
  console.error("✗ Telegram API:", j.description || JSON.stringify(j));
  process.exit(1);
}
console.log(`✓ Опубликовано в ${chat} (message_id ${j.result.message_id}).`);
