#!/usr/bin/env node
// Сколько денег у эксперимента ФАКТИЧЕСКИ есть — по всем рельсам приёма сразу.
// Запуск:  node tools/check-balance.mjs  [--json]
//
// ПОЧЕМУ ОН ПЕРЕПИСАН (2026-08-06, тик 61). До этого дня скрипт читал ровно одну рельсу
// из трёх — TRON — и печатал «✓ Баланс: 0 USDT», как будто это баланс эксперимента.
// С 2026-08-03 это было неправдой: 21 сатоши лежали на Lightning-счёте, о котором скрипт
// не знал. Ошибка стоила три дня незамеченной вехи, и заметил её человек, а не инструмент.
// Отсюда правило, вшитое в вывод: у каждой рельсы есть строка, и у рельсы, которую
// прочитать НЕ удалось, тоже есть строка — «не измерено» никогда не складывается в ноль.
//
// Читаются:
//   lightning  coinos, кастодиальный (нужен COINOS_TOKEN в .env) — tools/coinos.mjs
//   tron       USDT-TRC20 через публичный TronGrid, без ключа
//   base       USDC на Base через публичный RPC, без ключа
//
// Ключей на трату on-chain здесь нет и быть не может: все три запроса — чтение (хартия §6.1).

import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { snapshot as coinosSnapshot } from "./coinos.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
const w = cfg.wallet;
const asJson = process.argv.includes("--json");

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

// Минимальные единицы → человекочитаемое число без потери точности.
function toAmount(raw, decimals) {
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const frac = (raw % base).toString().padStart(Number(decimals), "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

// --- base58check (TRON-адрес T... → 20-байтовый hex) ---
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Decode(s) {
  let num = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error("Некорректный символ в base58-адресе");
    num = num * 58n + BigInt(i);
  }
  let hex = num.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const body = num === 0n ? Buffer.alloc(0) : Buffer.from(hex, "hex");
  let zeros = 0;
  for (const ch of s) { if (ch === "1") zeros++; else break; }
  return Buffer.concat([Buffer.alloc(zeros, 0), body]);
}
function tronToHex(addr) {
  const d = base58Decode(addr);
  if (d.length !== 25 || d[0] !== 0x41) throw new Error("Это не похоже на TRON-адрес (ожидается T..., 34 символа)");
  const payload = d.subarray(0, 21);
  const want = createHash("sha256").update(createHash("sha256").update(payload).digest()).digest().subarray(0, 4);
  if (!want.equals(d.subarray(21, 25))) throw new Error("Адрес не прошёл контрольную сумму — возможно опечатка");
  return d.subarray(1, 21).toString("hex");
}

async function tronRail() {
  const rail = { rail: "tron", asset: w.asset ?? "USDT-TRC20", target: w.address, read: false, amount: null, usd: null, note: "" };
  if (!w.address || /ЗАМЕНИ/i.test(w.address)) { rail.note = "адрес не задан в config.json"; return rail; }
  const ownerHex = tronToHex(w.address).padStart(64, "0");
  const res = await fetch("https://api.trongrid.io/wallet/triggerconstantcontract", {
    method: "POST", // конституционально это чтение: triggerconstantcontract не изменяет состояние сети
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      owner_address: w.address, contract_address: w.token_contract,
      function_selector: "balanceOf(address)", parameter: ownerHex, visible: true,
    }),
  });
  const j = await res.json();
  const hex = j?.constant_result?.[0];
  if (!hex) throw new Error("TronGrid: пустой ответ — " + JSON.stringify(j).slice(0, 160));
  const raw = BigInt("0x" + hex);
  rail.read = true;
  rail.amount = toAmount(raw, w.decimals ?? 6);
  rail.raw = raw.toString();
  rail.usd = Number(rail.amount); // USDT считаем 1:1 к доллару
  return rail;
}

// Base: USDC. Контракт и его decimals НЕ доверяются на слово — читаются у самой сети
// (symbol()/decimals()) и сверяются с config.base_asset. Захардкоженный адрес токена —
// ровно тот класс утверждения, который однажды окажется устаревшим и никто не заметит.
// Публичных узлов несколько не для красоты: на первом же прогоне mainnet.base.org ответил
// `-32016 over rate limit` на одном запуске из трёх. Один узел — это рельса, которая
// «не измерена» каждый третий тик по причине, не имеющей отношения к деньгам.
const BASE_RPCS = ["https://mainnet.base.org", "https://base.llamarpc.com", "https://base-rpc.publicnode.com"];
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
async function baseCall(data) {
  const errors = [];
  for (const rpc of BASE_RPCS) {
    try {
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: BASE_USDC, data }, "latest"] }),
      });
      const j = await res.json();
      if (j.error || typeof j.result !== "string") { errors.push(`${rpc}: ${JSON.stringify(j.error || j).slice(0, 90)}`); continue; }
      return j.result;
    } catch (e) { errors.push(`${rpc}: ${e.message}`); }
  }
  // Ни один узел не ответил — это «не измерено», и в тексте ошибки названы все, кого спросили.
  throw new Error("Base RPC, опрошено узлов " + BASE_RPCS.length + ": " + errors.join(" · "));
}
function decodeAbiString(hex) {
  const b = Buffer.from(hex.slice(2), "hex");
  if (b.length < 64) return "";
  const len = Number(BigInt("0x" + b.subarray(32, 64).toString("hex")));
  return b.subarray(64, 64 + len).toString("utf8");
}
async function baseRail() {
  const rail = { rail: "base", asset: w.base_asset ?? "USDC-Base", target: w.base_address, read: false, amount: null, usd: null, note: "" };
  if (!w.base_address) { rail.note = "адрес не задан в config.json"; return rail; }
  const [symHex, decHex] = await Promise.all([baseCall("0x95d89b41"), baseCall("0x313ce567")]);
  const symbol = decodeAbiString(symHex);
  const decimals = Number(BigInt(decHex));
  if (!String(rail.asset).toUpperCase().startsWith(symbol.toUpperCase()) || !symbol) {
    rail.note = `контракт на Base называет себя «${symbol}», а config ждёт «${rail.asset}» — не читаю, пока не совпадёт`;
    return rail;
  }
  const raw = BigInt(await baseCall("0x70a08231" + w.base_address.slice(2).toLowerCase().padStart(64, "0")));
  rail.read = true;
  rail.amount = toAmount(raw, decimals);
  rail.raw = raw.toString();
  rail.usd = Number(rail.amount);
  rail.note = `контракт подтвердил symbol=${symbol}, decimals=${decimals}`;
  return rail;
}

async function lightningRail() {
  const rail = { rail: "lightning", asset: "сат", target: w.lightning_address ?? "", read: false, amount: null, usd: null, note: "" };
  const s = await coinosSnapshot({ token: process.env.COINOS_TOKEN });
  if (!s.ok) { rail.note = s.errors.join("; ") || "не прочитан"; return rail; }
  rail.read = true;
  rail.amount = `${s.balance_sats}`;
  rail.raw = String(s.balance_sats);
  rail.usd = s.balance_usd;
  rail.incoming_sats = s.incoming_sats;
  rail.note = s.balance_usd === null
    ? "курс BTC не прочитан — сумму в долларах не привожу"
    : `кастодиальный счёт, всего поступило ${s.incoming_sats} сат`;
  return rail;
}

const rails = [];
for (const [name, fn] of [["lightning", lightningRail], ["tron", tronRail], ["base", baseRail]]) {
  try { rails.push(await fn()); }
  catch (e) { rails.push({ rail: name, read: false, amount: null, usd: null, note: "ошибка: " + e.message }); }
}

const ts = new Date().toISOString();
const readRails = rails.filter((r) => r.read);
const unreadRails = rails.filter((r) => !r.read);
// В сумму входят ТОЛЬКО прочитанные рельсы, и рядом всегда стоит, сколько их из скольких.
const totalUsd = readRails.reduce((a, r) => a + (Number.isFinite(r.usd) ? r.usd : 0), 0);
const usdComplete = readRails.every((r) => Number.isFinite(r.usd));

// Исторический лог (формат первой колонки не меняем — по нему читается вся история эксперимента).
appendFileSync(
  join(root, "memory", "balance-log.csv"),
  `${ts},${w.chain},${w.address},${rails.find((r) => r.rail === "tron")?.raw ?? ""},${rails.find((r) => r.rail === "tron")?.amount ?? ""},${w.symbol ?? "USDT"}\n`,
);

if (asJson) {
  console.log(JSON.stringify({ read_at: ts, rails, total_usd: totalUsd, total_usd_complete: usdComplete, rails_read: readRails.length, rails_total: rails.length }, null, 2));
} else {
  console.log(`Баланс эксперимента по всем рельсам приёма · ${ts}`);
  for (const r of rails) {
    if (r.read) {
      const usd = Number.isFinite(r.usd) ? `≈ $${r.usd.toFixed(4)}` : "(в долларах не переведено)";
      console.log(`  ✓ ${r.rail.padEnd(10)} ${r.amount} ${r.asset}  ${usd}`);
    } else {
      console.log(`  ? ${r.rail.padEnd(10)} НЕ ИЗМЕРЕНО — ${r.note}`);
    }
    if (r.target) console.log(`      ${r.target}`);
    if (r.read && r.note) console.log(`      ${r.note}`);
  }
  console.log(`  ── итого прочитано: $${totalUsd.toFixed(4)} по ${readRails.length} рельсам из ${rails.length}`);
  if (unreadRails.length) {
    console.log(`     ВНИМАНИЕ: ${unreadRails.map((r) => r.rail).join(", ")} не прочитано — это не ноль, это отсутствие измерения.`);
  }
  console.log(`  Записано в memory/balance-log.csv (${ts})`);
}

// Код возврата: 1, если хоть одна рельса осталась непрочитанной — чтобы «дыра в измерении»
// была видна вызывающему скрипту, а не только человеку, читающему вывод.
process.exit(unreadRails.length ? 1 : 0);
