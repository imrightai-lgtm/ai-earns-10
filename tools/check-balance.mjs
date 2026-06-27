#!/usr/bin/env node
// Проверка баланса кошелька — ТОЛЬКО ЧТЕНИЕ.
// Без npm-зависимостей и без API-ключей (нужен Node 18+ с глобальным fetch).
// Запуск:  node tools/check-balance.mjs
//
// Поддержка по полю wallet.chain в config.json:
//   - "tron":    баланс токена (по умолчанию USDT-TRC20) через публичный TronGrid
//   - "bitcoin": через blockstream.info
//   - иначе:     EVM-сеть, нативный баланс через wallet.rpc_url (eth_getBalance)

import { readFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
const w = cfg.wallet;

if (!w.address || /ЗАМЕНИ/i.test(w.address)) {
  console.error("✗ Адрес кошелька не задан. Впиши публичный адрес в config.json → wallet.address.");
  process.exit(1);
}

const decimals = BigInt(w.decimals ?? 18);
const symbol = w.symbol ?? w.native_symbol ?? "";

// Минимальные единицы (wei/сатоши/микро-USDT) → человекочитаемое число без потери точности.
function toAmount(raw) {
  const base = 10n ** decimals;
  const whole = raw / base;
  const frac = (raw % base).toString().padStart(Number(decimals), "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

// --- base58 (для конвертации TRON-адреса T... в hex для ABI-вызова) ---
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
// TRON base58check (25 байт: 0x41 + 20 байт адреса + 4 байта контрольной суммы) → 20-байтовый hex
function tronToHex(addr) {
  const d = base58Decode(addr);
  if (d.length !== 25 || d[0] !== 0x41) throw new Error("Это не похоже на TRON-адрес (ожидается T..., 34 символа)");
  // base58check: последние 4 байта — контрольная сумма от двойного SHA-256 первых 21 байта.
  const payload = d.subarray(0, 21);
  const want = createHash("sha256").update(createHash("sha256").update(payload).digest()).digest().subarray(0, 4);
  if (!want.equals(d.subarray(21, 25))) {
    throw new Error("Адрес не прошёл проверку контрольной суммы — возможно опечатка. Перепроверь TRON-адрес.");
  }
  return d.subarray(1, 21).toString("hex"); // 40 hex
}

// USDT-TRC20: balanceOf(address) через публичный узел TronGrid (без ключа).
// Если TronGrid начнёт требовать ключ/лимитировать — можно добавить заголовок TRON-PRO-API-KEY
// или переключиться на Tronscan API.
async function tronTokenBalance() {
  const ownerHex = tronToHex(w.address).padStart(64, "0");
  const res = await fetch("https://api.trongrid.io/wallet/triggerconstantcontract", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      owner_address: w.address,
      contract_address: w.token_contract,
      function_selector: "balanceOf(address)",
      parameter: ownerHex,
      visible: true,
    }),
  });
  const j = await res.json();
  const hex = j?.constant_result?.[0];
  if (!hex) throw new Error("TronGrid: пустой ответ — " + JSON.stringify(j).slice(0, 200));
  return BigInt("0x" + hex);
}

async function bitcoinBalance() {
  const res = await fetch(`https://blockstream.info/api/address/${w.address}`);
  if (!res.ok) throw new Error("Explorer HTTP " + res.status);
  const j = await res.json();
  return BigInt(j.chain_stats.funded_txo_sum) - BigInt(j.chain_stats.spent_txo_sum);
}

async function evmBalance() {
  const res = await fetch(w.rpc_url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [w.address, "latest"] }),
  });
  const j = await res.json();
  if (j.error) throw new Error("RPC: " + JSON.stringify(j.error));
  return BigInt(j.result);
}

try {
  let raw;
  if (w.chain === "tron") raw = await tronTokenBalance();
  else if (w.chain === "bitcoin") raw = await bitcoinBalance();
  else raw = await evmBalance();

  const amount = toAmount(raw);
  const ts = new Date().toISOString();
  appendFileSync(
    join(root, "memory", "balance-log.csv"),
    `${ts},${w.chain},${w.address},${raw.toString()},${amount},${symbol}\n`,
  );

  console.log(`✓ Баланс: ${amount} ${symbol}  (${raw.toString()} мин. ед.)`);
  console.log(`  Сеть:   ${w.chain}${w.asset ? " / " + w.asset : ""}`);
  console.log(`  Адрес:  ${w.address}`);
  if (w.explorer_url) console.log(`  Обозреватель: ${w.explorer_url}${w.address}`);
  console.log(`  Записано в memory/balance-log.csv (${ts})`);
} catch (e) {
  console.error("✗ Не удалось получить баланс:", e.message);
  console.error("  Проверь wallet.* в config.json и доступ к интернету.");
  process.exit(1);
}
