"""Public-only offline shell, automatic versions and install metadata."""
import base64
import hashlib
import json
from pathlib import Path
import re
import shutil
import tempfile
import unittest
from unittest.mock import patch
from PIL import Image

import server
import test_http


class PwaTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.app = server.App(server.Store(Path(self.tmp.name) / 'notes.sqlite3'), 'test-password', 's' * 32)

    def tearDown(self):
        self.tmp.cleanup()

    def request(self, *args, **kwargs):
        return test_http.HttpTests.request(self, *args, **kwargs)

    def test_manifest_icons_and_worker_are_public_and_correctly_typed(self):
        status, headers, body = self.request('GET', '/manifest.webmanifest')
        self.assertEqual(status, 200)
        self.assertIn('application/manifest+json', headers)
        manifest = json.loads(body)
        self.assertEqual(manifest['id'], '/')
        self.assertEqual(manifest['start_url'], '/')
        self.assertEqual(manifest['scope'], '/')
        self.assertEqual(manifest['display'], 'standalone')
        self.assertEqual({icon['sizes'] for icon in manifest['icons']}, {'192x192', '512x512'})
        for icon in manifest['icons']:
            self.assertEqual(self.request('GET', icon['src'])[0], 200)
            with Image.open(server.ROOT / 'static' / icon['src'].lstrip('/')) as image:
                self.assertEqual('x'.join(map(str, image.size)), icon['sizes'])
        status, headers, body = self.request('GET', '/sw.js')
        self.assertEqual(status, 200)
        self.assertIn('text/javascript', headers)
        self.assertIn('Cache-Control: no-store', headers)
        self.assertNotIn(b'__TEXTDROP_', body)

    def test_worker_contains_only_integrity_checked_public_resources(self):
        self.app.store.add('PRIVATE-CONTENT-NOT-FOR-CACHE')
        worker = self.app.worker.decode()
        assets = json.loads(re.search(r'const ASSETS = (.+);', worker)[1])
        self.assertEqual({asset['url'] for asset in assets}, set(server.STATIC_FILES))
        self.assertNotIn('PRIVATE-CONTENT-NOT-FOR-CACHE', worker)
        self.assertNotIn('/sw.js', {asset['url'] for asset in assets})
        for asset in assets:
            self.assertFalse(asset['url'].startswith('/api/'))
            body = (server.ROOT / 'static' / server.STATIC_FILES[asset['url']][0]).read_bytes()
            self.assertEqual(asset['integrity'], 'sha256-' + base64.b64encode(hashlib.sha256(body).digest()).decode())

    def test_any_asset_or_worker_change_updates_the_cache_version(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            shutil.copytree(server.ROOT / 'static', root / 'static')
            with patch('server.ROOT', root):
                initial = server.service_worker()
                self.assertEqual(initial, server.service_worker())
                path = root / 'static' / 'style.css'
                path.write_text(path.read_text() + '\n/* new release */\n')
                updated = server.service_worker()
                self.assertNotEqual(initial, updated)
                path = root / 'static' / 'sw.js'
                path.write_text(path.read_text() + '\n/* worker update */\n')
                self.assertNotEqual(updated, server.service_worker())
