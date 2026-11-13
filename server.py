"""Textdrop: private shared text storage, using Python's standard library."""
import base64
import binascii
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import sys
import struct
import subprocess
import tempfile
import threading
import unicodedata
import time
from contextlib import contextmanager, nullcontext
from functools import wraps
from accounts import Accounts, password_matches
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit, quote

ROOT = Path(__file__).resolve().parent
PAGE_SIZE = 50
PAGE_MAX = 100
PAGE_BYTES = 900_000
SEARCH_LIMIT = 256
FILE_LIMIT = 125 * 1024 * 1024
STORAGE_LIMIT = 3 * 1024 * 1024 * 1024
LIMIT = 100_000
PREVIEW_VERSION = 1
PREVIEW_INPUT_LIMIT = 32 * 1024 * 1024
PREVIEW_BYTE_LIMIT = 100 * 1024
TRASH_LIFETIME = 30 * 24 * 60 * 60 * 1000
ATTACHMENT_SELECT = ', a.name AS attachment_name, a.size AS attachment_size, a.sha256 AS attachment_sha256, i.eligible AS attachment_preview '
NOTE_SELECT = ('SELECT n.id, n.text, n.created, COALESCE(v.version, 0) AS version, v.updated'
               + ATTACHMENT_SELECT + 'FROM notes n LEFT JOIN note_versions v ON v.note_id = n.id '
               'LEFT JOIN attachments a ON a.note_id = n.id LEFT JOIN attachment_images i ON i.note_id = n.id')
TRASH_SELECT = 'SELECT n.*' + ATTACHMENT_SELECT + 'FROM trash n LEFT JOIN attachments a ON a.note_id = n.id LEFT JOIN attachment_images i ON i.note_id = n.id'


def note_record(row):
    note = dict(row)
    name = note.pop('attachment_name', None)
    size = note.pop('attachment_size', None)
    digest = note.pop('attachment_sha256', None)
    preview = note.pop('attachment_preview', None)
    if name is not None:
        note['file'] = {'name': name, 'size': size, 'sha256': digest}
        if preview:
            note['file']['preview'] = True
    return note


def preview_candidate(header, size):
    return size <= PREVIEW_INPUT_LIMIT and (header.startswith(b'\x89PNG\r\n\x1a\n')
        or header.startswith(b'\xff\xd8\xff') or header.startswith((b'GIF87a', b'GIF89a'))
        or header[:4] == b'RIFF' and header[8:12] == b'WEBP')


class PreviewBusy(Exception):
    pass


class UploadLimit(ValueError):
    pass



class RequestConflict(ValueError):
    pass


class RequestGone(ValueError):
    pass


class EditConflict(RequestConflict):
    def __init__(self, current):
        super().__init__('Сообщение изменено на другом устройстве. Сравни версии перед сохранением.')
        self.current = current


def storage_serialized(method):
    @wraps(method)
    def run(self, *args, **kwargs):
        with self.accounts.storage_lock if self.accounts else nullcontext():
            return method(self, *args, **kwargs)
    return run


class Store:
    def __init__(self, path, file_limit=FILE_LIMIT, storage_limit=STORAGE_LIMIT):
        self.path = path
        self.accounts = None
        self.preview_lock = threading.Lock()
        self.preview_quota_blocked = {}
        if file_limit <= 0 or storage_limit <= 0:
            raise ValueError('File storage limits must be positive.')
        self.file_limit, self.storage_limit = file_limit, storage_limit
        with self.connect() as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, text TEXT NOT NULL, created INTEGER NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS send_requests (request_id TEXT PRIMARY KEY, note_id TEXT NOT NULL, text_hash TEXT NOT NULL)')
            # Separate metadata keeps the original notes schema compatible with rollback.
            db.execute('CREATE TABLE IF NOT EXISTS note_versions (note_id TEXT PRIMARY KEY, version INTEGER NOT NULL, updated INTEGER NOT NULL)')
            db.execute('''CREATE TABLE IF NOT EXISTS trash (
                id TEXT PRIMARY KEY, text TEXT NOT NULL, created INTEGER NOT NULL,
                version INTEGER NOT NULL, updated INTEGER, deleted INTEGER NOT NULL, expires INTEGER NOT NULL)''')
            db.execute('''CREATE TABLE IF NOT EXISTS attachments (
                note_id TEXT PRIMARY KEY, name TEXT NOT NULL, size INTEGER NOT NULL,
                sha256 TEXT NOT NULL, body BLOB NOT NULL)''')
            db.execute('''CREATE TABLE IF NOT EXISTS file_requests (
                request_id TEXT PRIMARY KEY, note_id TEXT NOT NULL, fingerprint TEXT NOT NULL)''')
            db.execute('''CREATE TABLE IF NOT EXISTS attachment_images (
                note_id TEXT PRIMARY KEY, eligible INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 0,
                width INTEGER, height INTEGER, body BLOB)''')
            db.execute('''CREATE TRIGGER IF NOT EXISTS preview_cleanup AFTER DELETE ON attachments BEGIN
                DELETE FROM attachment_images WHERE note_id=OLD.note_id;
                END''')
            # Backfill only tiny headers of files saved by earlier images; never SELECT the BLOB.
            for record in db.execute('''SELECT a.rowid, a.note_id, a.size FROM attachments a
                LEFT JOIN attachment_images i ON i.note_id=a.note_id WHERE i.note_id IS NULL''').fetchall():
                with db.blobopen('attachments', 'body', record['rowid'], readonly=True) as blob:
                    eligible = preview_candidate(blob.read(16), record['size'])
                db.execute('INSERT INTO attachment_images(note_id, eligible) VALUES (?, ?)', (record['note_id'], int(eligible)))
            for table in ('notes', 'trash'):
                db.execute(f'''CREATE TRIGGER IF NOT EXISTS attachments_cleanup_{table}
                    AFTER DELETE ON {table} BEGIN
                    DELETE FROM attachments WHERE note_id = OLD.id
                    AND NOT EXISTS (SELECT 1 FROM notes WHERE id = OLD.id)
                    AND NOT EXISTS (SELECT 1 FROM trash WHERE id = OLD.id);
                    END''')
            db.execute('CREATE INDEX IF NOT EXISTS trash_expiry ON trash(expires)')
            db.execute('CREATE INDEX IF NOT EXISTS notes_chronology ON notes(created DESC, id DESC)')
            db.execute('CREATE INDEX IF NOT EXISTS trash_chronology ON trash(deleted DESC, id DESC)')
            db.execute('CREATE TABLE IF NOT EXISTS sync_state (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), revision INTEGER NOT NULL)')
            db.execute('INSERT OR IGNORE INTO sync_state VALUES (1, 0)')
            db.execute('CREATE TABLE IF NOT EXISTS note_changes (note_id TEXT PRIMARY KEY, revision INTEGER NOT NULL)')
            db.execute('CREATE INDEX IF NOT EXISTS changes_revision ON note_changes(revision)')
            # Triggers also track writes from a previous app image after rollback.
            # Only the most recent revision per ID is retained; no message text is duplicated.
            for table in ('notes', 'trash'):
                for event in ('INSERT', 'UPDATE', 'DELETE'):
                    row = 'OLD' if event == 'DELETE' else 'NEW'
                    db.execute(f'''CREATE TRIGGER IF NOT EXISTS feed_{table}_{event.lower()}
                        AFTER {event} ON {table} BEGIN
                        UPDATE sync_state SET revision = revision + 1 WHERE singleton = 1;
                        INSERT INTO note_changes VALUES ({row}.id, (SELECT revision FROM sync_state))
                        ON CONFLICT(note_id) DO UPDATE SET revision = excluded.revision;
                        END''')


    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        db.create_function('casefold', 1, str.casefold, deterministic=True)
        return db

    def notes(self):
        with self.connect() as db:
            return [note_record(row) for row in db.execute(NOTE_SELECT + ' ORDER BY n.created DESC, n.rowid DESC')]

    @staticmethod
    def cursor(note, trash=False):
        key = 'deleted' if trash else 'created'
        return base64.urlsafe_b64encode(json.dumps([note[key], note['id']]).encode()).decode().rstrip('=')

    @staticmethod
    def parse_cursor(value):
        try:
            if not isinstance(value, str) or len(value) > 256:
                raise ValueError()
            raw = base64.b64decode(value + '=' * (-len(value) % 4), altchars=b'-_', validate=True)
            key, note_id = json.loads(raw)
            if type(key) is not int or not 0 <= key <= 2 ** 53 - 1 or not isinstance(note_id, str) or not 1 <= len(note_id) <= 80:
                raise ValueError()
            return key, note_id
        except (ValueError, TypeError, UnicodeDecodeError, binascii.Error):
            raise ValueError('Некорректный указатель страницы.') from None

    @staticmethod
    def feed_params(query, limit):
        if not isinstance(query, str) or len(query) > SEARCH_LIMIT:
            raise ValueError('Поисковый запрос должен быть не длиннее 256 символов.')
        if type(limit) is not int or not 1 <= limit <= PAGE_MAX:
            raise ValueError('Размер страницы должен быть от 1 до 100.')
        return query.casefold()

    @staticmethod
    def feed_source(trash):
        if trash:
            return TRASH_SELECT, 'trash n', 'n.deleted'
        return NOTE_SELECT, 'notes n', 'n.created'

    @staticmethod
    def feed_counts(db, table, query):
        total = db.execute('SELECT count(*) FROM ' + table).fetchone()[0]
        matched = db.execute('SELECT count(*) FROM ' + table + ' WHERE instr(casefold(n.text), ?) > 0 OR EXISTS (SELECT 1 FROM attachments a WHERE a.note_id=n.id AND instr(casefold(a.name), ?) > 0)', (query, query)).fetchone()[0] if query else total
        return {'total': total, 'matched': matched}

    def page(self, query='', before=None, limit=PAGE_SIZE, trash=False):
        query = self.feed_params(query, limit)
        cursor = self.parse_cursor(before) if before is not None else None
        if trash:
            self.purge_expired()
        select, table, key = self.feed_source(trash)
        conditions, args = [], []
        if query:
            conditions.append("(instr(casefold(n.text), ?) > 0 OR instr(casefold(COALESCE(a.name, '')), ?) > 0)"); args.extend((query, query))
        if cursor:
            conditions.append(f'({key}, n.id) < (?, ?)'); args.extend(cursor)
        where = ' WHERE ' + ' AND '.join(conditions) if conditions else ''
        with self.connect() as db:
            db.execute('BEGIN')  # Rows, counts and revision belong to the same snapshot.
            revision = db.execute('SELECT revision FROM sync_state').fetchone()[0]
            records = db.execute(select + where + f' ORDER BY {key} DESC, n.id DESC LIMIT ?', (*args, limit + 1))
            items, size, more = [], 0, False
            for row in records:
                note = note_record(row)
                cost = len(json.dumps(note, ensure_ascii=False).encode()) + 2
                if len(items) == limit or (items and size + cost > PAGE_BYTES):
                    more = True
                    break
                items.append(note); size += cost
            return dict(items=items, next=self.cursor(items[-1], trash) if more else None,
                        revision=revision, **self.feed_counts(db, table, query))

    def changes(self, since, query='', limit=PAGE_SIZE, trash=False):
        query = self.feed_params(query, limit)
        if type(since) is not int or not 0 <= since <= 2 ** 53 - 1:
            raise ValueError('Некорректная версия синхронизации.')
        if trash:
            self.purge_expired()
        select, table, _ = self.feed_source(trash)
        with self.connect() as db:
            db.execute('BEGIN')
            revision = db.execute('SELECT revision FROM sync_state').fetchone()[0]
            if since > revision:
                return {'reset': True}
            rows = db.execute('SELECT note_id, revision FROM note_changes WHERE revision > ? ORDER BY revision LIMIT ?', (since, limit + 1))
            items, removed, size, processed, more = [], [], 0, since, False
            for row in rows:
                record = db.execute(select + ' WHERE n.id = ?', (row['note_id'],)).fetchone()
                note = note_record(record) if record is not None else None
                if note is not None:
                    note['matches'] = not query or query in note['text'].casefold() or query in note.get('file', {}).get('name', '').casefold()
                cost = len(json.dumps(note or row['note_id'], ensure_ascii=False).encode()) + 2
                if len(items) + len(removed) == limit or ((items or removed) and size + cost > PAGE_BYTES):
                    more = True
                    break
                if note is None:
                    removed.append(row['note_id'])
                else:
                    items.append(note)
                processed = row['revision']; size += cost
            return dict(items=items, removed=removed, revision=processed if more else revision,
                        has_more=more, **self.feed_counts(db, table, query))

    def get(self, note_id):
        with self.connect() as db:
            row = db.execute(NOTE_SELECT + ' WHERE n.id = ?', (note_id,)).fetchone()
            return note_record(row) if row else None

    def add(self, text, request_id=None):
        if not isinstance(text, str) or not text.strip() or len(text) > LIMIT:
            raise ValueError('Введите текст длиной от 1 до 100 000 символов.')
        if request_id is not None and (not isinstance(request_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{16,80}', request_id)):
            raise ValueError('Некорректный идентификатор отправки.')
        digest = hashlib.sha256(text.encode()).hexdigest()
        note = dict(id=secrets.token_hex(16), text=text, created=int(time.time() * 1000), version=0, updated=None)
        with self.connect() as db:
            # Serializes check-and-insert across threads/processes, not just this App.
            db.execute('BEGIN IMMEDIATE')
            if request_id is not None:
                previous = db.execute('SELECT note_id, text_hash FROM send_requests WHERE request_id = ?', (request_id,)).fetchone()
                if previous:
                    if previous['text_hash'] != digest:
                        raise RequestConflict('Этот идентификатор уже использован для другого текста.')
                    existing = db.execute(NOTE_SELECT + ' WHERE n.id = ?', (previous['note_id'],)).fetchone()
                    if existing is None:
                        raise RequestGone('Сообщение уже было отправлено и удалено. Повтор не восстановит его.')
                    return note_record(existing)
            db.execute('INSERT INTO notes VALUES (:id, :text, :created)', note)
            if request_id is not None:
                db.execute('INSERT INTO send_requests VALUES (?, ?, ?)', (request_id, note['id'], digest))
        return note

    @staticmethod
    def used_file_bytes(db):
        return db.execute('SELECT COALESCE((SELECT sum(size) FROM attachments),0) + COALESCE((SELECT sum(length(body)) FROM attachment_images),0)').fetchone()[0]

    @storage_serialized
    def quota_bytes(self, db):
        return self.used_file_bytes(db) + (self.accounts.other_bytes(self.path) if self.accounts else 0)

    @storage_serialized
    def storage(self):
        with self.connect() as db:
            used = self.quota_bytes(db)
        return dict(used_bytes=used, max_file_bytes=self.file_limit, max_storage_bytes=self.storage_limit)

    @storage_serialized
    def add_file(self, stream, size, name, text, request_id, digest):
        if type(size) is not int or not 0 <= size <= self.file_limit:
            raise UploadLimit('Файл превышает допустимый размер.')
        if not isinstance(name, str) or not isinstance(text, str) or len(text) > LIMIT:
            raise ValueError('Некорректное имя файла или подпись.')
        name = ''.join(c for c in name.replace('\\', '/').split('/')[-1] if not unicodedata.category(c).startswith('C')).strip()[:180]
        if not name or name in ('.', '..'):
            raise ValueError('У файла должно быть имя.')
        if not isinstance(request_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{16,80}', request_id):
            raise ValueError('Некорректный идентификатор отправки.')
        fingerprint = hashlib.sha256(json.dumps([name, text, size, digest], ensure_ascii=False).encode()).hexdigest()
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            previous = db.execute('SELECT * FROM file_requests WHERE request_id = ?', (request_id,)).fetchone()
            if previous:
                if previous['fingerprint'] != fingerprint:
                    raise RequestConflict('Идентификатор отправки уже использован для другого файла.')
                row = db.execute(NOTE_SELECT + ' WHERE n.id = ?', (previous['note_id'],)).fetchone()
                if row is None:
                    raise RequestGone('Файл уже отправлен и удалён. Повтор не восстановит его.')
                return note_record(row)
            used = self.quota_bytes(db)
            if used + size > self.storage_limit:
                raise UploadLimit('Хранилище файлов заполнено. Освободи место, удалив файлы из корзины.')
            header = stream.read(16); stream.seek(0)
            eligible = preview_candidate(header, size)
            note_id = secrets.token_hex(16)
            db.execute('INSERT INTO attachments VALUES (?, ?, ?, ?, zeroblob(?))', (note_id, name, size, digest, size))
            rowid = db.execute('SELECT rowid FROM attachments WHERE note_id = ?', (note_id,)).fetchone()[0]
            with db.blobopen('attachments', 'body', rowid, readonly=False) as blob:
                remaining = size
                checksum = hashlib.sha256()
                while remaining:
                    chunk = stream.read(min(65536, remaining))
                    if not chunk:
                        raise ValueError('Загрузка файла прервана. Повтори отправку.')
                    blob.write(chunk); checksum.update(chunk); remaining -= len(chunk)
                if stream.read(1) or checksum.hexdigest() != digest:
                    raise ValueError('Содержимое файла не совпало. Повтори отправку.')
            db.execute('INSERT INTO attachment_images(note_id, eligible) VALUES (?, ?)', (note_id, int(eligible)))
            db.execute('INSERT INTO notes VALUES (?, ?, ?)', (note_id, text, int(time.time() * 1000)))
            db.execute('INSERT INTO file_requests VALUES (?, ?, ?)', (request_id, note_id, fingerprint))
            return note_record(db.execute(NOTE_SELECT + ' WHERE n.id = ?', (note_id,)).fetchone())

    @contextmanager
    def download(self, note_id):
        db = self.connect()
        try:
            db.execute('BEGIN')
            row = db.execute("""SELECT a.rowid, a.name, a.size FROM attachments a WHERE a.note_id = ?
                AND (EXISTS (SELECT 1 FROM notes WHERE id = a.note_id)
                OR EXISTS (SELECT 1 FROM trash WHERE id = a.note_id AND expires > ?))""",
                (note_id, int(time.time() * 1000))).fetchone()
            if row is None:
                raise RequestGone('Файл удалён или срок хранения истёк.')
            with db.blobopen('attachments', 'body', row['rowid'], readonly=True) as blob:
                yield row, blob
        finally:
            db.close()

    @staticmethod
    def preview_row(db, note_id):
        row = db.execute("""SELECT i.* FROM attachment_images i JOIN attachments a ON a.note_id=i.note_id
            WHERE i.note_id=? AND (EXISTS (SELECT 1 FROM notes WHERE id=i.note_id)
            OR EXISTS (SELECT 1 FROM trash WHERE id=i.note_id AND expires>?))""",
            (note_id, int(time.time() * 1000))).fetchone()
        if row is None:
            raise RequestGone('Изображение удалено или срок хранения истёк.')
        return row

    def preview(self, note_id):
        with self.connect() as db:
            row = self.preview_row(db, note_id)
            if not row['eligible'] or row['version'] == PREVIEW_VERSION:
                return row['body']
        if not self.preview_lock.acquire(timeout=15):
            raise PreviewBusy()
        try:
            with self.connect() as db:
                row = self.preview_row(db, note_id)
                if row['version'] == PREVIEW_VERSION:
                    return row['body']
                used = self.quota_bytes(db)
                blocked = self.preview_quota_blocked.get(note_id)
                if blocked and blocked[:2] == (used, self.storage_limit) and blocked[2] > time.monotonic():
                    return None
                if used >= self.storage_limit:
                    return None
            body, width, height = None, None, None
            with tempfile.TemporaryDirectory(prefix='.preview-', dir=Path(self.path).parent) as directory:
                source = Path(directory) / 'source'
                with self.download(note_id) as (_, blob), source.open('wb') as output:
                    while chunk := blob.read(65536):
                        output.write(chunk)
                try:
                    result = subprocess.run([sys.executable, str(ROOT / 'preview.py'), str(source)],
                        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=8, check=False)
                    if result.returncode == 0 and 8 < len(result.stdout) <= PREVIEW_BYTE_LIMIT + 8:
                        width, height = struct.unpack('>II', result.stdout[:8])
                        candidate = result.stdout[8:]
                        if 1 <= width <= 640 and 1 <= height <= 640 and candidate.startswith(b'\xff\xd8') and candidate.endswith(b'\xff\xd9'):
                            body = candidate
                except subprocess.TimeoutExpired:
                    pass
            with self.accounts.storage_lock if self.accounts else nullcontext():
                return self.save_preview(note_id, body, width, height)
        finally:
            self.preview_lock.release()

    def save_preview(self, note_id, body, width, height):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            self.preview_row(db, note_id)  # Deletion while processing must not create an orphan.
            used = self.quota_bytes(db)
            if body is not None and used + len(body) > self.storage_limit:
                now = time.monotonic()
                self.preview_quota_blocked = {key: value for key, value in self.preview_quota_blocked.items() if value[2] > now}
                if len(self.preview_quota_blocked) >= 256:
                    self.preview_quota_blocked.pop(next(iter(self.preview_quota_blocked)))
                self.preview_quota_blocked[note_id] = (used, self.storage_limit, now + 60)
                return None
            self.preview_quota_blocked.pop(note_id, None)
            db.execute('UPDATE attachment_images SET version=?, width=?, height=?, body=? WHERE note_id=?',
                (PREVIEW_VERSION, width, height, body, note_id))
        return body

    def edit(self, note_id, text, version):
        if not isinstance(text, str) or len(text) > LIMIT:
            raise ValueError('Введите текст длиной до 100 000 символов.')
        if type(version) is not int or version < 0:
            raise ValueError('Некорректная версия сообщения. Обнови историю и попробуй снова.')
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute(NOTE_SELECT + ' WHERE n.id = ?', (note_id,)).fetchone()
            if row is None:
                raise RequestGone('Сообщение удалено на другом устройстве. Правки не сохранены.')
            current = note_record(row)
            if not text.strip() and 'file' not in current:
                raise ValueError('Введите текст сообщения.')
            if current['version'] != version:
                # Acknowledgement may have been lost after the previous PATCH committed.
                if current['version'] == version + 1 and current['text'] == text:
                    return current
                raise EditConflict(current)
            if current['text'] == text:
                return current
            updated = max(int(time.time() * 1000), (current['updated'] or 0) + 1)
            db.execute('UPDATE notes SET text = ? WHERE id = ?', (text, note_id))
            db.execute('''INSERT INTO note_versions VALUES (?, ?, ?)
                          ON CONFLICT(note_id) DO UPDATE SET version=excluded.version, updated=excluded.updated''',
                       (note_id, version + 1, updated))
            return dict(current, text=text, version=version + 1, updated=updated)

    def delete(self, note_id):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            now = int(time.time() * 1000)
            row = db.execute(NOTE_SELECT + ' WHERE n.id = ?', (note_id,)).fetchone()
            if row is None:
                # A repeated deletion never extends the original retention deadline.
                return db.execute('SELECT 1 FROM trash WHERE id = ? AND expires > ?', (note_id, now)).fetchone() is not None
            note = dict(row, deleted=now, expires=now + TRASH_LIFETIME)
            db.execute('INSERT INTO trash VALUES (:id, :text, :created, :version, :updated, :deleted, :expires)', note)
            db.execute('DELETE FROM notes WHERE id = ?', (note_id,))
            db.execute('DELETE FROM note_versions WHERE note_id = ?', (note_id,))
            return True

    def purge_expired(self):
        with self.connect() as db:
            return db.execute('DELETE FROM trash WHERE expires <= ?', (int(time.time() * 1000),)).rowcount

    def trash(self):
        self.purge_expired()
        with self.connect() as db:
            return [note_record(row) for row in db.execute(TRASH_SELECT + ' WHERE n.expires > ? ORDER BY n.deleted DESC, n.rowid DESC', (int(time.time() * 1000),))]

    def restore(self, note_id):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT * FROM trash WHERE id = ? AND expires > ?', (note_id, int(time.time() * 1000))).fetchone()
            if row is None:
                # Restoring again after a lost response is safe and does not bump the version.
                active = db.execute(NOTE_SELECT + ' WHERE n.id = ?', (note_id,)).fetchone()
                if active is not None:
                    return note_record(active)
                raise RequestGone('Срок хранения истёк или сообщение удалено окончательно. Восстановить его нельзя.')
            note = dict(row)
            db.execute('INSERT INTO notes VALUES (:id, :text, :created)', note)
            # Invalidate editors opened before the deletion/restoration lifecycle.
            db.execute('INSERT INTO note_versions VALUES (?, ?, ?)', (note_id, note['version'] + 1, note['updated'] or 0))
            db.execute('DELETE FROM trash WHERE id = ?', (note_id,))
            return note_record(db.execute(NOTE_SELECT + ' WHERE n.id = ?', (note_id,)).fetchone())

    def purge(self, note_id):
        with self.connect() as db:
            # Never delete an active message when restore and permanent delete race.
            return db.execute('DELETE FROM trash WHERE id = ?', (note_id,)).rowcount > 0


class App:
    def __init__(self, store, password, secret, secure=False):
        self.store, self.password, self.secret, self.secure = store, password, secret.encode(), secure
        self.accounts = Accounts(store.path, password, self.secret)
        store.accounts = self.accounts
        self.stores = {'owner': store}
        self.store_lock = threading.Lock()
        self.failures = {}
        self.uploads = threading.BoundedSemaphore(2)
        self.lock = threading.Lock()

    def signature(self, expires):
        return hmac.new(self.secret, str(expires).encode(), hashlib.sha256).hexdigest()

    def token(self, user_id='owner'):
        return self.accounts.issue(user_id)

    @staticmethod
    def cookie_token(header):
        try:
            return cookies.SimpleCookie(header or '')['session'].value
        except (KeyError, cookies.CookieError):
            return ''

    def user(self, header):
        return self.accounts.resolve(self.cookie_token(header))

    def authenticated(self, header):
        return self.user(header) is not None

    def store_for(self, user_id):
        with self.accounts.storage_lock, self.store_lock:
            if user_id not in self.stores:
                path = self.accounts.data_path(user_id)
                path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                store = Store(path, self.store.file_limit, self.store.storage_limit)
                store.accounts = self.accounts
                # All accounts share one bounded image worker.
                store.preview_lock = self.store.preview_lock
                self.stores[user_id] = store
            return self.stores[user_id]


def database_errors(method):
    @wraps(method)
    def run(self, *args, **kwargs):
        try:
            return method(self, *args, **kwargs)
        except sqlite3.Error:
            self.close_connection = True
            return self.reply(503, {'error': 'Хранилище временно недоступно. Повтори попытку.'})
    return run


class Handler(BaseHTTPRequestHandler):
    @property
    def store(self):
        return self.server.app.store_for(self.account['id'])

    def authorize(self, require_binding=True):
        self.account = self.server.app.user(self.headers.get('Cookie'))
        if self.account is None:
            self.reply(401, {'error': 'Войдите, чтобы открыть записи.'})
            return False
        binding = self.headers.get('X-Textdrop-User')
        if binding != self.account['id'] and (binding is not None or require_binding and self.account['id'] != 'owner'):
            self.reply(409, {'error': 'Учётная запись изменилась. Войди снова.', 'account_changed': True})
            return False
        return True

    timeout = 10
    json_read_timeout = 10

    def read_json_body(self, size):
        deadline = time.monotonic() + self.json_read_timeout
        chunks = []
        remaining = size
        try:
            while remaining:
                wait = deadline - time.monotonic()
                if wait <= 0:
                    raise TimeoutError()
                if hasattr(self.connection, "settimeout"):
                    self.connection.settimeout(wait)
                chunk = self.rfile.read1(min(65536, remaining))
                if not chunk:
                    raise ValueError()
                chunks.append(chunk); remaining -= len(chunk)
            return json.loads(b"".join(chunks)) if size else {}
        finally:
            if hasattr(self.connection, "settimeout"):
                self.connection.settimeout(self.timeout)

    def log_message(self, fmt, *args):
        # Never log passwords, request bodies, or note text.
        super().log_message(fmt, *args)

    def log_request(self, code='-', size='-'):
        self.log_message('"%s %s" %s %s', self.command, self.path.split('?')[0], str(code), str(size))

    def reply(self, status, data, cookie=None, content_type='application/json; charset=utf-8'):
        body = json.dumps(data, ensure_ascii=False).encode() if isinstance(data, (dict, list)) else data
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        if cookie:
            self.send_header('Set-Cookie', cookie)
        self.end_headers()
        self.wfile.write(body)

    def session_cookie(self, value, age):
        return f'session={value}; HttpOnly; SameSite=Strict; Path=/; Max-Age={age}' + ('; Secure' if self.server.app.secure else '')

    @database_errors
    def do_GET(self):
        path = self.path.split('?')[0]
        if path == '/api/session':
            user = self.server.app.user(self.headers.get('Cookie'))
            return self.reply(200, {'authenticated': bool(user), **({'user': user} if user else {})})
        if path.startswith('/api/'):
            if not self.authorize(require_binding=not path.startswith('/api/files/')):
                return
            if path == '/api/users':
                if self.account['role'] != 'admin':
                    return self.reply(403, {'error': 'Доступно только владельцу.'})
                return self.reply(200, {'users': self.server.app.accounts.users()})
            if path == '/api/storage':
                try:
                    return self.reply(200, self.store.storage())
                except sqlite3.Error:
                    return self.reply(503, {'error': 'Не удалось проверить хранилище.'})
            preview_match = re.fullmatch(r'/api/files/([a-f0-9]{32})/preview', path)
            if preview_match:
                return self.image_preview(preview_match[1])
            file_match = re.fullmatch(r'/api/files/([a-f0-9]{32})', path)
            if file_match:
                return self.download_file(file_match[1])
            if path in ('/api/notes/page', '/api/trash/page', '/api/notes/changes', '/api/trash/changes'):
                try:
                    params = parse_qs(urlsplit(self.path).query, keep_blank_values=True, errors='strict', max_num_fields=8)
                    changes = path.endswith('/changes')
                    allowed = {'q', 'limit', 'since' if changes else 'before'}
                    if any(key not in allowed or len(values) != 1 for key, values in params.items()):
                        raise ValueError('Некорректные параметры запроса.')
                    value = lambda key, default=None: params.get(key, [default])[0]
                    kwargs = dict(query=value('q', ''), limit=int(value('limit', str(PAGE_SIZE))), trash=path.startswith('/api/trash/'))
                    if changes:
                        result = self.store.changes(int(value('since', '-1')), **kwargs)
                    else:
                        result = self.store.page(before=value('before'), **kwargs)
                    return self.reply(200, result)
                except (ValueError, UnicodeDecodeError):
                    return self.reply(400, {'error': 'Некорректные параметры страницы или поиска.'})
                except sqlite3.Error:
                    return self.reply(503, {'error': 'Не удалось загрузить сообщения. Повторите попытку.'})
            note_match = re.fullmatch(r'/api/notes/([^/]+)', path)
            if note_match:
                try:
                    note = self.store.get(note_match[1])
                    return self.reply(200, note) if note else self.reply(404, {'error': 'Сообщение удалено.'})
                except sqlite3.Error:
                    return self.reply(503, {'error': 'Не удалось загрузить сообщение. Повторите попытку.'})
            if path in ('/api/notes', '/api/trash'):
                try:
                    records = self.store.trash() if path == '/api/trash' else self.store.notes()
                    return self.reply(200, records)
                except sqlite3.Error:
                    return self.reply(503, {'error': 'Не удалось загрузить сообщения. Повторите попытку.'})
            return self.reply(404, {'error': 'Не найдено.'})
        files = {'/': ('index.html', 'text/html'), '/app.js': ('app.js', 'text/javascript'), '/theme.js': ('theme.js', 'text/javascript'), '/draft.js': ('draft.js', 'text/javascript'), '/editor.js': ('editor.js', 'text/javascript'), '/links.js': ('links.js', 'text/javascript'), '/style.css': ('style.css', 'text/css')}
        if path not in files:
            return self.reply(404, {'error': 'Не найдено.'})
        name, mime = files[path]
        self.reply(200, (ROOT / 'static' / name).read_bytes(), content_type=mime + '; charset=utf-8')

    def image_preview(self, note_id):
        try:
            body = self.store.preview(note_id)
            if body is None:
                return self.reply(415, {'error': 'Для этого файла предпросмотр недоступен.'})
            etag = '"' + hashlib.sha256(body).hexdigest() + '"'
            unchanged = self.headers.get('If-None-Match') == etag
            self.send_response(304 if unchanged else 200)
            self.send_header('ETag', etag)
            self.send_header('Cache-Control', 'private, no-cache')
            self.send_header('Vary', 'Cookie')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Content-Type', 'image/jpeg')
            self.send_header('Content-Disposition', 'inline; filename=preview.jpg')
            self.send_header('Content-Security-Policy', "sandbox; default-src 'none'")
            self.send_header('Referrer-Policy', 'no-referrer')
            if not unchanged:
                self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            if not unchanged:
                self.wfile.write(body)
        except RequestGone as error:
            self.reply(404, {'error': str(error)})
        except (BrokenPipeError, ConnectionResetError):
            return
        except (PreviewBusy, sqlite3.Error, OSError):
            self.reply(503, {'error': 'Предпросмотр временно недоступен. Файл можно скачать.'})

    def download_file(self, note_id):
        started = False
        try:
            with self.store.download(note_id) as (record, blob):
                self.send_response(200)
                self.send_header('Content-Type', 'application/octet-stream')
                self.send_header('Content-Length', str(record['size']))
                self.send_header('Content-Disposition', "attachment; filename=download; filename*=UTF-8''" + quote(record['name'], safe=''))
                self.send_header('Cache-Control', 'no-store')
                self.send_header('X-Content-Type-Options', 'nosniff')
                self.send_header('Content-Security-Policy', "sandbox; default-src 'none'")
                self.send_header('Referrer-Policy', 'no-referrer')
                self.end_headers(); started = True
                while chunk := blob.read(65536):
                    self.wfile.write(chunk)
        except RequestGone as error:
            self.reply(404, {'error': str(error)})
        except (OSError, sqlite3.Error):
            if not started:
                self.reply(503, {'error': 'Не удалось скачать файл. Попробуй снова.'})

    def upload_file(self):
        app = self.server.app
        if not self.authorize():
            return
        if not app.uploads.acquire(blocking=False):
            return self.reply(429, {'error': 'Другие файлы ещё загружаются. Повтори отправку чуть позже.'})
        try:
            size = int(self.headers.get('Content-Length', '-1'))
            prefix = int(self.headers.get('X-Textdrop-Metadata-Length', '0'))
            if self.headers.get('Transfer-Encoding') or not 1 <= prefix <= LIMIT * 6 + 1024 or size < prefix:
                raise ValueError('Некорректный формат загрузки.')
            file_size = size - prefix
            if file_size > self.store.file_limit:
                raise UploadLimit('Файл превышает допустимый размер.')
            if hasattr(self.connection, 'settimeout'):
                self.connection.settimeout(120)
            meta = json.loads(self.rfile.read(prefix))
            if not isinstance(meta, dict):
                raise ValueError('Некорректные данные файла.')
            # Receive outside the write transaction, using the writable data volume.
            with tempfile.TemporaryFile(dir=Path(self.store.path).parent) as stream:
                remaining = file_size; digest = hashlib.sha256()
                while remaining:
                    chunk = self.rfile.read(min(65536, remaining))
                    if not chunk:
                        raise ValueError('Загрузка прервана. Повтори отправку.')
                    stream.write(chunk); digest.update(chunk); remaining -= len(chunk)
                stream.seek(0)
                if not self.authorize():
                    return
                note = self.store.add_file(stream, file_size, meta.get('name'), meta.get('text', ''), meta.get('request_id'), digest.hexdigest())
            self.reply(201, note)
        except UploadLimit as error:
            self.reply(413, {'error': str(error)})
        except RequestConflict as error:
            self.reply(409, {'error': str(error)})
        except RequestGone as error:
            self.reply(410, {'error': str(error)})
        except (ValueError, UnicodeDecodeError):
            self.reply(400, {'error': 'Некорректная или прерванная загрузка файла.'})
        except (OSError, sqlite3.Error):
            self.reply(503, {'error': 'Не удалось сохранить файл. Повтори отправку.'})
        finally:
            app.uploads.release()

    def do_POST(self):
        self.mutate()

    def do_DELETE(self):
        self.mutate()

    def do_PATCH(self):
        self.mutate()

    @database_errors
    def mutate(self):
        app = self.server.app
        # Reject cross-origin browser writes, including login/logout.
        origin = self.headers.get('Origin')
        if self.headers.get('Sec-Fetch-Site') == 'cross-site' or (origin and origin not in ('http://' + self.headers.get('Host', ''), 'https://' + self.headers.get('Host', ''))):
            return self.reply(403, {'error': 'Запрос с другого сайта отклонён.'})
        if not (self.path == '/api/login' and self.command == 'POST') and not self.authorize():
            return
        if self.path == '/api/files' and self.command == 'POST':
            return self.upload_file()
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if size < 0 or size > LIMIT * 6 + 100:
                return self.reply(413, {'error': 'Слишком большой текст.'})
            data = self.read_json_body(size)
            if not isinstance(data, dict):
                raise ValueError()
        except TimeoutError:
            self.close_connection = True
            return self.reply(408, {'error': 'Время получения запроса истекло.'})
        except (ValueError, UnicodeDecodeError):
            return self.reply(400, {'error': 'Некорректный запрос.'})
        if self.path == '/api/login' and self.command == 'POST':
            ip, now = self.client_address[0], time.monotonic()
            username = data.get('username', 'admin')
            key = (ip, username.strip().lower()[:32] if isinstance(username, str) else '')
            with app.lock:
                app.failures = {k: v for k, v in app.failures.items() if v[1] > now - 300}
                attempts, _ = app.failures.get(key, (0, now))
                if attempts >= 10 or sum(v[0] for v in app.failures.values()) >= 120:
                    return self.reply(429, {'error': 'Слишком много попыток. Подождите 5 минут.'})
                app.failures[key] = (attempts + 1, now)
            if not app.accounts.login_slots.acquire(blocking=False):
                return self.reply(429, {'error': 'Вход занят. Повтори через несколько секунд.'})
            try:
                with app.accounts.auth_lock:
                    user = app.accounts.check_login(username, data.get('password'))
                    if user is None:
                        return self.reply(401, {'error': 'Неверный логин или пароль.'})
                    token = app.token(user['id'])
            finally:
                app.accounts.login_slots.release()
            with app.lock:
                app.failures.pop(key, None)
            return self.reply(200, {'ok': True, 'user': user}, self.session_cookie(token, 30 * 86400))
        if not app.authenticated(self.headers.get('Cookie')):
            return self.reply(401, {'error': 'Войдите, чтобы открыть записи.'})
        try:
            if self.path == '/api/logout' and self.command == 'POST':
                app.accounts.revoke(app.cookie_token(self.headers.get('Cookie')))
                return self.reply(200, {'ok': True}, self.session_cookie('', 0))
            if self.path == '/api/password' and self.command == 'POST':
                with app.accounts.auth_lock:
                    current = app.accounts.get(self.account['id'])
                    if not password_matches(data.get('current_password'), current['password_hash']):
                        return self.reply(403, {'error': 'Текущий пароль неверен.'})
                    app.accounts.change_password(self.account['id'], data.get('password'))
                return self.reply(200, {'ok': True}, self.session_cookie('', 0))
            if self.path == '/api/users' or self.path.startswith('/api/users/'):
                if self.account['role'] != 'admin':
                    return self.reply(403, {'error': 'Доступно только владельцу.'})
                if self.path == '/api/users' and self.command == 'POST':
                    user = app.accounts.create(data.get('username'), data.get('password'))
                    return self.reply(201, {'ok': True, 'user': user})
                match = re.fullmatch(r'/api/users/([a-f0-9]{32})(/password)?', self.path)
                if not match or not app.accounts.get(match[1]):
                    return self.reply(404, {'error': 'Учётная запись не найдена.'})
                if match[2] and self.command == 'POST':
                    app.accounts.change_password(match[1], data.get('password'))
                    return self.reply(200, {'ok': True})
                if not match[2] and self.command == 'PATCH':
                    app.accounts.set_active(match[1], data.get('active'))
                    return self.reply(200, {'ok': True})
                return self.reply(404, {'error': 'Не найдено.'})
            if self.path == '/api/notes' and self.command == 'POST':
                return self.reply(201, self.store.add(data.get('text'), data.get('request_id')))
            restore_match = re.fullmatch(r'/api/trash/([^/]+)/restore', self.path)
            if restore_match and self.command == 'POST':
                return self.reply(200, self.store.restore(restore_match[1]))
            purge_match = re.fullmatch(r'/api/trash/([^/]+)', self.path)
            if purge_match and self.command == 'DELETE':
                if self.store.purge(purge_match[1]):
                    return self.reply(200, {'ok': True})
                return self.reply(404, {'error': 'Сообщение уже восстановлено или удалено окончательно.'})
            if self.path.startswith('/api/notes/') and self.command == 'PATCH':
                note = self.store.edit(self.path.removeprefix('/api/notes/'), data.get('text'), data.get('version'))
                return self.reply(200, note)
            if self.path.startswith('/api/notes/') and self.command == 'DELETE':
                deleted = self.store.delete(self.path.removeprefix('/api/notes/'))
                return self.reply(200 if deleted else 404, {'ok': bool(deleted)})
            self.reply(404, {'error': 'Не найдено.'})
        except RequestConflict as exc:
            body = {'error': str(exc)}
            if isinstance(exc, EditConflict):
                body['current'] = exc.current
            self.reply(409, body)
        except RequestGone as exc:
            self.reply(410, {'error': str(exc)})
        except ValueError as exc:
            self.reply(400, {'error': str(exc)})
        except sqlite3.Error:
            self.reply(503, {'error': 'Не удалось сохранить изменения. Повторите попытку.'})


def configuration_secret(name):
    path = os.environ.get(name + '_FILE')
    return Path(path).read_text().rstrip('\r\n') if path else os.environ.get(name)


class TextdropServer(ThreadingHTTPServer):
    def __init__(self, *args, **kwargs):
        self.request_slots = threading.BoundedSemaphore(64)
        super().__init__(*args, **kwargs)

    def process_request(self, request, client_address):
        if not self.request_slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.request_slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.request_slots.release()

    def service_actions(self):
        # Expired items are immediately unavailable via the API; also remove them
        # physically when the trash is never opened. No external scheduler needed.
        now = time.monotonic()
        if now < getattr(self, '_next_cleanup', 0):
            return
        self._next_cleanup = now + 3600
        try:
            for user in self.app.accounts.users():
                if self.app.accounts.data_path(user['id']).exists():
                    self.app.store_for(user['id']).purge_expired()
        except sqlite3.Error:
            self._next_cleanup = now + 60
            print('Trash cleanup failed; retrying later.', file=sys.stderr, flush=True)


def main():
    password, secret = configuration_secret('TEXTDROP_PASSWORD'), configuration_secret('TEXTDROP_SECRET')
    if not password or len(password) < 12 or not secret or len(secret) < 32:
        raise SystemExit('Set TEXTDROP_PASSWORD (12+ characters) and TEXTDROP_SECRET (32+ characters).')
    data = Path(os.environ.get('TEXTDROP_DATA', ROOT / 'data'))
    data.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.umask(0o077)
    server = TextdropServer((os.environ.get('TEXTDROP_HOST', '127.0.0.1'), int(os.environ.get('TEXTDROP_PORT', '8765'))), Handler)
    server.app = App(Store(data / 'notes.sqlite3', int(os.environ.get('TEXTDROP_FILE_LIMIT', FILE_LIMIT)), int(os.environ.get('TEXTDROP_STORAGE_LIMIT', STORAGE_LIMIT))), password, secret, os.environ.get('TEXTDROP_SECURE') == '1')
    print('Textdrop listening on port', server.server_port, flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
