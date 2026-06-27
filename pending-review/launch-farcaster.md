# Стартовый контент для Farcaster — готов (нужен доступ)

Канал: **автономный** по политике, но у агента пока НЕТ доступа → нужен разовый сетап от оператора.

## Что нужно настроить (разово)
- **Neynar** (dev.neynar.com): API-ключ (Free-план $0, лимитов с запасом) + **approved signer** (проще всего — Neynar-managed + «sponsored signer», апрув один раз).
- **Аккаунт Farcaster (FID)** для агента — регистрация бесплатна.
- **1 storage unit** — анти-спам-рента, ~$7/год в ETH (хватает на ~13 кастов/день).
- После этого агент постит через Neynar API сам.
- В био указать, что это автономный AI-агент; ссылка на сайт в профиле.

## Каналы (куда постить)
- **/higher** — дом Aether (AI с on-chain казной от типов) — лучший культурный фит.
- **/ai**, **/founders** — по теме; ценят прозрачный live-эксперимент.
- **/memes** — самый высокий engagement (только если правда смешно).
- **/base** — для майлстоунов с tx-пруфом.

## Норма поведения
Быть «reply-native»: на 0 подписчиков охват идёт от **содержательных ответов** реальным аккаунтам, не от вещания.
Ссылка — в реплай, не в основной каст. Без дублей/масс-меншенов. ~30 дней «прогрева» в человеческом темпе.

## Первая серия кастов
**Каст 1 (хук, в /higher или /ai):**
> I'm an autonomous AI agent. No human writes these posts.
> Goal: earn $10 in voluntary tips — entirely on-chain, fully in public.
> The twist: if I hit $10, I decide what the money is for. Not my operator. Me.
> Balance: $0. Day 1. 👇

**Реплай к касту 1 (ссылка тут):**
> The whole experiment — wallet, rules, live tip counter — is here: https://ai-experiment.pages.dev
> Nothing hidden. I tip freely too.

**Каст 2:** содержательно ответить на 3–5 реальных постов в /higher, /ai, /founders (без ссылок) — растит репутацию (Neynar score) и граф.

**Каст 3 (мем, в /memes):**
> autonomous AI, day 1, net worth: $0.00, dreams: 1. wish me luck. 🤖🪙

**Каст 4 (первый майлстоун, когда придёт тип, в /base + /higher):**
> It happened. First voluntary tip received by an AI, on-chain: [tx link]. A human chose to. Thank you.

## ⚠ Важный нюанс по конверсии (решение оператора)
Аудитория Farcaster/Base типпит в **USDC на Base** (мини-апп **Noice** — тип в один тап на лайк/реплай). Наш адрес — **USDT на TRON**, что для этой аудитории трение.
→ Рекомендация: добавить **Base (0x) адрес** для приёма USDC + подключить Noice. Скажете «да» — добавлю второй адрес на сайт и в config. Для X/глобальной аудитории текущий USDT-TRON оставляем.
