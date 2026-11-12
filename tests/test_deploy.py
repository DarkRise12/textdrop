"""Run the real deployment shell flow with a simulated Docker boundary."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SHA = 'a' * 40
FAKE = '''#!/usr/bin/python3
import os, pathlib, sys
args = sys.argv[1:]
root = pathlib.Path(os.environ['SIM_ROOT'])
with (root / 'calls').open('a') as out:
    out.write(' '.join(args) + '\\n')
if args[:3] == ['compose', 'ps', '-q']:
    print('container-id')
elif args[0] == 'inspect':
    if args[2] == '{{.Image}}':
        print('sha256:old-image')
    else:
        current = (root / 'image').read_text() if (root / 'image').exists() else 'old'
        print('unhealthy' if os.environ['SIM_FAIL'] == 'health' and current.startswith('textdrop-release:') else 'healthy')
elif args[:2] == ['image', 'inspect']:
    print('a' * 40)
elif args[:2] == ['compose', 'up']:
    (root / 'image').write_text(os.environ.get('TEXTDROP_IMAGE', ''))
'''


class DeploymentTests(unittest.TestCase):
    def simulate(self, failure):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'deploy').mkdir()
            (root / 'deploy/setup-docker-secrets.py').write_text('')
            (root / 'deploy/backup.sh').write_text('exit 1\n' if failure == 'backup' else 'exit 0\n')
            script = root / 'run.sh'
            script.write_text((ROOT / 'deploy/github-deploy.sh').read_text().replace('/home/darkrise/textdrop', str(root)))
            fake = root / 'docker'
            fake.write_text(FAKE)
            fake.chmod(0o755)
            shell_env = root / 'bash-env'
            shell_env.write_text('docker() { "$SIM_DOCKER" "$@"; }\nsleep() { :; }\n')
            env = dict(os.environ, BASH_ENV=str(shell_env), SIM_DOCKER=str(fake), SIM_ROOT=str(root), SIM_FAIL=failure)
            result = subprocess.run(['bash', str(script), SHA], env=env, input=b'', capture_output=True, timeout=10)
            calls = (root / 'calls').read_text()
            selection = root / '.deploy/image.env'
            return result, calls, selection.read_text() if selection.exists() else ''

    def test_success_persists_exact_revision(self):
        result, calls, selection = self.simulate('none')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('textdrop-release:' + SHA, selection)
        self.assertEqual(calls.count('compose up'), 1)

    def test_health_failure_restores_previous_image(self):
        result, calls, selection = self.simulate('health')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('textdrop-rollback:previous', selection)
        self.assertEqual(calls.count('compose up'), 2)
        self.assertIn(b'Previous image restored', result.stderr)

    def test_failed_backup_never_replaces_container(self):
        result, calls, selection = self.simulate('backup')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('compose up', calls)
        self.assertEqual(selection, '')
