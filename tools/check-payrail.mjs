#!/usr/bin/env node
// Проверка ПУТИ ДОНОРА от начала до конца — только чтение, ничего не публикует.
//
// Зачем: 2026-08-03 посторонний агент попытался прислать мне первые в эксперименте сатоши и не смог —
// LNURL-эндпоинт моего Lightning-провайдера отвечал ошибкой. Узнал я об этом только потому, что он
// написал мне об этом сам. Мои метрики (визиты/звёзды/баланс) при полностью сломанной рельсе приёма
// показывали ровно то же самое, что и при рабочей: нули. Отличить нельзя.
//
// Что проверяется (каждая рельса — до конца, а не «сайт открылся»):
//   lightning  lud16 -> .well-known/lnurlp -> callback -> ВЫПИСАННЫЙ bolt11 на запрошенную сумму
//   tron       адрес проходит base58check -> публичный узел отвечает по нему balanceOf
//   base       адрес валиден -> публичный RPC отвечает eth_getBalance
//   surfaces   каждая поверхность, откуда незнакомец копирует адрес (сайт, Nostr-профиль kind:0),
//              сверяется с config.json — расхождение значит, что часть доноров платит не туда
//
// Вердикты различают ответ и молчание (урок тика 56):
//   OK           рельса довела до конца
//   DOWN         провайдер ОТВЕТИЛ ошибкой (в выводе — код и тело ответа)
//   BROKEN       ответил успешно, но содержимое непригодно (нет callback / не bolt11 / не та сумма)
//   UNREACHABLE  не ответил вовсе (таймаут/сеть) — это НЕ то же самое, что DOWN
//   MISMATCH     поверхность рекламирует не то, что в config.json
//
// Запуск:  node tools/check-payrail.mjs [--sats 21] [--json] [--strict]
//   --strict  выход с кодом 1, если хоть одна рельса не OK (для использования в скриптах)

import { readFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
const w = cfg.wallet;

const args = process.argv.slice(2);
const SATS = Number(args[args.indexOf("--sats") + 1]) || 21;
// --lud16 позволяет проверить ЧУЖОЙ адрес: это же и контроль на самого себя — инструмент,
// который умеет говорить только «DOWN», не доказывает ничего (урок тиков 56-57).
const LUD16 = args.includes("--lud16") ? args[args.indexOf("--lud16") + 1] : null;
const AS_JSON = args.includes("--json");
const STRICT = args.includes("--strict");
const TIMEOUT_MS = 20000;

// fetch, который отличает «ответили ошибкой» от «не ответили».
async function get(url, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, signal: ctl.signal });
    const body = await res.text();
    return { answered: true, status: res.status, body };
  } catch (e) {
    return { answered: false, status: null, body: "", error: e.name === "AbortError" ? `таймаут ${TIMEOUT_MS} мс` : e.message };
  } finally {
    clearTimeout(t);
  }
}

const short = (s, n = 120) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);

// ---------- Lightning: единственная проверка, которая что-то доказывает, — выписанный счёт ----------
async function checkLightning(lud16) {
  const steps = [];
  const fail = (verdict, detail) => ({ rail: "lightning", target: lud16, verdict, detail, steps });

  const m = /^([^@\s]+)@([^@\s]+)$/.exec(lud16 || "");
  if (!m) return fail("BROKEN", "lud16 не разбирается как user@host");
  const [, user, host] = m;

  const lnurlp = `https://${host}/.well-known/lnurlp/${user}`;
  const r1 = await get(lnurlp);
  steps.push({ step: "lnurlp", url: lnurlp, status: r1.status, ok: r1.answered && r1.status === 200 });
  if (!r1.answered) return fail("UNREACHABLE", `${lnurlp}: ${r1.error}`);
  // 403/429/451 — отказ ПРОБНИКУ, а не приговор адресу (провайдер может резать дата-центры,
  // обслуживая при этом обычные кошельки). Отдельный вердикт, иначе получится ложь в красную сторону.
  if ([403, 429, 451].includes(r1.status)) return fail("BLOCKED", `${lnurlp}: HTTP ${r1.status} — провайдер отказал ПРОВЕРКЕ, об адресе это не говорит ничего · «${short(r1.body)}»`);
  if (r1.status !== 200) return fail("DOWN", `${lnurlp}: HTTP ${r1.status} · «${short(r1.body)}»`);

  let meta;
  try { meta = JSON.parse(r1.body); } catch { return fail("BROKEN", `${lnurlp}: ответ 200, но не JSON · «${short(r1.body)}»`); }
  if (meta.status === "ERROR") return fail("DOWN", `${lnurlp}: HTTP 200, но LNURL-ошибка · «${short(meta.reason)}»`);
  if (meta.tag !== "payRequest" || !meta.callback) return fail("BROKEN", `${lnurlp}: нет callback/tag=payRequest`);

  const msat = SATS * 1000;
  if (meta.minSendable && msat < meta.minSendable) {
    return fail("BROKEN", `${SATS} сат ниже minSendable ${meta.minSendable / 1000} сат`);
  }

  const cb = `${meta.callback}${meta.callback.includes("?") ? "&" : "?"}amount=${msat}`;
  const r2 = await get(cb);
  steps.push({ step: "callback", url: cb, status: r2.status, ok: r2.answered && r2.status === 200 });
  if (!r2.answered) return fail("UNREACHABLE", `callback: ${r2.error}`);
  if (r2.status !== 200) return fail("DOWN", `callback: HTTP ${r2.status} · «${short(r2.body)}»`);

  let inv;
  try { inv = JSON.parse(r2.body); } catch { return fail("BROKEN", `callback: ответ 200, но не JSON · «${short(r2.body)}»`); }
  if (inv.status === "ERROR") return fail("DOWN", `callback: LNURL-ошибка · «${short(inv.reason)}»`);

  const pr = (inv.pr || "").toLowerCase();
  if (!pr) return fail("BROKEN", "callback вернул 200 без поля pr (счёта нет)");

  // Проверка счёта БЕЗ доверия провайдеру: сумма закодирована в человекочитаемой части bolt11.
  // Сеть проверяется ПЕРВОЙ: счёт на testnet/regtest разбирается точно так же и дал бы зелёный
  // вердикт на монеты, которых не существует. Ложь в зелёную сторону хуже отсутствия проверки.
  const net = /^ln(bc|tbs?|bcrt|sb)/.exec(pr);
  if (net && net[1] !== "bc") return fail("BROKEN", `счёт выписан не в mainnet (ln${net[1]}…) — такие сатоши не существуют`);
  const hrp = /^lnbc(\d+)([munp])?1/.exec(pr);
  if (!hrp) return fail("BROKEN", `pr не разбирается как mainnet-bolt11 с суммой · «${short(pr, 40)}»`);
  const MULT = { m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12 };
  const btc = Number(hrp[1]) * (hrp[2] ? MULT[hrp[2]] : 1);
  const gotSats = Math.round(btc * 1e8);
  steps.push({ step: "invoice", bolt11_prefix: pr.slice(0, 20), sats_in_invoice: gotSats, ok: gotSats === SATS });
  if (gotSats !== SATS) return fail("BROKEN", `счёт выписан на ${gotSats} сат вместо запрошенных ${SATS}`);

  return { rail: "lightning", target: lud16, verdict: "OK", detail: `счёт на ${SATS} сат выписан`, steps };
}

// ---------- On-chain: адрес валиден и публичный узел отвечает по нему ----------
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function tronToHex(addr) {
  let num = 0n;
  for (const ch of addr) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error("недопустимый символ base58");
    num = num * 58n + BigInt(i);
  }
  let hex = num.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const d = Buffer.from(hex, "hex");
  if (d.length !== 25 || d[0] !== 0x41) throw new Error("не TRON-адрес");
  const want = createHash("sha256").update(createHash("sha256").update(d.subarray(0, 21)).digest()).digest().subarray(0, 4);
  if (!want.equals(d.subarray(21, 25))) throw new Error("контрольная сумма не сошлась");
  return d.subarray(1, 21).toString("hex");
}

async function checkTron() {
  const rail = "tron";
  let ownerHex;
  try { ownerHex = tronToHex(w.address).padStart(64, "0"); }
  catch (e) { return { rail, target: w.address, verdict: "BROKEN", detail: `адрес: ${e.message}`, steps: [] }; }

  const url = "https://api.trongrid.io/wallet/triggerconstantcontract";
  const r = await get(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ owner_address: w.address, contract_address: w.token_contract, function_selector: "balanceOf(address)", parameter: ownerHex, visible: true }),
  });
  if (!r.answered) return { rail, target: w.address, verdict: "UNREACHABLE", detail: `TronGrid: ${r.error}`, steps: [] };
  if (r.status !== 200) return { rail, target: w.address, verdict: "DOWN", detail: `TronGrid: HTTP ${r.status} · «${short(r.body)}»`, steps: [] };
  let j; try { j = JSON.parse(r.body); } catch { return { rail, target: w.address, verdict: "BROKEN", detail: "TronGrid: ответ не JSON", steps: [] }; }
  if (!j?.constant_result?.[0]) return { rail, target: w.address, verdict: "BROKEN", detail: `TronGrid: нет constant_result · «${short(r.body)}»`, steps: [] };
  return { rail, target: w.address, verdict: "OK", detail: "адрес прошёл base58check, узел отвечает по нему balanceOf", steps: [] };
}

// EIP-55: у EVM-адреса контрольная сумма закодирована регистром букв. Без неё проверка адреса
// тавтологична — узел ответит балансом на ЛЮБУЮ строку из 40 hex, включая опечатанную.
async function eip55Ok(addr) {
  let keccak_256;
  try { ({ keccak_256 } = await import("@noble/hashes/sha3.js")); } catch { return null; }
  const body = addr.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return null; // регистр не несёт суммы
  const lower = body.toLowerCase();
  const hash = Buffer.from(keccak_256(new TextEncoder().encode(lower))).toString("hex");
  let want = "0x";
  for (let i = 0; i < lower.length; i++) want += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  return want === addr;
}

async function checkBase() {
  const rail = "base";
  const addr = w.base_address;
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr || "")) return { rail, target: addr, verdict: "BROKEN", detail: "адрес не в формате 0x + 40 hex", steps: [] };
  const cs = await eip55Ok(addr);
  if (cs === false) return { rail, target: addr, verdict: "BROKEN", detail: "адрес не проходит контрольную сумму EIP-55 — вероятна опечатка", steps: [] };
  const r = await get("https://mainnet.base.org", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [addr, "latest"] }),
  });
  if (!r.answered) return { rail, target: addr, verdict: "UNREACHABLE", detail: `Base RPC: ${r.error}`, steps: [] };
  if (r.status !== 200) return { rail, target: addr, verdict: "DOWN", detail: `Base RPC: HTTP ${r.status} · «${short(r.body)}»`, steps: [] };
  let j; try { j = JSON.parse(r.body); } catch { return { rail, target: addr, verdict: "BROKEN", detail: "Base RPC: ответ не JSON", steps: [] }; }
  if (j.error || typeof j.result !== "string") return { rail, target: addr, verdict: "BROKEN", detail: `Base RPC: ${short(JSON.stringify(j.error || j))}`, steps: [] };
  return {
    rail, target: addr, verdict: "OK", steps: [],
    detail: cs === true
      ? "адрес проходит контрольную сумму EIP-55, публичный RPC сети отвечает"
      : "адрес корректен по формату (контрольная сумма EIP-55 не проверяется: адрес записан в одном регистре), публичный RPC сети отвечает",
  };
}

// ---------- Поверхности: то, что незнакомец реально копирует ----------
async function checkSurfaces(deadTargets) {
  const base = cfg.deploy?.public_url?.replace(/\/$/, "") || "";
  const expect = [w.lightning_address, w.address, w.base_address].filter(Boolean);
  const out = [];

  // Считаем ТОЛЬКО то, что донор копирует как «адрес получателя»: блоки class="addr" и
  // inline-<code>. Адреса контрактов USDT/USDC и чужие адреса в таблице реестра — это контент
  // страницы, а не платёжные реквизиты, и путать их с расхождением нельзя.
  const PAYEE_BLOCK = /<(?:div|p|span|code)[^>]*class="[^"]*\b(?:addr|inline)\b[^"]*"[^>]*>([\s\S]*?)<\/(?:div|p|span|code)>/gi;
  const ADDRESSISH = /\b(?:[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}|T[1-9A-HJ-NP-Za-km-z]{33}|0x[0-9a-fA-F]{40})\b/gi;
  const allow = new Set(expect.map((a) => a.toLowerCase()));

  // Список страниц берётся из sitemap.xml, а не из хардкода: иначе «проверены все поверхности»
  // означает «проверены те три, про которые я вспомнил», и новая страница выпадает молча.
  let pages = [];
  const sm = await get(base + "/sitemap.xml");
  if (sm.answered && sm.status === 200) pages = [...sm.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
  if (!pages.length) {
    out.push({ surface: base + "/sitemap.xml", verdict: "UNREACHABLE", detail: "список страниц не получен — поверхности НЕ проверены" });
    return out;
  }

  for (const url of pages) {
    const r = await get(url);
    if (!r.answered) { out.push({ surface: url, verdict: "UNREACHABLE", detail: r.error }); continue; }
    if (r.status !== 200) { out.push({ surface: url, verdict: "DOWN", detail: `HTTP ${r.status}` }); continue; }

    const claimed = new Set();
    for (const m of r.body.matchAll(PAYEE_BLOCK)) {
      const text = m[1].replace(/<[^>]+>/g, " ");
      for (const a of text.matchAll(ADDRESSISH)) claimed.add(a[0].toLowerCase());
    }
    const stray = [...claimed].filter((a) => !allow.has(a));
    const mine = [...claimed].filter((a) => allow.has(a));
    const onlyDead = mine.length > 0 && mine.every((a) => deadTargets.has(a));
    // Страница без реквизитов — не обязательно дефект, но только если с неё есть путь туда, где
    // реквизиты есть. Рельса, которая работает и нигде не предложена, отказывает так же полно,
    // как рельса, которая лежит: вердикт обязан это ловить, иначе он противоречит своему тезису.
    const linksToPayee = /href="\/(?:"|#|index\.html")/.test(r.body) || new RegExp(`href="${base}/?"`).test(r.body);

    let verdict = "OK";
    let detail = `реквизиты совпадают с config (${mine.length} из ${expect.length} рельс предложено)`;
    if (stray.length) {
      verdict = "MISMATCH";
      detail = `в блоке реквизитов адрес не из config: ${stray.join(", ")}`;
    } else if (onlyDead) {
      verdict = "ONLY-DEAD-RAIL";
      detail = `единственная предлагаемая рельса сейчас не работает: ${mine.join(", ")}`;
    } else if (mine.length === 0) {
      verdict = linksToPayee ? "NO-RAIL-LINKED" : "NO-RAIL-OFFERED";
      detail = linksToPayee
        ? "реквизитов нет, но есть ссылка на страницу, где они есть"
        : "реквизитов нет и ссылки на страницу с ними нет — поддержать отсюда невозможно";
    }
    out.push({ surface: url, verdict, detail });
  }
  return out;
}

async function checkNostrProfile() {
  // kind:0 читается тем же способом, что и в остальных инструментах, но без зависимости от них.
  let SimplePool;
  try { ({ SimplePool } = await import("nostr-tools")); }
  catch { return { surface: "nostr kind:0", verdict: "SKIPPED", detail: "нет nostr-tools" }; }
  const relays = (process.env.NOSTR_RELAYS || "wss://relay.primal.net,wss://relay.ditto.pub,wss://offchain.pub,wss://nostr.oxtr.dev,wss://relay.mostr.pub,wss://purplerelay.com,wss://relay.damus.io").split(",");
  let pk = "";
  try {
    const env = readFileSync(join(root, ".env"), "utf8");
    const nsec = /^NOSTR_NSEC=(.*)$/m.exec(env)?.[1]?.trim().replace(/^["']|["']$/g, "");
    if (nsec) {
      const { nip19, getPublicKey } = await import("nostr-tools");
      pk = getPublicKey(nsec.startsWith("nsec") ? nip19.decode(nsec).data : Buffer.from(nsec, "hex"));
    }
  } catch { /* нет ключа — просто пропускаем, это read-only проверка */ }
  if (!pk) return { surface: "nostr kind:0", verdict: "SKIPPED", detail: "не удалось определить свой pubkey" };

  const pool = new SimplePool();
  let evs = [];
  try { evs = await pool.querySync(relays, { authors: [pk], kinds: [0], limit: 5 }); } catch { /* ниже */ }
  try { pool.close(relays); } catch {}
  const latest = evs.sort((a, b) => b.created_at - a.created_at)[0];
  if (!latest) return { surface: "nostr kind:0", verdict: "UNREACHABLE", detail: "профиль не отдан ни одним релеем" };
  let prof = {};
  try { prof = JSON.parse(latest.content); } catch { return { surface: "nostr kind:0", verdict: "BROKEN", detail: "content не JSON" }; }
  const published = (prof.lud16 || "").toLowerCase();
  const want = String(w.lightning_address || "").toLowerCase();
  if (!published) return { surface: "nostr kind:0", verdict: "MISMATCH", detail: "в профиле нет lud16 — зап отправить некуда" };
  if (published !== want) return { surface: "nostr kind:0", verdict: "MISMATCH", detail: `в профиле ${published}, в config ${want}` };
  return { surface: "nostr kind:0", verdict: "OK", detail: `lud16 совпадает с config (${published})` };
}

// ---------- Запуск ----------
// Рельсы проверяются первыми: поверхности сверяются с их результатом, чтобы отличить
// «страница предлагает не тот адрес» от «страница предлагает единственную мёртвую рельсу».
if (LUD16) {
  const r = await checkLightning(LUD16);
  console.log(JSON.stringify(r, null, 2));
  // exitCode вместо process.exit(): принудительный выход при ещё закрывающемся сокете роняет
  // Node на Windows с assertion в libuv — вывод при этом уже напечатан и выглядит корректным.
  process.exitCode = r.verdict === "OK" ? 0 : 1;
} else {
  await auditOwnPath();
}

async function auditOwnPath() {


const [ln, tron, basechain] = await Promise.all([
  checkLightning(w.lightning_address),
  checkTron(),
  checkBase(),
]);
const rails = [ln, tron, basechain];
const deadTargets = new Set(rails.filter((r) => r.verdict !== "OK").map((r) => String(r.target).toLowerCase()));

const [surfaces, profile] = await Promise.all([checkSurfaces(deadTargets), checkNostrProfile()]);
const allSurfaces = [...surfaces, profile];
const ts = new Date().toISOString();

if (AS_JSON) {
  console.log(JSON.stringify({ checked_at: ts, probe_sats: SATS, rails, surfaces: allSurfaces }, null, 2));
} else {
  const mark = (v) => (v === "OK" ? "✓" : v === "SKIPPED" || v === "NO-RAIL-LINKED" ? "·" : "✗");
  console.log(`Путь донора · ${ts} · пробный счёт на ${SATS} сат\n`);
  console.log("РЕЛЬСЫ (может ли посторонний реально прислать):");
  for (const r of rails) console.log(`  ${mark(r.verdict)} ${r.rail.padEnd(10)} ${r.verdict.padEnd(12)} ${r.target}\n      ${r.detail}`);
  console.log("\nПОВЕРХНОСТИ (откуда он копирует адрес):");
  for (const s of allSurfaces) console.log(`  ${mark(s.verdict)} ${String(s.surface).padEnd(42)} ${s.verdict.padEnd(12)} ${s.detail}`);
  const bad = rails.filter((r) => r.verdict !== "OK");
  console.log(bad.length
    ? `\n✗ Нерабочих рельс: ${bad.length} из ${rails.length} — ${bad.map((b) => b.rail).join(", ")}`
    : `\n✓ Все ${rails.length} рельсы довели до конца.`);
  console.log("  Замечание: OK у on-chain означает «адрес валиден и узел по нему отвечает»,");
  console.log("  а у lightning — «провайдер выписал настоящий счёт на запрошенную сумму». Это разной силы утверждения.");
}

// Длинный формат: одна строка на проверку. Широкий формат ломается каждый раз, когда
// появляется новая страница, и шапка перестаёт соответствовать строкам.
const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
const csv = [
  ...rails.map((r) => [ts, "rail", r.rail, r.target, r.verdict, r.detail]),
  ...allSurfaces.map((s) => [ts, "surface", s.surface, "", s.verdict, s.detail]),
].map((row) => row.map(q).join(",")).join("\n");
appendFileSync(join(root, "memory", "payrail-log.csv"), csv + "\n");

// Поверхность в состоянии MISMATCH (донор копирует не тот адрес) — самый дорогой отказ из всех,
// и он обязан ронять --strict наравне с мёртвой рельсой.
const failing = [...rails, ...allSurfaces].filter((x) => !["OK", "NO-RAIL-LINKED", "SKIPPED"].includes(x.verdict));
if (STRICT && failing.length) process.exitCode = 1;
}
