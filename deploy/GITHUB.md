# GitHub: тесты и автоматическое обновление

## Схема

Push в `master` запускает тесты и сборку Docker. После успеха образ конкретного коммита передаётся по SSH на сервер. Сервер сохраняет предыдущий образ, делает проверенный бэкап, запускает новый контейнер и до двух минут ждёт healthy. Ошибка запуска возвращает предыдущий образ и помечает workflow неуспешным.

База не откатывается автоматически: это могло бы уничтожить новые записи. До появления отдельных миграций в автодеплой допускаются только изменения, совместимые с существующей схемой. Изменения Compose/Caddy и скриптов сервера пока устанавливаются вручную; workflow обновляет только образ приложения. Возможен короткий перерыв при пересоздании контейнера.

## 1. Репозиторий (публичный по выбору владельца)

Репозиторий проекта: https://github.com/DarkRise12/textdrop. Remote `origin` настроен на HTTPS. Для первой отправки авторизуйтесь в обычной SSH-сессии:

```bash
sudo apt update
sudo apt install gh
gh auth login --hostname github.com --git-protocol https --web
gh auth setup-git
cd ~/textdrop
git push -u origin master
```

Откройте показанный CLI адрес в браузере и введите одноразовый код там. Авторизация выполняется напрямую в GitHub, без передачи токенов в чат. Если remote ещё не настроен в вашей копии, сначала выполните `git remote add origin https://github.com/DarkRise12/textdrop.git`.

Первая публикация запустит только тесты: автодеплой выключен по умолчанию. Для подключения workflow требуются разрешения вашей GitHub-авторизации на запись кода и workflows.

## 2. Однократная установка на сервере

В обычной SSH-сессии с актуальными файлами проекта:

```bash
cd ~/textdrop
python3 deploy/setup-docker-secrets.py --check
sudo docker compose up -d --build
sudo sh deploy/backup.sh
sudo install -o root -g root -m 755 deploy/github-deploy.sh /usr/local/sbin/textdrop-deploy
```

Перед включением автоматизации убедитесь, что контейнер healthy и сайт работает. Скрипт использует `/home/darkrise/textdrop`, текущую Compose-конфигурацию и сеть `caddy_default`.

## 3. SSH для Actions

Создайте отдельную SSH-пару только для выпуска. Публичный ключ добавьте в `~darkrise/.ssh/authorized_keys` с `restrict` и принудительной командой `command="/home/darkrise/.ssh/textdrop-actions-dispatch"`. Диспетчер — копия `deploy/ssh-dispatch.sh` с правами 700. Он разрешает только проверку доступа и вызов deploy helper с полным SHA, запрещает интерактивный вход и произвольные команды. Приватный ключ загрузите непосредственно в GitHub Secret; не присылайте его в чат и не добавляйте в репозиторий.

Через `sudo visudo -f /etc/sudoers.d/textdrop-deploy` разрешите запуск установленного helper без пароля:

```sudoers
darkrise ALL=(root) NOPASSWD: /usr/local/sbin/textdrop-deploy
```

Helper принимает только полный SHA и работает в фиксированном каталоге. Workflow, SSH-ключ и авторы основной ветки получают возможность запускать контейнерный код на сервере: доступ к записи в репозиторий должен быть только у доверенных людей. Не запускайте Actions runner на production-сервере.

В GitHub → Settings → Environments создайте `production`. Выберите Selected branches and tags и разрешите только **ветку** `master` (не теги). Секреты добавляйте внутри этого окружения:

| Secret | Значение |
| --- | --- |
| `DEPLOY_HOST` | SSH-адрес сервера, без `https://` |
| `DEPLOY_USER` | `darkrise` |
| `DEPLOY_PORT` | SSH-порт, обычно `22` |
| `DEPLOY_SSH_KEY` | Приватный ключ выделенной пары |
| `DEPLOY_KNOWN_HOSTS` | Проверенная запись SSH host key сервера |

Host key сверяйте через доверенную SSH-сессию/консоль сервера. Для нестандартного порта запись должна соответствовать `[host]:port`. Workflow использует StrictHostKeyChecking и не доверяет ключу, впервые полученному из сети во время деплоя.

Когда всё настроено, в разделе Variables создайте `AUTO_DEPLOY=true`. Запустите workflow вручную для ветки `master` и проверьте первый выпуск и сайт. Следующие push в эту ветку обновят приложение автоматически. Pull request запускает только проверки.

## Обслуживание

После автодеплоя перед ручными Compose-командами загрузите выбор текущего образа:

```bash
cd ~/textdrop
source .deploy/image.env
sudo TEXTDROP_IMAGE="$TEXTDROP_IMAGE" docker compose ps
```

Не выполняйте обычный `up --build` после автодеплоя без намерения заменить выбранный образ локальным кодом. На сервере исходники могут отставать от образа: workflow переносит Docker-образ, а не обновляет Git checkout. Старые образы и бэкапы автоматически не удаляются; контролируйте свободное место.

Чтобы отключить новые автоматические выпуски, измените `AUTO_DEPLOY` на `false`. Текущий сайт продолжит работать. При ошибке смотрите вкладку Actions и `sudo docker compose logs --tail=100 textdrop`.

Справка GitHub: [секреты для GitHub Actions](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions).

## Установленные ограничения

Окружение production разрешает только master. Pull request запускает тесты без production secrets. Официальные Actions закреплены на полных SHA; checkout не сохраняет GitHub credentials. SSH-ключ доступен только шагу отправки образа и не попадает в сборку. На сервере host key проверяется по доверенной локальной копии; ключ автодеплоя не разрешает shell, forwarding и произвольные команды.

Публичность исходников не делает GitHub Secrets общедоступными. Тем не менее владелец и доверенные авторы master контролируют выпускаемый код. Компрометация GitHub-аккаунта или разрешённого кода остаётся риском: используйте двухфакторную аутентификацию и ограничивайте доступ к записи. Секреты приложения, база и резервные копии исключены из Git и Docker build context.

Для отзыва доступа удалите выделенную строку из authorized_keys и секрет DEPLOY_SSH_KEY из production, затем выключите AUTO_DEPLOY. Это не затрагивает обычный SSH-ключ владельца.

Образ передаётся потоком с gzip-сжатием уровня 1, чтобы не отправлять несжатые слои при каждом обновлении. Установленный helper принимает этот поток через обычный `docker load`, который автоматически распознаёт сжатие: [Docker CLI reference](https://docs.docker.com/reference/cli/docker/image/load/).
