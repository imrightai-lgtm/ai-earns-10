// GET /invoice?sats=210[&comment=...]   ·   GET /invoice?usd=10[&comment=...]
//
// Выписывает НАСТОЯЩИЙ Lightning-счёт на запрошенную сумму и возвращает его странице.
// Зачем это существует: 2026-08-03 посторонний впервые захотел заплатить и не смог,
// а единственным способом заплатить у меня был адрес, который надо скопировать в кошелёк
// руками. Кнопка «выписать счёт на 210 сат» — это разница между «можно было бы» и «сделано».
//
// Никаких секретов: LNURL-pay целиком публичный протокол (lud16 -> .well-known/lnurlp ->
// callback -> bolt11). Токен счёта здесь не нужен и намеренно не используется — эта функция
// умеет ровно одно: ПРИНЯТЬ. Отправить деньги ею нельзя в принципе.
//
// Комментарий (до 512 знаков, лимит объявляет сам провайдер) вшивается в счёт: кошелёк
// плательщика передаёт его вместе с платежом, и я читаю его следующим тиком. Это и есть
// механика «строки в журнале» — сообщение приходит вместе с деньгами, а не отдельным каналом.
//
// Курс читается в момент запроса, поэтому «$10» на странице не протухает: число сатоши
// считается сейчас, а не тогда, когда я писал HTML. Источников четыре — см. ниже, почему.

const LUD16 = "experiment@coinos.io";
const TIMEOUT_MS = 8000;

// Курс BTC/USD. Источников несколько НЕ для красоты: этот код исполняется в дата-центре
// Cloudflare, а `coinos.io/api/rates` оттуда отвечает 403 — при том что с обычного канала он
// отдаёт курс нормально (тот же эффект измерен в тике 58 на другом эндпоинте того же хоста:
// 403 из дата-центра, 500 с обычного канала, адрес при этом живой). Один источник здесь — это
// рельса, которая молча роняет самую дорогую ступень меню.
const RATE_SOURCES = [
  { url: "https://coinos.io/api/rates", pick: (j) => j?.USD },
  { url: "https://api.coinbase.com/v2/prices/BTC-USD/spot", pick: (j) => j?.data?.amount },
  { url: "https://blockchain.info/ticker", pick: (j) => j?.USD?.last },
  { url: "https://api.kraken.com/0/public/Ticker?pair=XBTUSD", pick: (j) => j?.result?.XXBTZUSD?.c?.[0] },
];

// Диапазон правдоподобия. Источник, ответивший 200 и мусором, не должен назначать цену:
// «$10» по курсу 5 долларов за биткойн — это счёт на 200 000 000 сатоши.
const RATE_MIN = 1000;
const RATE_MAX = 10000000;

// Границы суммы. Нижняя — минимум провайдера (1000 мсат = 1 сат), но 21 сат это цена
// нижней ступени и заодно размер первого доната; ниже неё выписывать нечего.
// Верхняя — защита от опечатки в адресной строке, а не от щедрости: 200 000 сат ≈ $130
// при курсе этого файла, то есть в 13 раз больше всей цели этапа 1.
const MIN_SATS = 21;
const MAX_SATS = 200000;
const MAX_COMMENT = 512;

// `access-control-allow-origin: *` здесь осознанно, а не по невнимательности. Эндпоинт умеет
// ровно одно — попросить провайдера выписать счёт НА МОЙ счёт; хуже всего, что может сделать
// злоупотребляющий, — наплодить неоплаченных счетов, которые истекут сами. Зато открытый CORS
// делает его вызываемым чужими агентами напрямую (он объявлен в llms.txt как JSON-API), а это
// та самая аудитория, которая единственная за всю историю эксперимента что-то заплатила.
// `no-store` обязателен: счёт одноразовый, и закэшированный счёт — это чужой платёж, зачтённый
// не тому заказу.
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
};

async function getJson(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { accept: "application/json" } });
    const body = await res.text();
    let json = null;
    try { json = JSON.parse(body); } catch { /* оставляем null — вызывающий решает */ }
    return { ok: res.ok, status: res.status, json, body };
  } catch (e) {
    return { ok: false, status: null, json: null, body: "", error: e.name === "AbortError" ? "timeout" : String(e) };
  } finally {
    clearTimeout(t);
  }
}

function fail(status, error, detail) {
  return new Response(JSON.stringify({ ok: false, error, detail: detail ?? null }, null, 1), {
    status,
    headers: JSON_HEADERS,
  });
}

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const askedUsd = url.searchParams.get("usd");
  const askedSats = url.searchParams.get("sats");
  const comment = (url.searchParams.get("comment") || "").slice(0, MAX_COMMENT);

  let sats = null;
  let rate = null;
  let rateAt = null;
  let rateSource = null;

  if (askedUsd !== null) {
    const usd = Number(askedUsd);
    if (!Number.isFinite(usd) || usd <= 0) return fail(400, "bad_usd", "usd must be a positive number");
    const tried = [];
    for (const src of RATE_SOURCES) {
      const r = await getJson(src.url);
      const v = r.json ? Number(src.pick(r.json)) : NaN;
      if (r.ok && Number.isFinite(v) && v >= RATE_MIN && v <= RATE_MAX) {
        rate = v;
        rateSource = new URL(src.url).host;
        break;
      }
      tried.push(`${new URL(src.url).host}: ${r.ok ? (Number.isFinite(v) ? `implausible rate ${v}` : "no usable number") : `HTTP ${r.status ?? r.error}`}`);
    }
    if (rate === null) {
      // Курс не прочитан ни у кого — не подставляем «примерно» и не берём вчерашнее число.
      // Каждый отказ назван поимённо: у несостоявшейся проверки должно быть имя.
      return fail(502, "rate_unavailable", `no source returned a usable BTC/USD rate — ${tried.join(" · ")}`);
    }
    rateAt = new Date().toISOString();
    sats = Math.round((usd / rate) * 1e8);
  } else if (askedSats !== null) {
    const n = Number(askedSats);
    if (!Number.isInteger(n)) return fail(400, "bad_sats", "sats must be a whole number");
    sats = n;
  } else {
    return fail(400, "no_amount", "pass ?sats=<n> or ?usd=<n>");
  }

  if (sats < MIN_SATS || sats > MAX_SATS) {
    return fail(400, "out_of_range", `amount must be between ${MIN_SATS} and ${MAX_SATS} sats (got ${sats})`);
  }

  const [user, host] = LUD16.split("@");
  const meta = await getJson(`https://${host}/.well-known/lnurlp/${user}`);
  if (!meta.ok || !meta.json) {
    return fail(502, "lnurlp_failed", `https://${host}/.well-known/lnurlp/${user} -> HTTP ${meta.status ?? meta.error}`);
  }
  if (meta.json.tag !== "payRequest" || !meta.json.callback) {
    return fail(502, "lnurlp_malformed", "provider answered 200 but without tag=payRequest/callback");
  }

  const msat = sats * 1000;
  if (Number.isFinite(Number(meta.json.minSendable)) && msat < Number(meta.json.minSendable)) {
    return fail(400, "below_provider_minimum", `provider minimum is ${Number(meta.json.minSendable) / 1000} sats`);
  }

  const allowedComment = Number(meta.json.commentAllowed) || 0;
  const sentComment = comment.slice(0, allowedComment);

  let cb = `${meta.json.callback}${meta.json.callback.includes("?") ? "&" : "?"}amount=${msat}`;
  if (sentComment) cb += `&comment=${encodeURIComponent(sentComment)}`;

  const inv = await getJson(cb);
  if (!inv.ok || !inv.json) return fail(502, "callback_failed", `callback -> HTTP ${inv.status ?? inv.error}`);
  if (inv.json.status === "ERROR") return fail(502, "callback_error", String(inv.json.reason || "").slice(0, 300));

  const pr = String(inv.json.pr || "");
  if (!/^lnbc\d+[munp]?1/i.test(pr)) {
    // Провайдер ответил 200 и чем-то, что не является счётом mainnet на сумму. Отдавать это
    // странице значит показать человеку строку, которую его кошелёк молча не поймёт.
    return fail(502, "not_an_invoice", `callback returned 200 without a mainnet bolt11 (got "${pr.slice(0, 24)}")`);
  }

  return new Response(JSON.stringify({
    ok: true,
    sats,
    msats: msat,
    bolt11: pr,
    uri: `lightning:${pr}`,
    verify: inv.json.verify || null,     // LNURL-verify: страница спрашивает «оплачено?» сама
    lud16: LUD16,
    comment_sent: sentComment,
    comment_max: allowedComment,
    usd_rate: rate,                      // null, если сумму просили сразу в сатоши
    usd_rate_at: rateAt,
    usd_rate_source: rateSource,
    issued_at: new Date().toISOString(),
    note: "Invoices expire. If yours has, ask for a new one. This endpoint can only receive.",
  }, null, 1), { status: 200, headers: JSON_HEADERS });
}
