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
import time
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parent
PAGE_SIZE = 50
PAGE_MAX = 100
PAGE_BYTES = 900_000
SEARCH_LIMIT = 256
LIMIT = 100_000
TRASH_LIFETIME = 30 * 24 * 60 * 60 * 1000
NOTE_SELECT = '''SELECT n.id, n.text, n.created, COALESCE(v.version, 0) AS version,
                 v.updated FROM notes n LEFT JOIN note_versions v ON v.note_id = n.id'''


class RequestConflict(ValueError):
    pass


class RequestGone(ValueError):
    pass


class EditConflict(RequestConflict):
    def __init__(self, current):
        super().__init__('Сообщение изменено на другом устройстве. Сравни версии перед сохранением.')
        self.current = current


class Store:
    def __init__(self, path):
        self.path = path
        with self.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, text TEXT NOT NULL, created INTEGER NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS send_requests (request_id TEXT PRIMARY KEY, note_id TEXT NOT NULL, text_hash TEXT NOT NULL)')
            # Separate metadata keeps the original notes schema compatible with rollback.
            db.execute('CREATE TABLE IF NOT EXISTS note_versions (note_id TEXT PRIMARY KEY, version INTEGER NOT NULL, updated INTEGER NOT NULL)')
            db.execute('''CREATE TABLE IF NOT EXISTS trash (
                id TEXT PRIMARY KEY, text TEXT NOT NULL, created INTEGER NOT NULL,
                version INTEGER NOT NULL, updated INTEGER, deleted INTEGER NOT NULL, expires INTEGER NOT NULL)''')
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
            return [dict(row) for row in db.execute(NOTE_SELECT + ' ORDER BY n.created DESC, n.rowid DESC')]

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
            return 'SELECT * FROM trash n', 'trash n', 'n.deleted'
        return NOTE_SELECT, 'notes n', 'n.created'

    @staticmethod
    def feed_counts(db, table, query):
        total = db.execute('SELECT count(*) FROM ' + table).fetchone()[0]
        matched = db.execute('SELECT count(*) FROM ' + table + ' WHERE instr(casefold(n.text), ?) > 0', (query,)).fetchone()[0] if query else total
        return {'total': total, 'matched': matched}

    def page(self, query='', before=None, limit=PAGE_SIZE, trash=False):
        query = self.feed_params(query, limit)
        cursor = self.parse_cursor(before) if before is not None else None
        if trash:
            self.purge_expired()
        select, table, key = self.feed_source(trash)
        conditions, args = [], []
        if query:
            conditions.append('instr(casefold(n.text), ?) > 0'); args.append(query)
        if cursor:
            conditions.append(f'({key}, n.id) < (?, ?)'); args.extend(cursor)
        where = ' WHERE ' + ' AND '.join(conditions) if conditions else ''
        with self.connect() as db:
            db.execute('BEGIN')  # Rows, counts and revision belong to the same snapshot.
            revision = db.execute('SELECT revision FROM sync_state').fetchone()[0]
            records = db.execute(select + where + f' ORDER BY {key} DESC, n.id DESC LIMIT ?', (*args, limit + 1))
            items, size, more = [], 0, False
            for row in records:
                note = dict(row)
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
                note = dict(record) if record is not None else None
                if note is not None:
                    note['matches'] = not query or query in note['text'].casefold()
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
            return dict(row) if row else None

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
                    return dict(existing)
            db.execute('INSERT INTO notes VALUES (:id, :text, :created)', note)
            if request_id is not None:
                db.execute('INSERT INTO send_requests VALUES (?, ?, ?)', (request_id, note['id'], digest))
        return note

    def edit(self, note_id, text, version):
        if not isinstance(text, str) or not text.strip() or len(text) > LIMIT:
            raise ValueError('Введите текст длиной от 1 до 100 000 символов.')
        if type(version) is not int or version < 0:
            raise ValueError('Некорректная версия сообщения. Обнови историю и попробуй снова.')
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute(NOTE_SELECT + ' WHERE n.id = ?', (note_id,)).fetchone()
            if row is None:
                raise RequestGone('Сообщение удалено на другом устройстве. Правки не сохранены.')
            current = dict(row)
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
            return [dict(row) for row in db.execute('SELECT * FROM trash WHERE expires > ? ORDER BY deleted DESC, rowid DESC', (int(time.time() * 1000),))]

    def restore(self, note_id):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT * FROM trash WHERE id = ? AND expires > ?', (note_id, int(time.time() * 1000))).fetchone()
            if row is None:
                # Restoring again after a lost response is safe and does not bump the version.
                active = db.execute(NOTE_SELECT + ' WHERE n.id = ?', (note_id,)).fetchone()
                if active is not None:
                    return dict(active)
                raise RequestGone('Срок хранения истёк или сообщение удалено окончательно. Восстановить его нельзя.')
            note = dict(row)
            db.execute('INSERT INTO notes VALUES (:id, :text, :created)', note)
            # Invalidate editors opened before the deletion/restoration lifecycle.
            db.execute('INSERT INTO note_versions VALUES (?, ?, ?)', (note_id, note['version'] + 1, note['updated'] or 0))
            db.execute('DELETE FROM trash WHERE id = ?', (note_id,))
            return dict(db.execute(NOTE_SELECT + ' WHERE n.id = ?', (note_id,)).fetchone())

    def purge(self, note_id):
        with self.connect() as db:
            # Never delete an active message when restore and permanent delete race.
            return db.execute('DELETE FROM trash WHERE id = ?', (note_id,)).rowcount > 0


class App:
    def __init__(self, store, password, secret, secure=False):
        self.store, self.password, self.secret, self.secure = store, password, secret.encode(), secure
        self.failures = {}
        import threading
        self.lock = threading.Lock()

    def signature(self, expires):
        return hmac.new(self.secret, str(expires).encode(), hashlib.sha256).hexdigest()

    def token(self):
        expires = int(time.time()) + 30 * 86400
        return f'{expires}.{self.signature(expires)}'

    def authenticated(self, header):
        try:
            jar = cookies.SimpleCookie(header or '')
            expires, signature = jar['session'].value.split('.')
            return int(expires) > time.time() and hmac.compare_digest(signature, self.signature(expires))
        except (KeyError, ValueError, cookies.CookieError):
            return False


class Handler(BaseHTTPRequestHandler):
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

    def do_GET(self):
        path = self.path.split('?')[0]
        if path == '/api/session':
            return self.reply(200, {'authenticated': self.server.app.authenticated(self.headers.get('Cookie'))})
        if path.startswith('/api/'):
            if not self.server.app.authenticated(self.headers.get('Cookie')):
                return self.reply(401, {'error': 'Войдите, чтобы открыть записи.'})
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
                        result = self.server.app.store.changes(int(value('since', '-1')), **kwargs)
                    else:
                        result = self.server.app.store.page(before=value('before'), **kwargs)
                    return self.reply(200, result)
                except (ValueError, UnicodeDecodeError):
                    return self.reply(400, {'error': 'Некорректные параметры страницы или поиска.'})
                except sqlite3.Error:
                    return self.reply(503, {'error': 'Не удалось загрузить сообщения. Повторите попытку.'})
            note_match = re.fullmatch(r'/api/notes/([^/]+)', path)
            if note_match:
                try:
                    note = self.server.app.store.get(note_match[1])
                    return self.reply(200, note) if note else self.reply(404, {'error': 'Сообщение удалено.'})
                except sqlite3.Error:
                    return self.reply(503, {'error': 'Не удалось загрузить сообщение. Повторите попытку.'})
            if path in ('/api/notes', '/api/trash'):
                try:
                    records = self.server.app.store.trash() if path == '/api/trash' else self.server.app.store.notes()
                    return self.reply(200, records)
                except sqlite3.Error:
                    return self.reply(503, {'error': 'Не удалось загрузить сообщения. Повторите попытку.'})
            return self.reply(404, {'error': 'Не найдено.'})
        files = {'/': ('index.html', 'text/html'), '/app.js': ('app.js', 'text/javascript'), '/theme.js': ('theme.js', 'text/javascript'), '/draft.js': ('draft.js', 'text/javascript'), '/editor.js': ('editor.js', 'text/javascript'), '/links.js': ('links.js', 'text/javascript'), '/style.css': ('style.css', 'text/css')}
        if path not in files:
            return self.reply(404, {'error': 'Не найдено.'})
        name, mime = files[path]
        self.reply(200, (ROOT / 'static' / name).read_bytes(), content_type=mime + '; charset=utf-8')

    def do_POST(self):
        self.mutate()

    def do_DELETE(self):
        self.mutate()

    def do_PATCH(self):
        self.mutate()

    def mutate(self):
        app = self.server.app
        # Reject cross-origin browser writes, including login/logout.
        origin = self.headers.get('Origin')
        if self.headers.get('Sec-Fetch-Site') == 'cross-site' or (origin and origin not in ('http://' + self.headers.get('Host', ''), 'https://' + self.headers.get('Host', ''))):
            return self.reply(403, {'error': 'Запрос с другого сайта отклонён.'})
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if size < 0 or size > LIMIT * 6 + 100:
                return self.reply(413, {'error': 'Слишком большой текст.'})
            data = json.loads(self.rfile.read(size)) if size else {}
            if not isinstance(data, dict):
                raise ValueError()
        except (ValueError, UnicodeDecodeError):
            return self.reply(400, {'error': 'Некорректный запрос.'})
        if self.path == '/api/login' and self.command == 'POST':
            ip, now = self.client_address[0], time.monotonic()
            with app.lock:
                app.failures = {k: v for k, v in app.failures.items() if v[1] > now - 300}
                attempts, _ = app.failures.get(ip, (0, now))
                if attempts >= 10:
                    return self.reply(429, {'error': 'Слишком много попыток. Подождите 5 минут.'})
                password = data.get('password')
                if not isinstance(password, str) or not hmac.compare_digest(password.encode(), app.password.encode()):
                    app.failures[ip] = (attempts + 1, now)
                    return self.reply(401, {'error': 'Неверный пароль.'})
                app.failures.pop(ip, None)
            return self.reply(200, {'ok': True}, self.session_cookie(app.token(), 30 * 86400))
        if not app.authenticated(self.headers.get('Cookie')):
            return self.reply(401, {'error': 'Войдите, чтобы открыть записи.'})
        try:
            if self.path == '/api/logout' and self.command == 'POST':
                return self.reply(200, {'ok': True}, self.session_cookie('', 0))
            if self.path == '/api/notes' and self.command == 'POST':
                return self.reply(201, app.store.add(data.get('text'), data.get('request_id')))
            restore_match = re.fullmatch(r'/api/trash/([^/]+)/restore', self.path)
            if restore_match and self.command == 'POST':
                return self.reply(200, app.store.restore(restore_match[1]))
            purge_match = re.fullmatch(r'/api/trash/([^/]+)', self.path)
            if purge_match and self.command == 'DELETE':
                if app.store.purge(purge_match[1]):
                    return self.reply(200, {'ok': True})
                return self.reply(404, {'error': 'Сообщение уже восстановлено или удалено окончательно.'})
            if self.path.startswith('/api/notes/') and self.command == 'PATCH':
                note = app.store.edit(self.path.removeprefix('/api/notes/'), data.get('text'), data.get('version'))
                return self.reply(200, note)
            if self.path.startswith('/api/notes/') and self.command == 'DELETE':
                deleted = app.store.delete(self.path.removeprefix('/api/notes/'))
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
    def service_actions(self):
        # Expired items are immediately unavailable via the API; also remove them
        # physically when the trash is never opened. No external scheduler needed.
        now = time.monotonic()
        if now < getattr(self, '_next_cleanup', 0):
            return
        self._next_cleanup = now + 3600
        try:
            self.app.store.purge_expired()
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
    server.app = App(Store(data / 'notes.sqlite3'), password, secret, os.environ.get('TEXTDROP_SECURE') == '1')
    print('Textdrop listening on port', server.server_port, flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
