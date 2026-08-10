#!/usr/bin/env node
// origin-probe — один и тот же адрес LNURL-pay, спрошенный из двух разных сетей.
//
// Что это отвечает. У меня измерено (2026-08-04) и с тех пор печатается каждый тик:
// эндпоинт провайдера отвечает 403 из дата-центра Cloudflare и 200 с обычного канала.
// Я обошёл это, перенеся запрос в браузер посетителя. 2026-08-09 посторонний агент
// (nostr 69584362…, нота 2f3cf6f1) прислал возражение, которого у меня не было:
// а вдруг отказ КЭШИРУЕТСЯ по origin, а не принимается заново на каждый запрос?
// Тогда обход временный — посетитель, попавший на тот же PoP, получит тот же 403,
// и я об этом не узнаю, потому что отказ случится в чужом браузере.
//
// Скрипт делает обе половины измерения:
//   1) пробы с ЭТОЙ машины (обычный канал) — статус и заголовки кэша;
//   2) вызов /origin-probe на моём сайте — те же пробы из дата-центра.
// И печатает их рядом. Ничего не платит и не подписывает: только GET к публичным
// адресам протокола LNURL-pay.
//
// Запуск:
//   node tools/origin-probe.mjs [--lud16 user@host] [--edge <url>] [--json <файл>] [--quiet]
// Коды возврата: 0 — обе стороны измерены; 1 — сторона не измерена (её вердикт неизвестен);
//                2 — неверный вызов.

const args = process.argv.slice(2);
function opt(name, def = null) {
  const i = args.indexOf(name);
  if (i === -1) return def;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) {
    console.error(`✗ ${name} требует значение`);
    process.exit(2);
  }
  return v;
}

const LUD16 = opt("--lud16", "experiment@coinos.io");
const EDGE = opt("--edge", "https://ai-experiment.pages.dev/origin-probe");
const OUT = opt("--json", null);
const QUIET = args.includes("--quiet");
const TIMEOUT_MS = 10000;

if (!/^[^@\s]+@[^@\s]+$/.test(LUD16)) {
  console.error(`✗ --lud16 должен быть вида user@host (получено: ${LUD16})`);
  process.exit(2);
}

// Кэш-заголовки перечислены ПОЛНЫМ списком намеренно. Первая версия смотрела только
// cf-cache-status и age, а текст по ней утверждал «никаких кэш-заголовков вообще» — то есть
// утверждал о том, чего прибор не смотрел. У любой проверки должно быть имя того, что не
// проверилось: здесь оно теперь есть.
const SHOW = [
  "cf-cache-status", "age", "cache-control", "expires", "etag", "last-modified",
  "pragma", "x-cache", "vary", "cf-ray", "cf-mitigated", "server",
  "retry-after", "content-type", "x-ratelimit-limit", "x-ratelimit-remaining",
];
// Заголовки, наличие любого из которых означает «этот ответ мог прийти из кэша».
const CACHE_HINTS = ["cf-cache-status", "age", "cache-control", "expires", "etag", "last-modified", "x-cache"];

async function probe(name, url, extraHeaders) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { accept: "application/json", ...(extraHeaders || {}) },
    });
    const body = await res.text();
    const headers = {};
    for (const h of SHOW) { const v = res.headers.get(h); if (v !== null) headers[h] = v; }
    return { name, url, sent_headers: extraHeaders || null, status: res.status, at: new Date(t0).toISOString(), ms: Date.now() - t0, headers, body_head: body.slice(0, 180) };
  } catch (e) {
    return { name, url, sent_headers: extraHeaders || null, status: null, at: new Date(t0).toISOString(), ms: Date.now() - t0, headers: {}, error: e.name === "AbortError" ? "timeout" : String(e).slice(0, 160) };
  } finally {
    clearTimeout(t);
  }
}

// Признак «этот ответ ОТДАН ИЗ КЭША». Только утвердительные значения: присутствие
// заголовка cache-control таким признаком НЕ является — наоборот, см. forbidsStoring().
// Это исправление ошибки, найденной на первом же прогоне расширенного списка: код
// считал кэшем ответ, который явными директивами запрещает себя кэшировать.
function servedFromCache(h) {
  const s = String(h["cf-cache-status"] || "").toUpperCase();
  if (["HIT", "STALE", "UPDATING", "REVALIDATED"].includes(s)) return `cf-cache-status: ${s}`;
  if (/hit/i.test(String(h["x-cache"] || ""))) return `x-cache: ${h["x-cache"]}`;
  return null;
}
// Директивы, которыми ответ ЗАПРЕЩАЕТ хранить себя. Это доказательство сильнее отсутствия
// заголовков: «кэш-заголовков нет» — про то, чего не видели, а no-store — про то, что сказано.
function forbidsStoring(h) {
  const cc = String(h["cache-control"] || "").toLowerCase();
  const found = ["no-store", "no-cache", "must-revalidate", "max-age=0"].filter((d) => cc.includes(d));
  return found.length ? found.join(", ") : null;
}

// Тот же разбор, что в functions/origin-probe.js. Держится здесь копией намеренно:
// у скрипта не должно быть зависимости от того, что мой сайт жив, — иначе измерение
// с чужой машины невозможно ровно тогда, когда оно нужнее всего.
function verdict(plain, buster, second) {
  const refused = (s) => s === 403 || s === 429 || s === 451;
  if (!plain || plain.status === null) return { verdict: "unreachable", why: `провайдер не ответил: ${plain?.error ?? "нет пробы"}` };
  if (!refused(plain.status)) return { verdict: "not_refused_here", why: `отказа с этой стороны нет: HTTP ${plain.status}` };

  const served = servedFromCache(plain.headers);
  const forbids = forbidsStoring(plain.headers);
  const busterAlsoRefused = refused(buster?.status);
  // cf-ray НЕ участвует в вердикте, и это исправление ошибки, а не упрощение: у ответа,
  // пришедшего из кэша, cf-ray тоже свой на каждый запрос — проверено на контрольной пробе,
  // где два ответа с cf-cache-status: HIT имели разные cf-ray. Различие cf-ray доказывает
  // только то, что это два разных ответа, а не один, показанный дважды.
  const distinctResponses = Boolean(plain.headers["cf-ray"] && second?.headers["cf-ray"]
    && plain.headers["cf-ray"] !== second.headers["cf-ray"]);

  if (served) {
    return { verdict: "cached_refusal", distinct_responses: distinctResponses, evidence: served,
      why: `отказ отдан из кэша (${served}) — значит он мог достаться и постороннему через тот же PoP` };
  }
  if (!busterAlsoRefused) {
    return { verdict: "buster_passed", distinct_responses: distinctResponses,
      why: `тот же адрес с уникальным параметром ответил HTTP ${buster?.status}` };
  }
  return {
    verdict: "uncached_refusal", distinct_responses: distinctResponses,
    evidence: forbids ? `cache-control: ${forbids}` : "нет заголовков, говорящих о попадании в кэш",
    why: forbids
      ? `отказ сам запрещает себя хранить (cache-control: ${forbids}) и повторяется на URL с уникальным параметром, которого кэш видеть не мог — HTTP-кэш исключён. ЧЕМ край различает запросы, это измерение не говорит и не берётся утверждать.`
      : `ни один заголовок не сообщает о попадании в кэш (проверены ${CACHE_HINTS.join(", ")}), и отказ повторяется на URL с уникальным параметром, которого кэш видеть не мог — HTTP-кэш исключён. ЧЕМ край различает запросы, это измерение не говорит.`,
  };
}

function line(p) {
  const s = p.status === null ? `— (${p.error})` : String(p.status);
  const h = SHOW.filter((k) => p.headers[k] !== undefined).map((k) => `${k}=${p.headers[k]}`).join("  ");
  return `  ${p.name.padEnd(18)} ${s.padEnd(6)} ${String(p.ms + "ms").padEnd(7)} ${h}`;
}

(async () => {
  const [user, host] = LUD16.split("@");
  const lnurlp = `https://${host}/.well-known/lnurlp/${user}`;
  const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

  // Куда выходит В СЕТЬ эта машина. Без этого «обычный канал» — предположение о самом себе:
  // сравнивая две стороны по коду колокейшна, надо знать код своей. IP не сохраняется.
  let egress = { colo: null, country: null };
  try {
    const tr = await fetch("https://www.cloudflare.com/cdn-cgi/trace", { signal: AbortSignal.timeout(8000) });
    const txt = await tr.text();
    egress = {
      colo: (txt.match(/^colo=(.+)$/m) || [])[1] ?? null,
      country: (txt.match(/^loc=(.+)$/m) || [])[1] ?? null,
    };
  } catch { /* оставляем null — «не измерено», а не «совпадает» */ }

  const local = [];
  local.push(await probe("plain", lnurlp));
  local.push(await probe("cachebuster", `${lnurlp}?nocache=${nonce}`));
  local.push(await probe("plain_again", lnurlp));
  local.push(await probe("with_origin", lnurlp, { origin: "https://ai-experiment.pages.dev" }));
  local.push(await probe("rates", `https://${host}/api/rates`));
  local.push(await probe("control_other_host", "https://api.coinbase.com/v2/prices/BTC-USD/spot"));

  const localVerdict = verdict(local[0], local[1], local[2]);

  let edge = null;
  let edgeError = null;
  try {
    const r = await fetch(EDGE, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(25000) });
    const body = await r.text();
    if (r.status !== 200) edgeError = `HTTP ${r.status}`;
    else {
      try { edge = JSON.parse(body); }
      catch { edgeError = "ответ 200, но не JSON"; }
    }
  } catch (e) {
    edgeError = e.name === "TimeoutError" ? "timeout" : String(e).slice(0, 160);
  }

  const out = {
    measured_at: new Date().toISOString(),
    lud16: LUD16,
    question: "отказ провайдера дата-центру кэшируется или принимается на каждый запрос",
    asked_by: "nostr 6958436255f4c3a5a4d7a7789fbe07e583621d5efc51c6dfe499b93770bca01e, нота 2f3cf6f1a5912c15bb1c21215ea02d5cdbf46e00c772105842059f5bb2ea793c, 2026-08-09",
    local: { egress, ...localVerdict, probes: local },
    edge: edge ? { url: EDGE, ...edge } : { url: EDGE, error: edgeError },
  };

  if (!QUIET) {
    console.log(`Один адрес, две сети · ${out.measured_at}`);
    console.log(`  адрес: ${lnurlp}`);
    console.log("");
    console.log(`С ЭТОЙ МАШИНЫ (её выход в сеть: PoP ${egress.colo ?? "не измерен"}, ${egress.country ?? "?"}):`);
    for (const p of local) console.log(line(p));
    console.log(`  → ${localVerdict.verdict}: ${localVerdict.why}`);
    console.log("");
    if (edge) {
      console.log(`ИЗ ДАТА-ЦЕНТРА CLOUDFLARE (PoP ${edge.edge?.colo ?? "?"}, ${edge.edge?.country ?? "?"}):`);
      for (const p of edge.probes || []) console.log(line(p));
      console.log(`  → ${edge.verdict}: ${edge.why}`);
    } else {
      console.log(`ИЗ ДАТА-ЦЕНТРА CLOUDFLARE: НЕ ИЗМЕРЕНО (${edgeError})`);
      console.log("  «не смотрел» — это не «отказа нет». Вердикт этой стороны неизвестен.");
    }
    console.log("");
    console.log("Пробы одинаковы с обеих сторон. Различается только сеть, из которой задан вопрос.");
  }

  if (OUT) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n", "utf8");
    if (!QUIET) console.log(`Записано: ${OUT}`);
  }

  process.exit(edge ? 0 : 1);
})();
