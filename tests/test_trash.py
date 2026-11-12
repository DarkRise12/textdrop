from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
import io
import sqlite3
import tempfile
import unittest
from backup import backup
from server import Store, RequestGone, EditConflict, TextdropServer, TRASH_LIFETIME


class TrashTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'notes.sqlite3'
        self.store = Store(self.path)
        self.note = self.store.add('Original 😀', 'request-1234567890')

    def tearDown(self):
        self.tmp.cleanup()

    def test_delete_restore_keep_content_and_invalidate_stale_editors(self):
        edited = self.store.edit(self.note['id'], 'Updated', 0)
        self.assertTrue(self.store.delete(self.note['id']))
        self.assertEqual(self.store.notes(), [])
        trashed = Store(self.path).trash()[0]
        self.assertEqual(trashed['text'], edited['text'])
        self.assertEqual(trashed['expires'] - trashed['deleted'], TRASH_LIFETIME)
        with self.assertRaises(RequestGone):
            self.store.add('Original 😀', 'request-1234567890')
        restored = self.store.restore(self.note['id'])
        self.assertEqual(restored['id'], edited['id'])
        self.assertEqual(restored['created'], edited['created'])
        self.assertEqual(restored['updated'], edited['updated'])
        self.assertEqual(restored['version'], edited['version'] + 1)
        self.assertEqual(self.store.restore(self.note['id']), restored)
        self.assertEqual(self.store.trash(), [])
        with self.assertRaises(EditConflict):
            self.store.edit(self.note['id'], 'Stale text', edited['version'])
        self.assertEqual(self.store.add('Original 😀', 'request-1234567890'), restored)
        self.assertFalse(self.store.purge(self.note['id']))
        self.assertEqual(self.store.notes(), [restored])

    def test_retries_never_extend_retention_or_duplicate_restore(self):
        self.store.delete(self.note['id'])
        first = self.store.trash()[0]
        with patch('server.time.time', return_value=(first['deleted'] + 10000) / 1000):
            self.assertTrue(self.store.delete(self.note['id']))
        self.assertEqual(self.store.trash(), [first])
        with ThreadPoolExecutor(max_workers=4) as pool:
            restored = list(pool.map(lambda _: Store(self.path).restore(self.note['id']), range(4)))
        self.assertTrue(all(note == restored[0] for note in restored))
        self.assertEqual(len(self.store.notes()), 1)

    def test_expired_items_cannot_be_restored_and_are_purged(self):
        self.store.delete(self.note['id'])
        expires = self.store.trash()[0]['expires']
        with patch('server.time.time', return_value=expires / 1000):
            with self.assertRaises(RequestGone):
                self.store.restore(self.note['id'])
            self.assertEqual(self.store.trash(), [])
        with self.store.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM trash').fetchone()[0], 0)
        with self.assertRaises(RequestGone):
            self.store.add('Original 😀', 'request-1234567890')

    def test_permanent_delete_cannot_touch_active_records_or_resurrect(self):
        self.assertFalse(self.store.purge(self.note['id']))
        self.assertEqual(self.store.notes(), [self.note])
        self.store.delete(self.note['id'])
        self.assertTrue(self.store.purge(self.note['id']))
        self.assertFalse(self.store.purge(self.note['id']))
        self.assertEqual(self.store.trash(), [])
        with self.assertRaises(RequestGone):
            self.store.restore(self.note['id'])
        with self.assertRaises(RequestGone):
            self.store.add('Original 😀', 'request-1234567890')

    def test_restore_and_permanent_delete_race_does_not_delete_active_record(self):
        self.store.delete(self.note['id'])
        def restore():
            try:
                return Store(self.path).restore(self.note['id'])
            except RequestGone:
                return None
        with ThreadPoolExecutor(max_workers=2) as pool:
            restored = pool.submit(restore)
            purged = pool.submit(lambda: Store(self.path).purge(self.note['id']))
            result, removed = restored.result(), purged.result()
        self.assertEqual(self.store.trash(), [])
        self.assertEqual(len(self.store.notes()), 1 if result else 0)
        self.assertEqual(removed, result is None)

    def test_backup_keeps_trash_and_previous_app_cannot_see_deleted_records(self):
        self.store.delete(self.note['id'])
        with sqlite3.connect(self.path) as db:
            self.assertEqual(db.execute('SELECT * FROM notes').fetchall(), [])
        snapshot = backup(self.path, Path(self.tmp.name) / 'backup.sqlite3')
        restored = Store(snapshot)
        self.assertEqual(restored.trash(), self.store.trash())
        self.assertEqual(restored.restore(self.note['id'])['text'], self.note['text'])

    def test_periodic_cleanup_retries_without_exposing_sqlite_errors(self):
        server = TextdropServer.__new__(TextdropServer)
        server.app = SimpleNamespace(store=Mock())
        with patch('server.time.monotonic', return_value=100):
            server.service_actions(); server.service_actions()
        self.assertEqual(server.app.store.purge_expired.call_count, 1)
        server.app.store.purge_expired.side_effect = sqlite3.OperationalError('private-path')
        with patch('server.time.monotonic', return_value=3700), patch('server.sys.stderr', new_callable=io.StringIO) as stderr:
            server.service_actions()
            self.assertNotIn('private-path', stderr.getvalue())
        self.assertEqual(server._next_cleanup, 3760)
