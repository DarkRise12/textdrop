#!/bin/sh
# Run from the host: sudo sh deploy/backup.sh
set -eu
cd "$(dirname "$0")/.."
umask 077
mkdir -p backups
chmod 700 backups
partial=$(mktemp backups/.partial-XXXXXX)
trap 'rm -f "$partial"' EXIT HUP INT TERM
docker compose exec -T textdrop python backup.py /data/notes.sqlite3 - > "$partial"
# Verify the transferred file before marking it as a completed backup.
python3 - "$partial" <<'PY'
from pathlib import Path
import sqlite3
import sys
path = Path(sys.argv[1]).resolve()
if not path.stat().st_size:
    raise SystemExit('Empty backup received.')
with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True) as db:
    if db.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
        raise SystemExit('Backup integrity check failed.')
    db.execute('SELECT id, text, created FROM notes LIMIT 1')
PY
final="backups/textdrop-$(date -u +%Y%m%dT%H%M%SZ)-${partial##*-}.sqlite3"
mv "$partial" "$final"
printf 'Backup verified: %s\n' "$final"
