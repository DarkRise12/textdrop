"""Atomic groups of 1–10 attachments, migration, retries and authorization."""
import hashlib
import io
import json
from pathlib import Path
import sqlite3
import tempfile
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
import unittest
from types import SimpleNamespace
import test_http
from PIL import Image

import test_files
from backup import backup
from server import App, Store, RequestGone, RequestConflict, UploadLimit


def payloads(contents):
    return [(io.BytesIO(body), len(body), name, hashlib.sha256(body).hexdigest()) for name, body in contents]


class MultiFileTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'notes.sqlite3'
        self.store = Store(self.path, 1024, 2000)
        self.contents = [('первый.txt', b'first'), ('Второй <script>.bin', b'\x00\xffsecond'), ('empty.txt', b'')]

    def tearDown(self):
        self.tmp.cleanup()

    def send(self, contents=None, text='Подпись', key='multiple-files-request'):
        return self.store.add_files(payloads(self.contents if contents is None else contents), text, key)

    def read_all(self, note, store=None):
        result = []
        for file in note.get('files', [dict(id=note['id'], **note['file'])]):
            with (store or self.store).download(file['id']) as (metadata, blob):
                result.append((metadata['name'], blob.read()))
        return result

    def test_ten_files_one_note_order_and_private_metadata(self):
        contents = [(str(i) + '.txt', bytes([i]) * i) for i in range(10)]
        note = self.send(contents)
        self.assertEqual(len(note['files']), 10)
        self.assertEqual(note['files'][0]['id'], note['id'])
        self.assertEqual(len({file['id'] for file in note['files']}), 10)
        self.assertEqual(self.store.notes(), [note])
        self.assertEqual(self.read_all(note), contents)
        self.assertEqual(self.store.storage()['used_bytes'], sum(map(lambda value: len(value[1]), contents)))
        self.assertNotIn('body', json.dumps(self.store.page()))
        self.assertEqual(self.store.edit(note['id'], '', 0)['files'], note['files'])

    def test_count_limit_and_total_quota_reject_without_partial_note(self):
        for files in ([], self.contents * 4):
            with self.assertRaises(ValueError):
                self.send(files)
        with self.assertRaises(UploadLimit):
            self.send([('big', b'x' * 1025)])
        with self.assertRaises(UploadLimit):
            self.send([('a', b'x' * 800), ('b', b'x' * 800), ('c', b'x' * 800)])
        self.assertEqual(self.store.notes(), [])
        self.assertEqual(self.store.storage()['used_bytes'], 0)

    def test_failed_second_file_rolls_back_first_and_retry_identifier(self):
        files = payloads(self.contents)
        files[1] = (io.BytesIO(b'truncated'), 20, 'bad', '0' * 64)
        with self.assertRaises(ValueError):
            self.store.add_files(files, '', 'multiple-files-request')
        self.assertEqual(self.store.notes(), [])
        self.assertEqual(self.store.storage()['used_bytes'], 0)
        with self.store.connect() as db:
            for table in ('attachments', 'attachment_groups', 'attachment_images', 'file_requests'):
                self.assertEqual(db.execute('SELECT count(*) FROM ' + table).fetchone()[0], 0)
        self.assertEqual(self.read_all(self.send()), self.contents)

    def test_reordered_retry_conflict_and_deleted_message(self):
        note = self.send()
        self.assertEqual(self.send(list(reversed(self.contents))), note)
        with self.assertRaises(RequestConflict):
            self.send(text='Changed caption')
        with self.assertRaises(RequestConflict):
            self.send([('первый.txt', b'FIRST'), *self.contents[1:]])
        self.store.delete(note['id'])
        with self.assertRaises(RequestGone):
            self.send()
        self.assertEqual(self.read_all(self.store.trash()[0]), self.contents)

    def test_search_pagination_and_changes_match_any_file_once(self):
        note = self.send([('same.txt', b'one'), ('same.txt', b'two'), ('УНИКАЛЬНЫЙ.bin', b'three')])
        for query in ('same', 'уникальный'):
            result = self.store.page(query=query, limit=1)
            self.assertEqual(result['matched'], 1)
            self.assertEqual(result['items'], [note])
            self.assertIsNone(result['next'])
            change = self.store.changes(0, query=query)
            self.assertTrue(change['items'][0]['matches'])
            self.assertEqual(change['total'], 1)
        self.store.delete(note['id'])
        self.assertEqual(self.store.page(query='уникальный', trash=True)['matched'], 1)

    def test_restore_expiry_and_sql_rollback_cleanup_all_files(self):
        note = self.send()
        self.store.delete(note['id']); self.store.restore(note['id'])
        self.assertEqual(self.read_all(note), self.contents)
        self.store.delete(note['id'])
        expires = self.store.trash()[0]['expires']
        with patch('server.time.time', return_value=expires / 1000):
            for file in note['files']:
                with self.assertRaises(RequestGone):
                    with self.store.download(file['id']):
                        pass
            self.store.purge_expired()
        self.assertEqual(self.store.storage()['used_bytes'], 0)
        other = self.send(key='another-files-request')
        with sqlite3.connect(self.path) as db:
            db.execute('DELETE FROM notes WHERE id=?', (other['id'],))
        self.assertEqual(self.store.storage()['used_bytes'], 0)
        with self.store.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM attachment_groups').fetchone()[0], 0)

    def test_preview_for_each_file_and_backup_restore(self):
        image = Image.new('RGB', (4, 4), 'red')
        png = io.BytesIO(); image.save(png, format='PNG')
        self.store.storage_limit = 100000
        note = self.send([('one.png', png.getvalue()), ('two.png', png.getvalue())])
        for file in note['files']:
            self.assertTrue(file['preview'])
            self.assertTrue(self.store.preview(file['id']).startswith(b'\xff\xd8'))
        self.store.delete(note['id'])
        snapshot = backup(self.path, Path(self.tmp.name) / 'snapshot.sqlite3')
        restored = Store(snapshot)
        self.assertEqual(self.read_all(restored.trash()[0], restored), [('one.png', png.getvalue()), ('two.png', png.getvalue())])
        self.store.purge(note['id'])
        self.assertEqual(self.store.storage()['used_bytes'], 0)
        with self.store.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM attachment_images').fetchone()[0], 0)

    def test_legacy_files_and_pending_retry_keep_their_url_and_fingerprint(self):
        body = b'old file'
        old = self.store.add_file(io.BytesIO(body), len(body), 'old.txt', '', 'legacy-file-request', hashlib.sha256(body).hexdigest())
        # A previous release has no grouping table; leave its original BLOB and metadata intact.
        with self.store.connect() as db:
            db.execute('DROP TABLE attachment_groups')
        restored = Store(self.path)
        self.assertEqual(restored.notes(), [old])
        self.assertEqual(restored.add_file(io.BytesIO(body), len(body), 'old.txt', '', 'legacy-file-request', hashlib.sha256(body).hexdigest()), old)
        self.assertEqual(self.read_all(old, restored), [('old.txt', body)])

    def test_concurrent_groups_do_not_exceed_shared_account_quota(self):
        app = App(self.store, 'test-password', 's' * 32)
        user = app.accounts.create('alex', 'test-password')
        def send(user_id):
            try:
                return app.store_for(user_id).add_files(payloads([('a', b'x' * 600), ('b', b'x' * 600)]), '', 'concurrent-files-request')
            except UploadLimit:
                return None
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(send, ['owner', user['id']]))
        self.assertEqual(sum(result is not None for result in results), 1)
        self.assertEqual(self.store.storage()['used_bytes'], 1200)


class MultiFileHttpTests(unittest.TestCase):
    def setUp(self):
        test_files.FileHttpTests.setUp(self)

    def tearDown(self):
        self.tmp.cleanup()

    def request(self, *args, **kwargs):
        return test_files.FileHttpTests.request(self, *args, **kwargs)

    def upload(self, contents=None, manifest=None, headers=None):
        contents = contents or [('one', b'first'), ('two', b'second')]
        meta = json.dumps({'files': manifest if manifest is not None else [{'name': name, 'size': len(body)} for name, body in contents], 'text': '', 'request_id': 'http-multiple-files-request'}).encode()
        return self.request('POST', '/api/files', meta + b''.join(body for _, body in contents), dict(headers or {}, **{'X-Textdrop-Metadata-Length': str(len(meta))}))

    def test_authorization_and_all_private_downloads(self):
        self.assertEqual(self.upload()[0], 401)
        self.assertEqual(self.upload(headers=dict(self.auth, Origin='https://evil.test'))[0], 403)
        status, _, raw = self.upload(headers=self.auth)
        self.assertEqual(status, 201)
        note = json.loads(raw)
        user = self.app.accounts.create('alex', 'test-password')
        other = {'Cookie': 'session=' + self.app.token(user['id']), 'X-Textdrop-User': user['id']}
        for file, expected in zip(note['files'], [b'first', b'second']):
            url = '/api/files/' + file['id']
            self.assertEqual(self.request('GET', url, headers=self.auth)[2], expected)
            self.assertEqual(self.request('GET', url)[0], 401)
            self.assertEqual(self.request('GET', url, headers=other)[0], 404)
            self.assertEqual(self.request('GET', url + '/preview', headers=other)[0], 404)

    def test_invalid_manifests_and_per_file_limit(self):
        for manifest in ([], [{'name': 'x', 'size': 0}] * 11, [{'name': 'x', 'size': -1}], [{'name': 'x', 'size': True}], [{'name': 'x', 'size': 1}], 'bad', [None]):
            self.assertEqual(self.upload(manifest=manifest, headers=self.auth)[0], 400)
        self.assertEqual(self.upload(manifest=[{'name': 'x', 'size': 1025}], headers=self.auth)[0], 413)
        self.assertEqual(self.app.store.notes(), [])

    def test_interrupted_second_body_leaves_no_note_or_temporary_files(self):
        meta = json.dumps({'files': [{'name': 'one', 'size': 5}, {'name': 'two', 'size': 6}], 'text': '', 'request_id': 'http-interrupted-group'}).encode()
        header = ('POST /api/files HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nCookie: ' + self.auth['Cookie'] + '\r\nContent-Length: ' + str(len(meta) + 11) + '\r\nX-Textdrop-Metadata-Length: ' + str(len(meta)) + '\r\n\r\n').encode()
        socket = test_http.MemorySocket(header + meta + b'firstse')
        opened = []
        original = tempfile.TemporaryFile
        def temporary(*args, **kwargs):
            stream = original(*args, **kwargs); opened.append(stream); return stream
        with patch('server.tempfile.TemporaryFile', side_effect=temporary):
            test_http.QuietHandler(socket, ('127.0.0.1', 1234), SimpleNamespace(app=self.app))
        self.assertEqual(int(socket.output.getvalue().split()[1]), 400)
        self.assertEqual(self.app.store.notes(), [])
        self.assertEqual(self.app.store.storage()['used_bytes'], 0)
        self.assertEqual(len(opened), 2)
        self.assertTrue(all(stream.closed for stream in opened))
