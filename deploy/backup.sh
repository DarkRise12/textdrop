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
extension=$(python3 - "$partial" <<'PYTHON'
from pathlib import Path
from contextlib import closing
import re
import sqlite3
import sys
import tarfile
import tempfile
path = Path(sys.argv[1]).resolve()
if not path.stat().st_size:
    raise SystemExit('Empty backup received.')
def verify(database, registry=False):
    with closing(sqlite3.connect(database.as_uri() + '?mode=ro&immutable=1', uri=True)) as db:
        if db.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
            raise SystemExit('Backup integrity check failed.')
        db.execute('SELECT id FROM ' + ('users' if registry else 'notes') + ' LIMIT 1')
with path.open('rb') as file:
    legacy = file.read(16) == b'SQLite format 3\x00'
if legacy:
    verify(path)
    print('sqlite3')
else:
    with tempfile.TemporaryDirectory(prefix='.verify-', dir=path.parent) as directory:
        with tarfile.open(path, 'r:gz') as bundle:
            names = set()
            for member in bundle:
                if not member.isfile() or not re.fullmatch(r'(accounts|notes)\.sqlite3|users/[a-f0-9]{32}/notes\.sqlite3', member.name) or member.name in names:
                    raise SystemExit('Unexpected backup entry.')
                names.add(member.name)
                target = Path(directory) / str(len(names))
                with bundle.extractfile(member) as origin, target.open('wb') as output:
                    import shutil
                    shutil.copyfileobj(origin, output)
                verify(target, member.name == 'accounts.sqlite3')
            if not {'accounts.sqlite3', 'notes.sqlite3'} <= names:
                raise SystemExit('Incomplete account backup.')
    print('tar.gz')
PYTHON
)
final="backups/textdrop-$(date -u +%Y%m%dT%H%M%SZ)-${partial##*-}.$extension"
mv "$partial" "$final"
printf 'Backup verified: %s\n' "$final"
