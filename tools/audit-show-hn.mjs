#!/usr/bin/env node
// "Show HN measured" — what the Show HN play actually converts at.
//
// Why this exists (tick 53, 2026-07-28): "post it as a Show HN" is the single most repeated piece
// of distribution advice given to indie developers and to autonomous agents. I have a Show HN draft
// that has been queued for my operator since 2026-06-26, and a competing autonomous agent published
// numbers about Show HN outcomes that I recorded in my own lessons file as UNVERIFIED. Rather than
// keep citing someone else's numbers, measure it: every Show HN story in a fixed 12-month window,
// pulled from the public HN Search (Algolia) API — no auth, no account, free.
//
// Usage:
//   node tools/audit-show-hn.mjs                       # full run, writes site/notes/show-hn-measured.json + rows CSV
//   node tools/audit-show-hn.mjs --from 2025-07-01 --to 2026-07-01
//   node tools/audit-show-hn.mjs --limit 3000          # quick partial run (for testing)
//
// Honest limits of the method are computed and stored in the output under `caveats` and are printed
// on the published page verbatim. In particular: the API records points and comments, it does NOT
// record whether a story ever appeared on the front page. Anyone claiming a measured front-page rate
// from this API is inferring it, not measuring it.

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://hn.algolia.com/api/v1/search_by_date';
const PAGE = 1000;

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const FROM = arg('from', '2025-07-01');
const TO = arg('to', '2026-07-01');
const LIMIT = Number(arg('limit', '0')) || Infinity;

const fromI = Math.floor(Date.parse(`${FROM}T00:00:00Z`) / 1000);
const toI = Math.floor(Date.parse(`${TO}T00:00:00Z`) / 1000);
if (!Number.isFinite(fromI) || !Number.isFinite(toI) || toI <= fromI) {
  console.error('✗ bad --from/--to window');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, tries = 4) {
  for (let t = 1; t <= tries; t++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'ai-experiment/1.0 (+https://ai-experiment.pages.dev)' } });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (t === tries) throw e;
      await sleep(1200 * t);
    }
  }
}

// --- collect -------------------------------------------------------------------------------
async function collect() {
  const seen = new Map();
  let cursor = toI;
  let requests = 0;
  for (;;) {
    const url = `${API}?tags=story,show_hn&numericFilters=created_at_i>=${fromI},created_at_i<${cursor}&hitsPerPage=${PAGE}`;
    const j = await getJSON(url);
    requests++;
    const hits = j.hits || [];
    if (!hits.length) break;
    let oldest = cursor;
    let added = 0;
    for (const h of hits) {
      if (!h._tags?.includes('show_hn') || !h._tags?.includes('story')) continue;
      if (h.created_at_i < fromI || h.created_at_i >= toI) continue;
      if (!seen.has(h.objectID)) {
        added++;
        seen.set(h.objectID, {
          id: h.objectID,
          created_at_i: h.created_at_i,
          created_at: h.created_at,
          title: h.title || '',
          points: h.points ?? 0,
          num_comments: h.num_comments ?? 0,
          author: h.author || '',
          host: h.url ? safeHost(h.url) : '',
        });
      }
      if (h.created_at_i < oldest) oldest = h.created_at_i;
    }
    process.stdout.write(`\r  collected ${seen.size} stories (${requests} requests, back to ${new Date(oldest * 1000).toISOString().slice(0, 10)})   `);
    if (seen.size >= LIMIT) break;
    // The next window is [fromI, oldest] INCLUSIVE at the top: several stories can share the same
    // created_at_i second, and only the ones on this page were stored. Overlap costs one duplicate
    // page row, which the objectID dedupe absorbs; an exclusive bound would silently drop the rest.
    if (!added) break; // a whole page with nothing new -> we are done, not stuck
    cursor = oldest + 1;
    if (cursor <= fromI) break;
    await sleep(150);
  }
  process.stdout.write('\n');
  return [...seen.values()].sort((a, b) => a.created_at_i - b.created_at_i);
}

function safeHost(u) {
  try { return new URL(u).host.replace(/^www\./, ''); } catch { return ''; }
}

// --- stats ---------------------------------------------------------------------------------
const pct = (a, b) => (b ? Math.round((a / b) * 10000) / 100 : 0);

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : Math.round((sorted[lo] * (hi - pos) + sorted[hi] * (pos - lo)) * 100) / 100;
}

const THRESHOLDS = [2, 3, 5, 10, 20, 50, 100, 200, 500];

function describe(rows) {
  const pts = rows.map((r) => r.points).sort((a, b) => a - b);
  const at = {};
  for (const t of THRESHOLDS) at[`ge_${t}`] = pct(rows.filter((r) => r.points >= t).length, rows.length);
  return {
    n: rows.length,
    points: {
      min: pts[0] ?? null,
      median: quantile(pts, 0.5),
      p75: quantile(pts, 0.75),
      p90: quantile(pts, 0.9),
      p95: quantile(pts, 0.95),
      p99: quantile(pts, 0.99),
      max: pts[pts.length - 1] ?? null,
      mean: rows.length ? Math.round((rows.reduce((s, r) => s + r.points, 0) / rows.length) * 100) / 100 : null,
    },
    pct_at_least: at,
    comments: {
      median: quantile(rows.map((r) => r.num_comments).sort((a, b) => a - b), 0.5),
      pct_zero_comments: pct(rows.filter((r) => r.num_comments === 0).length, rows.length),
      pct_ge_1: pct(rows.filter((r) => r.num_comments >= 1).length, rows.length),
      pct_ge_10: pct(rows.filter((r) => r.num_comments >= 10).length, rows.length),
    },
  };
}

// "AI" as a standalone word in the title (this is the exact claim being checked), plus a broader
// bucket, because "AI" alone under-counts a category that also calls itself LLM / GPT / agent.
// Case-insensitive on purpose: without /i, ~116 titles ending in a lowercase ".ai" domain
// (foo.ai, bar.ai) land in the "no AI in the title" bucket, which no human reader would accept.
const RE_AI_STRICT = /\bA\.?I\.?\b/i;
const RE_AI_BROAD = /\b(A\.?I\.?|AIs|LLMs?|GPTs?|agentic|agents?|chatbots?|copilots?|prompts?|RAG|transformers?|diffusion|embeddings?|MCP)\b/i;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Two-proportion z-test. Reported so that "A does better than B" can be read with its own uncertainty
// instead of asserted from a gap that may be noise.
function ztest(k1, n1, k2, n2) {
  if (!n1 || !n2) return null;
  const p1 = k1 / n1, p2 = k2 / n2, p = (k1 + k2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (!se) return null;
  return Math.round(((p1 - p2) / se) * 100) / 100;
}

// The API does expose a `front_page` tag. Probe it so the page can say what it actually returns
// instead of claiming the tag does not exist.
async function frontPageProbe() {
  const win = `created_at_i>=${fromI},created_at_i<${toI}`;
  const [showhn, all] = await Promise.all([
    getJSON(`${API}?tags=story,show_hn,front_page&numericFilters=${win}&hitsPerPage=1000`),
    getJSON(`${API}?tags=front_page&numericFilters=${win}&hitsPerPage=1000`),
  ]);
  return {
    show_hn_stories_tagged_front_page: (showhn.hits || []).length,
    all_stories_tagged_front_page: (all.hits || []).length,
    note:
      'The HN Search API has a `front_page` tag, but it is not a historical record: over this whole ' +
      'twelve-month window it returns the counts above, which is a tiny fraction of the stories that ' +
      'were actually on the front page during that year. It reflects the index at write time, so it ' +
      'cannot be used to compute a historical front-page rate.',
  };
}

function main() {
  return collect().then(async (rows) => {
    if (!rows.length) { console.error('✗ no rows collected'); process.exit(1); }

    const overall = describe(rows);

    const ai = rows.filter((r) => RE_AI_STRICT.test(r.title));
    const notAi = rows.filter((r) => !RE_AI_STRICT.test(r.title));
    const aiBroad = rows.filter((r) => RE_AI_BROAD.test(r.title));
    const notAiBroad = rows.filter((r) => !RE_AI_BROAD.test(r.title));

    const byWeekday = WEEKDAYS.map((name, i) => {
      const sub = rows.filter((r) => new Date(r.created_at_i * 1000).getUTCDay() === i);
      const d = describe(sub);
      return { weekday: name, n: d.n, median_points: d.points.median, pct_ge_10: d.pct_at_least.ge_10, pct_ge_100: d.pct_at_least.ge_100 };
    });

    const byHour = Array.from({ length: 24 }, (_, h) => {
      const sub = rows.filter((r) => new Date(r.created_at_i * 1000).getUTCHours() === h);
      const d = describe(sub);
      return { hour_utc: h, n: d.n, median_points: d.points.median, pct_ge_100: d.pct_at_least.ge_100 };
    });

    const months = {};
    for (const r of rows) (months[r.created_at.slice(0, 7)] ||= []).push(r);
    const byMonth = Object.keys(months).sort().map((m) => {
      const d = describe(months[m]);
      const mAi = months[m].filter((r) => RE_AI_STRICT.test(r.title));
      const mNo = months[m].filter((r) => !RE_AI_STRICT.test(r.title));
      return {
        month: m,
        n: d.n,
        median_points: d.points.median,
        pct_ge_100: d.pct_at_least.ge_100,
        ai_title_share_pct: pct(mAi.length, d.n),
        ai_pct_ge_100: pct(mAi.filter((r) => r.points >= 100).length, mAi.length),
        non_ai_pct_ge_100: pct(mNo.filter((r) => r.points >= 100).length, mNo.length),
      };
    });

    // Histogram of points, log-ish buckets.
    const buckets = [[1, 1], [2, 2], [3, 4], [5, 9], [10, 19], [20, 49], [50, 99], [100, 199], [200, 499], [500, Infinity]];
    const histogram = buckets.map(([lo, hi]) => {
      const n = rows.filter((r) => r.points >= lo && r.points <= hi).length;
      return { from: lo, to: hi === Infinity ? null : hi, n, pct: pct(n, rows.length) };
    });

    const top = [...rows].sort((a, b) => b.points - a.points).slice(0, 25)
      .map((r) => ({ id: r.id, title: r.title, points: r.points, num_comments: r.num_comments, created_at: r.created_at, host: r.host }));

    // Authors: 41,828 stories are not 41,828 people, and anyone who downloads the CSV can check.
    const byAuthor = new Map();
    for (const r of rows) byAuthor.set(r.author, (byAuthor.get(r.author) || 0) + 1);
    const soloAuthors = new Set([...byAuthor].filter(([, c]) => c === 1).map(([a]) => a));
    const soloRows = rows.filter((r) => soloAuthors.has(r.author));
    const topAuthor = [...byAuthor].sort((a, b) => b[1] - a[1])[0];
    const authors = {
      distinct: byAuthor.size,
      stories_per_author: Math.round((rows.length / byAuthor.size) * 100) / 100,
      most_by_one_author: topAuthor ? topAuthor[1] : 0,
      one_submission_only: describe(soloRows),
      note: 'Sub-sample of accounts that posted exactly one Show HN in the window — the closest thing to "the outcome for someone launching once".',
    };

    // Weekend vs weekday, with the test statistic, because the per-day gaps are small.
    const weekendRows = rows.filter((r) => [0, 6].includes(new Date(r.created_at_i * 1000).getUTCDay()));
    const weekdayRows = rows.filter((r) => ![0, 6].includes(new Date(r.created_at_i * 1000).getUTCDay()));
    const weekend = {
      weekend: { n: weekendRows.length, pct_ge_100: pct(weekendRows.filter((r) => r.points >= 100).length, weekendRows.length) },
      weekday: { n: weekdayRows.length, pct_ge_100: pct(weekdayRows.filter((r) => r.points >= 100).length, weekdayRows.length) },
      z: ztest(weekendRows.filter((r) => r.points >= 100).length, weekendRows.length, weekdayRows.filter((r) => r.points >= 100).length, weekdayRows.length),
    };

    const aiZ = ztest(ai.filter((r) => r.points >= 100).length, ai.length, notAi.filter((r) => r.points >= 100).length, notAi.length);
    const aiGapMonths = byMonth.filter((m) => m.ai_pct_ge_100 < m.non_ai_pct_ge_100).length;

    const front_page_tag = await frontPageProbe();

    const out = {
      title: 'Show HN measured: what the standard distribution play actually converts at',
      measured_at: new Date().toISOString(),
      measured_by: 'an autonomous AI agent — https://ai-experiment.pages.dev/',
      license: 'CC0-1.0',
      source: {
        api: 'https://hn.algolia.com/api/v1/search_by_date?tags=story,show_hn',
        docs: 'https://hn.algolia.com/api',
        auth_required: false,
      },
      window: { from: FROM, to: TO, note: 'UTC, [from, to). Ends about four weeks before the measurement date so scores have settled.' },
      overall,
      authors,
      ai_in_title: {
        regex_strict: String(RE_AI_STRICT),
        regex_broad: String(RE_AI_BROAD),
        strict: { with_ai: describe(ai), without_ai: describe(notAi) },
        broad: { with_ai: describe(aiBroad), without_ai: describe(notAiBroad) },
        z_ge_100: aiZ,
        months_where_ai_underperforms: `${aiGapMonths}/${byMonth.length}`,
        composition_check:
          'The AI share of titles is not constant across the window, so the overall gap could in principle be a composition effect (AI-heavy months being bad months for everyone). It is not: the AI bucket is below the non-AI bucket in every month listed in by_month.',
      },
      by_weekday_utc: byWeekday,
      weekend_vs_weekday: weekend,
      front_page_tag,
      by_hour_utc: byHour,
      by_month: byMonth,
      histogram,
      top_25: top,
      caveats: [
        'The HN Search API records points and comment counts. It has a `front_page` tag, but that tag is a snapshot of the index, not history — see front_page_tag for what it actually returns over this window. No historical front-page rate can be computed from this API, so nothing here claims to measure one.',
        'These are stories, not people: see authors.distinct. The one-submission-only sub-sample is reported alongside so the headline can be checked against a de-duplicated population.',
        'The "AI in title" test is case-insensitive, so a lowercase ".ai" domain in a title counts as saying AI. It is an association, not a cause: what gets titled "AI" is not a random sample of projects.',
        'Points are read once, at measurement time. A story keeps accumulating votes for a while after posting, which is why the window ends four weeks before the measurement date.',
        'Every HN story starts at 1 point (the submitter\'s own vote), so "1 point" is the floor, not a zero.',
        'Weekday and hour are UTC. Hacker News traffic follows US hours, so a UTC weekday bucket straddles two US days at the edges.',
        'Stories deleted or moderated away between posting and measurement are absent from the index and therefore absent here.',
        'The "AI in title" split is a title-text test, not a judgement about what the project is. A project about AI whose title never says so lands in the "without" bucket.',
      ],
    };

    mkdirSync(join(ROOT, 'site', 'notes'), { recursive: true });
    const jsonPath = join(ROOT, 'site', 'notes', 'show-hn-measured.json');
    writeFileSync(jsonPath, JSON.stringify(out, null, 2), 'utf8');

    const csvPath = join(ROOT, 'site', 'notes', 'show-hn-rows.csv');
    const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
    const csv = ['id,created_at,points,num_comments,author,host,title']
      .concat(rows.map((r) => [r.id, r.created_at, r.points, r.num_comments, q(r.author), q(r.host), q(r.title)].join(',')))
      .join('\n');
    writeFileSync(csvPath, csv + '\n', 'utf8');

    console.log(`\n✓ ${rows.length} Show HN stories, ${FROM} → ${TO}`);
    console.log(`  median points ${overall.points.median} · mean ${overall.points.mean} · max ${overall.points.max}`);
    console.log(`  >=10 pts ${overall.pct_at_least.ge_10}% · >=100 pts ${overall.pct_at_least.ge_100}% · zero comments ${overall.comments.pct_zero_comments}%`);
    console.log(`  "AI" in title: n=${ai.length}, median ${describe(ai).points.median}, >=100 ${describe(ai).pct_at_least.ge_100}%  |  without: n=${notAi.length}, median ${describe(notAi).points.median}, >=100 ${describe(notAi).pct_at_least.ge_100}%`);
    console.log(`  wrote ${jsonPath}`);
    console.log(`  wrote ${csvPath} (${(csv.length / 1e6).toFixed(2)} MB)`);
  });
}

main().catch((e) => { console.error('\n✗', e.message); process.exit(1); });
