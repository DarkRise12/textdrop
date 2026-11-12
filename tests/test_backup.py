from pathlib import Path
import sqlite3
import tempfile
import unittest
from backup import backup
from server import Store


class BackupTests(unittest.TestCase):
    def test_restore_independent_snapshot_with_unicode(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'live.sqlite3'
            store = Store(source)
            first = store.add('Текст\n<script>😀')
            destination = Path(directory) / 'backup.sqlite3'
            backup(source, destination)
            store.delete(first['id'])
            store.add('After snapshot')
            restored = Store(destination)
            self.assertEqual(restored.notes(), [first])
            self.assertEqual(destination.stat().st_mode & 0o777, 0o600)

    def test_uncommitted_changes_are_not_included(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'live.sqlite3'
            store = Store(source)
            committed = store.add('Committed')
            with sqlite3.connect(source) as writer:
                writer.execute('PRAGMA journal_mode=WAL')
                writer.execute("INSERT INTO notes VALUES ('pending', 'Uncommitted', 1)")
                destination = backup(source, Path(directory) / 'snapshot.sqlite3')
                self.assertEqual(Store(destination).notes(), [committed])
                writer.rollback()

    def test_missing_source_and_existing_destination_are_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'live.sqlite3'
            destination = Path(directory) / 'existing.sqlite3'
            destination.write_bytes(b'keep me')
            with self.assertRaises(ValueError):
                backup(source, destination)
            self.assertFalse(source.exists())
            Store(source).add('Original')
            with self.assertRaises(FileExistsError):
                backup(source, destination)
            self.assertEqual(destination.read_bytes(), b'keep me')
            with self.assertRaises(ValueError):
                backup(source, source)
            self.assertEqual(Store(source).notes()[0]['text'], 'Original')
