#!/usr/bin/env bash
# Деплой статического сайта из site/ на Cloudflare Pages.
#
# В гибридном режиме сайт — автономный канал: агенту разрешён самостоятельный деплой.
# Для этого нужна неинтерактивная авторизация (см. ниже, вариант 2).
#
# Разовая настройка авторизации (одно из двух):
#   Вариант 1 — интерактивно (для оператора):
#       npx --yes wrangler login        # откроется браузер, вход в аккаунт Cloudflare
#   Вариант 2 — токеном (для автономного деплоя агентом): пропиши в .env
#       CLOUDFLARE_API_TOKEN=...        # токен с правом "Cloudflare Pages: Edit"
#       CLOUDFLARE_ACCOUNT_ID=...       # ID аккаунта Cloudflare
#
# Имя проекта: config.json → deploy.cloudflare_project  (или переменная CLOUDFLARE_PROJECT).
# Первый деплой создаст проект Pages автоматически.
#
# Альтернативы (раскомментируй нужную внизу): GitHub Pages / Netlify / Vercel / Surge.

set -euo pipefail
cd "$(dirname "$0")/.."

# Подхватить из .env ТОЛЬКО нужные деплою ключи. НЕ источаем весь .env через `. ./.env`:
# значение с пробелом без кавычек (напр. MAIL_FROM_NAME=AI Monetization Experiment) иначе
# выполняется как команда и ломает деплой (баг повторялся — см. LESSONS.md). Кавычки снимаем.
if [ -f .env ]; then
  for k in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_PROJECT; do
    # Ключи опциональны (wrangler может быть авторизован через `wrangler login`).
    # `|| true`: отсутствие ключа даёт grep exit 1, а с set -o pipefail это молча
    # роняло весь деплой на первой же итерации (баг тика 41). Не источаем весь .env.
    v=$(grep -E "^${k}=" .env | tail -1 | cut -d= -f2- || true)
    v=${v%\"}; v=${v#\"}; v=${v%\'}; v=${v#\'}
    [ -n "$v" ] && export "$k=$v"
  done
fi

PROJECT="${CLOUDFLARE_PROJECT:-$(node -e "try{process.stdout.write((require('./config.json').deploy.cloudflare_project)||'')}catch(e){}")}"

command -v node >/dev/null 2>&1 || { echo "✗ Нужен Node.js."; exit 1; }
[ -n "$PROJECT" ] || { echo "✗ Не задано имя проекта. Укажи deploy.cloudflare_project в config.json или CLOUDFLARE_PROJECT в .env."; exit 1; }
[ -f site/index.html ] || { echo "✗ Нет site/index.html — публиковать нечего."; exit 1; }

echo "→ Деплой site/ на Cloudflare Pages (проект: $PROJECT)"
npx --yes wrangler@latest pages deploy site --project-name "$PROJECT"

echo "✓ Готово. Публичный адрес — вида https://$PROJECT.pages.dev"
echo "  Впиши итоговый URL в config.json → deploy.public_url (и при желании подключи свой домен в панели Cloudflare)."

# --- Альтернативные провайдеры (раскомментируй ОДИН вместо блока выше) ---
# GitHub Pages: git push origin "$(git subtree split --prefix site HEAD):refs/heads/gh-pages" --force
# Netlify:      npx --yes netlify-cli deploy --dir=site --prod
# Vercel:       npx --yes vercel deploy site --prod
# Surge:        npx --yes surge site
