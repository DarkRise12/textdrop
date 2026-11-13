import hashlib
import io
import json
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zlib
from PIL import Image
from backup import backup
from server import Store, RequestGone, PREVIEW_VERSION, PREVIEW_BYTE_LIMIT
import test_files


def picture(format='PNG', size=(96, 64), color='orange', **kwargs):
    output = io.BytesIO()
    with Image.new('RGB', size, color) as image:
        image.save(output, format=format, **kwargs)
    return output.getvalue()


class PreviewTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'db'
        self.store = Store(self.path)

    def tearDown(self):
        self.tmp.cleanup()

    def send(self, body, name='photo.bin'):
        return self.store.add_file(io.BytesIO(body), len(body), name, '', 'preview-' + hashlib.sha256(body).hexdigest(), hashlib.sha256(body).hexdigest())

    def test_supported_formats_sniff_content_and_cache_once(self):
        for format in ['JPEG', 'PNG', 'WEBP', 'GIF']:
            body = picture(format)
            note = self.send(body, name=format + '.bin')
            self.assertTrue(note['file']['preview'])
            real_run = subprocess.run
            with patch('server.subprocess.run', wraps=real_run) as run:
                preview = self.store.preview(note['id'])
                self.assertEqual(self.store.preview(note['id']), preview)
                self.assertEqual(run.call_count, 1)
            self.assertLessEqual(len(preview), PREVIEW_BYTE_LIMIT)
            with Image.open(io.BytesIO(preview)) as image:
                self.assertEqual(image.format, 'JPEG')
                self.assertLessEqual(max(image.size), 640)
            with self.store.download(note['id']) as (_, source):
                self.assertEqual(source.read(), body)

    def test_large_noisy_image_is_small_and_metadata_orientation_are_handled(self):
        raw = bytes((i * 73 + i // 7) % 256 for i in range(1800 * 1200 * 3))
        image = Image.frombytes('RGB', (1800, 1200), raw)
        output = io.BytesIO(); image.save(output, format='PNG'); image.close()
        note = self.send(output.getvalue())
        preview = self.store.preview(note['id'])
        self.assertLessEqual(len(preview), 100 * 1024)
        exif = Image.Exif(); exif[0x0112] = 6; exif[0x010e] = 'private metadata'
        rotated = self.send(picture('JPEG', size=(160, 80), exif=exif))
        with Image.open(io.BytesIO(self.store.preview(rotated['id']))) as result:
            self.assertEqual(result.size, (80, 160))
            self.assertEqual(len(result.getexif()), 0)
            self.assertNotIn('icc_profile', result.info)

    def test_corrupt_oversized_and_active_formats_fall_back_without_repeated_work(self):
        def chunk(kind, data):
            return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
        huge_png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 6000, 5000, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b'')) + chunk(b'IEND', b'')
        for body in [b'\xff\xd8\xffnot a photo', huge_png]:
            note = self.send(body)
            real_run = subprocess.run
            with patch('server.subprocess.run', wraps=real_run) as run:
                self.assertIsNone(self.store.preview(note['id']))
                self.assertIsNone(self.store.preview(note['id']))
                self.assertEqual(run.call_count, 1)
        note = self.send(b'<svg onload="alert(1)"></svg>', 'photo.png')
        self.assertNotIn('preview', note['file'])
        with patch('server.subprocess.run') as run:
            self.assertIsNone(self.store.preview(note['id']))
            run.assert_not_called()

    def test_cache_is_backed_up_counts_towards_quota_and_follows_trash(self):
        body = picture(); note = self.send(body)
        self.store.storage_limit = len(body) + 1
        self.assertIsNone(self.store.preview(note['id']))
        self.assertEqual(self.store.storage()['used_bytes'], len(body))
        self.store.storage_limit = 1024 * 1024
        preview = self.store.preview(note['id'])
        self.assertEqual(self.store.storage()['used_bytes'], len(body) + len(preview))
        snapshot = backup(self.path, Path(self.tmp.name) / 'snapshot')
        self.assertEqual(Store(snapshot).preview(note['id']), preview)
        self.store.delete(note['id']); self.assertEqual(self.store.preview(note['id']), preview)
        expires = self.store.trash()[0]['expires']
        self.store.restore(note['id']); self.assertEqual(self.store.preview(note['id']), preview)
        self.store.delete(note['id'])
        expires = self.store.trash()[0]['expires']
        with patch('server.time.time', return_value=(expires + 1) / 1000):
            with self.assertRaises(RequestGone): self.store.preview(note['id'])
        self.store.purge(note['id']); self.assertEqual(self.store.storage()['used_bytes'], 0)
        self.assertEqual(Store(snapshot).preview(note['id']), preview)

    def test_existing_files_are_backfilled_and_deletion_during_work_leaves_no_cache(self):
        note = self.send(picture())
        with self.store.connect() as db:
            db.execute('DELETE FROM attachment_images WHERE note_id=?', (note['id'],))
        reopened = Store(self.path)
        self.assertTrue(reopened.get(note['id'])['file']['preview'])
        real_run = subprocess.run
        def delete_during_work(*args, **kwargs):
            result = real_run(*args, **kwargs)
            reopened.delete(note['id']); reopened.purge(note['id'])
            return result
        with patch('server.subprocess.run', side_effect=delete_during_work):
            with self.assertRaises(RequestGone): reopened.preview(note['id'])
        self.assertFalse(reopened.preview_lock.locked())
        with reopened.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM attachment_images').fetchone()[0], 0)

    def test_concurrent_requests_share_one_generated_thumbnail(self):
        note = self.send(picture())
        real_run = subprocess.run
        with patch('server.subprocess.run', wraps=real_run) as run:
            with ThreadPoolExecutor(max_workers=3) as pool:
                results = list(pool.map(lambda _: self.store.preview(note['id']), range(3)))
            self.assertTrue(all(body == results[0] for body in results))
            self.assertEqual(run.call_count, 1)

    def test_worker_timeout_is_negative_cached(self):
        note = self.send(picture())
        with patch('server.subprocess.run', side_effect=subprocess.TimeoutExpired('preview', 8)) as run:
            self.assertIsNone(self.store.preview(note['id']))
            self.assertIsNone(self.store.preview(note['id']))
            self.assertEqual(run.call_count, 1)


class PreviewHttpTests(unittest.TestCase):
    setUp = test_files.FileHttpTests.setUp
    tearDown = test_files.FileHttpTests.tearDown
    request = test_files.FileHttpTests.request
    upload = test_files.FileHttpTests.upload

    def test_private_jpeg_and_conditional_cache_never_bypass_auth_or_deletion(self):
        status, _, body = self.upload(picture(), headers=self.auth)
        self.assertEqual(status, 201)
        note = json.loads(body); url = '/api/files/' + note['id'] + '/preview'
        self.assertEqual(self.request('GET', url)[0], 401)
        status, headers, preview = self.request('GET', url, headers=self.auth)
        self.assertEqual(status, 200); self.assertTrue(preview.startswith(b'\xff\xd8'))
        self.assertIn('Content-Type: image/jpeg', headers)
        self.assertIn('private, no-cache', headers); self.assertIn('Vary: Cookie', headers)
        self.assertIn('nosniff', headers)
        etag = next(line.split(': ', 1)[1] for line in headers.splitlines() if line.startswith('ETag:'))
        self.assertEqual(self.request('GET', url, headers=dict(self.auth, **{'If-None-Match': etag}))[0], 304)
        self.assertEqual(self.request('GET', url, headers={'If-None-Match': etag})[0], 401)
        self.app.store.delete(note['id']); self.app.store.purge(note['id'])
        self.assertEqual(self.request('GET', url, headers=dict(self.auth, **{'If-None-Match': etag}))[0], 404)
