import tempfile
import unittest
from pathlib import Path
from server import App, Store


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'notes.sqlite3'
        self.store = Store(self.path)

    def tearDown(self):
        self.tmp.cleanup()

    def test_persist_order_delete_and_unicode(self):
        first = self.store.add('Привет <script> & 😀\nвторая строка')
        second = self.store.add('Другой текст')
        reopened = Store(self.path)
        self.assertEqual(reopened.notes(), [second, first])
        self.assertTrue(reopened.delete(first['id']))
        self.assertTrue(reopened.delete(first['id']))
        self.assertEqual(reopened.notes(), [second])

    def test_invalid_text(self):
        for value in (None, '', '  \n', 123, 'x' * 100001):
            with self.assertRaises(ValueError):
                self.store.add(value)
        self.assertEqual(self.store.notes(), [])

    def test_session_integrity_expiry_and_secret_rotation(self):
        app = App(self.store, 'test-password', 'a' * 32)
        token = app.token()
        self.assertTrue(app.authenticated('session=' + token))
        for value in ('', 'session=x', 'session=' + token + 'x', 'session=1.' + app.signature(1)):
            self.assertFalse(app.authenticated(value))
        self.assertFalse(App(self.store, 'test-password', 'b' * 32).authenticated('session=' + token))


if __name__ == '__main__':
    unittest.main()
