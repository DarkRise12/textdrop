import hashlib
import io
import json
from pathlib import Path
import socket
import struct
import tempfile
import threading
import time
from unittest.mock import patch
import unittest
from server import App, Handler, Store, TextdropServer


class AuditTests(unittest.TestCase):
    def test_preview_quota_failure_is_cached_and_retried_when_space_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            store = Store(Path(directory) / 'db')
            body = b'\xff\xd8\xffsynthetic'
            store.storage_limit = len(body) + 1
            note = store.add_file(io.BytesIO(body), len(body), 'a.jpg', '', 'audit-file-request', hashlib.sha256(body).hexdigest())
            packet = struct.pack('>II', 1, 1) + b'\xff\xd8jpeg\xff\xd9'
            with patch('server.subprocess.run') as run:
                run.return_value.returncode = 0; run.return_value.stdout = packet
                self.assertIsNone(store.preview(note['id']))
                self.assertIsNone(store.preview(note['id']))
                self.assertEqual(run.call_count, 1)
                store.storage_limit += 1024
                self.assertEqual(store.preview(note['id']), packet[8:])
                self.assertEqual(run.call_count, 2)

    def test_unauthenticated_body_is_not_read_and_login_has_absolute_deadline(self):
        class QuickHandler(Handler):
            timeout = .3
            json_read_timeout = .3
            def log_message(self, *args): pass
        with tempfile.TemporaryDirectory() as directory:
            server = TextdropServer(('127.0.0.1', 0), QuickHandler)
            server.app = App(Store(Path(directory) / 'db'), 'audit-test-password', 's' * 32)
            thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
            try:
                with socket.create_connection(server.server_address, timeout=2) as client:
                    client.sendall(b'POST /api/notes HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\n{')
                    self.assertIn(b'401', client.recv(4096).split(b'\r\n')[0])
                with socket.create_connection(server.server_address, timeout=2) as client:
                    client.sendall(b'POST /api/login HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\n{')
                    started = time.monotonic()
                    for _ in range(3):
                        time.sleep(.06); client.sendall(b' ')
                    self.assertIn(b'408', client.recv(4096).split(b'\r\n')[0])
                    self.assertLess(time.monotonic() - started, 1.5)
                # An exhausted slot budget rejects a connection without starting a thread.
                for _ in range(64): server.request_slots.acquire()
                try:
                    with socket.create_connection(server.server_address, timeout=2) as client:
                        self.assertEqual(client.recv(1), b'')
                finally:
                    for _ in range(64): server.request_slots.release()
            finally:
                server.shutdown(); server.server_close(); thread.join(timeout=2)
