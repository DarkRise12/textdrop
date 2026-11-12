"""Create a consistent SQLite backup without copying a live database file."""
import argparse
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile


def backup(source, destination):
    source, destination = Path(source).resolve(), Path(destination).resolve()
    if source == destination:
        raise ValueError('Source and destination must differ.')
    if not source.is_file():
        raise ValueError(f'Database not found: {source}')
    # Build in the destination directory so publishing with link() is atomic.
    # Exclusive publication never overwrites an existing backup or live DB.
    with tempfile.TemporaryDirectory(prefix='.textdrop-backup-', dir=destination.parent) as directory:
        temporary = Path(directory) / 'snapshot.sqlite3'
        with sqlite3.connect(source.as_uri() + '?mode=ro', uri=True) as origin:
            with sqlite3.connect(temporary) as snapshot:
                origin.backup(snapshot)
                if snapshot.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                    raise ValueError('Backup integrity check failed.')
                snapshot.execute('SELECT id, text, created FROM notes LIMIT 1')
        os.chmod(temporary, 0o600)
        with temporary.open('rb') as file:
            os.fsync(file.fileno())
        os.link(temporary, destination)
        fd = os.open(destination.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', help='Path to notes.sqlite3')
    parser.add_argument('destination', help='New backup path, or - for binary stdout')
    args = parser.parse_args()
    try:
        if args.destination == '-':
            # /data is writable even in the read-only application container.
            with tempfile.TemporaryDirectory(prefix='.textdrop-export-', dir=Path(args.source).resolve().parent) as directory:
                path = backup(args.source, Path(directory) / 'snapshot.sqlite3')
                with path.open('rb') as file:
                    shutil.copyfileobj(file, sys.stdout.buffer)
        else:
            path = backup(args.source, args.destination)
            print(f'Backup verified: {path}')
    except (OSError, sqlite3.Error, ValueError) as exc:
        print(f'Backup failed: {exc}', file=sys.stderr)
        raise SystemExit(1)


if __name__ == '__main__':
    main()
