from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import sqlite3
import tempfile
import unittest
from backup import backup
from server import Store, EditConflict, RequestGone


class EditTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'notes.sqlite3'
        self.store = Store(self.path)
        self.note = self.store.add('Original', 'original-request-123456')

    def tearDown(self):
        self.tmp.cleanup()

    def test_edit_retains_identity_creation_and_order(self):
        latest = self.store.add('Later')
        edited = self.store.edit(self.note['id'], 'Исправлено\n<script>😀', 0)
        self.assertEqual(edited['id'], self.note['id'])
        self.assertEqual(edited['created'], self.note['created'])
        self.assertEqual(edited['version'], 1)
        self.assertIsInstance(edited['updated'], int)
        self.assertEqual(Store(self.path).notes(), [latest, edited])
        self.assertEqual(self.store.add('Original', 'original-request-123456'), edited)

    def test_stale_change_cannot_overwrite_current(self):
        latest = self.store.edit(self.note['id'], 'From second device', 0)
        with self.assertRaises(EditConflict) as conflict:
            self.store.edit(self.note['id'], 'Stale first device', 0)
        self.assertEqual(conflict.exception.current, latest)
        self.assertEqual(self.store.notes(), [latest])
        resolved = self.store.edit(self.note['id'], 'Explicit merged text', latest['version'])
        self.assertEqual(resolved['version'], 2)

    def test_concurrent_different_edits_have_one_winner(self):
        def edit(text):
            try:
                return Store(self.path).edit(self.note['id'], text, 0)
            except EditConflict:
                return None
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(edit, ['one', 'two']))
        winners = [note for note in results if note]
        self.assertEqual(len(winners), 1)
        self.assertEqual(self.store.notes(), winners)

    def test_lost_acknowledgement_retry_and_noop_do_not_increment_version(self):
        saved = self.store.edit(self.note['id'], 'Updated', 0)
        self.assertEqual(Store(self.path).edit(self.note['id'], 'Updated', 0), saved)
        self.assertEqual(self.store.edit(self.note['id'], 'Updated', 1), saved)
        # Even if the text later returns to the same value, an older version cannot overwrite it.
        self.store.edit(self.note['id'], 'Other', 1)
        current = self.store.edit(self.note['id'], 'Updated', 2)
        with self.assertRaises(EditConflict):
            self.store.edit(self.note['id'], 'Updated', 0)
        self.assertEqual(self.store.notes(), [current])

    def test_delete_and_invalid_input_never_create_or_modify_message(self):
        for text, version in [('', 0), ('   ', 0), (None, 0), ('x' * 100001, 0), ('ok', None), ('ok', True), ('ok', -1), ('ok', '0')]:
            with self.subTest(text_type=type(text), version=version):
                with self.assertRaises(ValueError):
                    self.store.edit(self.note['id'], text, version)
        self.assertEqual(self.store.notes(), [self.note])
        self.store.delete(self.note['id'])
        with self.assertRaises(RequestGone):
            self.store.edit(self.note['id'], 'Cannot resurrect', 0)
        self.assertEqual(self.store.notes(), [])

    def test_additive_migration_and_backup_preserve_versions(self):
        old = Path(self.tmp.name) / 'old.sqlite3'
        with sqlite3.connect(old) as db:
            db.execute('CREATE TABLE notes (id TEXT PRIMARY KEY, text TEXT NOT NULL, created INTEGER NOT NULL)')
            db.execute("INSERT INTO notes VALUES ('legacy', 'keep', 1)")
        upgraded = Store(old)
        self.assertEqual(upgraded.notes()[0]['version'], 0)
        changed = upgraded.edit('legacy', 'new', 0)
        snapshot = backup(old, Path(self.tmp.name) / 'backup.sqlite3')
        self.assertEqual(Store(snapshot).notes(), [changed])
        # The former app can still insert into the unchanged three-column notes table.
        with sqlite3.connect(old) as db:
            db.execute("INSERT INTO notes VALUES ('legacy-insert', 'still works', 2)")
        self.assertEqual(upgraded.notes()[0]['text'], 'still works')
