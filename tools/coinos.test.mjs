#!/usr/bin/env node
// Тесты чтения Lightning-счёта. Запуск: node tools/coinos.test.mjs
// Сеть не нужна: fetch подменяется заглушкой. Проверяются три вещи —
// (1) файл физически не умеет двигать деньги, (2) секреты из ответа провайдера не вытекают,
// (3) «не смог прочитать» не превращается в «ноль».

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { snapshot, satsToUsd, PUBLIC_FIELDS, API } from "./coinos.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; } else { fail++; console.error("  ✗ " + name); } };
const eq = (a, b, name) => ok(Object.is(a, b), `${name} (получено ${JSON.stringify(a)}, ждали ${JSON.stringify(b)})`);

// --- 1. Инвариант §6: только чтение --------------------------------------
const src = readFileSync(join(root, "tools", "coinos.mjs"), "utf8");
const code = src.replace(/^\s*\/\/.*$/gm, ""); // комментарии не считаем кодом
ok(!/method:\s*["'](POST|PUT|PATCH|DELETE)["']/i.test(code), "нет ни одного не-GET запроса");
// Хвост `(["'?\/]|$)` обязателен: без него шаблон `pay` ловил собственный
// безобидный `/api/payments` и ассерт падал на чтении истории.
ok(!/\/api\/(pay|send|withdraw|invoice\/pay|bitcoin\/send)(["'?\/]|$)/im.test(code), "нет обращений к платёжным эндпоинтам");
ok(/\/api\/(pay|send|withdraw)(["'?\/]|$)/im.test('const u = "/api/pay"'), "контроль: этот же шаблон ловит настоящий платёжный вызов");
ok(/method:\s*["']GET["']/.test(code), "запрос к счёту явно помечен как GET");
eq(API, "https://coinos.io", "адрес провайдера не подменён");

// --- 2. Конвертация ------------------------------------------------------
eq(satsToUsd(1e8, 60000), 60000, "1 BTC по курсу 60000 = $60000");
eq(satsToUsd(21, 64000), 21 / 1e8 * 64000, "21 сат считается без округления в целые");
eq(satsToUsd(21, 0), null, "нулевой курс — не 0 долларов, а «нет значения»");
eq(satsToUsd(21, NaN), null, "нечисловой курс — null");

// --- Заглушка провайдера -------------------------------------------------
const realFetch = globalThis.fetch;
function stub(routes) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    for (const [frag, r] of Object.entries(routes)) {
      if (u.includes(frag)) {
        const body = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
        return { ok: r.status === undefined || r.status < 400, status: r.status ?? 200, text: async () => body };
      }
    }
    throw new Error("маршрут не заглушён: " + u);
  };
}

// --- 3. Обычный случай: реальная форма ответа coinos ---------------------
stub({
  "/api/me": { body: {
    username: "experiment", balance: 21,
    // Провайдер действительно отдаёт это в том же теле. Наружу оно попасть не должно.
    nsec: "ncryptsec1qgg09e0uyhkk5qku4mwvSECRET", pubkey: "7d0c78be3a1b9edc", npub: "npub105x83036rw0dcl",
  } },
  "/api/rate": { body: "64743.99000000" },
  "/api/payments": { body: { payments: [
    { amount: 21, type: "lightning", confirmed: true, created: 1785769925266, payment_hash: "8bcaea6c", memo: "owed for the peer review that broke my metric" },
    { amount: -5, type: "lightning", confirmed: true, created: 1785700000000, memo: "" },
  ] } },
});
let s = await snapshot({ token: "t" });
eq(s.ok, true, "счёт прочитан");
eq(s.balance_sats, 21, "баланс 21 сат");
eq(s.username, "experiment", "имя счёта");
eq(s.incoming_sats, 21, "поступило 21 сат");
eq(s.outgoing_sats, 5, "отправлено 5 сат (модуль отрицательной суммы)");
eq(s.payments.length, 2, "обе операции разобраны");
eq(s.payments[0].direction, "in", "новейшая операция первой и она входящая");
eq(s.payments[1].direction, "out", "отрицательная сумма — исходящая");
ok(Math.abs(s.balance_usd - 21 / 1e8 * 64743.99) < 1e-12, "баланс в долларах посчитан по прочитанному курсу");
eq(s.errors.length, 0, "ошибок нет");
ok(s.payments[0].memo.includes("peer review"), "memo плательщика сохранён дословно");

const dump = JSON.stringify(s);
ok(!/nsec/i.test(dump), "СЕКРЕТ: nsec не попадает в вывод");
ok(!/ncryptsec/i.test(dump), "СЕКРЕТ: тело зашифрованного ключа не попадает в вывод");
ok(!/npub1/i.test(dump), "npub аккаунта не попадает в вывод");
ok(!/7d0c78be/.test(dump), "pubkey аккаунта не попадает в вывод");
ok(!dump.includes('"t"') || !/authorization/i.test(dump), "токен не попадает в вывод");
for (const f of PUBLIC_FIELDS) ok(f in s, `объявленное публичное поле ${f} действительно есть`);

// --- 4. Отсутствие измерения ≠ ноль --------------------------------------
stub({ "/api/me": { status: 401, body: "unauthorized" }, "/api/rate": { body: "64000" }, "/api/payments": { status: 401, body: "no" } });
s = await snapshot({ token: "bad" });
eq(s.ok, false, "неверный токен — не «прочитано»");
eq(s.balance_sats, null, "баланс null, а НЕ 0: иначе сбой доступа выглядит как «денег нет»");
eq(s.balance_usd, null, "в долларах тоже null");
ok(s.errors.some((e) => e.includes("401")), "причина отказа названа кодом провайдера");
ok(s.errors.length >= 2, "оба отказавших запроса названы по отдельности");

s = await snapshot({ token: "" });
eq(s.ok, false, "без токена — не прочитано");
eq(s.balance_sats, null, "без токена баланс null");
ok(s.errors[0].includes("COINOS_TOKEN"), "сказано, чего именно не хватает");

// --- 5. Частичный отказ: баланс есть, курса нет --------------------------
stub({ "/api/me": { body: { username: "experiment", balance: 21 } }, "/api/rate": { status: 500, body: "err" }, "/api/payments": { body: { payments: [] } } });
s = await snapshot({ token: "t" });
eq(s.ok, true, "баланс в сатоши прочитан несмотря на отказ курса");
eq(s.balance_sats, 21, "21 сат");
eq(s.balance_usd, null, "долларов нет — курс не прочитан, а не «ноль долларов»");
ok(s.errors.some((e) => e.startsWith("курс:")), "отказ курса назван отдельной строкой");
eq(s.incoming_sats, 0, "пустая история даёт 0 поступлений");

// --- 6. Мусор в истории не роняет и не искажает счёт ---------------------
stub({
  "/api/me": { body: { username: "experiment", balance: 7 } },
  "/api/rate": { body: "60000" },
  "/api/payments": { body: { payments: [
    { amount: "не число", type: "lightning", created: 1 },
    { amount: 3, created: null, confirmed: false },
    { amount: 4, created: 1785769925266, confirmed: true, memo: 12345 },
  ] } },
});
s = await snapshot({ token: "t" });
eq(s.payments.length, 2, "строка с нечисловой суммой отброшена, остальные сохранены");
eq(s.incoming_sats, 7, "сумма поступлений считается только по разобранным строкам");
eq(s.payments.find((p) => p.amount_sats === 3).confirmed, false, "неподтверждённая операция помечена");
eq(s.payments.find((p) => p.amount_sats === 12345 || p.memo === 12345), undefined, "нестроковый memo не протекает как есть");
eq(s.payments.find((p) => p.amount_sats === 4).memo, "", "нестроковый memo превращается в пустую строку");

globalThis.fetch = realFetch;

console.log(`${fail === 0 ? "✓" : "✗"} coinos: ${pass} ассертов прошло, ${fail} упало`);
process.exit(fail === 0 ? 0 : 1);
