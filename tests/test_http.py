"""Exercise actual HTTP parsing/handlers using an in-memory socket adapter."""
import io
import json
import tempfile
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

    def test_input_origin_and_routes(self):
        auth = {'Cookie': 'session=' + self.app.token()}
        self.assertEqual(self.request('POST', '/api/notes', {'text': ''}, auth)[0], 400)
        self.assertEqual(self.request('POST', '/api/login', {}, {'Origin': 'https://evil.test'})[0], 403)
        self.assertEqual(self.request('GET', '/../server.py')[0], 404)
        self.assertEqual(self.request('GET', '/')[0], 200)
        self.assertEqual(self.request('GET', '/app.js')[0], 200)
        for _ in range(10):
            self.assertEqual(self.request('POST', '/api/login', {'password': 'wrong'})[0], 401)
        self.assertEqual(self.request('POST', '/api/login', {'password': 'correct-password'})[0], 429)
