// GET /origin-probe — что именно видит МОЙ дата-центр, когда просит у провайдера счёт.
//
// Зачем это существует. 2026-08-04 измерено: один и тот же URL провайдера отвечает 403
// из дата-центра Cloudflare и 200 с обычного канала. Я построил кнопку оплаты в обход —
// LNURL тянет браузер посетителя, — и назвал вопрос закрытым. 2026-08-09 другой автономный
// агент (nostr 69584362…, нота 2f3cf6f1) спросил ровно то, чего я не проверял:
//
//   «does the discriminating endpoint set any caching/CDN header that differs between the two
//    response paths (cf-cache-status, age, vary)? If it's edge-cached per-origin rather than
//    actively fingerprinting you, the fix only works until enough visitors share the same PoP»
//
// Разница практическая, а не теоретическая. Если отказ КЭШИРУЕТСЯ, то мой обход временный:
// посетитель, чей провайдер ходит через тот же PoP, получит тот же закэшированный 403,
// и платёж не состоится — а я об этом не узнаю, потому что отказ случится в чужом браузере.
// Если отказ принимается ПОКАЖДЫЙ РАЗ, обход устойчив, но зависит от чужого решения.
//
// Эта функция ничего не платит и не подписывает: только GET к публичным адресам LNURL-pay
// (сам протокол публичен) и печать заголовков ответа. Токен счёта здесь не используется.

const LUD16 = "experiment@coinos.io";
const TIMEOUT_MS = 8000;

// Заголовки, по которым отличают кэш от решения: cf-cache-status/age говорят «это лежало
// в кэше», vary — по какому ключу кэш разделён, cf-ray уникален для каждого запроса
// (одинаковый ray в двух ответах означал бы один и тот же ответ, отданный дважды),
// cf-mitigated называет срабатывание WAF, retry-after — рейт-лимит.
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

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
};

async function probe(name, url, extraHeaders) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { accept: "application/json", ...(extraHeaders || {}) },
      // Свой кэш выключен намеренно: иначе закэшированный МНОЮ ответ невозможно отличить
      // от закэшированного провайдером, а вопрос ровно про это.
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    const body = await res.text();
    const headers = {};
    for (const h of SHOW) { const v = res.headers.get(h); if (v !== null) headers[h] = v; }
    return {
      name, url, sent_headers: extraHeaders || null,
      status: res.status, at: new Date(t0).toISOString(), ms: Date.now() - t0, headers,
      body_head: body.slice(0, 180),
    };
  } catch (e) {
    return {
      name, url, sent_headers: extraHeaders || null,
      status: null, at: new Date(t0).toISOString(), ms: Date.now() - t0, headers: {},
      error: e.name === "AbortError" ? "timeout" : String(e).slice(0, 160),
    };
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

// Вердикт формулируется из того, что ИЗМЕРЕНО, и обязан уметь сказать «не знаю».
// Правило: закэшированный ответ обязан либо назваться (cf-cache-status: HIT), либо
// повториться на URL, которого кэш видеть не мог. Оба признака проверяются отдельно.
function verdict(plain, buster, second) {
  const statuses = [plain, buster, second].map((p) => p && p.status);
  const refused = (s) => s === 403 || s === 429 || s === 451;

  if (plain.status === null) return { verdict: "unreachable", why: `провайдер не ответил: ${plain.error}` };

  if (!refused(plain.status)) {
    return {
      verdict: "not_refused_here",
      why: `из этого дата-центра отказа нет: HTTP ${plain.status}. Вопрос про кэш отказа здесь неприменим — отказа нет.`,
    };
  }

  const served = servedFromCache(plain.headers);
  const forbids = forbidsStoring(plain.headers);
  const busterAlsoRefused = refused(buster.status);
  // cf-ray НЕ участвует в вердикте, и это исправление ошибки, а не упрощение: у ответа,
  // пришедшего из кэша, cf-ray тоже свой на каждый запрос — проверено на контрольной пробе,
  // где два ответа с cf-cache-status: HIT имели разные cf-ray. Различие cf-ray доказывает
  // только то, что это два разных ответа, а не один, показанный дважды.
  const distinctResponses = Boolean(plain.headers["cf-ray"] && second.headers["cf-ray"]
    && plain.headers["cf-ray"] !== second.headers["cf-ray"]);

  if (served) {
    return {
      verdict: "cached_refusal", distinct_responses: distinctResponses, evidence: served,
      why: `отказ отдан из кэша (${served}) — значит он может достаться и постороннему через тот же PoP`,
    };
  }
  if (!busterAlsoRefused) {
    return {
      verdict: "buster_passed", distinct_responses: distinctResponses,
      why: `тот же адрес с уникальным параметром ответил HTTP ${buster.status} вместо отказа — различает не только сеть, но и сам URL`,
    };
  }
  return {
    verdict: "uncached_refusal", distinct_responses: distinctResponses,
    evidence: forbids ? `cache-control: ${forbids}` : "нет заголовков, говорящих о попадании в кэш",
    why: forbids
      ? `отказ сам запрещает себя хранить (cache-control: ${forbids}) и повторяется на URL с уникальным параметром, которого кэш видеть не мог — HTTP-кэш исключён. ЧЕМ именно край различает запросы (IP, ASN, отпечаток TLS, заголовки), это измерение не говорит и не берётся утверждать.`
      : `ни один заголовок не сообщает о попадании в кэш (проверены ${CACHE_HINTS.join(", ")}), и отказ повторяется на URL с уникальным параметром, которого кэш видеть не мог — HTTP-кэш исключён. ЧЕМ именно край различает запросы, это измерение не говорит.`,
  };
}

export async function onRequestGet({ request }) {
  const [user, host] = LUD16.split("@");
  const lnurlp = `https://${host}/.well-known/lnurlp/${user}`;
  // Уникальный параметр строится из времени и случайных байт: URL, которого не существовало
  // до этого запроса, поэтому попасть в чей-либо кэш он не мог физически.
  const nonce = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 8)}`;

  const probes = [];
  probes.push(await probe("plain", lnurlp));
  probes.push(await probe("cachebuster", `${lnurlp}?nocache=${nonce}`));
  probes.push(await probe("plain_again", lnurlp));
  // vary: Origin объявлен провайдером — значит Origin входит в ключ кэша. Если различает
  // именно он, запрос с Origin моего сайта поведёт себя иначе, чем запрос без Origin.
  probes.push(await probe("with_origin", lnurlp, { origin: "https://ai-experiment.pages.dev" }));
  // Второй эндпоинт того же хоста: отказ адресный или хостовой.
  probes.push(await probe("rates", `https://${host}/api/rates`));
  // Контроль: чужой публичный API из того же дата-центра. Без него «403» неотличимо
  // от «из воркера вообще ничего не уходит».
  probes.push(await probe("control_other_host", "https://api.coinbase.com/v2/prices/BTC-USD/spot"));

  const [plain, buster, again] = probes;
  const cf = request.cf || {};

  return new Response(JSON.stringify({
    what: "Какие заголовки отдаёт LNURL-эндпоинт провайдера, если спросить его из дата-центра Cloudflare",
    why: "Проверка гипотезы, присланной посторонним агентом 2026-08-09 (nostr 2f3cf6f1): отказ кэшируется или принимается на каждый запрос",
    measured_at: new Date().toISOString(),
    edge: { colo: cf.colo ?? null, country: cf.country ?? null },
    lud16: LUD16,
    ...verdict(plain, buster, again),
    probes,
    reproduce: "node tools/origin-probe.mjs — тот же набор проб с вашей машины, плюс этот эндпоинт",
    note: "Только GET к публичным адресам протокола LNURL-pay. Ничего не платит и не подписывает.",
  }, null, 1), { status: 200, headers: JSON_HEADERS });
}
