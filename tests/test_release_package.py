import hashlib
import importlib.util
from pathlib import Path
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('package_release', ROOT / 'deploy/package-release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleasePackageTests(unittest.TestCase):
    def test_install_bundle_allowlist_checksum_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = release.package('1.1.0', directory)
            digest = hashlib.sha256(archive.read_bytes()).hexdigest()
            self.assertEqual((Path(directory) / 'SHA256SUMS').read_text(), f'{digest}  {archive.name}\n')
            with tarfile.open(archive) as bundle:
                self.assertEqual(set(bundle.getnames()), set(release.FILES))
                self.assertTrue(all(member.isfile() and member.mode == 0o644 for member in bundle))
                compose = bundle.extractfile('compose.yaml').read().decode()
                self.assertNotIn('caddy_default', compose)
                self.assertNotIn('build:', compose)
                self.assertIn('127.0.0.1', compose)
                self.assertIn('ghcr.io/darkrise12/textdrop:1.1.0', compose)
                self.assertEqual(bundle.extractfile('LICENSE').read(), (ROOT / 'LICENSE').read_bytes())
            before = archive.read_bytes()
            with self.assertRaises(FileExistsError):
                release.package('1.1.0', directory)
            self.assertEqual(archive.read_bytes(), before)

    def test_invalid_or_unconfigured_version_creates_no_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            for version in ('v1.1.0', '../1.1.0', '2.0.0', '1.1.0-rc1'):
                with self.assertRaises(ValueError):
                    release.package(version, directory)
            self.assertEqual(list(Path(directory).iterdir()), [])
