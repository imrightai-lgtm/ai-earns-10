#!/usr/bin/env node
// IndexNow submitter — tells Bing / Yandex / Seznam / Naver that these URLs exist or changed.
//
// Why this exists (tick 52, 2026-07-27): the site had been live for 33 days with content that
// exists nowhere else, and it was indexed by exactly zero search engines — measured, not assumed
// (`site:ai-experiment.pages.dev` on DuckDuckGo/Bing => "No results found"). Nothing links to it,
// so no crawler ever had a reason to come. IndexNow is the only push channel a keyless autonomous
// agent has: no account, no API key issued by anyone, no human in the loop — you host a text file
// with a self-chosen key and POST a URL list.
//
// Usage:
//   node tools/indexnow.mjs             # verify key file is live, then submit every sitemap URL
//   node tools/indexnow.mjs --dry-run   # print what would be submitted, send nothing
//   node tools/indexnow.mjs <url> ...   # submit specific URLs instead of the whole sitemap
//
// Docs: https://www.indexnow.org/documentation
// Response codes: 200 OK, 202 Accepted (key validation pending), 400 bad request,
// 403 key not valid, 422 url does not belong to host, 429 too many requests.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEY = '560da5ee170cbf34c3b1c82518d1489c';
const HOST = 'ai-experiment.pages.dev';
const ORIGIN = `https://${HOST}`;
const KEY_LOCATION = `${ORIGIN}/${KEY}.txt`;
const ENDPOINT = 'https://api.indexnow.org/indexnow';

// Data endpoints that are worth indexing but are not HTML pages, so they are not in sitemap.xml.
const EXTRA_URLS = [
  `${ORIGIN}/ledger.json`,
  `${ORIGIN}/notes/awesome-lists-measured.json`,
  `${ORIGIN}/llms.txt`,
];

function sitemapUrls() {
  const xml = readFileSync(join(ROOT, 'site', 'sitemap.xml'), 'utf8');
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
}

async function assertKeyIsLive() {
  const res = await fetch(KEY_LOCATION, { headers: { 'cache-control': 'no-cache' } });
  if (!res.ok) throw new Error(`key file ${KEY_LOCATION} -> HTTP ${res.status} (deploy it first)`);
  const body = (await res.text()).trim();
  if (body !== KEY) throw new Error(`key file content mismatch: got "${body.slice(0, 40)}"`);
  console.log(`✓ key file live: ${KEY_LOCATION}`);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const explicit = args.filter((a) => a.startsWith('http'));

  const urls = [...new Set(explicit.length ? explicit : [...sitemapUrls(), ...EXTRA_URLS])];
  const foreign = urls.filter((u) => !u.startsWith(`${ORIGIN}/`) && u !== ORIGIN + '/');
  if (foreign.length) throw new Error(`URLs outside ${HOST} would be rejected (422): ${foreign.join(', ')}`);

  console.log(`IndexNow → ${urls.length} URL(s) on ${HOST}`);
  for (const u of urls) console.log(`  · ${u}`);
  if (dryRun) { console.log('\n(dry run — nothing sent)'); return; }

  await assertKeyIsLive();

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ host: HOST, key: KEY, keyLocation: KEY_LOCATION, urlList: urls }),
  });
  const text = await res.text();
  console.log(`\nHTTP ${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 300)}` : ''}`);
  if (res.status !== 200 && res.status !== 202) {
    console.error('✗ submission NOT accepted');
    process.exit(1);
  }
  console.log('✓ accepted (200 = indexed queue, 202 = accepted, key validation pending)');
}

main().catch((e) => { console.error('✗', e.message); process.exit(1); });
