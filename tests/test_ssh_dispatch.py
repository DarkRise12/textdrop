from pathlib import Path
import os
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'deploy/ssh-dispatch.sh'


class DispatchTests(unittest.TestCase):
    def run_command(self, command):
        with tempfile.TemporaryDirectory() as directory:
            fake = Path(directory) / 'sudo'
            fake.write_text('#!/bin/sh\n[ "$3" != invalid ] || exit 2\nprintf "%s\\n" "$@"\n')
            fake.chmod(0o755)
            return subprocess.run(['bash', str(SCRIPT)], env=dict(os.environ, SSH_ORIGINAL_COMMAND=command, PATH=directory + ':' + os.environ['PATH']), capture_output=True, text=True, timeout=3)

    def test_only_exact_deploy_command_allowed(self):
        sha = 'a' * 40
        result = self.run_command('sudo -n /usr/local/sbin/textdrop-deploy ' + sha)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout.splitlines(), ['-n', '/usr/local/sbin/textdrop-deploy', sha])
        self.assertEqual(self.run_command('textdrop-probe').returncode, 0)

    def test_shell_commands_and_injection_rejected(self):
        for command in ['', 'bash', 'id', 'cat ~/.ssh/authorized_keys', 'sudo -n /usr/local/sbin/textdrop-deploy ' + 'a' * 40 + '; id', 'sudo -n /usr/local/sbin/textdrop-deploy $(id)', 'textdrop-probe; id']:
            with self.subTest(command=command):
                result = self.run_command(command)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stdout, '')
