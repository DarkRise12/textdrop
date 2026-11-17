import io
from pathlib import Path
import tempfile
import unittest

import server
import test_http


class CategoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'notes.sqlite3'
        self.store = server.Store(self.path)

    def tearDown(self):
        self.tmp.cleanup()

    def test_membership_idempotency_delta_search_pagination_and_editor_independence(self):
        work = server.CATEGORIES[1]
        idea = server.CATEGORIES[3]
        note = self.store.add('Найти важный текст')
        old = self.store.page()['revision']
        self.store.mark_category(note['id'], work['id'], True)
        self.store.mark_category(note['id'], idea['id'], True)
        marked = self.store.get(note['id'])
        self.assertEqual(set(marked['categories']), {work['id'], idea['id']})
        self.assertEqual(marked['version'], note['version'])
        self.assertEqual(marked['updated'], note['updated'])
        revision = self.store.page()['revision']
        self.store.mark_category(note['id'], idea['id'], True)
        self.assertEqual(self.store.page()['revision'], revision)
        self.assertEqual(self.store.page(query='важный', category=work['id'])['matched'], 1)
        self.assertEqual(self.store.page(query='missing', category=work['id'])['matched'], 0)
        self.assertTrue(self.store.changes(old, category=idea['id'])['items'][0]['matches'])
        self.store.mark_category(note['id'], idea['id'], False)
        self.assertFalse(self.store.changes(revision, category=idea['id'])['items'][0]['matches'])
        self.store.edit(note['id'], 'Изменено', note['version'])
        self.assertEqual(self.store.get(note['id'])['categories'], [work['id']])
        for index in range(7):
            item = self.store.add(str(index))
            self.store.mark_category(item['id'], work['id'], True)
        page = self.store.page(category=work['id'], limit=3)
        self.assertEqual((len(page['items']), page['matched'], page['total']), (3, 8, 8))
        second = self.store.page(category=work['id'], limit=3, before=page['next'])
        self.assertFalse({n['id'] for n in page['items']} & {n['id'] for n in second['items']})

    def test_trash_restore_purge_and_legacy_rollback_triggers(self):
        category = server.CATEGORIES[2]
        note = self.store.add('original')
        self.store.mark_category(note['id'], category['id'], True)
        self.store.delete(note['id'])
        self.assertEqual(self.store.page(trash=True, category=category['id'])['matched'], 1)
        with self.assertRaises(server.RequestGone):
            self.store.mark_category(note['id'], category['id'], False)
        self.store.restore(note['id'])
        self.assertEqual(self.store.get(note['id'])['categories'], [category['id']])
        self.store.delete(note['id'])
        self.store.purge(note['id'])
        with self.store.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM note_categories').fetchone()[0], 0)
        self.assertEqual(server.Store(self.path).categories(), list(server.CATEGORIES))

    def test_predefined_categories_and_invalid_values(self):
        self.assertEqual(self.store.categories(), list(server.CATEGORIES))
        note = self.store.add('original')
        with self.assertRaises(ValueError):
            self.store.mark_category(note['id'], '0'*32, True)
        with self.assertRaises(ValueError):
            self.store.mark_category(note['id'], server.CATEGORIES[0]['id'], 'true')
        with self.assertRaises(ValueError):
            self.store.page(category="' OR 1=1")
        for category in server.CATEGORIES:
            self.store.mark_category(note['id'], category['id'], True)
        self.assertEqual(len(self.store.get(note['id'])['categories']), len(server.CATEGORIES))

    def test_backup_contains_categories_and_memberships(self):
        import backup
        category = server.CATEGORIES[0]
        note = self.store.add_file(io.BytesIO(b'file'), 4, 'a.txt', '', 'category-file-request', server.hashlib.sha256(b'file').hexdigest())
        self.store.mark_category(note['id'], category['id'], True)
        destination = Path(self.tmp.name) / 'backup.sqlite3'
        backup.backup(self.path, destination)
        copy = server.Store(destination)
        self.assertEqual(copy.categories(), list(server.CATEGORIES))
        self.assertEqual(copy.page(category=category['id'])['items'][0]['file']['name'], 'a.txt')


class CategoryHTTPTests(unittest.TestCase):
    setUp = test_http.HttpTests.setUp
    tearDown = test_http.HttpTests.tearDown
    request = test_http.HttpTests.request

    def test_authorization_routes_binding_and_user_isolation(self):
        self.assertEqual(self.request('GET', '/api/categories')[0], 401)
        auth = {'Cookie': 'session=' + self.app.token()}
        category = server.CATEGORIES[1]
        self.assertEqual(self.request('GET', '/api/categories', headers=auth)[2], list(server.CATEGORIES))
        note = self.app.store.add('owner text')
        route = '/api/notes/' + note['id'] + '/categories/' + category['id']
        self.assertEqual(self.request('PATCH', route, {'active':True}, auth)[0], 200)
        self.assertEqual(self.request('PATCH', route, {'active':'true'}, auth)[0], 400)
        page = self.request('GET', '/api/notes/page?category=' + category['id'], headers=auth)
        self.assertEqual(page[2]['matched'], 1)
        user = self.app.accounts.create('guest', 'guest-password')
        guest = {'Cookie':'session='+self.app.token(user['id']), 'X-Textdrop-User':user['id']}
        self.assertEqual(self.request('GET', '/api/categories', headers=guest)[2], list(server.CATEGORIES))
        self.assertEqual(self.request('PATCH', route, {'active':True}, guest)[0], 410)
        self.assertEqual(self.request('GET', '/api/notes/page?category=' + category['id'], headers=guest)[2]['matched'], 0)
        self.assertEqual(self.request('GET', '/api/categories', headers={**auth,'X-Textdrop-User':user['id']})[0],409)
        self.assertEqual(self.request('POST', '/api/categories', {'name':'custom'}, auth)[0],404)
