import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('setup_secrets', Path(__file__).resolve().parents[1] / 'deploy/setup-docker-secrets.py')
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class SetupTests(unittest.TestCase):
    def test_fresh_setup_and_repeat_preserve_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / '.secrets'
            self.assertEqual(len(setup.check(root)), 2)
            with patch.object(setup.getpass, 'getpass', side_effect=['example-password'] * 2):
                setup.prepare(root)
            before = {p.name: p.read_bytes() for p in root.iterdir()}
            with patch.object(setup.getpass, 'getpass', side_effect=AssertionError('Unexpected prompt')):
                setup.prepare(root)
            self.assertEqual(before, {p.name: p.read_bytes() for p in root.iterdir()})
            self.assertEqual(setup.check(root), [])

    def test_repair_missing_session_preserves_password(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'password').write_text('existing-password')
            setup.prepare(root)
            self.assertEqual((root / 'password').read_text(), 'existing-password')
            self.assertEqual(setup.check(root), [])

    def test_mismatched_password_creates_no_partial_setup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / '.secrets'
            with patch.object(setup.getpass, 'getpass', side_effect=['example-password', 'different-password']):
                with self.assertRaises(ValueError):
                    setup.prepare(root)
            self.assertFalse(root.exists())

    def test_seven_character_password_minimum(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / '.secrets'
            with patch.object(setup.getpass, 'getpass', return_value='abcdef'):
                with self.assertRaises(ValueError):
                    setup.prepare(root)
            self.assertFalse(root.exists())
            with patch.object(setup.getpass, 'getpass', side_effect=['abcdefg'] * 2):
                setup.prepare(root)
            self.assertEqual(setup.check(root), [])
            self.assertEqual((root / 'password').read_text(), 'abcdefg')
            with patch.object(setup.getpass, 'getpass', side_effect=AssertionError('Unexpected prompt')):
                setup.prepare(root)
