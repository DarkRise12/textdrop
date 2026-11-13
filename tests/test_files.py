import hashlib
import io
import json
import sqlite3
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import test_http
from backup import backup
from server import Store, App, RequestGone, RequestConflict, UploadLimit


class FileTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'db'
        self.store = Store(self.path, file_limit=1024, storage_limit=1500)

    def tearDown(self):
        self.tmp.cleanup()

    def send(self, body=b'\x00\xffbinary\n', name='Тест.bin', text='', key='file-request-123456'):
        return self.store.add_file(io.BytesIO(body), len(body), name, text, key, hashlib.sha256(body).hexdigest())

    def read(self, note_id, store=None):
        with (store or self.store).download(note_id) as (metadata, blob):
            return metadata['name'], blob.read()

    def test_roundtrip_metadata_search_and_empty_caption_edit(self):
        note = self.send(text='Подпись <script>')
        self.assertEqual(self.read(note['id']), ('Тест.bin', b'\x00\xffbinary\n'))
        self.assertEqual(note['file']['size'], 9)
        self.assertEqual(self.store.page(query='ТЕСТ.BIN')['items'], [note])
        self.assertEqual(self.store.page(query='тест')['matched'], 1)
        self.assertNotIn('body', json.dumps(self.store.page()))
        changed = self.store.edit(note['id'], '', 0)
        self.assertEqual(changed['text'], '')
        self.assertEqual(changed['file'], note['file'])
        self.assertEqual(self.store.changes(0, query='ТЕСТ')['items'][0]['matches'], True)

    def test_empty_file_safe_name_and_attachment_headers_data(self):
        note = self.send(b'', name='../../папка\\имя\r\n.html')
        self.assertEqual(note['file']['name'], 'имя.html')
        self.assertEqual(self.read(note['id'])[1], b'')
        for name in ['', '..', '.', '\x00\n']:
            with self.assertRaises(ValueError): self.send(name=name, key='other-file-request')

    def test_retry_concurrency_conflict_and_deleted_file(self):
        with ThreadPoolExecutor(max_workers=3) as pool:
            results = list(pool.map(lambda _: self.send(), range(3)))
        self.assertTrue(all(note == results[0] for note in results))
        self.assertEqual(self.store.storage()['used_bytes'], 9)
        with self.assertRaises(RequestConflict): self.send(b'other')
        self.store.delete(results[0]['id'])
        with self.assertRaises(RequestGone): self.send()
        self.assertEqual(self.store.storage()['used_bytes'], 9)

    def test_limits_checksum_and_interrupted_upload_rollback(self):
        with self.assertRaises(UploadLimit): self.send(b'x' * 1025)
        first = self.send(b'x' * 1000)
        with self.assertRaises(UploadLimit): self.send(b'x' * 501, key='file-request-second')
        self.assertEqual(len(self.store.notes()), 1)
        for stream, size, digest in [(io.BytesIO(b'short'), 10, '0' * 64), (io.BytesIO(b'long'), 2, '0' * 64)]:
            with self.assertRaises(ValueError): self.store.add_file(stream, size, 'a', '', 'file-request-second', digest)
        self.assertEqual(self.store.storage()['used_bytes'], 1000)
        self.store.delete(first['id']); self.store.purge(first['id'])
        self.assertEqual(self.store.storage()['used_bytes'], 0)
        self.send(b'x' * 1000, key='file-request-third')

    def test_download_snapshot_allows_writes_and_concurrent_quota_is_atomic(self):
        note = self.send()
        with self.store.download(note['id']) as (_, blob):
            self.store.add('Write during download')
            self.assertEqual(blob.read(), b'\x00\xffbinary\n')
        def send(key):
            try:
                return self.send(b'x' * 1000, key=key)
            except UploadLimit:
                return None
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(send, ['quota-first-request', 'quota-second-request']))
        self.assertEqual(sum(result is not None for result in results), 1)
        self.assertEqual(self.store.storage()['used_bytes'], 1009)

    def test_trash_restore_purge_expiry_and_backup_include_bytes(self):
        note = self.send()
        self.store.delete(note['id'])
        self.assertEqual(self.store.trash()[0]['file'], note['file'])
        snapshot = backup(self.path, Path(self.tmp.name) / 'snapshot')
        restored = Store(snapshot)
        self.assertEqual(self.read(note['id'], restored), ('Тест.bin', b'\x00\xffbinary\n'))
        self.store.restore(note['id'])
        self.assertEqual(self.read(note['id'])[1], b'\x00\xffbinary\n')
        self.assertFalse(self.store.purge(note['id']))
        self.store.delete(note['id']); expires = self.store.trash()[0]['expires']
        with patch('server.time.time', return_value=expires / 1000):
            with self.assertRaises(RequestGone): self.read(note['id'])
            self.store.purge_expired()
        self.assertEqual(self.store.storage()['used_bytes'], 0)
        self.assertEqual(self.read(note['id'], restored)[1], b'\x00\xffbinary\n')
        # A rollback image's SQL deletion still cleans up bytes through the trigger.
        other = self.send(key='file-request-rollback')
        with sqlite3.connect(self.path) as db: db.execute('DELETE FROM notes WHERE id=?', (other['id'],))
        self.assertEqual(self.store.storage()['used_bytes'], 0)


class FileHttpTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.app = App(Store(Path(self.tmp.name) / 'db', 1024, 2048), 'correct-password', 's' * 32)
        self.auth = {'Cookie': 'session=' + self.app.token()}

    def tearDown(self): self.tmp.cleanup()

    def request(self, method, path, body=b'', headers=None):
        lines = [f'{method} {path} HTTP/1.1', 'Host: localhost', 'Connection: close', f'Content-Length: {len(body)}']
        lines += [f'{k}: {v}' for k, v in (headers or {}).items()]
        sock = test_http.MemorySocket(('\r\n'.join(lines) + '\r\n\r\n').encode() + body)
        test_http.QuietHandler(sock, ('127.0.0.1', 1234), SimpleNamespace(app=self.app))
        head, data = sock.output.getvalue().split(b'\r\n\r\n', 1)
        return int(head.split()[1]), head.decode(), data

    def upload(self, data=b'\x00\xffraw', name='Привет.html', headers=None, key='file-http-request-123'):
        meta = json.dumps(dict(name=name, text='', request_id=key)).encode()
        return self.request('POST', '/api/files', meta + data, dict(headers or {}, **{'X-Textdrop-Metadata-Length': str(len(meta))}))

    def test_auth_origin_binary_download_limits_and_retries(self):
        self.assertEqual(self.upload()[0], 401)
        self.assertEqual(self.upload(headers=dict(self.auth, Origin='https://evil.test'))[0], 403)
        status, _, raw = self.upload(headers=self.auth)
        self.assertEqual(status, 201)
        note = json.loads(raw); url = '/api/files/' + note['id']
        self.assertEqual(json.loads(self.upload(headers=self.auth)[2]), note)
        self.assertEqual(self.request('GET', url)[0], 401)
        status, head, body = self.request('GET', url, headers=self.auth)
        self.assertEqual(status, 200); self.assertEqual(body, b'\x00\xffraw')
        self.assertIn('application/octet-stream', head)
        self.assertIn("attachment; filename=download; filename*=UTF-8''", head)
        self.assertIn('nosniff', head); self.assertIn("sandbox; default-src 'none'", head)
        self.assertNotIn('Привет', head)
        self.assertEqual(self.upload(b'x' * 1025, headers=self.auth, key='file-http-request-456')[0], 413)
        self.assertEqual(self.request('POST', '/api/files', b'bad', self.auth)[0], 400)
        self.app.store.delete(note['id']); self.app.store.purge(note['id'])
        self.assertEqual(self.request('GET', url, headers=self.auth)[0], 404)
        self.assertEqual(self.request('GET', '/api/files/../../server.py', headers=self.auth)[0], 404)
        self.assertEqual(self.request('GET', '/api/storage')[0], 401)

    def test_concurrent_limit_rejects_without_consuming_request(self):
        self.app.uploads.acquire(); self.app.uploads.acquire()
        try: self.assertEqual(self.upload(headers=self.auth)[0], 429)
        finally: self.app.uploads.release(); self.app.uploads.release()
