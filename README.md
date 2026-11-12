# Textdrop

Личная лента для обмена текстом между устройствами. Один пароль, общая SQLite-база на сервере. Python 3.12+, без сторонних зависимостей.

## Проверка

```bash
python3 -m unittest discover -s tests -v
node --check static/app.js
```

## Установка на сервере

В обычной SSH-сессии, под пользователем `darkrise`:

```bash
cd ~/textdrop
python3 deploy/setup-env.py
mkdir -p ~/.config/systemd/user
cp deploy/textdrop.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now textdrop
sudo loginctl enable-linger "$USER"
curl -i http://127.0.0.1:8765/api/session
```

Сервис слушает только `127.0.0.1:8765`. Настройте HTTPS через существующий reverse proxy или Caddy (пример: `deploy/Caddyfile`). Укажите реальный домен и направьте DNS на сервер. Прокси должен сохранять заголовок `Host`. После этого откройте `https://ваш-домен` на каждом устройстве и введите одинаковый пароль. В `.env` включён Secure cookie; вход через обычный HTTP не сохраняется.

Логи: `journalctl --user -u textdrop -f`. После обновления: `systemctl --user restart textdrop`. Изменение `TEXTDROP_SECRET` завершает все существующие сессии. Смена пароля требует одновременной смены секрета.

Для локальной разработки задайте переменные `TEXTDROP_PASSWORD` (12+ символов), `TEXTDROP_SECRET` (32+ символов), `TEXTDROP_SECURE=0`, затем `python3 server.py`. Не используйте пароль из production для HTTP-разработки.

## Хранение

Данные: `data/notes.sqlite3`, конфигурация: `.env`; оба исключены из Git. Для согласованного бэкапа используйте SQLite backup API или остановите сервис перед копированием базы. Удаление записей окончательное. Ограничение: 100 000 символов на запись; общая лента загружается целиком, поэтому текущая версия рассчитана на личное использование. Синхронизация — опрос сервера каждые 3 секунды при открытой вкладке.
