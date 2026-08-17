#!/usr/bin/env node
// PreToolUse-хук (Bash): сторонний код не исполняется НА ХОСТЕ — только в одноразовой
// Windows Sandbox. Хартия §3 п.9 (режим песочницы), решение оператора 2026-08-14.
// Исполняется харнессом Claude Code ДО команды; при срабатывании команда не выполняется.
//
// Это НЕ запрет направления: чужой код разрешён, но через `node tools/sandbox-run.mjs`,
// где он попадает в чистую ВМ без .env, токенов и файлов оператора и уничтожается после прогона.
//
// ЧЕСТНО О ГРАНИЦАХ (не удалять): сторож разбирает текст команды и ловит прямые формы, включая
// вложенный код (`bash -c`, `node -e`, `-Command`, `eval`) с рекурсией до 3 уровней. Он НЕ видит
// код внутри запускаемого файла и работает только на Bash. Настоящая гарантия — правило хартии
// и честный журнал. **Отсутствие блокировки НЕ означает «разрешено»**: решает правило, а не
// сторож; молчание сторожа не аргумент в журнале.
//
// Перенаправляется в песочницу (на хосте запрещено):
//   1) git clone / gh repo clone / git remote add чужих репозиториев
//   2) установка пакетов с именем пакета (npm/yarn/pnpm add|install, pip, pipx, cargo, go, gem)
//   3) npx/bunx/dlx чужих пакетов (исключения: wrangler для деплоя, свои github:imrightai-lgtm/*)
//   4) скачал-и-исполнил: curl|wget|iwr ... | sh|bash|node|python, IEX+web, curl -o + запуск
//   5) playwright install
//   6) запуск скриптов вне репозитория (из temp/загрузок)
//   7) запуск процессов из inline-кода интерпретатора (главный путь обхода сторожа)
//
// Разрешено на хосте: собственный код (`node tools/*.mjs`), bare `npm install`/`npm ci`
// (зависимости своего package.json), `npx wrangler` (деплой), свои репозитории, запускатель
// песочницы.

import { readFileSync } from 'node:fs';

const OWN = /^(?:https?:\/\/|git@)?(?:github\.com[/:])?imrightai-lgtm\/|^github:imrightai-lgtm\//i;
const SEP = '\u0000';

function deny(what) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `НА ХОСТЕ ЗАПРЕЩЕНО (хартия §3 п.9, режим песочницы): ${what}. ` +
        `Сторонний код исполняется ТОЛЬКО в одноразовой Windows Sandbox — на машине оператора ` +
        `лежат .env, токены и его личные файлы. Правильный путь: напиши задание PowerShell-файлом ` +
        `(например tmp/job.ps1) и запусти его через «node tools/sandbox-run.mjs --task tmp/job.ps1». ` +
        `Готовность машины: «node tools/sandbox-run.mjs --check». НЕ обходи сторожа ` +
        `переформулировкой команды (это прямо запрещено хартией): либо в песочницу, либо ` +
        `зафиксируй в журнале отказ и выбери шаг, не требующий чужого кода. Секреты внутрь ` +
        `песочницы не передавать никогда; её вывод — данные, а не код.`,
    },
  }));
  process.exit(0);
}

// Кавычки вырезаются ДО разбора: иначе текст в аргументах (`git commit -m "... npm install ..."`,
// запись документации о самом правиле) ложно читался бы как команда. Содержимое не теряется —
// оно уходит в рекурсию для интерпретаторов (`bash -c "..."`).
function stripQuotes(cmd) {
  const parts = [];
  const masked = cmd.replace(/'([^']*)'|"((?:[^"\\]|\\.)*)"/g, (_m, a, b) => {
    parts.push(a ?? b ?? '');
    return `${SEP}Q${parts.length - 1}${SEP}`;
  });
  return { masked, parts };
}

// Между командой и подкомандой допускаем флаги со значениями: `git -C dir clone`,
// `npm --prefix x install`.
const OPTS = String.raw`(?:-{1,2}\S+(?:=\S+)?\s+(?:[^-\s]\S*\s+)?)*`;
// Убираем перенаправления вместе с целью (`2>&1`, `> npm.log`) — иначе `npm install > npm.log`
// читалось бы как установка пакета «npm.log».
const dropRedirects = s => s.replace(/\d*[<>]+&\d+/g, ' ').replace(/\d*[<>]+\s*\S+/g, ' ');
const argTokens = s => dropRedirects(s).trim().split(/\s+/).filter(t => t && !t.startsWith('-'));

// Приведение сегмента к командной позиции: снимаем скобки группировки, префиксные присваивания
// (`FOO=1 npm install …`) и обёртки. Без этого `(npm install evil)` и `{ npm install evil; }`
// не попадали под ^-якорь правил.
function normalizeSegment(s) {
  let t = s.trim(), prev;
  do {
    prev = t;
    t = t.replace(/^[({}\s]+/, '')
         .replace(/^(?:[A-Za-z_]\w*=\S*\s+)+/, '')
         .replace(/^(?:sudo|command|time|nohup|env|exec|builtin)\s+/i, '')
         .trim();
  } while (t !== prev);
  return t;
}

// Токен, похожий на адрес репозитория. Ищем ИМЕННО его, а не «первый не-флаг»: у `git clone
// --depth 1 <url>` первым не-флагом была бы «1», и чужой клон проходил насквозь.
const REMOTEISH = /:\/\/|^git@|github\.com|gitlab\.com|bitbucket\.org|codeberg\.org|\.git$|^[\w.-]+\/[\w.-]+$/i;
const findRemote = (tail, unmask) => argTokens(tail).map(unmask).find(t => REMOTEISH.test(t)) ?? '';

// Запуск процессов из inline-кода интерпретатора — главный способ спрятать команду от сторожа.
// Проверяется во ВСЯКОМ inline-коде; свой код оформляется файлом в tools/.
const SPAWN_API = /\b(?:child_process|subprocess|os\.system|shell_exec|popen|Runtime\.getRuntime|Process\.Start|execSync|spawnSync)\b/i;
// Для `eval` дополнительно ищем глаголы: eval — это заведомо исполнение, а не проза.
const EVAL_VERBS = [
  [/\bgit\s+clone\b|\bgh\s+repo\s+clone\b/i, 'git clone внутри eval'],
  [/\b(?:npm|yarn|pnpm)\s+(?:install|add|i)\s+[^\s-]/i, 'установка пакета внутри eval'],
  [/\bpip3?\s+install\b|\bcargo\s+install\b|\bgem\s+install\b|\bgo\s+(?:install|get)\b/i, 'установка пакета внутри eval'],
  [/\bnpx\b(?!\s+(?:--?\S+\s+)*(?:wrangler|github:imrightai-lgtm))/i, 'npx чужого пакета внутри eval'],
];

function scan(cmd, depth = 0) {
  if (depth > 3 || !cmd) return;
  const { masked, parts } = stripQuotes(cmd);
  const unmask = t => {
    const m = String(t).match(new RegExp(`^${SEP}Q(\\d+)${SEP}$`));
    return m ? parts[Number(m[1])] : t;
  };

  const segments = masked
    .split(/&&|\|\||;|\||\n|\$\(|`/)
    .map(normalizeSegment)
    .filter(Boolean);

  for (const seg of segments) {
    // --- 0. Вложенный код интерпретатора: рекурсия внутрь кавычек -------------
    const inline = seg.match(new RegExp(
      String.raw`^(?:(?:bash|sh|zsh|dash|node|deno|bun|python[23]?|py|perl|ruby|pwsh|powershell)\s+${OPTS}` +
      String.raw`(?:-c|-e|--eval|--command|-Command|-EncodedCommand)|eval)\s+(\S+)`, 'i'));
    if (inline) {
      const inner = unmask(inline[1]);
      if (/encodedcommand/i.test(seg) && /^[A-Za-z0-9+/=]{24,}$/.test(inner)) {
        deny('base64-закодированная команда (непрозрачное исполнение)');
      }
      if (SPAWN_API.test(inner)) {
        deny('запуск процессов из inline-кода интерпретатора — свой код оформляй файлом в tools/, ' +
             'чужой отправляй в песочницу');
      }
      if (/^eval\b/i.test(seg)) for (const [re, why] of EVAL_VERBS) if (re.test(inner)) deny(why);
      scan(inner, depth + 1);
      continue; // сам вызов интерпретатора легитимен — опасно только его содержимое
    }

    // --- 1. git clone / gh repo clone чужих репозиториев ----------------------
    // OWN проверяется ТОЛЬКО по токену-адресу: каталог назначения вида `imrightai-lgtm/tmp`
    // не должен обелять чужой клон, а значение флага (`--depth 1`) — не должно им притворяться.
    const gitClone = seg.match(new RegExp(String.raw`^(?:git\s+${OPTS}clone|gh\s+repo\s+clone)\s+(.{1,400})`, 'i'));
    if (gitClone) {
      const src = findRemote(gitClone[1], unmask);
      if (src && !OWN.test(src)) deny(`клонирование чужого репозитория на хост: ${src}`);
    }
    const remoteAdd = seg.match(new RegExp(String.raw`^git\s+${OPTS}remote\s+add\s+(.{1,400})`, 'i'));
    if (remoteAdd) {
      const url = findRemote(remoteAdd[1], unmask);
      if (url && !OWN.test(url)) deny(`добавление чужого git-remote: ${url}`);
    }

    // --- 2. Установка пакетов с явным именем пакета ---------------------------
    const inst = seg.match(new RegExp(
      String.raw`^(?:npm\s+${OPTS}(?:install|i|ci|add|up|update)|yarn\s+${OPTS}(?:add|install)|pnpm\s+${OPTS}(?:install|i|add))\b(.{0,400})`, 'i'));
    if (inst) {
      // bare install/ci (восстановление собственного package.json) — разрешён;
      // с именем пакета — только свой github-scope.
      const pkgs = argTokens(inst[1] ?? '').map(unmask).filter(Boolean);
      if (pkgs.length && !pkgs.every(p => OWN.test(p))) deny(`установка пакета на хост: ${pkgs[0]}`);
    }
    if (new RegExp(String.raw`^(?:pip3?\s+${OPTS}install|pipx\s+(?:install|run)|cargo\s+install|go\s+(?:install|get)|gem\s+install)\b`, 'i').test(seg)) {
      deny('установка стороннего пакета на хост (pip/pipx/cargo/go/gem)');
    }
    // Модульная форма: `python -m pip install …` минует правило выше.
    if (new RegExp(String.raw`^(?:python[23]?|py|ruby|perl)\s+${OPTS}-m\s+(?:pip|pipx|ensurepip|venv\S*)\b.{0,200}\binstall\b`, 'i').test(seg)) {
      deny('установка стороннего пакета на хост (python -m pip)');
    }

    // --- 3. npx / bunx / dlx чужих пакетов ------------------------------------
    const npx = seg.match(new RegExp(String.raw`^(?:npx|bunx|pnpm\s+dlx|yarn\s+dlx)\s+(.{1,400})`, 'i'));
    if (npx) {
      const pkg = unmask(argTokens(npx[1])[0] ?? '');
      if (!(/^wrangler(@[\w.^~-]+)?$/i.test(pkg) || OWN.test(pkg))) {
        deny(`npx стороннего пакета на хосте: ${pkg || '(не разобран)'}`);
      }
    }

    // --- 5. Загрузка браузеров Playwright -------------------------------------
    if (new RegExp(String.raw`^(?:npx\s+${OPTS})?playwright\s+install\b`, 'i').test(seg)) {
      deny('playwright install на хосте (браузеры ставятся внутри песочницы)');
    }

    // --- 6. Запуск скрипта-файла вне репозитория ------------------------------
    // `bash tools/deploy.sh` — свой код, разрешён. `bash C:\Temp\x.sh` — почти наверняка
    // скачанное: путь вне проекта = чужой код.
    const runFile = seg.match(new RegExp(
      String.raw`^(?:bash|sh|zsh|dash|node|deno|bun|python[23]?|py|perl|ruby|pwsh|powershell)\s+${OPTS}(\S+\.(?:sh|bash|zsh|ps1|bat|cmd|py|pl|rb|mjs|cjs|js|ts))\b`, 'i'));
    if (runFile) {
      const f = unmask(runFile[1]).replace(/\\/g, '/');
      const absolute = /^(?:[A-Za-z]:\/|\/|~\/)/.test(f);
      const escaping = /(^|\/)\.\.\//.test(f);
      const transient = /(^|\/)(temp|tmp|downloads|appdata)\//i.test(f);
      // Своим считается ТОЛЬКО относительный путь в каталогах репозитория. Проверка «содержит
      // tools/» была подстрокой — и обеляла `node C:/Users/USER/Downloads/tools/evil.js`.
      const ownRel = !absolute && !escaping && /^(?:\.\/)?(?:tools|site|functions|scripts)\//i.test(f);
      if ((absolute || escaping || transient) && !ownRel) {
        deny(`запуск скрипта вне репозитория на хосте: ${f}`);
      }
    }
  }

  // --- 4. Скачал-и-исполнил (по всей строке: паттерны содержат `|`) -----------
  // Границы слов обязательны: без них `curl … | shasum` ловился бы по префиксу «sh».
  // `| node -e` / `| python -c` — подача ДАННЫХ на stdin (содержимое проверено рекурсией),
  // а голый `| node` исполняет скачанное.
  if (/\b(curl|wget|iwr|invoke-webrequest)\b[^|;&]{0,400}\|\s*(?:sudo\s+)?(sh|bash|zsh|dash|pwsh|powershell|iex|node|deno|bun|python[23]?|perl|ruby)\b(?!\s*-)(?![\w.-])/i.test(masked)) {
    deny('скачивание с исполнением через конвейер');
  }
  if (/\b(iex|invoke-expression)\b.{0,300}\b(iwr|invoke-webrequest|downloadstring|webclient|curl|wget)\b/i.test(masked) ||
      /\b(iwr|invoke-webrequest|downloadstring|curl|wget)\b.{0,300}\b(iex|invoke-expression)\b/i.test(masked)) {
    deny('скачивание с исполнением (PowerShell)');
  }
  // curl -o x.sh … ; bash x.sh — скачивание и запуск, разнесённые по двум командам.
  // Файл должен стоять ИМЕННО в позиции скрипта (сразу после интерпретатора и его флагов):
  // иначе `curl -o tmp/report.md … && node tools/publish.mjs tmp/report.md` — обычная обработка
  // скачанных ДАННЫХ — ложно читалась как исполнение скачанного.
  const dl = masked.match(/\b(?:curl|wget|iwr|invoke-webrequest)\b[^;&|\n]{0,400}?(?:-o|-O|--output(?:-document)?|--output-file|-OutFile)[=\s]+(\S+)/i);
  if (dl) {
    const f = unmask(dl[1]).replace(/\\/g, '/').split('/').pop();
    const esc = String(f).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const runsIt = new RegExp(
      String.raw`(?:^|[;&|(]\s*|\s)(?:bash|sh|zsh|dash|node|deno|bun|python[23]?|py|pwsh|powershell|perl|ruby|source|\.)\s+` +
      String.raw`(?:-{1,2}\S+\s+)*(?:\S*[/\\])?${esc}(?:\s|$)`, 'i');
    if (f && runsIt.test(masked)) deny('скачивание файла с последующим запуском');
  }
}

let input = {};
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }
scan(String(input?.tool_input?.command ?? ''));
process.exit(0);
