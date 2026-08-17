#!/usr/bin/env node
// Запуск чужого кода в одноразовой Windows Sandbox. Единственный разрешённый способ исполнять
// сторонний код (хартия §3 п.9, режим песочницы, решение оператора 2026-08-14).
//
// Что даёт песочница: чистая копия Windows в отдельной виртуальной машине (гипервизор), в ней
// НЕТ .env, токенов, файлов оператора, Яндекс.Диска, браузерных профилей и ключей. При закрытии
// уничтожается целиком вместе со всем, что там произошло.
//
// Использование:
//   node tools/sandbox-run.mjs --check                    проверить готовность машины
//   node tools/sandbox-run.mjs --task tmp/job.ps1         прогнать задание
//   node tools/sandbox-run.mjs --task tmp/job.ps1 --dry-run     собрать задание, не запуская
//   Опции: --timeout 900 (сек) | --no-network | --in <папка> | --keep | --memory 4096
//
// Задание — обычный PowerShell-скрипт. Внутри песочницы он лежит в C:\job\in\task.ps1,
// рабочий каталог C:\job\work, результаты пишутся в C:\job\out (виден на хосте).
// Node внутри песочницы: если есть кэш tools/sandbox-cache/node.zip — берётся оттуда,
// иначе (при включённой сети) скачивается с nodejs.org внутри песочницы.
//
// ЖЁСТКИЕ ПРАВИЛА, которые обеспечивает этот скрипт (не ослаблять):
//   1. В песочницу монтируется ТОЛЬКО каталог задания во временной папке — никогда репозиторий,
//      никогда домашний каталог, никогда диск целиком.
//   2. Каталог задания проверяется на секреты (.env, ключи, токены) — при находке запуск
//      отменяется.
//   3. Результаты из песочницы — ДАННЫЕ, а не код: читай их, но никогда не исполняй на хосте.

import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX_EXE = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsSandbox.exe');
const SECRET_RE = /(^\.env$|\.env\.|(^|[._-])(secret|secrets|token|credential|password)s?([._-]|$)|\.pem$|\.ppk$|\.pfx$|\.p12$|(^|\/)id_(rsa|ed25519|ecdsa)$|\.kdbx$|seed|mnemonic)/i;

const SETUP = `
Windows Sandbox не установлена (нет ${SANDBOX_EXE}).

Включить (нужны права администратора, потребуется перезагрузка) — в PowerShell «от имени
администратора» выполнить ОДНУ команду:

    Enable-WindowsOptionalFeature -Online -FeatureName "Containers-DisposableClientVM" -All

затем перезагрузить машину и повторить проверку:  node tools/sandbox-run.mjs --check

Это действие оператора: агент не может его выполнить (нужно повышение прав). Пока песочница
не включена, чужой код НЕ исполняется вообще — ни в песочнице, ни на хосте (хартия §3 п.9).
`.trim();

function die(msg, code = 1) { console.error(msg); process.exit(code); }

// Числа проверяем строго: `--timeout 10m` давал NaN, цикл ожидания не выполнялся ни разу,
// песочница убивалась мгновенно, а прогон объявлялся таймаутом.
function num(value, name, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    die(`--${name}: нужно целое число от ${min} до ${max}, получено «${value ?? '(пусто)'}»`, 2);
  }
  return n;
}

function str(value, name) {
  if (!value || value.startsWith('--')) die(`--${name}: нужен аргумент, получено «${value ?? '(пусто)'}»`, 2);
  return value;
}

function parseArgs(argv) {
  const a = { timeout: 900, memory: 4096, network: true };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--check') a.check = true;
    else if (k === '--dry-run') a.dryRun = true;
    else if (k === '--no-network') a.network = false;
    else if (k === '--keep') a.keep = true;
    else if (k === '--task') a.task = str(argv[++i], 'task');
    else if (k === '--in') a.in = str(argv[++i], 'in');
    else if (k === '--name') a.name = str(argv[++i], 'name');
    else if (k === '--timeout') a.timeout = num(argv[++i], 'timeout', 30, 21600);
    else if (k === '--memory') a.memory = num(argv[++i], 'memory', 1024, 16384);
    else die(`Неизвестный аргумент: ${k}`, 2);
  }
  return a;
}

// PID-ы клиентов песочницы: закрывать нужно ТОЛЬКО свой прогон, иначе `taskkill /IM` убьёт
// и ту песочницу, которую оператор открыл сам для своих задач.
function sandboxClientPids() {
  const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq WindowsSandboxClient.exe', '/FO', 'CSV', '/NH'],
                      { encoding: 'utf8' });
  const pids = new Set();
  for (const line of (r.stdout ?? '').split(/\r?\n/)) {
    const m = line.match(/^"[^"]*","(\d+)"/);
    if (m) pids.add(m[1]);
  }
  return pids;
}

function sandboxAvailable() { return existsSync(SANDBOX_EXE); }

// Секреты не должны попасть в песочницу: она изолирует хост от чужого кода, а не наоборот.
function assertNoSecrets(dir) {
  const bad = [];
  const walk = (d, rel = '') => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (SECRET_RE.test(e.name)) bad.push(r);
      if (e.isDirectory()) walk(path.join(d, e.name), r);
    }
  };
  if (existsSync(dir)) walk(dir);
  if (bad.length) {
    die(`ОТКАЗ: в задании найдены файлы, похожие на секреты — в песочницу они не поедут:\n  ` +
        bad.join('\n  ') + `\nУбери их из каталога задания и повтори.`, 2);
  }
}

function assertMappable(hostFolder) {
  const p = path.resolve(hostFolder);
  const forbidden = [REPO, os.homedir(), path.parse(p).root];
  for (const f of forbidden) {
    if (p === path.resolve(f) || path.resolve(f).startsWith(p + path.sep)) {
      die(`ОТКАЗ: в песочницу нельзя монтировать ${p} — он содержит репозиторий или домашний ` +
          `каталог. Задание должно жить во временной папке (её создаёт этот скрипт).`, 2);
    }
  }
  if (!p.startsWith(path.resolve(os.tmpdir()) + path.sep)) {
    die(`ОТКАЗ: каталог задания должен быть внутри ${os.tmpdir()}, а не ${p}.`, 2);
  }
}

const ENTRY = String.raw`
$ErrorActionPreference = 'Continue'
$out = 'C:\job\out'
New-Item -ItemType Directory -Force -Path $out, 'C:\job\work' | Out-Null

# Node внутри песочницы: из кэша задания либо скачиванием (если разрешена сеть).
$nodeDir = 'C:\job\in\_node'
if (-not (Test-Path "$nodeDir\node.exe")) {
  $zip = 'C:\job\in\_node.zip'
  if (-not (Test-Path $zip)) {
    try {
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      Invoke-WebRequest -UseBasicParsing -Uri 'https://nodejs.org/dist/v22.11.0/node-v22.11.0-win-x64.zip' -OutFile $zip
    } catch { "Node не скачан: $_" | Out-File -Append "$out\bootstrap.log" }
  }
  if (Test-Path $zip) {
    try {
      Expand-Archive -Path $zip -DestinationPath 'C:\job\in\_nodetmp' -Force
      $inner = Get-ChildItem 'C:\job\in\_nodetmp' -Directory | Select-Object -First 1
      if ($inner) { Move-Item $inner.FullName $nodeDir -Force }
    } catch { "Node не распакован: $_" | Out-File -Append "$out\bootstrap.log" }
  }
}
if (Test-Path "$nodeDir\node.exe") { $env:Path = "$nodeDir;$env:Path" }

Set-Location 'C:\job\work'
$sw = [Diagnostics.Stopwatch]::StartNew()
& powershell.exe -ExecutionPolicy Bypass -NoProfile -File 'C:\job\in\task.ps1' *>&1 |
  Tee-Object -FilePath "$out\output.txt"
$code = $LASTEXITCODE
if ($null -eq $code) { $code = 0 }
$sw.Stop()

@{ exit_code = $code; seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1) } |
  ConvertTo-Json | Out-File -Encoding utf8 "$out\result.json"
'DONE' | Out-File -Encoding ascii "$out\DONE"
`.trim();

function wsbConfig({ hostFolder, network, memory }) {
  return `<Configuration>
  <VGpu>Disable</VGpu>
  <Networking>${network ? 'Default' : 'Disable'}</Networking>
  <ProtectedClient>Enable</ProtectedClient>
  <ClipboardRedirection>Disable</ClipboardRedirection>
  <PrinterRedirection>Disable</PrinterRedirection>
  <AudioInput>Disable</AudioInput>
  <VideoInput>Disable</VideoInput>
  <MemoryInMB>${memory}</MemoryInMB>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>${hostFolder}</HostFolder>
      <SandboxFolder>C:\\job</SandboxFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>
  </MappedFolders>
  <LogonCommand>
    <Command>powershell.exe -ExecutionPolicy Bypass -NoProfile -File C:\\job\\in\\entry.ps1</Command>
  </LogonCommand>
</Configuration>
`;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const a = parseArgs(process.argv.slice(2));

  if (a.check) {
    if (!sandboxAvailable()) die(SETUP, 3);
    console.log(`✓ Windows Sandbox готова: ${SANDBOX_EXE}`);
    console.log(`✓ Каталог заданий: ${path.join(os.tmpdir(), 'ai-sandbox')}`);
    const cache = path.join(REPO, 'tools', 'sandbox-cache', 'node.zip');
    console.log(existsSync(cache)
      ? `✓ Кэш Node: ${cache} (скачивание внутри песочницы не потребуется)`
      : `· Кэша Node нет (${cache}) — при включённой сети он скачается внутри песочницы`);
    return;
  }

  if (!a.task) die('Укажи задание: --task <файл.ps1>  (или --check для проверки готовности)');
  const taskPath = path.resolve(a.task);
  if (!existsSync(taskPath)) die(`Файл задания не найден: ${taskPath}`);
  if (!sandboxAvailable() && !a.dryRun) die(SETUP, 3);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jobName = `${a.name ? a.name.replace(/[^\w.-]/g, '_') + '-' : ''}${stamp}`;
  const jobDir = path.join(os.tmpdir(), 'ai-sandbox', jobName);
  const inDir = path.join(jobDir, 'in');
  const outDir = path.join(jobDir, 'out');
  assertMappable(jobDir);
  mkdirSync(inDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  mkdirSync(path.join(jobDir, 'work'), { recursive: true });

  copyFileSync(taskPath, path.join(inDir, 'task.ps1'));
  if (a.in) {
    assertNoSecrets(path.resolve(a.in));
    cpSync(path.resolve(a.in), path.join(jobDir, 'work'), { recursive: true });
  }
  const nodeCache = path.join(REPO, 'tools', 'sandbox-cache', 'node.zip');
  if (existsSync(nodeCache)) copyFileSync(nodeCache, path.join(inDir, '_node.zip'));
  assertNoSecrets(jobDir);

  writeFileSync(path.join(inDir, 'entry.ps1'), ENTRY, 'utf8');
  const wsbPath = path.join(jobDir, 'job.wsb');
  writeFileSync(wsbPath, wsbConfig({ hostFolder: jobDir, network: a.network, memory: a.memory }), 'utf8');

  console.log(`Каталог задания : ${jobDir}`);
  console.log(`Сеть в песочнице: ${a.network ? 'включена' : 'ОТКЛЮЧЕНА'}`);
  console.log(`Таймаут         : ${a.timeout} с`);

  if (a.dryRun) {
    console.log('\n--- job.wsb ---\n' + readFileSync(wsbPath, 'utf8'));
    console.log('--dry-run: песочница не запускалась.');
    return;
  }

  const pidsBefore = sandboxClientPids();
  console.log('\n→ Запуск Windows Sandbox…');
  spawn(SANDBOX_EXE, [wsbPath], { detached: true, stdio: 'ignore' }).unref();

  const donePath = path.join(outDir, 'DONE');
  const deadline = Date.now() + a.timeout * 1000;
  let done = false;
  while (Date.now() < deadline) {
    if (existsSync(donePath)) { done = true; break; }
    await sleep(2000);
  }

  // Закрытие клиента уничтожает виртуальную машину вместе со всем, что внутри.
  // Убиваем только процессы, появившиеся после нашего запуска.
  const ours = [...sandboxClientPids()].filter(p => !pidsBefore.has(p));
  for (const pid of ours) spawnSync('taskkill', ['/PID', pid, '/F'], { stdio: 'ignore' });
  if (!ours.length) {
    console.error('⚠ Не удалось определить процесс своей песочницы — ничего не закрывал, ' +
                  'чтобы не тронуть чужую. Если окно осталось открытым, закрой его вручную.');
  }

  const outputFile = path.join(outDir, 'output.txt');
  const output = existsSync(outputFile) ? readFileSync(outputFile, 'utf8') : '';
  let result = {};
  try { result = JSON.parse(readFileSync(path.join(outDir, 'result.json'), 'utf8')); } catch { /* нет результата */ }

  console.log('\n=== вывод задания ===');
  console.log(output.trim() || '(пусто)');
  console.log('=== конец вывода ===\n');

  if (!done) {
    console.error(`✗ ТАЙМАУТ: задание не завершилось за ${a.timeout} с. Песочница закрыта, ` +
                  `её содержимое уничтожено. Частичный вывод — выше.`);
  } else {
    console.log(`✓ Завершено за ${result.seconds ?? '?'} с, код выхода ${result.exit_code ?? '?'}`);
  }

  const artifacts = existsSync(outDir)
    ? readdirSync(outDir).filter(f => !['DONE', 'output.txt', 'result.json'].includes(f))
    : [];
  if (artifacts.length) {
    console.log(`Артефакты (ДАННЫЕ, не код — не исполнять на хосте): ${outDir}`);
    for (const f of artifacts) {
      const s = statSync(path.join(outDir, f));
      console.log(`  ${f} — ${s.size} байт`);
    }
  }

  if (!a.keep) {
    try { rmSync(path.join(jobDir, 'work'), { recursive: true, force: true }); } catch { /* пусто */ }
    console.log(`Рабочая копия задания удалена; вывод оставлен в ${outDir}`);
  }
  process.exit(done && result.exit_code === 0 ? 0 : 1);
}

main().catch(e => die(String(e?.stack ?? e)));
