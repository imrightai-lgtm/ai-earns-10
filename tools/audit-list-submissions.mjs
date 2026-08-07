#!/usr/bin/env node
// Аудит «submit to awesome-lists» кампании — ТОЛЬКО ЧТЕНИЕ, без зависимостей (Node 18+).
//
// Отвечает на два РАЗНЫХ вопроса по каждой заявке:
//   1) состояние PR/issue по GitHub API (merged / closed-unmerged / open);
//   2) присутствует ли проект в списке ПРЯМО СЕЙЧАС (fetch README списка + поиск иглы).
// Второй вопрос главный: мейнтейнер может забрать коммит и закрыть PR — по состоянию PR это
// неотличимо от отказа. Поэтому вывод содержит оба поля, и они считаются независимо.
//
// Запуск:
//   node tools/audit-list-submissions.mjs data/awesome-list-audit.spec.json > out.json
//   GITHUB_TOKEN в .env повышает лимит API (60/час без токена → 5000/час с ним), но не обязателен.
//
// Формат spec: { "needles": ["строка", ...], "items": [ {"repo":"owner/name","number":123,"kind":"pull|issue","stars_claimed":86667}, ... ] }

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

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

const specPath = process.argv[2];
if (!specPath) {
  console.error("usage: node tools/audit-list-submissions.mjs <spec.json>");
  process.exit(2);
}
const spec = JSON.parse(readFileSync(resolve(specPath), "utf8"));
const needles = (spec.needles || []).map((s) => s.toLowerCase());
if (!needles.length) { console.error("spec.needles is required"); process.exit(2); }

const H = { "user-agent": "ai-experiment-list-audit", accept: "application/vnd.github+json" };
if (process.env.GITHUB_TOKEN) H.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- 1. состояние PR/issue ---------------------------------------------------
async function submissionState(item) {
  const seg = item.kind === "issue" ? "issues" : "pulls";
  const res = await fetch(`https://api.github.com/repos/${item.repo}/${seg}/${item.number}`, { headers: H });
  if (!res.ok) return { pr_state: "unreadable", http: res.status, merged: null };
  const j = await res.json();
  const merged = j.merged === true || !!j.merged_at;
  return {
    http: res.status,
    merged,
    pr_state: merged ? "merged" : j.state === "closed" ? "closed_unmerged" : "open",
    created_at: j.created_at || null,
    updated_at: j.updated_at || null,
    merged_at: j.merged_at || null,
    comments: (j.comments ?? 0) + (j.review_comments ?? 0),
  };
}

// --- 2. присутствие в списке сегодня ----------------------------------------
// Честное ограничение: читаем только README верхнего уровня. Список, который хранит записи
// в отдельном файле, даст ложное "not_listed" — это записано в поле listed_check_scope.
async function listedNow(repo) {
  for (const branch of ["main", "master"]) {
    for (const file of ["README.md", "readme.md"]) {
      const res = await fetch(`https://raw.githubusercontent.com/${repo}/${branch}/${file}`);
      if (!res.ok) continue;
      const txt = (await res.text()).toLowerCase();
      return { listed: needles.some((n) => txt.includes(n)) ? "listed" : "not_listed", readme: `${branch}/${file}` };
    }
  }
  return { listed: "readme_unreadable", readme: null };
}

// --- 3. сколько звёзд у списка СЕЙЧАС ---------------------------------------
// Тик 64: до этого «сколько звёзд реально конвертировалось» считалось по числам из чужой
// таблицы (stars_claimed). То есть измерение размещения опиралось на неизмеренную величину.
async function starsNow(repo) {
  const res = await fetch(`https://api.github.com/repos/${repo}`, { headers: H });
  if (!res.ok) return null;
  const j = await res.json();
  return typeof j.stargazers_count === "number" ? j.stargazers_count : null;
}

const rows = [];
for (const item of spec.items || []) {
  const [state, listed, stars_now] = [
    await submissionState(item),
    await listedNow(item.repo),
    await starsNow(item.repo),
  ];
  rows.push({ ...item, ...state, ...listed, stars_now });
  await sleep(120);
}

const tally = (key, val) => rows.filter((r) => r[key] === val).length;
const starsOf = (pred) => rows.filter(pred).reduce((s, r) => s + (r.stars_claimed || 0), 0);

const out = {
  measured_at: new Date().toISOString(),
  measured_by: "ai-experiment (autonomous AI agent) — https://ai-experiment.pages.dev/",
  subject: spec.subject || null,
  needles: spec.needles,
  listed_check_scope: "top-level README.md of each list repo only; entries kept in a separate file would read as not_listed",
  caveat_closed_unmerged:
    "GitHub's API cannot distinguish 'rejected' from 'maintainer cherry-picked the commit and closed the PR'. Use the listed-now column to settle it.",
  totals: {
    submissions: rows.length,
    merged: tally("pr_state", "merged"),
    closed_unmerged: tally("pr_state", "closed_unmerged"),
    open: tally("pr_state", "open"),
    unreadable: tally("pr_state", "unreadable"),
    listed_now: tally("listed", "listed"),
    not_listed_now: tally("listed", "not_listed"),
    listed_check_failed: tally("listed", "readme_unreadable"),
    stars_claimed_total: starsOf(() => true),
    stars_actually_listed: starsOf((r) => r.listed === "listed"),
    stars_now_listed: rows
      .filter((r) => r.listed === "listed")
      .reduce((s, r) => s + (r.stars_now || 0), 0),
    stars_now_unreadable: rows.filter((r) => r.stars_now === null).length,
    // Полная сумма заявленных звёзд ПО ТАБЛИЦЕ кампании: проверяемые строки + строки без ссылки.
    stars_claimed_table_total:
      starsOf(() => true) + (spec.unlinked_items || []).reduce((s, u) => s + (u.stars_claimed || 0), 0),
  },
  unlinked_items: spec.unlinked_items || [],
  rows,
};
out.totals.star_conversion_pct = out.totals.stars_claimed_total
  ? +((out.totals.stars_actually_listed / out.totals.stars_claimed_total) * 100).toFixed(3)
  : null;

process.stdout.write(JSON.stringify(out, null, 2) + "\n");
