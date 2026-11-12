# Textdrop

Личная лента для обмена текстом между устройствами: один пароль, SQLite, поиск, копирование и удаление. Python 3.12+, без сторонних библиотек. Адрес: `https://share.nikitalebe.dev`.

## Запуск с существующим Caddy в Docker

Выполняйте команды в обычной SSH-сессии с доступом к Docker. Нужен Docker Compose v2+. Найдите имя контейнера Caddy и его сеть:

```bash
docker ps --format 'table {{.Names}}\t{{.Networks}}'
docker network inspect ИМЯ_СЕТИ --format '{{.Driver}}'
```

Используйте пользовательскую bridge-сеть Caddy, поддерживающую DNS контейнеров. Если Caddy использует `host` или стандартную сеть `bridge`, потребуется отдельная общая сеть и её подключение в конфигурации Compose Caddy.

```bash
cd ~/textdrop
python3 deploy/setup-docker-secrets.py
export CADDY_NETWORK=ИМЯ_СЕТИ_CADDY
docker compose up -d --build
docker compose ps
```

Сохраните `CADDY_NETWORK` для следующих запусков (например, в настройках вашей shell). Скрипт спрашивает пароль интерактивно и не перезаписывает секреты. Приложение работает без root, хранит SQLite в именованном томе и не публикует порт 8765 на хосте. Caddy обращается к нему по имени `textdrop-share` в общей сети.

Добавьте в **действующий** Caddyfile отдельный блок:

```caddyfile
share.nikitalebe.dev {
    reverse_proxy textdrop-share:8765
}
```

Основной домен и другие блоки не меняйте. Если блок поддомена уже существует, отредактируйте его, не дублируйте. Для стандартного пути внутри контейнера проверьте и примените конфигурацию (замените `ИМЯ_CADDY`):

```bash
docker exec ИМЯ_CADDY caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker exec ИМЯ_CADDY caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
curl -i https://share.nikitalebe.dev/api/session
```

DNS-запись `share` (A и, при наличии IPv6, AAAA) должна указывать на сервер. Caddy автоматически получает TLS-сертификат при доступных портах 80/443. Ожидаемый ответ проверки: HTTP 200 и `{"authenticated": false}`. Откройте адрес на каждом устройстве и введите одинаковый пароль.

Логи: `docker compose logs --tail=100 textdrop`. Обновление: `docker compose up -d --build`. Не выполняйте `docker compose down -v`, если хотите сохранить записи.

## Проверка и разработка

```bash
python3 -m unittest discover -s tests -v
node --check static/app.js
```

Для запуска без Docker задайте `TEXTDROP_PASSWORD` (12+ символов), `TEXTDROP_SECRET` (32+ символов), `TEXTDROP_SECURE=0` и выполните `python3 server.py`. По умолчанию сервер слушает `127.0.0.1:8765`. Для HTTP-разработки используйте отдельный пароль. Файлы `deploy/textdrop.service` и `deploy/setup-env.py` оставлены как альтернативный запуск через systemd, без Docker.

## Данные и секреты

Docker: база `/data/notes.sqlite3` в томе `textdrop_data`; секреты в `.secrets/`, исключённом из Git и Docker build context. Без Docker: `data/notes.sqlite3` и `.env`. Файлы секретов доступны контейнеру для чтения; родительский каталог `.secrets` на хосте имеет права 0700.

Смена пароля требует смены секрета сессий и пересоздания контейнера. Для бэкапа остановите приложение перед копированием базы либо используйте SQLite backup API. Удаление записей окончательное. Лимит записи — 100 000 символов. Лента загружается целиком и рассчитана на личное использование; обновляется каждые 3 секунды в открытой вкладке.
