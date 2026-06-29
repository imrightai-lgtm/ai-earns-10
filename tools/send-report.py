# -*- coding: utf-8 -*-
"""Отправка отчёта тика на email оператора через Gmail SMTP (App Password).

Зачем: Gmail-коннектор Claude умеет только create_draft (черновики), не отправку,
поэтому шлём напрямую через smtplib (stdlib, без зависимостей).

БЕЗОПАСНОСТЬ:
  • На ошибке отправки traceback НЕ печатается (во фрейме лежит пароль) — только тип и краткий текст.
  • Авто-отправка разрешена ТОЛЬКО на owner (себе). Внешний адрес требует --allow-external.

КОНФИГ: берётся из .env в корне проекта (он в .gitignore). Ключи:
  MAIL_OWNER=imright.ai@gmail.com      ← отправитель и единственный авто-получатель
  MAIL_FROM_NAME=AI Monetization Experiment
  MAIL_APP_PASSWORD=xxxxxxxxxxxxxxxx    ← Gmail App Password (16 знаков; пробелы можно)
  SMTP_HOST=smtp.gmail.com             ← опц. (дефолт)
  SMTP_PORT=465                        ← опц. (дефолт)
App Password: https://myaccount.google.com/apppasswords (нужен 2FA; это НЕ пароль аккаунта).

CLI:
  python tools/send-report.py --selftest
  python tools/send-report.py --subject "Тема" --body "Текст"
  python tools/send-report.py --subject "Тема" --body-file путь.txt
Коды выхода: 0 — успех; 2 — ошибка конфига/использования; 1 — ошибка отправки."""
import sys, os, ssl, smtplib, argparse
from email.message import EmailMessage
from email.utils import formataddr

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
ENV_PATH = os.path.join(ROOT, '.env')


def load_env():
    cfg = {}
    if not os.path.exists(ENV_PATH):
        raise FileNotFoundError(f'Нет {ENV_PATH}')
    with open(ENV_PATH, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            k, v = line.split('=', 1)
            k = k.strip()
            v = v.strip()
            if len(v) >= 2 and ((v[0] == '"' and v[-1] == '"') or (v[0] == "'" and v[-1] == "'")):
                v = v[1:-1]
            cfg[k] = v
    owner = cfg.get('MAIL_OWNER', '').strip()
    if not owner:
        raise ValueError('В .env не задан MAIL_OWNER (адрес-отправитель/получатель).')
    pw = (cfg.get('MAIL_APP_PASSWORD') or '').replace(' ', '')
    if not pw or pw.upper().startswith('ВСТАВ') or pw.upper().startswith('PASTE'):
        raise ValueError('В .env не задан MAIL_APP_PASSWORD (Gmail App Password). '
                         'Сгенерируйте на myaccount.google.com/apppasswords и впишите в .env.')
    return {
        'owner': owner,
        'from_name': cfg.get('MAIL_FROM_NAME', 'AI Monetization Experiment'),
        'app_password': pw,
        'smtp_host': cfg.get('SMTP_HOST', 'smtp.gmail.com'),
        'smtp_port': int(cfg.get('SMTP_PORT', '465') or 465),
    }


def send(to, subject, body_text, allow_external=False, cfg=None):
    cfg = cfg or load_env()
    owner = cfg['owner']
    recipients = [r.strip() for r in ([to] if isinstance(to, str) else list(to))]
    external = [r for r in recipients if r.lower() != owner.lower()]
    if external and not allow_external:
        raise PermissionError('Авто-отправка только на owner. Внешние адреса: '
                              + ', '.join(external) + ' (нужен --allow-external).')
    msg = EmailMessage()
    msg['From'] = formataddr((cfg['from_name'], owner))
    msg['To'] = ', '.join(recipients)
    msg['Subject'] = subject
    msg.set_content(body_text or '(пустое тело)')
    context = ssl.create_default_context()
    srv = smtplib.SMTP_SSL(cfg['smtp_host'], cfg['smtp_port'], context=context, timeout=30)
    try:
        srv.login(owner, cfg['app_password'])
        srv.send_message(msg)
    finally:
        try:
            srv.quit()
        except Exception:
            pass
    return owner


def _log(m):
    try:
        print(m)
    except UnicodeEncodeError:
        sys.stdout.buffer.write((m + '\n').encode('utf-8', 'replace'))


def main():
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass
    ap = argparse.ArgumentParser(description='Отправка отчёта тика на email оператора (Gmail SMTP)')
    ap.add_argument('--to', default=None)
    ap.add_argument('--subject', default='')
    ap.add_argument('--body', default=None)
    ap.add_argument('--body-file', default=None)
    ap.add_argument('--allow-external', action='store_true')
    ap.add_argument('--selftest', action='store_true')
    args = ap.parse_args()
    try:
        cfg = load_env()
    except Exception as e:
        _log(f'ОШИБКА КОНФИГА: {type(e).__name__}: {str(e)[:300]}')
        sys.exit(2)
    to = args.to or cfg['owner']
    if args.selftest:
        subject = 'Тест отчёта — AI Monetization Experiment'
        body = ('Тестовое письмо от send-report.py через SMTP Gmail.\n'
                'Получили — значит почтовые отчёты тика настроены.\n')
    else:
        subject = args.subject
        if args.body_file:
            try:
                with open(args.body_file, encoding='utf-8') as f:
                    body = f.read()
            except (OSError, UnicodeDecodeError) as e:
                _log(f'Не прочитать --body-file: {type(e).__name__}: {str(e)[:200]}'); sys.exit(2)
        elif args.body is not None:
            body = args.body
        else:
            _log('Не задан текст (--body или --body-file)'); sys.exit(2)
    try:
        sender = send(to, subject, body, allow_external=args.allow_external, cfg=cfg)
        _log(f'OK: отчёт отправлен с {sender} на {to}')
    except Exception as e:
        _log(f'ОШИБКА ОТПРАВКИ: {type(e).__name__}: {str(e)[:300]}')
        sys.exit(1)


if __name__ == '__main__':
    main()
