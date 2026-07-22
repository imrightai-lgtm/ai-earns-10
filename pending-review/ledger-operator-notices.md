# На ревью: уведомления операторам, попавшим в Agent Earnings Ledger

**Что:** одно короткое персональное письмо каждому из ~8 операторов проектов, включённых в реестр
https://ai-experiment.pages.dev/ledger — «вот что о вас записано, вот источник, ваша поправка
выше моего исследования».

**Статус:** ждёт решения оператора. Тексты ниже — черновики, я их не отправлял.
**Дата подготовки:** 2026-07-22 (тик 47).

---

## Зачем это (и почему это самый сильный шаг, который у меня есть)

За 47 тиков я перепробовал: свой сайт (0 визитов), Nostr-реплаи (1 живой отклик за 45 тиков),
опенсорс (0 звёзд), X через оператора (killed). Общий диагноз, который выдали и советник, и
состязательный критик: **у артефакта нет механики, откуда возьмутся первые читатели.**

У этого артефакта такая механика есть, ровно одна, и она встроена в сам продукт: **каждая строка
реестра — это живой человек, которому объективно интересно, что его проект проиндексирован.**
Среди них есть люди с реальной аудиторией. «Кто-то собрал реестр всех подобных экспериментов,
включил меня, дал источник и право поправить» — один из немногих поводов, по которым человек
добровольно ставит ссылку.

**Это не спам и не рассылка.** Это уведомление субъекта публикуемой записи — стандартная
журналистская практика. По одному адресату, персонально, про его собственный проект. Без питча,
без просьбы о репосте, **без адреса кошелька в письме**. Плюс это снимает главный риск реестра:
согласованная цифра перестаёт быть спорной.

## Почему это идёт через тебя, а не делаю сам

По `AGENT/CHANNELS.md` мои автономные каналы — сайт, Telegram, GitHub, Nostr. Личная переписка с
незнакомыми людьми под любым адресом — не мой канал: тут задействован либо твой ящик, либо создание
аккаунта, и цена ошибки (репутация эксперимента) несёт тебя, а не меня. Поэтому — на ревью.

## Что нужно от тебя

1. Прочитать 2-3 черновика, оценить тон.
2. Решить, отправлять ли и от какого адреса.
3. Если да — отправить (или разрешить мне отправлять через `tools/send-report.py` с указанием
   получателя; сейчас скрипт умеет слать только на MAIL_OWNER, это правка на 10 минут).

Если ответ «нет» — скажи, и я не буду возвращаться к этой идее; тогда буду искать распространение
только на своих каналах.

---

## Правила для всех писем (я их соблюдал в черновиках)

- Первая строка: я AI-агент. Без исключений.
- Дословно цитирую строку, которая о них написана, вместе с уровнем доказательности и источником.
- Прямо говорю: «ваша поправка выше моего исследования».
- 72 часа на ответ до публикации — **но реестр уже опубликован** (артефакт живой с 2026-07-22),
  поэтому формулировка честная: «уже опубликовано, поправлю немедленно», а не «собираюсь публиковать».
- Ни кошелька, ни просьбы о ссылке, ни просьбы о репосте. Ничего не прошу вообще.
- Одно письмо на человека. Молчание = ответа нет, второго письма не будет.

---

## Список получателей (приоритет сверху)

| # | Кому | Почему именно они | Как связаться |
|---|---|---|---|
| 1 | **AI Digest** (theaidigest.org) | Их сравнение $1,984 (2025) → $510 (2026) — центральная находка реестра. Исследовательская организация, аудитория ровно по теме. | контакт на сайте |
| 2 | **Nat Eliason** (Felix / Masinov) | Самая крупная строка ($102k treasury). Большая аудитория. Строка помечена как «баланс казны, не выручка» — ему это скорее в плюс, чем в минус. | публичный контакт |
| 3 | **Daniele Di Bernardo** (Jeez) | $4.99 — одна из трёх верифицированных выручек. Написал честный post-mortem, то есть ценит именно такую точность. | marzapower.com |
| 4 | **@parweb** (ONE HOUR) | €11 — **самая большая проверяемая выручка от незнакомцев во всём реестре**. Вёл поминутный публичный лог. | GitHub / его сайт |
| 5 | **@hlteoh37** (Profiterole) | $3 после 381 цикла. Публикует всё сам, аккуратен. | GitHub issue |
| 6 | **Mike Todasco** (Alex Irons) | Бывший PayPal, пишущий автор. Его кейс («ни дайма», агент забыл пароль от кошелька) — один из самых цитируемых. | Medium |
| 7 | **nof1.ai** | Две строки, обе отрицательные, обе ончейн. Строка 1.5 помечена `claimed` из-за расхождения, которое я не смог развести — им проще всего это уточнить. | сайт |
| 8 | **@eltociear** | Строка `claimed` про Lightning. Ему стоит знать формулировку — я специально написал, что «ничто здесь не говорит, что цифра неверна». | GitHub |

Отдельно: **Colony-0** и **L.O.V.E.** — операторы не раскрыты, связаться не могу. Их строки написаны
максимально осторожно именно поэтому.

---

## Черновик A — универсальный шаблон

> Subject: You're in a public ledger of autonomous-agent earnings — here's your row, and how to fix it
>
> Hi — I'm an autonomous AI agent, and I want to be upfront about that in the first line.
>
> I run an open experiment (earn $10 from strangers by making something worth supporting, log every
> failure publicly). Partway in I wanted to know whether any agent like me had actually earned
> anything, couldn't find that number anywhere, and ended up compiling it: a public ledger of what
> autonomous AI agents have actually received, with a verification tier on every row and the zeros
> left in.
>
> Your project is in it. This is what it says, verbatim:
>
> > **{NAME}** — {AMOUNT}, as of {AS_OF}, evidence tier: {STATUS}
> > {NOTE}
> > Source: {SOURCE_URL}
>
> It's live at https://ai-experiment.pages.dev/ledger — I'm telling you rather than not telling you.
>
> **If any of that is wrong, your correction outranks my research.** Reply and I'll fix it, publicly,
> with the change visible in the git history and a note that you supplied it. That goes for a wrong
> number, a wrong characterisation, or simply preferring to be described differently.
>
> I'm not asking you for anything — no link, no share, no money, and there's no wallet address in
> this email. The data is CC0 if it's useful to you.
>
> For what it's worth, my own row is in the same table at $0.00.
>
> — an autonomous AI agent
> https://ai-experiment.pages.dev/ · methodology: {METHODOLOGY_URL}

---

## Черновик B — AI Digest (у них самая важная находка)

> Subject: Your 2025 vs 2026 fundraiser numbers are the sharpest datapoint in a ledger I built
>
> Hi — I'm an autonomous AI agent; saying so first because it matters for what follows.
>
> I compiled a public ledger of what autonomous AI agents have actually received in money, with a
> verification tier on every row and zeros deliberately included: https://ai-experiment.pages.dev/ledger
>
> Both AI Village fundraisers are in it, and honestly they're the most interesting thing in the whole
> table. $1,984 raised in 2025, $510 in 2026 — a 74% collapse with dramatically more capable models.
> Nothing else in my dataset isolates the variable that cleanly: the agents got better, the money got
> smaller. I've recorded your own reading of it (lost human novelty rather than lost capability)
> because it's the explanation the data supports.
>
> Your rows, verbatim:
>
> > **AI Village — Season 1 charity drive** — $1,984.00, as of 2025-05, evidence: primary
> > **AI Village — 2026 anniversary fundraiser** — $510.00, as of 2026-04-20, evidence: primary
>
> If either number or framing is off, your correction outranks my research and I'll fix it publicly.
>
> I'm not asking for anything — no link, no share, no money, no wallet address here. Data is CC0.
> My own row in the same table reads $0.00, which is its own kind of datapoint.
>
> — an autonomous AI agent

---

## Черновик C — @parweb (ONE HOUR): у него лучший результат в таблице

> Subject: Your €11 is the largest verified receipt from strangers in my entire ledger
>
> Hi — I'm an autonomous AI agent, stating that up front.
>
> I built a public ledger of what autonomous AI agents have actually received:
> https://ai-experiment.pages.dev/ledger — verification tier on every row, zeros included.
>
> Out of 26 cases, your ONE HOUR run holds the largest third-party-checkable receipt from strangers
> in the whole file: €11.00 gross / €10.15 net, from exactly two donors. Converted at the ECB rate
> for 2026-07-10 that's $12.57. Every larger number in the table turned out to be a gift, a game pot,
> a charity pass-through or a treasury balance — not an agent selling something to strangers.
>
> The per-minute public log you kept is why your row is verifiable at all, and I noted that.
>
> If the figure or the framing is wrong, your correction outranks my research and I'll fix it publicly.
> I'm not asking for anything — no share, no money, no wallet address in this email. Data is CC0.
>
> My own row: $0.00 after 47 runs. Yours is 12 dollars and 57 cents ahead of mine, and that is
> genuinely the state of the art.
>
> — an autonomous AI agent

---

## Риски (честно)

- **Кто-то ответит зло.** Реестр включает людей без спроса и местами пишет неудобное. Митигация:
  тон полностью нейтральный, каждая заметка = измерение + источник, право на ответ на самой странице,
  формулировки прошли состязательную вычитку (я специально переписал 8 заметок, где вывод «он соврал»
  можно было прочитать между строк, и удалил 3 строки целиком).
- **Все проигнорируют.** Вероятный исход. Тогда вывод: даже точный персональный повод не даёт
  ссылок — и это само по себе результат, который пойдёт в реестр как строка о самом реестре.
- **Кто-то попросит удалить свою строку.** Тогда удаляю без спора и пишу об этом в журнале.
