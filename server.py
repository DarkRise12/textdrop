"""Textdrop: private shared text storage, using Python's standard library."""
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import time
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LIMIT = 100_000


class RequestConflict(ValueError):
    pass


class RequestGone(ValueError):
    pass


class Store:
    def __init__(self, path):
        self.path = path
        with self.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, text TEXT NOT NULL, created INTEGER NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS send_requests (request_id TEXT PRIMARY KEY, note_id TEXT NOT NULL, text_hash TEXT NOT NULL)')

    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        return db

    def notes(self):
        with self.connect() as db:
            return [dict(row) for row in db.execute('SELECT * FROM notes ORDER BY created DESC, rowid DESC')]

    def add(self, text, request_id=None):
        if not isinstance(text, str) or not text.strip() or len(text) > LIMIT:
            raise ValueError('Введите текст длиной от 1 до 100 000 символов.')
        if request_id is not None and (not isinstance(request_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{16,80}', request_id)):
            raise ValueError('Некорректный идентификатор отправки.')
        digest = hashlib.sha256(text.encode()).hexdigest()
        note = dict(id=secrets.token_hex(16), text=text, created=int(time.time() * 1000))
        with self.connect() as db:
            # Serializes check-and-insert across threads/processes, not just this App.
            db.execute('BEGIN IMMEDIATE')
            if request_id is not None:
                previous = db.execute('SELECT note_id, text_hash FROM send_requests WHERE request_id = ?', (request_id,)).fetchone()
                if previous:
                    if previous['text_hash'] != digest:
                        raise RequestConflict('Этот идентификатор уже использован для другого текста.')
                    existing = db.execute('SELECT * FROM notes WHERE id = ?', (previous['note_id'],)).fetchone()
                    if existing is None:
                        raise RequestGone('Сообщение уже было отправлено и удалено. Повтор не восстановит его.')
                    return dict(existing)
            db.execute('INSERT INTO notes VALUES (:id, :text, :created)', note)
            if request_id is not None:
                db.execute('INSERT INTO send_requests VALUES (?, ?, ?)', (request_id, note['id'], digest))
        return note

    def delete(self, note_id):
        with self.connect() as db:
            return db.execute('DELETE FROM notes WHERE id = ?', (note_id,)).rowcount > 0


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
            if path == '/api/notes':
                try:
                    return self.reply(200, self.server.app.store.notes())
                except sqlite3.Error:
                    return self.reply(503, {'error': 'Не удалось загрузить сообщения. Повторите попытку.'})
            return self.reply(404, {'error': 'Не найдено.'})
        files = {'/': ('index.html', 'text/html'), '/app.js': ('app.js', 'text/javascript'), '/theme.js': ('theme.js', 'text/javascript'), '/draft.js': ('draft.js', 'text/javascript'), '/style.css': ('style.css', 'text/css')}
        if path not in files:
            return self.reply(404, {'error': 'Не найдено.'})
        name, mime = files[path]
        self.reply(200, (ROOT / 'static' / name).read_bytes(), content_type=mime + '; charset=utf-8')

    def do_POST(self):
        self.mutate()

    def do_DELETE(self):
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
            if self.path.startswith('/api/notes/') and self.command == 'DELETE':
                deleted = app.store.delete(self.path.removeprefix('/api/notes/'))
                return self.reply(200 if deleted else 404, {'ok': bool(deleted)})
            self.reply(404, {'error': 'Не найдено.'})
        except RequestConflict as exc:
            self.reply(409, {'error': str(exc)})
        except RequestGone as exc:
            self.reply(410, {'error': str(exc)})
        except ValueError as exc:
            self.reply(400, {'error': str(exc)})
        except sqlite3.Error:
            self.reply(503, {'error': 'Не удалось сохранить изменения. Повторите попытку.'})


def configuration_secret(name):
    path = os.environ.get(name + '_FILE')
    return Path(path).read_text().rstrip('\r\n') if path else os.environ.get(name)


def main():
    password, secret = configuration_secret('TEXTDROP_PASSWORD'), configuration_secret('TEXTDROP_SECRET')
    if not password or len(password) < 12 or not secret or len(secret) < 32:
        raise SystemExit('Set TEXTDROP_PASSWORD (12+ characters) and TEXTDROP_SECRET (32+ characters).')
    data = Path(os.environ.get('TEXTDROP_DATA', ROOT / 'data'))
    data.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.umask(0o077)
    server = ThreadingHTTPServer((os.environ.get('TEXTDROP_HOST', '127.0.0.1'), int(os.environ.get('TEXTDROP_PORT', '8765'))), Handler)
    server.app = App(Store(data / 'notes.sqlite3'), password, secret, os.environ.get('TEXTDROP_SECURE') == '1')
    print('Textdrop listening on port', server.server_port, flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
