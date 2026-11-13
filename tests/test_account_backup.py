"""Host backup verifier accepts legacy and multi-account containers."""
import io
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

from backup import backup_all
from server import App, Store


class HostBackupTests(unittest.TestCase):
    def test_legacy_and_account_bundle_pass_host_verification(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'deploy').mkdir()
            script = Path(__file__).resolve().parents[1] / 'deploy' / 'backup.sh'
            (root / 'deploy' / 'backup.sh').write_bytes(script.read_bytes())
            (root / 'docker').write_text('#!/bin/sh\ncat "$TEXTDROP_BACKUP_FIXTURE"\n')
            (root / 'docker').chmod(0o700)
            store = Store(root / 'notes.sqlite3')
            store.add('Synthetic history')
            legacy = backup_all(store.path, root / 'legacy.sqlite3')
            app = App(store, 'owner-password', 'a' * 32)
            user = app.accounts.create('alex', 'alex-password')
            app.store_for(user['id']).add('Another synthetic history')
            bundle = backup_all(store.path, root / 'accounts.tar.gz')
            env = dict(os.environ, PATH=str(root) + os.pathsep + os.environ['PATH'])
            for fixture, extension in [(legacy, '.sqlite3'), (bundle, '.tar.gz')]:
                env['TEXTDROP_BACKUP_FIXTURE'] = str(fixture)
                result = subprocess.run(['sh', str(root / 'deploy' / 'backup.sh')], env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(extension, result.stdout)
            self.assertEqual(len(list((root / 'backups').iterdir())), 2)
            for path in (root / 'backups').iterdir():
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            # A container must not be able to smuggle archive paths into host extraction.
            unsafe = root / 'unsafe.tar.gz'
            with tarfile.open(unsafe, 'w:gz') as archive:
                member = tarfile.TarInfo('../escape'); member.size = 4
                archive.addfile(member, io.BytesIO(b'nope'))
            env['TEXTDROP_BACKUP_FIXTURE'] = str(unsafe)
            result = subprocess.run(['sh', str(root / 'deploy' / 'backup.sh')], env=env, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(len(list((root / 'backups').iterdir())), 2)
            self.assertFalse((root.parent / 'escape').exists())
