# Textdrop

Your private place to move text and files between devices. Run it on your own
server, open it from any device, and keep the same history everywhere.

[Install](docs/INSTALL.md) · [Releases](https://github.com/DarkRise12/textdrop/releases) ·
[Changelog](CHANGELOG.md) · [Русская техническая документация](docs/TECHNICAL.ru.md)

## Features

- Chat-style history, editing, search, copying, safe links and 30-day trash.
- Seven preset emoji categories shown as reactions; filter your history by category and search together.
- Up to **10 files per message**, **125 MiB per file**, **3 GiB total** by default.
- Lightweight image previews, light/dark themes and a responsive mobile interface.
- Owner-created accounts with separate messages, files and drafts; no public registration.
- Installable PWA. Offline shell and local drafts; private history and files need a connection.
- SQLite persistence. No external database, frontend build, analytics or third-party account required.

The interface is currently **Russian**. Textdrop stores readable content on your
server; it does not provide end-to-end encryption. Designed for personal use and
small trusted groups. Linux **AMD64 and ARM64** images are provided.

## Quick start

Requirements: Docker Engine, Compose v2 with `up --wait`, Python 3, `curl`, `tar`,
and `sha256sum`. For access across devices, use a domain and an HTTPS reverse proxy.

```sh
mkdir textdrop && cd textdrop
curl -fLO https://github.com/DarkRise12/textdrop/releases/download/v1.1.0/textdrop-install-1.1.0.tar.gz
curl -fLO https://github.com/DarkRise12/textdrop/releases/download/v1.1.0/SHA256SUMS
sha256sum --check SHA256SUMS
tar -xzf textdrop-install-1.1.0.tar.gz
cp .env.example .env
python3 deploy/setup-docker-secrets.py
docker compose up -d --wait
```

Point your HTTPS reverse proxy at `127.0.0.1:8765`. Log in as **admin** using the
password you entered. Create other accounts in account settings. The default
binding is localhost; nothing is exposed publicly until you configure your proxy.
See [installation](docs/INSTALL.md) for Caddy, Docker proxies, a localhost trial,
configuration, backup/restore and updates. No GitHub account or registry login is
needed to download a public release.

The repository's `compose.yaml` serves the maintainer's existing Caddy network.
For your own installation use the release bundle or **`compose.selfhost.yaml`**.

## Updates and data

Images use version tags such as `ghcr.io/darkrise12/textdrop:1.1.0`; pin a release
instead of automatically following `latest`. Read its changelog, create a backup,
change `TEXTDROP_IMAGE` in `.env`, then run `docker compose pull` and
`docker compose up -d --wait`. Application updates never require deleting the
volume or regenerating secrets. **`docker compose down -v` deletes your data.**

Backups include all account databases and attached files. Use
`sh deploy/backup.sh`, retain `.secrets/` securely, and copy backups off the server.
Test restoration before relying on a backup. [Full procedure](docs/INSTALL.md#backup-and-restore).

## Development and support

[Contributing](CONTRIBUTING.md) · [Report a bug](https://github.com/DarkRise12/textdrop/issues) ·
[Security reports](SECURITY.md) · [Roadmap](ROADMAP.md)

For source development use Python 3.12+, install `requirements.txt` in a virtual
environment, and run `python3 -m unittest discover -s tests -v` and
`node --test tests/*.test.cjs`. Browser regression scripts use synthetic data.
Releases run unit tests and real-container startup, persistence and account-isolation
checks for both supported architectures before promoting image tags.

## License

[MIT](LICENSE). Self-host, modify and redistribute Textdrop under its license terms.
