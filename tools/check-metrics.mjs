#!/usr/bin/env node
// Опережающие метрики — ТОЛЬКО ЧТЕНИЕ. Без npm-зависимостей (Node 18+).
// Запуск:  node tools/check-metrics.mjs
//
// Тянет всё, что настроено в .env, каждый источник независимо (если не настроен — пропускает):
//   - Трафик сайта: Cloudflare Web Analytics (CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID + CF_ANALYTICS_SITE_TAG)
//   - GitHub: звёзды/форки репозитория (GITHUB_REPO="owner/name", опц. GITHUB_TOKEN)
//   - Telegram: число подписчиков канала (TELEGRAM_BOT_TOKEN + TELEGRAM_CHANNEL)
// Результат дописывается в memory/metrics-log.csv и печатается сводкой.

import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Подгрузить .env, если есть (KEY=VALUE), не перетирая уже заданные переменные.
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

const E = process.env;
const results = []; // {source, metric, value}
const notes = [];

async function cfWebAnalytics() {
  const cfToken = E.CF_ANALYTICS_API_TOKEN || E.CLOUDFLARE_API_TOKEN;
  if (!cfToken || !E.CLOUDFLARE_ACCOUNT_ID || !E.CF_ANALYTICS_SITE_TAG) {
    notes.push("site: пропущено (нет CF_ANALYTICS_API_TOKEN/ACCOUNT_ID/CF_ANALYTICS_SITE_TAG)");
    return;
  }
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const query = `query($a:String!,$tag:String!,$since:Time!){viewer{accounts(filter:{accountTag:$a}){rumPageloadEventsAdaptiveGroups(filter:{datetime_geq:$since,siteTag:$tag},limit:1){count sum{visits}}}}}`;
  const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfToken}` },
    body: JSON.stringify({ query, variables: { a: E.CLOUDFLARE_ACCOUNT_ID, tag: E.CF_ANALYTICS_SITE_TAG, since } }),
  });
  const j = await res.json();
  if (j.errors && j.errors.length) throw new Error(JSON.stringify(j.errors).slice(0, 200));
  const g = j?.data?.viewer?.accounts?.[0]?.rumPageloadEventsAdaptiveGroups?.[0];
  results.push({ source: "site", metric: "pageviews_24h", value: g?.count ?? 0 });
  results.push({ source: "site", metric: "visits_24h", value: g?.sum?.visits ?? 0 });
}

async function github() {
  if (!E.GITHUB_REPO) { notes.push("github: пропущено (нет GITHUB_REPO)"); return; }
  const headers = { "user-agent": "ai-experiment-metrics" };
  if (E.GITHUB_TOKEN) headers.authorization = `Bearer ${E.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com/repos/${E.GITHUB_REPO}`, { headers });
  if (!res.ok) throw new Error("GitHub HTTP " + res.status);
  const j = await res.json();
  results.push({ source: "github", metric: "stars", value: j.stargazers_count ?? 0 });
  results.push({ source: "github", metric: "forks", value: j.forks_count ?? 0 });
}

async function telegram() {
  if (!E.TELEGRAM_BOT_TOKEN || !E.TELEGRAM_CHANNEL) { notes.push("telegram: пропущено (нет TELEGRAM_BOT_TOKEN/CHANNEL)"); return; }
  const res = await fetch(`https://api.telegram.org/bot${E.TELEGRAM_BOT_TOKEN}/getChatMemberCount?chat_id=${encodeURIComponent(E.TELEGRAM_CHANNEL)}`);
  const j = await res.json();
  if (!j.ok) throw new Error("Telegram: " + (j.description || JSON.stringify(j)));
  results.push({ source: "telegram", metric: "subscribers", value: j.result });
}

const sources = [["site", cfWebAnalytics], ["github", github], ["telegram", telegram]];
for (const [name, fn] of sources) {
  try { await fn(); } catch (e) { notes.push(`${name}: ошибка — ${e.message}`); }
}

const ts = new Date().toISOString();
for (const r of results) {
  appendFileSync(join(root, "memory", "metrics-log.csv"), `${ts},${r.source},${r.metric},${r.value}\n`);
}

if (results.length) {
  console.log(`✓ Метрики (${ts}):`);
  for (const r of results) console.log(`  ${r.source}.${r.metric} = ${r.value}`);
} else {
  console.log("ℹ Ни один источник метрик не настроен.");
}
for (const n of notes) console.log("  · " + n);
console.log("  Записано в memory/metrics-log.csv");
