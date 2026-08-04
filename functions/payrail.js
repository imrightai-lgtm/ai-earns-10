// GET /payrail — проверяет ПРЯМО СЕЙЧАС, может ли Lightning-адрес выписать счёт.
//
// Зачем это на сервере, а не в браузере: LNURL-эндпоинты не обязаны отдавать CORS-заголовки,
// поэтому со страницы напрямую проверка часто невозможна. И зачем вообще: 2026-08-03 посторонний
// пытался прислать первые в эксперименте сатоши и не смог, а на сайте всё это время висел
// адрес без единого признака, что он не работает. Написанная в HTML фраза «сейчас всё сломано»
// протухает через час; живая проверка — нет.
//
// Проверка одна и настоящая: lnurlp -> callback -> выписанный bolt11 на 21 сат.
// «Сайт провайдера открывается» ничего не значит и здесь не считается.

const LUD16 = "experiment@coinos.io";
const PROBE_SATS = 21;
const TIMEOUT_MS = 6000;

async function get(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { accept: "application/json" } });
    return { answered: true, status: res.status, body: await res.text() };
  } catch (e) {
    return { answered: false, status: null, body: "", error: e.name === "AbortError" ? "timeout" : String(e) };
  } finally {
    clearTimeout(t);
  }
}

async function probe() {
  const [user, host] = LUD16.split("@");
  const lnurlp = `https://${host}/.well-known/lnurlp/${user}`;

  const r1 = await get(lnurlp);
  if (!r1.answered) return { verdict: "unreachable", detail: `${host} did not answer (${r1.error})` };
  // 403/429 — это отказ ПРОБНИКУ, а не приговор адресу. Этот код исполняется в дата-центре, и
  // провайдеры регулярно режут такие адреса, продолжая обслуживать обычные кошельки. Назвать это
  // «не может принять» значит отговорить донора от рабочей рельсы — ложь в другую сторону, но ложь.
  if (r1.status === 403 || r1.status === 429 || r1.status === 451) {
    return { verdict: "blocked", detail: `${host} refused this automated check with HTTP ${r1.status} — that is a verdict about the check, not about the address` };
  }
  if (r1.status !== 200) return { verdict: "down", detail: `${host} answered HTTP ${r1.status}` };

  let meta;
  try { meta = JSON.parse(r1.body); } catch { return { verdict: "broken", detail: `${host} answered 200 with non-JSON` }; }
  if (meta.status === "ERROR") return { verdict: "down", detail: `${host}: ${String(meta.reason).slice(0, 90)}` };
  if (meta.tag !== "payRequest" || !meta.callback) return { verdict: "broken", detail: `${host} returned no payRequest callback` };

  const msat = PROBE_SATS * 1000;
  const cb = `${meta.callback}${meta.callback.includes("?") ? "&" : "?"}amount=${msat}`;
  const r2 = await get(cb);
  if (!r2.answered) return { verdict: "unreachable", detail: `invoice callback did not answer (${r2.error})` };
  if (r2.status !== 200) return { verdict: "down", detail: `invoice callback answered HTTP ${r2.status}` };

  let inv;
  try { inv = JSON.parse(r2.body); } catch { return { verdict: "broken", detail: "invoice callback answered 200 with non-JSON" }; }
  if (inv.status === "ERROR") return { verdict: "down", detail: `invoice callback: ${String(inv.reason).slice(0, 90)}` };

  const pr = String(inv.pr || "").toLowerCase();
  // Сеть проверяется первой: testnet/regtest-счёт разбирается точно так же и дал бы зелёный
  // вердикт на монеты, которых не существует. Ложь в зелёную сторону хуже отсутствия проверки.
  const net = /^ln(bc|tbs?|bcrt|sb)/.exec(pr);
  if (net && net[1] !== "bc") return { verdict: "broken", detail: `invoice was issued on ${"ln" + net[1]} (not bitcoin mainnet)` };
  const hrp = /^lnbc(\d+)([munp])?1/.exec(pr);
  if (!hrp) return { verdict: "broken", detail: "callback returned no usable mainnet bolt11 invoice" };
  const mult = { m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12 };
  const sats = Math.round(Number(hrp[1]) * (hrp[2] ? mult[hrp[2]] : 1) * 1e8);
  if (sats !== PROBE_SATS) return { verdict: "broken", detail: `invoice was for ${sats} sats, not ${PROBE_SATS}` };

  return { verdict: "ok", detail: `invoice for ${PROBE_SATS} sats issued` };
}

export async function onRequest() {
  const started = Date.now();
  const res = await probe();
  const body = JSON.stringify({
    lightning_address: LUD16,
    probe_sats: PROBE_SATS,
    checked_at: new Date().toISOString(),
    took_ms: Date.now() - started,
    ...res,
    method: "lnurlp -> callback -> bolt11 for the requested amount; the provider's homepage returning 200 is not counted",
    onchain_note: "The TRON and Base addresses on this page have no equivalent failure mode: they need no provider to be online at the moment you pay.",
  }, null, 1);

  return new Response(body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Короткий кэш: страница должна показывать свежее состояние, но не бить по провайдеру
      // на каждый просмотр. Отображается всегда checked_at, а не «только что», — иначе edge-кэш
      // превращает 45-секундную давность в утверждение о настоящем моменте.
      "cache-control": "public, max-age=45",
      "access-control-allow-origin": "*",
    },
  });
}
