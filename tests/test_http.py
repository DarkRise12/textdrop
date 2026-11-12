"""Exercise actual HTTP parsing/handlers using an in-memory socket adapter."""
import io
import json
import tempfile
import sqlite3
from unittest.mock import patch
import unittest
from pathlib import Path
from types import SimpleNamespace
from server import App, Handler, Store


class MemorySocket:
    def __init__(self, raw):
        self.input = io.BytesIO(raw)
        self.output = io.BytesIO()

    def makefile(self, *args):
        return self.input

    def sendall(self, data):
        self.output.write(data)


class QuietHandler(Handler):
    def log_message(self, *args):
        pass


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.app = App(Store(Path(self.tmp.name) / 'db'), 'correct-password', 'a' * 32, True)

    def tearDown(self):
        self.tmp.cleanup()

    def request(self, method, path, body=None, headers=None):
        payload = json.dumps(body).encode() if body is not None else b''
        lines = [f'{method} {path} HTTP/1.1', 'Host: localhost', 'Connection: close', f'Content-Length: {len(payload)}']
        lines.extend(f'{k}: {v}' for k, v in (headers or {}).items())
        sock = MemorySocket(('\r\n'.join(lines) + '\r\n\r\n').encode() + payload)
        QuietHandler(sock, ('127.0.0.1', 1234), SimpleNamespace(app=self.app))
        head, content = sock.output.getvalue().split(b'\r\n\r\n', 1)
        status = int(head.split()[1])
        return status, head.decode(), json.loads(content) if 'application/json' in head.decode() else content

    def test_complete_flow(self):
        self.assertEqual(self.request('GET', '/api/notes')[0], 401)
        self.assertEqual(self.request('POST', '/api/login', {'password': 'wrong'})[0], 401)
        status, headers, _ = self.request('POST', '/api/login', {'password': 'correct-password'})
        self.assertEqual(status, 200)
        self.assertIn('HttpOnly; SameSite=Strict', headers)
        self.assertIn('; Secure', headers)
        auth = {'Cookie': 'session=' + self.app.token()}
        status, _, note = self.request('POST', '/api/notes', {'text': 'Привет <script>'}, auth)
        self.assertEqual(status, 201)
        self.assertEqual(self.request('GET', '/api/notes', headers=auth)[2], [note])
        self.assertEqual(self.request('DELETE', '/api/notes/' + note['id'], headers=auth)[0], 200)
        self.assertEqual(self.request('GET', '/api/notes', headers=auth)[2], [])
        self.assertIn('Max-Age=0', self.request('POST', '/api/logout', headers=auth)[1])

    def test_send_retries_conflict_and_deleted_message(self):
        auth = {'Cookie': 'session=' + self.app.token()}
        payload = {'text': 'once', 'request_id': 'request-1234567890'}
        first = self.request('POST', '/api/notes', payload, auth)
        again = self.request('POST', '/api/notes', payload, auth)
        self.assertEqual(first[0], 201)
        self.assertEqual(first[2], again[2])
        self.assertEqual(len(self.request('GET', '/api/notes', headers=auth)[2]), 1)
        self.assertEqual(self.request('POST', '/api/notes', dict(payload, text='changed'), auth)[0], 409)
        self.request('DELETE', '/api/notes/' + first[2]['id'], headers=auth)
        self.assertEqual(self.request('POST', '/api/notes', payload, auth)[0], 410)
        self.assertEqual(self.request('POST', '/api/notes', payload)[0], 401)

    def test_database_errors_return_json_and_recovery_works(self):
        auth = {'Cookie': 'session=' + self.app.token()}
        original = self.app.store.add('keep')
        with patch.object(self.app.store, 'notes', side_effect=sqlite3.OperationalError('private db path')):
            status, headers, body = self.request('GET', '/api/notes', headers=auth)
            self.assertEqual(status, 503)
            self.assertIn('application/json', headers)
            self.assertNotIn('private db path', body['error'])
        self.assertEqual(self.request('GET', '/api/notes', headers=auth)[2], [original])
        with patch.object(self.app.store, 'add', side_effect=sqlite3.OperationalError('private db path')):
            status, _, body = self.request('POST', '/api/notes', {'text': 'later'}, auth)
            self.assertEqual(status, 503)
            self.assertNotIn('private db path', body['error'])
        self.assertEqual(self.request('GET', '/api/notes', headers=auth)[2], [original])

    def test_edit_requires_auth_and_expected_version(self):
        auth = {'Cookie': 'session=' + self.app.token()}
        note = self.app.store.add('original')
        path = '/api/notes/' + note['id']
        body = {'text': 'Исправлено <script>', 'version': 0}
        self.assertEqual(self.request('PATCH', path, body)[0], 401)
        self.assertEqual(self.request('PATCH', path, body, dict(auth, Origin='https://evil.test'))[0], 403)
        saved = self.request('PATCH', path, body, auth)
        self.assertEqual(saved[0], 200)
        self.assertEqual(saved[2]['text'], body['text'])
        self.assertEqual(self.request('PATCH', path, body, auth)[2], saved[2])
        status, _, conflict = self.request('PATCH', path, dict(body, text='different'), auth)
        self.assertEqual(status, 409)
        self.assertEqual(conflict['current'], saved[2])
        self.assertEqual(self.request('PATCH', path, {'text': 'missing version'}, auth)[0], 400)
        self.request('DELETE', path, headers=auth)
        self.assertEqual(self.request('PATCH', path, dict(body, version=1), auth)[0], 410)

    def test_trash_auth_restore_and_permanent_deletion(self):
        auth = {'Cookie': 'session=' + self.app.token()}
        note = self.app.store.add('Trash test')
        trash_path = '/api/trash/' + note['id']
        self.assertEqual(self.request('GET', '/api/trash')[0], 401)
        self.assertEqual(self.request('POST', trash_path + '/restore')[0], 401)
        self.assertEqual(self.request('DELETE', trash_path)[0], 401)
        self.assertEqual(self.request('DELETE', '/api/notes/' + note['id'], headers=auth)[0], 200)
        self.assertEqual(self.request('GET', '/api/notes', headers=auth)[2], [])
        self.assertEqual(self.request('GET', '/api/trash', headers=auth)[2][0]['id'], note['id'])
        self.assertEqual(self.request('POST', trash_path + '/restore', {}, dict(auth, Origin='https://evil.test'))[0], 403)
        restored = self.request('POST', trash_path + '/restore', {}, auth)
        self.assertEqual(restored[0], 200)
        self.assertEqual(restored[2]['id'], note['id'])
        self.assertEqual(self.request('DELETE', trash_path, headers=auth)[0], 404)
        self.assertEqual(len(self.request('GET', '/api/notes', headers=auth)[2]), 1)
        self.request('DELETE', '/api/notes/' + note['id'], headers=auth)
        self.assertEqual(self.request('DELETE', trash_path, headers=auth)[0], 200)
        self.assertEqual(self.request('POST', trash_path + '/restore', {}, auth)[0], 410)
        self.assertEqual(self.request('GET', '/api/trash', headers=auth)[2], [])

    def test_input_origin_and_routes(self):
        auth = {'Cookie': 'session=' + self.app.token()}
        self.assertEqual(self.request('POST', '/api/notes', {'text': ''}, auth)[0], 400)
        self.assertEqual(self.request('POST', '/api/login', {}, {'Origin': 'https://evil.test'})[0], 403)
        self.assertEqual(self.request('GET', '/../server.py')[0], 404)
        self.assertEqual(self.request('GET', '/')[0], 200)
        self.assertEqual(self.request('GET', '/app.js')[0], 200)
        self.assertEqual(self.request('GET', '/editor.js')[0], 200)
        status, headers, script = self.request('GET', '/theme.js')
        self.assertEqual(status, 200)
        self.assertIn('text/javascript', headers)
        self.assertIn(b'textdrop-theme', script)
        for _ in range(10):
            self.assertEqual(self.request('POST', '/api/login', {'password': 'wrong'})[0], 401)
        self.assertEqual(self.request('POST', '/api/login', {'password': 'correct-password'})[0], 429)
