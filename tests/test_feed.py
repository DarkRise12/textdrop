import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from urllib.parse import urlencode
from unittest.mock import patch
from server import Store, PAGE_SIZE, Handler
from backup import backup
from types import SimpleNamespace
from unittest.mock import Mock
import test_http


class FeedTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'notes.sqlite3'
        self.store = Store(self.path)

    def tearDown(self):
        self.tmp.cleanup()

    def seed(self, count, text='Текст'):
        with self.store.connect() as db:
            db.executemany('INSERT INTO notes VALUES (?, ?, ?)',
                           ((f'{i:032x}', f'{text} {i}', i // 4 + 1) for i in range(count)))

    def test_10000_records_initial_page_and_complete_stable_traversal(self):
        self.seed(10000)
        page = self.store.page()
        self.assertEqual(len(page['items']), PAGE_SIZE)
        self.assertEqual(page['total'], 10000)
        self.assertLess(len(json.dumps(page).encode()), 20000)
        seen = [n['id'] for n in page['items']]
        # Delete the cursor row and add a newer record between page requests.
        self.store.delete(page['items'][-1]['id'])
        added = self.store.add('After first page')
        while page['next']:
            page = self.store.page(before=page['next'])
            seen.extend(n['id'] for n in page['items'])
        self.assertEqual(len(seen), 10000)
        self.assertEqual(len(set(seen)), 10000)
        self.assertNotIn(added['id'], seen)
        self.assertEqual(seen, [f'{i:032x}' for i in reversed(range(10000))])

    def test_unicode_literal_substring_search_covers_unloaded_text_and_edits(self):
        self.seed(110)
        note = self.store.edit(f'{0:032x}', 'Старое сообщение: ЁЖИК 100% _ SQL\nStraße', 0)
        for query in ['ёжик', '100% _', 'STRASSE', 'сообщение: ёж']:
            result = self.store.page(query=query)
            self.assertEqual(result['matched'], 1, query)
            self.assertEqual(result['total'], 110)
            self.assertEqual(result['items'], [note])
        self.assertEqual(self.store.page(query="' OR 1=1 --")['matched'], 0)
        self.store.delete(note['id'])
        self.assertEqual(self.store.page(query='ёжик')['matched'], 0)
        self.assertEqual(self.store.page(query='ёжик', trash=True)['matched'], 1)

    def test_pages_and_change_batches_have_byte_and_count_limits(self):
        for i in range(8):
            self.store.add(('😀' if i % 2 else '\x01') * 100000)
        first = self.store.page(limit=100)
        self.assertTrue(first['next'])
        self.assertLessEqual(len(json.dumps(first, ensure_ascii=False).encode()), 1000000)
        revision, ids = 0, set()
        while True:
            batch = self.store.changes(revision, limit=100)
            self.assertLessEqual(len(json.dumps(batch, ensure_ascii=False).encode()), 1000000)
            self.assertGreater(batch['revision'], revision)
            ids.update(n['id'] for n in batch['items'])
            revision = batch['revision']
            if not batch['has_more']:
                break
        self.assertEqual(len(ids), 8)
        self.assertEqual(self.store.changes(revision)['items'], [])

    def test_changes_handle_edit_delete_restore_purge_restart_and_noop(self):
        note = self.store.add('original')
        revision = self.store.page()['revision']
        current = self.store.edit(note['id'], 'Изменено', 0)
        batch = self.store.changes(revision, query='исходный')
        self.assertEqual(batch['items'], [dict(current, matches=False)])
        revision = batch['revision']
        self.store.edit(note['id'], current['text'], 1)
        self.assertEqual(self.store.changes(revision)['revision'], revision)
        self.store.delete(note['id'])
        self.assertEqual(self.store.changes(revision)['removed'], [note['id']])
        trash_batch = self.store.changes(revision, trash=True)
        self.assertEqual(trash_batch['items'][0]['id'], note['id'])
        revision = trash_batch['revision']
        restored = self.store.restore(note['id'])
        self.assertEqual(Store(self.path).changes(revision)['items'], [dict(restored, matches=True)])
        self.assertEqual(self.store.changes(revision, trash=True)['removed'], [note['id']])
        self.store.delete(note['id']); revision = self.store.page(trash=True)['revision']
        self.store.purge(note['id'])
        self.assertEqual(self.store.changes(revision, trash=True)['removed'], [note['id']])
        self.assertEqual(self.store.changes(2 ** 40), {'reset': True})

    def test_legacy_migration_and_rollback_writes_are_tracked_without_schema_changes(self):
        legacy = Path(self.tmp.name) / 'legacy.sqlite3'
        with sqlite3.connect(legacy) as db:
            db.execute('CREATE TABLE notes (id TEXT PRIMARY KEY, text TEXT NOT NULL, created INTEGER NOT NULL)')
            db.execute("INSERT INTO notes VALUES ('legacy', 'kept', 1)")
        store = Store(legacy)
        self.assertEqual(store.page()['items'][0]['text'], 'kept')
        revision = store.page()['revision']
        with sqlite3.connect(legacy) as db:
            db.execute("UPDATE notes SET text = 'changed by old app' WHERE id = 'legacy'")
        self.assertEqual(store.changes(revision)['items'][0]['text'], 'changed by old app')
        with store.connect() as db:
            self.assertEqual([row[1] for row in db.execute('PRAGMA table_info(notes)')], ['id', 'text', 'created'])
            plan = ' '.join(str(tuple(row)) for row in db.execute('EXPLAIN QUERY PLAN SELECT * FROM notes WHERE (created,id) < (?,?) ORDER BY created DESC,id DESC LIMIT 50', (5, 'z')))
            self.assertIn('notes_chronology', plan)

    def test_backup_preserves_sync_state_and_changes(self):
        note = self.store.add('keep')
        revision = self.store.page()['revision']
        self.store.edit(note['id'], 'changed', 0)
        snapshot = backup(self.path, Path(self.tmp.name) / 'snapshot.sqlite3')
        restored = Store(snapshot)
        self.assertEqual(restored.page(), self.store.page())
        self.assertEqual(restored.changes(revision), self.store.changes(revision))

    def test_trash_ties_expiry_and_cursor_validation(self):
        self.seed(12)
        with patch('server.time.time', return_value=100):
            for note in self.store.notes():
                self.store.delete(note['id'])
            first = self.store.page(trash=True, limit=5)
            second = self.store.page(trash=True, limit=5, before=first['next'])
            self.assertEqual(len({n['id'] for n in first['items'] + second['items']}), 10)
            revision = second['revision']
        with patch('server.time.time', return_value=100 + 31 * 86400):
            self.assertEqual(self.store.page(trash=True)['total'], 0)
            self.assertEqual(len(self.store.changes(revision, trash=True)['removed']), 12)
        for value in ['', '!', 'x' * 300, 'e30', 'WzEsbnVsbF0']:
            with self.assertRaises(ValueError):
                self.store.page(before=value)
        for limit in [0, 101, True, '50']:
            with self.assertRaises(ValueError): self.store.page(limit=limit)
        with self.assertRaises(ValueError): self.store.page(query='x' * 257)


class FeedHttpTests(unittest.TestCase):
    setUp = test_http.HttpTests.setUp
    tearDown = test_http.HttpTests.tearDown
    request = test_http.HttpTests.request
    def test_request_log_omits_search_text_and_cursor(self):
        handler = SimpleNamespace(command='GET', path='/api/notes/page?q=private-search&before=private-cursor', log_message=Mock())
        Handler.log_request(handler, 200, 10)
        rendered = str(handler.log_message.call_args)
        self.assertIn('/api/notes/page', rendered)
        self.assertNotIn('private', rendered)

    def test_paginated_endpoints_auth_parameters_errors_and_legacy_compatibility(self):
        auth = {'Cookie': 'session=' + self.app.token()}
        note = self.app.store.add('Привет')
        for path in ['/api/notes/page', '/api/trash/page', '/api/notes/changes?since=0', '/api/trash/changes?since=0', '/api/notes/' + note['id']]:
            self.assertEqual(self.request('GET', path)[0], 401)
            self.assertEqual(self.request('GET', path, headers=auth)[0], 200)
        self.assertEqual(self.request('GET', '/api/notes', headers=auth)[2], [note])
        page = self.request('GET', '/api/notes/page?' + urlencode({'q': 'ПРИВЕТ'}), headers=auth)[2]
        self.assertEqual(page['matched'], 1)
        for params in ['limit=0', 'limit=101', 'before=garbage', 'q=' + 'x' * 257, 'q=a&q=b', 'unexpected=x']:
            self.assertEqual(self.request('GET', '/api/notes/page?' + params, headers=auth)[0], 400)
        for params in ['', 'since=-1', 'since=no', 'since=9007199254740992']:
            self.assertEqual(self.request('GET', '/api/notes/changes?' + params, headers=auth)[0], 400)
        with patch.object(self.app.store, 'page', side_effect=sqlite3.OperationalError('private')):
            status, _, body = self.request('GET', '/api/notes/page', headers=auth)
            self.assertEqual(status, 503); self.assertNotIn('private', body['error'])
