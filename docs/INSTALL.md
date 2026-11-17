# Install Textdrop on your server

## Requirements and first start

Use Linux AMD64 or ARM64, Docker Engine and Compose v2 supporting `up --wait`.
The release setup also needs Python 3, `curl`, `tar` and `sha256sum`. Allow space
for attachments, the image, temporary uploads and backups; 3 GiB is the default
shared file quota, not a total disk usage cap.

Download and verify the versioned installation bundle using the commands in the
[README](../README.md#quick-start). The bundle contains `compose.yaml`,
`.env.example`, `deploy/setup-docker-secrets.py`, `deploy/backup.sh` and `LICENSE`.
Run all subsequent commands from that installation directory. Python prompts for
the initial admin password (minimum 7 characters); prefer a long, unique password.
The script preserves existing secrets when run again.

```sh
cp .env.example .env
python3 deploy/setup-docker-secrets.py
python3 deploy/setup-docker-secrets.py --check
docker compose up -d --wait
docker compose ps
curl --fail http://127.0.0.1:8765/api/session
```

The last command should return `{"authenticated": false}`. The initial account is
`admin`; its password comes from setup. Subsequent password changes happen in the
app. Changing `.secrets/password` does not reset an existing account's password.

### HTTPS with a proxy on the host

Create a domain's DNS record pointing at the server. In your existing Caddyfile:

```caddyfile
share.example.com {
    reverse_proxy 127.0.0.1:8765
}
```

Validate/reload your Caddy configuration according to your installation. The
proxy needs ports 80/443 reachable for certificate issuance. Open
`https://share.example.com`. Keep `TEXTDROP_SECURE=1`: login cookies require HTTPS.
Use a dedicated domain/subdomain; installation under a URL path is unsupported.
Other reverse proxies work too; allow at least 1250 MiB request bodies for a
10-file batch and suitable upload timeouts. Caddy does not impose a default
request-body size limit. Configure the proxy to overwrite forwarded headers.

### Reverse proxy in another Docker container

A proxy container cannot reach the application's localhost binding. Connect both
to a shared user-defined Docker network; do not expose an unsecured public port.
Create `compose.proxy.yaml`, replacing `proxy_network` with your existing network:

```yaml
services:
  textdrop:
    networks: [proxy]
networks:
  proxy:
    external: true
    name: proxy_network
```

Use both files for every Compose command:
`docker compose -f compose.yaml -f compose.proxy.yaml up -d --wait`.
Configure the proxy to reach `textdrop:8765`. The host's localhost binding can
remain for health checks. Give this service a unique network alias if multiple
installations share the same proxy network.

### Local HTTP trial

For a trial **on the server itself**, set `TEXTDROP_SECURE=0` in `.env`, restart
with `docker compose up -d --wait`, and open `http://localhost:8765`. Restore
`TEXTDROP_SECURE=1` for HTTPS. Do not expose the HTTP trial to the internet.
PWA installation and service workers require a secure context (HTTPS or localhost).

## Configuration

Set these values in `.env` beside the release's Compose file:

| Variable | Default | Purpose |
| --- | --- | --- |
| `TEXTDROP_IMAGE` | `ghcr.io/darkrise12/textdrop:1.1.1` | Pinned release; AMD64/ARM64 selected automatically |
| `TEXTDROP_BIND` | `127.0.0.1` | Host binding; keep private behind proxy |
| `TEXTDROP_PORT` | `8765` | Host port; container port remains 8765 |
| `TEXTDROP_SECURE` | `1` | Secure cookies; `0` only for local HTTP trial |
| `TEXTDROP_FILE_LIMIT` | `131072000` | Maximum bytes per file (125 MiB) |
| `TEXTDROP_STORAGE_LIMIT` | `3221225472` | Shared attachment/preview quota, including trash (3 GiB) |

The application runs as UID/GID `10001:10001`, with a read-only root filesystem
and dropped capabilities. It writes only to the named volume mounted at `/data`.
Compose secrets are bind-mounted read-only; the host `.secrets` directory is 0700.
Do not publish `.secrets`, database files or backups. Do not regenerate the session
secret on every start. Server-side content is not encrypted by Textdrop.

Logs: `docker compose logs --tail=100 textdrop`. Status: `docker compose ps`.
Stop without deleting data: `docker compose down`. **Never use `down -v` to update.**

## Updates

1. Read the target release's changelog and any upgrade notes.
2. Create a verified backup and keep your current version in case of rollback.
3. Change `TEXTDROP_IMAGE` in `.env` to the desired exact release tag.
4. Run `docker compose pull` and `docker compose up -d --wait`.
5. Check login, your messages and a downloaded attachment. The PWA offers its own refresh.

Avoid unattended `latest` updates on an installation with important data. Rolling
back an image does not roll back the database; consult that release's schema notes.
Version 1.1.1 adds `note_categories` and synchronization/cleanup triggers to each
account database. Existing messages are unchanged and initially have no categories.
The pre-deployment backup should be retained. Rolling back to 1.0.0 keeps stored
category memberships but does not display or allow filtering them; return to 1.1.1
to use them again. Restoring a pre-upgrade backup discards later changes.

## Backup and restore

Run `sh deploy/backup.sh`. It creates and verifies `backups/textdrop-*.tar.gz`,
including the registry, all histories and attachments. Sessions are removed from
the backup. Each SQLite database is a consistent snapshot; the entire multi-account
bundle is not one cross-database transaction. Quiesce writes if you require a
single point in time across accounts. Also save `.secrets/` securely. Keep a copy
outside the server; backup scheduling/rotation is your responsibility.

Restore into a **new empty volume**, never over a running database:

1. Test the archive and inspect its file list (`tar -tzf BACKUP.tar.gz`). It contains
   `accounts.sqlite3`, `notes.sqlite3` and optional `users/<id>/notes.sqlite3` files.
   Extract only trusted archives you created.
2. Stop the old installation with `docker compose down` (without `-v`), retain its
   volume, then copy the installation configuration into a separate directory.
3. In that copy, change the Compose top-level `name` to `textdrop-restore`, keep the
   original data volume untouched, and use a different host port while testing.
4. Create the new empty volume with `docker compose create`. Obtain its name with
   `docker volume ls --filter label=com.docker.compose.project=textdrop-restore`.
5. Mount that new volume using a temporary container, extract the trusted archive
   into `/data`, and set ownership to `10001:10001`. For example, replacing the
   volume name and absolute backup directory with your values:

   ```sh
   docker run --rm --user 0 --entrypoint sh \
     -v textdrop-restore_textdrop_data:/data \
     -v /absolute/backup-directory:/backup:ro \
     ghcr.io/darkrise12/textdrop:1.1.1 \
     -c 'tar -xzf /backup/BACKUP.tar.gz -C /data && chown -R 10001:10001 /data'
   ```

6. Start the restored copy with `docker compose up -d --wait`. Sign in using the
   account password stored in the backup, then verify messages, files and account
   isolation. Switch your proxy only after verification. Restored sessions require
   login again. Keep the old volume until you have confirmed successful recovery.

## Build from source

```sh
git clone --branch v1.1.1 --depth 1 https://github.com/DarkRise12/textdrop.git
cd textdrop
cp deploy/selfhost.env.example .env
python3 deploy/setup-docker-secrets.py
docker build -t textdrop:1.1.1 .
TEXTDROP_IMAGE=textdrop:1.1.1 docker compose -f compose.selfhost.yaml up -d --wait
```

Set `TEXTDROP_IMAGE=textdrop:1.1.1` in `.env` for subsequent commands. Always pass
`-f compose.selfhost.yaml` in a source checkout; the default file is specific to
the maintainer's server. Use the release bundle for the simpler installation path.

## Troubleshooting

- **Secret path does not exist:** run the setup script from the installation and
  `--check` before starting Compose. Do not create blank placeholder secrets.
- **Login succeeds but session is lost:** check HTTPS and `TEXTDROP_SECURE`; confirm
  the proxy reaches the same persistent installation on every request.
- **Upload fails:** check per-file/shared quota, disk space and proxy body/time limits.
- **Cannot pull image:** verify the exact release tag and internet access to GHCR.
  Public images need no login. Source builds remain available.
- **New user sees an empty chat:** each account has its own history; this is expected.

[Report a sanitized bug](https://github.com/DarkRise12/textdrop/issues).
