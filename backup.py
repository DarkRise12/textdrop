"""Create a consistent SQLite backup without copying a live database file."""
import argparse
from contextlib import closing
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile
import tarfile
import re


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
        with closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)) as origin:
            with closing(sqlite3.connect(temporary)) as snapshot, snapshot:
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


def backup_all(source, destination):
    """Snapshot the registry first, then each registered content database."""
    source, destination = Path(source).resolve(), Path(destination).resolve()
    registry = source.parent / 'accounts.sqlite3'
    if not registry.exists():
        return backup(source, destination)
    with tempfile.TemporaryDirectory(prefix='.textdrop-backup-', dir=destination.parent) as directory:
        staging = Path(directory)
        registry_copy = staging / 'accounts.sqlite3'
        with closing(sqlite3.connect(registry.as_uri() + '?mode=ro', uri=True)) as origin:
            with closing(sqlite3.connect(registry_copy)) as snapshot, snapshot:
                origin.backup(snapshot)
                if snapshot.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                    raise ValueError('Registry integrity check failed.')
                ids = [row[0] for row in snapshot.execute('SELECT id FROM users')]
                # Backups restore accounts, never live login sessions.
                snapshot.execute('DELETE FROM sessions')
        paths = [('accounts.sqlite3', registry_copy)]
        for user_id in ids:
            if user_id == 'owner':
                name, path = 'notes.sqlite3', source
            elif re.fullmatch(r'[a-f0-9]{32}', user_id):
                name = 'users/' + user_id + '/notes.sqlite3'
                path = source.parent / name
            else:
                raise ValueError('Invalid account identifier in registry.')
            if not path.exists() and user_id != 'owner':
                continue  # New accounts have no content until their first API request.
            target = staging / name
            target.parent.mkdir(parents=True, exist_ok=True)
            backup(path, target)
            paths.append((name, target))
        archive = staging / 'bundle.tar.gz'
        with tarfile.open(archive, 'w:gz') as bundle:
            for name, path in paths:
                bundle.add(path, arcname=name, recursive=False)
        os.chmod(archive, 0o600)
        with archive.open('rb') as file:
            os.fsync(file.fileno())
        os.link(archive, destination)
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
                path = backup_all(args.source, Path(directory) / 'snapshot')
                with path.open('rb') as file:
                    shutil.copyfileobj(file, sys.stdout.buffer)
        else:
            path = backup_all(args.source, args.destination)
            print(f'Backup verified: {path}')
    except (OSError, sqlite3.Error, ValueError) as exc:
        print(f'Backup failed: {exc}', file=sys.stderr)
        raise SystemExit(1)


if __name__ == '__main__':
    main()
