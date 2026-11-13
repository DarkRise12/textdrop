"""Account migration, authorization, isolation, revocation and shared quota."""
import hashlib
import io
import json
import secrets
from pathlib import Path
import sqlite3
import tarfile
import tempfile
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import struct
from PIL import Image

from backup import backup_all
from server import App, Store, UploadLimit
from test_http import MemorySocket, QuietHandler


class AccountTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.store = Store(self.root / 'notes.sqlite3', 100, 150)
        self.old = self.store.add('Existing owner history')
        self.app = App(self.store, 'owner-password', 'a' * 32)
        self.owner = self.auth('owner')
        self.alex = self.app.accounts.create('alex', 'alex-password')
        self.auth_alex = self.auth(self.alex['id'])

    def tearDown(self):
        self.tmp.cleanup()

    def auth(self, user_id):
        return {'Cookie': 'session=' + self.app.token(user_id), 'X-Textdrop-User': user_id}

    def request(self, method, path, body=None, auth=None, raw=None):
        payload = json.dumps(body).encode() if body is not None else raw or b''
        lines = [f'{method} {path} HTTP/1.1', 'Host: localhost', 'Connection: close', f'Content-Length: {len(payload)}']
        lines.extend(f'{k}: {v}' for k, v in (auth or {}).items())
        socket = MemorySocket(('\r\n'.join(lines) + '\r\n\r\n').encode() + payload)
        QuietHandler(socket, ('127.0.0.1', 1234), SimpleNamespace(app=self.app))
        head, content = socket.output.getvalue().split(b'\r\n\r\n', 1)
        return int(head.split()[1]), json.loads(content) if b'application/json' in head else content

    def file(self, user_id, content=b'hello'):
        return self.app.store_for(user_id).add_file(io.BytesIO(content), len(content), 'test.bin', '', secrets.token_hex(16), hashlib.sha256(content).hexdigest())

    def test_migration_and_registry_survive_restart(self):
        self.assertEqual(self.request('GET', '/api/notes', auth=self.owner)[1], [self.old])
        self.assertEqual(self.request('GET', '/api/notes', auth=self.auth_alex)[1], [])
        with self.app.accounts.connect() as db:
            values = str(db.execute('SELECT * FROM users').fetchall())
            self.assertNotIn('owner-password', values)
            encoded = db.execute("SELECT password_hash FROM users WHERE id='owner'").fetchone()[0]
            self.assertTrue(encoded.startswith('600000$'))
        self.app.accounts.change_password('owner', 'changed-owner-password')
        reopened = App(Store(self.store.path), 'owner-password', 'a' * 32)
        self.assertIsNone(reopened.accounts.check_login('admin', 'owner-password'))
        self.assertEqual(reopened.accounts.check_login('ADMIN', 'changed-owner-password')['id'], 'owner')
        self.assertEqual(reopened.store.notes(), [self.old])
        self.assertNotIn('password_hash', self.request('GET', '/api/users', auth=self.auth('owner'))[1]['users'][0])

    def test_owner_creates_users_and_users_have_no_admin_access(self):
        self.assertEqual(self.request('POST', '/api/users', {'username': 'bob', 'password': 'bob-password'}, self.auth_alex)[0], 403)
        self.assertEqual(self.request('GET', '/api/users', auth=self.auth_alex)[0], 403)
        self.assertEqual(self.request('POST', '/api/users', {'username': ' ALEX ', 'password': 'alex-password'}, self.owner)[0], 400)
        for username in ('../x', 'ab', '<script>', 'кириллица'):
            self.assertEqual(self.request('POST', '/api/users', {'username': username, 'password': 'test-password'}, self.owner)[0], 400)
        status, result = self.request('POST', '/api/users', {'username': 'BOB', 'password': 'bob-password'}, self.owner)
        self.assertEqual(status, 201)
        self.assertEqual(result['user']['username'], 'bob')
        self.assertEqual(result['user']['role'], 'user')
        self.assertEqual(self.request('POST', '/api/login', {'username': 'bob', 'password': 'bob-password'})[0], 200)
        self.assertEqual(self.request('POST', '/api/login', {'username': 'nobody', 'password': 'bob-password'})[0], 401)

    def test_content_counters_search_changes_and_idempotency_are_private(self):
        payload = {'text': 'secret alex', 'request_id': 'same-request-12345'}
        alex_note = self.request('POST', '/api/notes', payload, self.auth_alex)[1]
        owner_note = self.request('POST', '/api/notes', dict(payload, text='owner separate'), self.owner)[1]
        self.assertNotEqual(alex_note['id'], owner_note['id'])
        for path in ('/api/notes/page?q=owner', '/api/notes/changes?since=0&q=owner'):
            page = self.request('GET', path, auth=self.auth_alex)[1]
            self.assertEqual(page['total'], 1)
            self.assertEqual(page['matched'], 0)
            self.assertNotIn(self.old['id'], str(page))
        path = '/api/notes/' + self.old['id']
        self.assertEqual(self.request('GET', path, auth=self.auth_alex)[0], 404)
        self.assertEqual(self.request('PATCH', path, {'text': 'overwrite', 'version': 0}, self.auth_alex)[0], 410)
        self.assertEqual(self.request('DELETE', path, auth=self.auth_alex)[0], 404)
        self.assertEqual(self.store.notes()[1], self.old)
        self.store.delete(self.old['id'])
        self.assertEqual(self.request('GET', '/api/trash', auth=self.auth_alex)[1], [])
        self.assertEqual(self.request('POST', '/api/trash/' + self.old['id'] + '/restore', {}, self.auth_alex)[0], 410)
        self.assertEqual(self.request('DELETE', '/api/trash/' + self.old['id'], auth=self.auth_alex)[0], 404)
        self.assertEqual(len(self.store.trash()), 1)

    def test_files_previews_and_cross_tab_identity_are_private(self):
        file = self.file('owner')
        for suffix in ('', '/preview'):
            self.assertEqual(self.request('GET', '/api/files/' + file['id'] + suffix, auth=self.auth_alex)[0], 404)
        wrong = dict(self.auth_alex, **{'X-Textdrop-User': 'owner'})
        status, result = self.request('POST', '/api/notes', {'text': 'owner draft'}, wrong)
        self.assertEqual(status, 409)
        self.assertTrue(result['account_changed'])
        self.assertEqual(self.request('GET', '/api/notes', auth={'Cookie': self.auth_alex['Cookie']})[0], 409)
        self.assertEqual(self.request('GET', '/api/session', auth=self.auth_alex)[1]['user']['id'], self.alex['id'])
        self.assertEqual(self.app.store_for(self.alex['id']).notes(), [])

    def test_password_reset_disable_and_logout_revoke_sessions(self):
        other_device = self.auth(self.alex['id'])
        path = '/api/users/' + self.alex['id']
        self.assertEqual(self.request('POST', path + '/password', {'password': 'new-alex-password'}, self.owner)[0], 200)
        for auth in (self.auth_alex, other_device):
            self.assertEqual(self.request('GET', '/api/notes', auth=auth)[0], 401)
        self.assertIsNone(self.app.accounts.check_login('alex', 'alex-password'))
        auth = self.auth(self.alex['id'])
        self.assertEqual(self.request('PATCH', path, {'active': False}, self.owner)[0], 200)
        self.assertEqual(self.request('GET', '/api/notes', auth=auth)[0], 401)
        self.assertIsNone(self.app.accounts.check_login('alex', 'new-alex-password'))
        self.assertEqual(self.request('PATCH', path, {'active': True}, self.owner)[0], 200)
        self.assertIsNotNone(self.app.accounts.check_login('alex', 'new-alex-password'))
        auth = self.auth(self.alex['id'])
        self.assertEqual(self.request('POST', '/api/logout', {}, auth)[0], 200)
        self.assertEqual(self.request('GET', '/api/notes', auth=auth)[0], 401)
        with self.assertRaises(ValueError):
            self.app.accounts.set_active('owner', False)

    def test_own_password_change_requires_current_password_and_revokes_all(self):
        body = {'current_password': 'wrong', 'password': 'new-alex-password'}
        self.assertEqual(self.request('POST', '/api/password', body, self.auth_alex)[0], 403)
        body['current_password'] = 'alex-password'
        other_device = self.auth(self.alex['id'])
        self.assertEqual(self.request('POST', '/api/password', body, self.auth_alex)[0], 200)
        self.assertEqual(self.request('GET', '/api/notes', auth=other_device)[0], 401)
        self.assertIsNotNone(self.app.accounts.check_login('alex', 'new-alex-password'))

    def test_shared_quota_serializes_simultaneous_account_uploads(self):
        self.app.store_for(self.alex['id'])
        def upload(user_id):
            try:
                return self.file(user_id, b'x' * 100)
            except UploadLimit:
                return None
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(upload, ['owner', self.alex['id']]))
        self.assertEqual(sum(result is not None for result in results), 1)
        for user_id in ('owner', self.alex['id']):
            self.assertEqual(self.app.store_for(user_id).storage()['used_bytes'], 100)

    def test_backup_restores_accounts_all_content_and_files_without_sessions(self):
        alex_file = self.file(self.alex['id'])
        self.app.store_for(self.alex['id']).delete(alex_file['id'])
        bundle = backup_all(self.store.path, self.root / 'backup.tar.gz')
        restored_root = self.root / 'restored'
        restored_root.mkdir()
        with tarfile.open(bundle, 'r:gz') as archive:
            archive.extractall(restored_root, filter='data')
        restored = App(Store(restored_root / 'notes.sqlite3'), 'ignored-password', 'a' * 32)
        self.assertEqual(restored.store.notes(), [self.old])
        self.assertIsNotNone(restored.accounts.check_login('alex', 'alex-password'))
        self.assertIsNone(restored.user(self.owner['Cookie']))
        alex_store = restored.store_for(self.alex['id'])
        self.assertEqual(alex_store.trash()[0]['id'], alex_file['id'])
        with alex_store.download(alex_file['id']) as (_, blob):
            self.assertEqual(blob.read(), b'hello')
        with self.assertRaises(FileExistsError):
            backup_all(self.store.path, bundle)

    def test_shared_quota_also_counts_thumbnail_cache_across_users(self):
        self.store.storage_limit = 800
        self.file('owner', b'x' * 100)
        image = Image.new('RGB', (10, 10), 'red')
        source, preview = io.BytesIO(), io.BytesIO()
        image.save(source, format='PNG')
        image.save(preview, format='JPEG')
        body = source.getvalue()
        alex = self.app.store_for(self.alex['id'])
        note = alex.add_file(io.BytesIO(body), len(body), 'red.png', '', 'preview-request-1234', hashlib.sha256(body).hexdigest())
        result = SimpleNamespace(returncode=0, stdout=struct.pack('>II', 10, 10) + preview.getvalue())
        self.assertLess(len(body) + len(preview.getvalue()), 800)
        self.assertGreater(100 + len(body) + len(preview.getvalue()), 800)
        with patch('server.subprocess.run', return_value=result) as worker:
            self.assertIsNone(alex.preview(note['id']))
            self.assertIsNone(alex.preview(note['id']))
            self.assertEqual(worker.call_count, 1)
            for item in self.store.notes():
                self.store.delete(item['id']); self.store.purge(item['id'])
            self.assertEqual(alex.preview(note['id']), preview.getvalue())

    def test_registry_errors_return_json_without_database_details(self):
        with patch.object(self.app.accounts, 'resolve', side_effect=sqlite3.OperationalError('private-path')):
            for method, path, body in [('GET', '/api/session', None), ('GET', '/api/notes', None), ('POST', '/api/notes', {'text': 'later'})]:
                status, result = self.request(method, path, body, self.owner)
                self.assertEqual(status, 503)
                self.assertNotIn('private-path', result['error'])
        self.assertEqual(self.request('GET', '/api/notes', auth=self.owner)[1], [self.old])

    def test_seven_character_passwords_and_six_character_rejection(self):
        status, body = self.request('POST', '/api/users', {'username': 'short', 'password': 'abcdefg'}, self.owner)
        self.assertEqual(status, 201)
        user_id = body['user']['id']
        self.assertEqual(self.request('POST', '/api/login', {'username': 'short', 'password': 'abcdefg'})[0], 200)
        self.assertEqual(self.request('POST', '/api/users', {'username': 'six', 'password': 'abcdef'}, self.owner)[0], 400)
        path = '/api/users/' + user_id + '/password'
        self.assertEqual(self.request('POST', path, {'password': 'abcdef'}, self.owner)[0], 400)
        self.assertIsNotNone(self.app.accounts.check_login('short', 'abcdefg'))
        self.assertEqual(self.request('POST', path, {'password': 'gfedcba'}, self.owner)[0], 200)
        auth = self.auth(user_id)
        payload = {'current_password': 'gfedcba', 'password': 'abcdef'}
        self.assertEqual(self.request('POST', '/api/password', payload, auth)[0], 400)
        payload['password'] = 'newpass'
        self.assertEqual(self.request('POST', '/api/password', payload, auth)[0], 200)
        self.assertIsNotNone(self.app.accounts.check_login('short', 'newpass'))
