from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import sqlite3
import tempfile
import unittest
from server import Store, RequestConflict, RequestGone


class IdempotencyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'notes.sqlite3'
        self.store = Store(self.path)
        self.key = 'request-1234567890'

    def tearDown(self):
        self.tmp.cleanup()

    def test_retry_after_restart_returns_same_message(self):
        first = self.store.add('Привет 😀', self.key)
        self.assertEqual(Store(self.path).add('Привет 😀', self.key), first)
        self.assertEqual(self.store.notes(), [first])

    def test_concurrent_requests_commit_one_note(self):
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: Store(self.path).add('same', self.key), range(12)))
        self.assertTrue(all(note == results[0] for note in results))
        self.assertEqual(len(self.store.notes()), 1)

    def test_intentional_repeat_and_key_conflict(self):
        self.store.add('same', self.key)
        self.store.add('same', 'request-abcdefghijk')
        with self.assertRaises(RequestConflict):
            self.store.add('different', self.key)
        self.assertEqual(len(self.store.notes()), 2)

    def test_deleted_message_is_never_recreated_by_retry(self):
        first = self.store.add('text', self.key)
        self.store.delete(first['id'])
        with self.assertRaises(RequestGone):
            Store(self.path).add('text', self.key)
        self.assertEqual(self.store.notes(), [])

    def test_upgrade_preserves_existing_notes_and_legacy_clients(self):
        other = Path(self.tmp.name) / 'old.sqlite3'
        with sqlite3.connect(other) as db:
            db.execute('CREATE TABLE notes (id TEXT PRIMARY KEY, text TEXT NOT NULL, created INTEGER NOT NULL)')
            db.execute("INSERT INTO notes VALUES ('old', 'keep', 1)")
        upgraded = Store(other)
        upgraded.add('new')
        self.assertEqual(upgraded.notes()[-1]['text'], 'keep')
        for key in ('', [], 'short', 'x' * 81):
            with self.assertRaises(ValueError):
                upgraded.add('bad', key)
