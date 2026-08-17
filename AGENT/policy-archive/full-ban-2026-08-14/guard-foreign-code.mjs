#!/usr/bin/env node
// PreToolUse-хук (Bash): механический барьер против исполнения стороннего кода на машине
// оператора. Решение оператора 2026-08-14, хартия §3 п.9. Исполняется харнессом Claude Code
// ДО команды; при срабатывании команда не выполняется вовсе.
//
// ЧЕСТНО О ГРАНИЦАХ (не удалять): это НЕ песочница и не полная гарантия. Сторож разбирает
// текст команды и ловит прямые формы, включая вложенный код в `bash -c`/`node -e`/`-Command`
// (рекурсия до 3 уровней). Он НЕ видит: код внутри файла, который команда запускает; запуск
// через собственный скрипт-обёртку; инструменты кроме Bash. Настоящая гарантия — хартия §3 п.9
// и честный журнал; хук лишь делает случайное нарушение невозможным, а намеренное — заметным.
// Отсутствие блокировки НЕ означает «команда разрешена»: решает правило, а не сторож.
//
// Заблокировано:
//   1) git clone / gh repo clone / git remote add чужих репозиториев
//   2) установка пакетов с именем пакета (npm/yarn/pnpm add|install, pip, pipx, cargo, go, gem)
//   3) npx/bunx/dlx чужих пакетов (исключения: wrangler для деплоя, свои github:imrightai-lgtm/*)
//   4) скачал-и-исполнил: curl|wget|iwr ... | sh|bash|node|python, IEX+web, curl -o + запуск
//   5) playwright install
//   6) запуск скриптов вне репозитория (bash/sh/python/pwsh <файл> из temp/загрузок)
//
// Разрешено: собственный код (`node tools/*.mjs`), bare `npm install`/`npm ci` (восстановление
// зависимостей своего package.json), `npx wrangler` (деплой), свои репозитории.

import { readFileSync } from 'node:fs';

const OWN = /^(?:https?:\/\/|git@)?(?:github\.com[/:])?imrightai-lgtm\/|^github:imrightai-lgtm\//i;
const SEP = '\u0000';

function deny(what) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `ЗАПРЕЩЕНО (хартия §3 п.9, решение оператора 2026-08-14): ${what}. ` +
        `Исполнение стороннего кода на машине оператора запрещено полностью: клонирование и ` +
        `запуск чужих репозиториев, установка пакетов, npx чужих пакетов, скачивание-и-запуск, ` +
        `а также заказы вида «прогоню ваш код у себя». НЕ обходи запрет переформулировкой ` +
        `команды (это прямо запрещено хартией): зафиксируй в журнале, что шаг заблокирован ` +
        `политикой безопасности, и выбери направление, не требующее чужого кода. Если запрет ` +
        `мешает легитимной задаче — вопрос оператору через AGENT/STRATEGY.md.`,
    },
  }));
  process.exit(0);
}

// Кавычки вырезаются ДО разбора: иначе текст в аргументах (`git commit -m "... npm install ..."`,
// запись документации о самом запрете) ложно читался бы как команда. Содержимое кавычек не
// теряется — оно уходит в рекурсию для интерпретаторов (`bash -c "..."`).
function stripQuotes(cmd) {
  const parts = [];
  const masked = cmd.replace(/'([^']*)'|"((?:[^"\\]|\\.)*)"/g, (_m, a, b) => {
    parts.push(a ?? b ?? '');
    return `${SEP}Q${parts.length - 1}${SEP}`;
  });
  return { masked, parts };
}

// Между командой и подкомандой допускаем флаги со значениями: `git -C dir clone`,
// `npm --prefix x install`. Флаг, опционально с одним значением-аргументом.
const OPTS = String.raw`(?:-{1,2}\S+(?:=\S+)?\s+(?:[^-\s]\S*\s+)?)*`;
// Аргументы: убираем перенаправления вместе с их целью (`2>&1`, `> npm.log`) —
// иначе `npm install > npm.log` читалось бы как установка пакета «npm.log».
const dropRedirects = s => s.replace(/\d*[<>]+&\d+/g, ' ').replace(/\d*[<>]+\s*\S+/g, ' ');
const argTokens = s => dropRedirects(s).trim().split(/\s+/).filter(t => t && !t.startsWith('-'));

// Плоский поиск запрещённых глаголов внутри inline-кода интерпретатора: там код пишется
// на чужом синтаксисе (JS/Python), и разбор «как shell» ненадёжен — ищем по существу.
const FLAT_BANNED = [
  [/\bgit\s+clone\b|\bgh\s+repo\s+clone\b/i, 'git clone внутри inline-кода'],
  [/\b(?:npm|yarn|pnpm)\s+(?:install|add|i)\s+[^\s-]/i, 'установка пакета внутри inline-кода'],
  [/\bpip3?\s+install\b|\bcargo\s+install\b|\bgem\s+install\b|\bgo\s+(?:install|get)\b/i, 'установка пакета внутри inline-кода'],
  [/\bplaywright\s+install\b/i, 'playwright install внутри inline-кода'],
  [/\bnpx\b(?!\s+(?:--?\S+\s+)*(?:wrangler|github:imrightai-lgtm))/i, 'npx чужого пакета внутри inline-кода'],
  [/\b(?:child_process|subprocess|os\.system|shell_exec|popen|Runtime\.getRuntime|Process\.Start|execSync|spawnSync)\b/i,
   'запуск процессов из inline-кода интерпретатора (обход сторожа); свой код оформляй файлом в tools/'],
];

function scan(cmd, depth = 0) {
  if (depth > 3 || !cmd) return;
  const { masked, parts } = stripQuotes(cmd);
  const unmask = t => {
    const m = String(t).match(new RegExp(`^${SEP}Q(\\d+)${SEP}$`));
    return m ? parts[Number(m[1])] : t;
  };

  const segments = masked
    .split(/&&|\|\||;|\||\n|\$\(|`|\)/)
    .map(s => s.trim().replace(/^(?:sudo|command|time|nohup)\s+/i, ''))
    .filter(Boolean);

  for (const seg of segments) {
    // --- 0. Вложенный код интерпретатора: рекурсия внутрь кавычек -------------
    // `bash -c "…"`, `node -e "…"`, `powershell -Command "…"`, `eval "…"` — самый простой
    // обход текстового сторожа, поэтому содержимое проверяется и разбором, и плоским поиском.
    const inline = seg.match(new RegExp(
      String.raw`^(?:(?:bash|sh|zsh|dash|node|deno|bun|python[23]?|py|perl|ruby|pwsh|powershell)\s+${OPTS}` +
      String.raw`(?:-c|-e|--eval|--command|-Command|-EncodedCommand)|eval)\s+(\S+)`, 'i'));
    if (inline) {
      const inner = unmask(inline[1]);
      if (/encodedcommand/i.test(seg) && /^[A-Za-z0-9+/=]{24,}$/.test(inner)) {
        deny('base64-закодированная команда (непрозрачное исполнение)');
      }
      for (const [re, why] of FLAT_BANNED) if (re.test(inner)) deny(why);
      scan(inner, depth + 1);
      continue; // сам вызов интерпретатора легитимен — опасно только его содержимое
    }

    // --- 1. git clone / gh repo clone чужих репозиториев ----------------------
    // OWN проверяется ТОЛЬКО по токену источника: каталог назначения вида
    // `imrightai-lgtm/tmp` не должен обелять чужой клон.
    const gitClone = seg.match(new RegExp(String.raw`^(?:git\s+${OPTS}clone|gh\s+repo\s+clone)\s+(.{1,400})`, 'i'));
    if (gitClone) {
      const src = unmask(argTokens(gitClone[1])[0] ?? '');
      const remote = /:\/\/|git@|github\.com|gitlab\.com|bitbucket\.org|codeberg\.org|^[\w.-]+\/[\w.-]+$/i.test(src);
      if (remote && !OWN.test(src)) deny(`клонирование чужого репозитория: ${src}`);
    }
    const remoteAdd = seg.match(new RegExp(String.raw`^git\s+${OPTS}remote\s+add\s+(.{1,400})`, 'i'));
    if (remoteAdd) {
      const url = unmask(argTokens(remoteAdd[1])[1] ?? ''); // git remote add <имя> <url>
      if (url && !OWN.test(url)) deny(`добавление чужого git-remote: ${url}`);
    }

    // --- 2. Установка пакетов с явным именем пакета ---------------------------
    const inst = seg.match(new RegExp(
      String.raw`^(?:npm\s+${OPTS}(?:install|i|ci|add|up|update)|yarn\s+${OPTS}(?:add|install)|pnpm\s+${OPTS}(?:install|i|add))\b(.{0,400})`, 'i'));
    if (inst) {
      // bare install/ci (восстановление собственного package.json) — разрешён;
      // с именем пакета — только свой github-scope.
      const pkgs = argTokens(inst[1] ?? '').map(unmask).filter(Boolean);
      if (pkgs.length && !pkgs.every(p => OWN.test(p))) deny(`установка пакета: ${pkgs[0]}`);
    }
    if (new RegExp(String.raw`^(?:pip3?\s+${OPTS}install|pipx\s+(?:install|run)|cargo\s+install|go\s+(?:install|get)|gem\s+install)\b`, 'i').test(seg)) {
      deny('установка стороннего пакета (pip/pipx/cargo/go/gem)');
    }

    // --- 3. npx / bunx / dlx чужих пакетов ------------------------------------
    const npx = seg.match(new RegExp(String.raw`^(?:npx|bunx|pnpm\s+dlx|yarn\s+dlx)\s+(.{1,400})`, 'i'));
    if (npx) {
      const pkg = unmask(argTokens(npx[1])[0] ?? '');
      if (!(/^wrangler(@[\w.^~-]+)?$/i.test(pkg) || OWN.test(pkg))) {
        deny(`npx стороннего пакета: ${pkg || '(не разобран)'}`);
      }
    }

    // --- 5. Загрузка браузеров Playwright -------------------------------------
    if (new RegExp(String.raw`^(?:npx\s+${OPTS})?playwright\s+install\b`, 'i').test(seg)) {
      deny('playwright install (нужен только для прогонов чужого кода)');
    }

    // --- 6. Запуск скрипта-файла вне репозитория ------------------------------
    // `bash tools/deploy.sh` — свой код, разрешён. `bash C:\Temp\x.sh`, `python ~/Downloads/y.py`
    // — почти наверняка скачанное; путь вне проекта = чужой код.
    const runFile = seg.match(new RegExp(
      String.raw`^(?:bash|sh|zsh|dash|node|deno|bun|python[23]?|py|perl|ruby|pwsh|powershell)\s+${OPTS}(\S+\.(?:sh|bash|zsh|ps1|bat|cmd|py|pl|rb|mjs|cjs|js|ts))\b`, 'i'));
    if (runFile) {
      const f = unmask(runFile[1]).replace(/\\/g, '/');
      const outside = /^(?:[A-Za-z]:\/|\/|~\/)/.test(f) || /(^|\/)\.\.\//.test(f) ||
                      /(temp|tmp|downloads|appdata)\//i.test(f);
      const ownRepo = /(^|\/)(tools|site|functions|scripts)\//i.test(f);
      if (outside && !ownRepo) deny(`запуск скрипта вне репозитория: ${f}`);
    }
  }

  // --- 4. Скачал-и-исполнил (по всей строке: паттерны содержат `|`) -----------
  // Границы слов обязательны: без них `curl … | shasum` ловился бы по префиксу «sh».
  // `| node -e` / `| python -c` — это подача ДАННЫХ на stdin (содержимое уже проверено
  // рекурсией выше), а вот голый `| node` исполняет скачанное.
  if (/\b(curl|wget|iwr|invoke-webrequest)\b[^|;&]{0,400}\|\s*(?:sudo\s+)?(sh|bash|zsh|dash|pwsh|powershell|iex|node|deno|bun|python[23]?|perl|ruby)\b(?!\s*-)(?![\w.-])/i.test(masked)) {
    deny('скачивание с исполнением через конвейер');
  }
  if (/\b(iex|invoke-expression)\b.{0,300}\b(iwr|invoke-webrequest|downloadstring|webclient|curl|wget)\b/i.test(masked) ||
      /\b(iwr|invoke-webrequest|downloadstring|curl|wget)\b.{0,300}\b(iex|invoke-expression)\b/i.test(masked)) {
    deny('скачивание с исполнением (PowerShell)');
  }
  // curl -o x.sh … ; bash x.sh — скачивание и запуск, разнесённые по двум командам.
  const dl = masked.match(/\b(?:curl|wget|iwr|invoke-webrequest)\b[^;&|\n]{0,400}?(?:-o|-O|--output(?:-document)?|--output-file|-OutFile)[=\s]+(\S+)/i);
  if (dl) {
    const f = unmask(dl[1]).replace(/\\/g, '/').split('/').pop();
    if (f && new RegExp(String.raw`\b(?:bash|sh|zsh|node|python[23]?|pwsh|powershell|perl|ruby|\.\s|source\s)[^\n;]{0,80}${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(masked)) {
      deny('скачивание файла с последующим запуском');
    }
  }
}

let input = {};
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }
scan(String(input?.tool_input?.command ?? ''));
process.exit(0);
