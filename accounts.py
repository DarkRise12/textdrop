"""Account registry and revocable sessions. User content lives in separate databases."""
from contextlib import closing
import hashlib
import hmac
from pathlib import Path
import re
import secrets
import sqlite3
import threading
import time


def password_hash(password):
    if not isinstance(password, str) or not 7 <= len(password) <= 1024:
        raise ValueError('Пароль должен содержать от 7 до 1024 символов.')
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac('sha256', password.encode(), salt, 600000)
    return '600000$' + salt.hex() + '$' + digest.hex()


def password_matches(password, encoded):
    if not isinstance(password, str) or len(password) > 1024:
        return False
    try:
        iterations, salt, expected = encoded.split('$')
        actual = hashlib.pbkdf2_hmac('sha256', password.encode(), bytes.fromhex(salt), int(iterations))
        return hmac.compare_digest(actual.hex(), expected)
    except (ValueError, TypeError):
        return False


class Accounts:
    def __init__(self, owner_path, password, secret):
        self.owner_path = Path(owner_path)
        self.root = self.owner_path.parent
        self.path = self.root / 'accounts.sqlite3'
        self.secret = secret
        self.storage_lock = threading.RLock()
        self.auth_lock = threading.RLock()
        self.login_slots = threading.BoundedSemaphore(2)
        with closing(self.connect()) as db, db:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('''CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                password_hash TEXT NOT NULL, role TEXT NOT NULL, active INTEGER NOT NULL,
                created INTEGER NOT NULL)''')
            db.execute('''CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL)''')
            if not db.execute("SELECT 1 FROM users WHERE id='owner'").fetchone():
                db.execute("INSERT INTO users VALUES ('owner', 'admin', ?, 'admin', 1, ?)", (password_hash(password), int(time.time())))
        # Unknown users take the same password hashing path as existing users.
        self.dummy_hash = self.get('owner')['password_hash']

    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        return db

    @staticmethod
    def public(user):
        return {key: user[key] for key in ('id', 'username', 'role', 'active', 'created')}

    def get(self, user_id):
        with closing(self.connect()) as db:
            row = db.execute('SELECT * FROM users WHERE id=?', (user_id,)).fetchone()
            return dict(row) if row else None

    def users(self):
        with closing(self.connect()) as db:
            return [self.public(row) for row in db.execute('SELECT * FROM users ORDER BY created, username')]

    def create(self, username, password):
        if not isinstance(username, str) or not re.fullmatch(r'[a-z0-9][a-z0-9._-]{2,31}', username.strip().lower()):
            raise ValueError('Логин: 3–32 латинские буквы, цифры, точка, дефис или подчёркивание.')
        encoded = password_hash(password)
        user_id = secrets.token_hex(16)
        try:
            with closing(self.connect()) as db, db:
                db.execute('BEGIN IMMEDIATE')
                if db.execute('SELECT count(*) FROM users').fetchone()[0] >= 50:
                    raise ValueError('Достигнут лимит в 50 учётных записей.')
                db.execute('INSERT INTO users VALUES (?, ?, ?, \'user\', 1, ?)', (user_id, username.strip().lower(), encoded, int(time.time())))
        except sqlite3.IntegrityError:
            raise ValueError('Такой логин уже занят.') from None
        return self.public(self.get(user_id))

    def check_login(self, username, password):
        with closing(self.connect()) as db:
            row = db.execute('SELECT * FROM users WHERE username=? COLLATE NOCASE', (username.strip() if isinstance(username, str) else '',)).fetchone()
        valid = password_matches(password, row['password_hash'] if row else self.dummy_hash)
        return self.public(row) if valid and row and row['active'] else None

    def token_hash(self, token):
        return hmac.new(self.secret, token.encode(), hashlib.sha256).hexdigest()

    def issue(self, user_id='owner'):
        token = secrets.token_urlsafe(32)
        with closing(self.connect()) as db, db:
            db.execute('DELETE FROM sessions WHERE expires <= ?', (int(time.time()),))
            # Bound sessions per user; preserve the most recent devices.
            db.execute('DELETE FROM sessions WHERE user_id=? AND token_hash NOT IN (SELECT token_hash FROM sessions WHERE user_id=? ORDER BY expires DESC LIMIT 19)', (user_id, user_id))
            db.execute('INSERT INTO sessions VALUES (?, ?, ?)', (self.token_hash(token), user_id, int(time.time()) + 30 * 86400))
        return token

    def resolve(self, token):
        if not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9_-]{43}', token):
            return None
        with closing(self.connect()) as db:
            row = db.execute('''SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
                WHERE s.token_hash=? AND s.expires>? AND u.active=1''', (self.token_hash(token), int(time.time()))).fetchone()
        return self.public(row) if row else None

    def revoke(self, token):
        with closing(self.connect()) as db, db:
            db.execute('DELETE FROM sessions WHERE token_hash=?', (self.token_hash(token),))

    def change_password(self, user_id, password):
        encoded = password_hash(password)
        with self.auth_lock, closing(self.connect()) as db, db:
            db.execute('UPDATE users SET password_hash=? WHERE id=?', (encoded, user_id))
            db.execute('DELETE FROM sessions WHERE user_id=?', (user_id,))

    def set_active(self, user_id, active):
        if user_id == 'owner' or type(active) is not bool:
            raise ValueError('Владельца нельзя отключить.')
        with self.auth_lock, closing(self.connect()) as db, db:
            db.execute('UPDATE users SET active=? WHERE id=?', (int(active), user_id))
            db.execute('DELETE FROM sessions WHERE user_id=?', (user_id,))

    def data_path(self, user_id):
        if user_id == 'owner':
            return self.owner_path
        if not re.fullmatch(r'[a-f0-9]{32}', user_id):
            raise ValueError('Некорректная учётная запись.')
        return self.root / 'users' / user_id / 'notes.sqlite3'

    def other_bytes(self, own_path):
        total = 0
        for user in self.users():
            path = self.data_path(user['id'])
            if path == Path(own_path) or not path.exists():
                continue
            with closing(sqlite3.connect(path, timeout=10)) as db:
                total += db.execute('SELECT COALESCE((SELECT sum(size) FROM attachments),0) + COALESCE((SELECT sum(length(body)) FROM attachment_images),0)').fetchone()[0]
        return total
