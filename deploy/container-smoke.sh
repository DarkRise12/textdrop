#!/bin/sh
# Disposable real-container checks; never uses an installation volume.
set -eu
image=${1:?image required}
platform=${2:-linux/amd64}
volume="textdrop-smoke-$(date +%s)-$$"
container="$volume"
cleanup() {
    docker rm -f "$container" >/dev/null 2>&1 || true
    docker volume rm "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM
docker volume create "$volume" >/dev/null
docker run -d --name "$container" --platform "$platform" --read-only \
    --cap-drop ALL --security-opt no-new-privileges:true \
    -e TEXTDROP_HOST=0.0.0.0 -e TEXTDROP_DATA=/data -e TEXTDROP_SECURE=0 \
    -e TEXTDROP_PASSWORD=test-password -e TEXTDROP_SECRET=test-session-secret-at-least-32-characters \
    -v "$volume:/data" "$image" >/dev/null
check() {
    docker exec -i "$container" python - "$1" <<'PYTHON'
import http.cookiejar
import json
import os
import sys
import time
import urllib.request
import urllib.error
base = 'http://127.0.0.1:8765'
for attempt in range(60):
    try:
        urllib.request.urlopen(base + '/api/session', timeout=2).close()
        break
    except (OSError, urllib.error.URLError):
        time.sleep(1)
else:
    raise SystemExit('Server startup failed')
assert os.getuid() == 10001
try:
    open('/app/smoke-must-not-write', 'w')
    raise AssertionError('Application filesystem is writable')
except OSError:
    pass
client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
def api(path, body=None):
    request = urllib.request.Request(base + path, data=None if body is None else json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
    with client.open(request, timeout=10) as response:
        return json.load(response)
assert api('/api/session') == {'authenticated': False}
user = api('/api/login', {'username': 'admin', 'password': 'test-password'})['user']
client.addheaders = [('X-Textdrop-User', user['id'])]
if sys.argv[1] == 'create':
    api('/api/notes', {'text': 'persistent container smoke', 'request_id': 'container-smoke-note'})
    api('/api/users', {'username': 'guest', 'password': 'guest-password'})
notes = api('/api/notes/page')
assert any(note['text'] == 'persistent container smoke' for note in notes['items'])
with client.open(base + '/sw.js') as response:
    assert b'__TEXTDROP_' not in response.read()
with client.open(base + '/manifest.webmanifest') as response:
    assert json.load(response)['display'] == 'standalone'
api('/api/logout', {})
client.addheaders = []
user = api('/api/login', {'username': 'guest', 'password': 'guest-password'})['user']
client.addheaders = [('X-Textdrop-User', user['id'])]
assert api('/api/notes/page')['items'] == []
print('PASS: non-root/read-only container, login, isolated accounts, persisted chat, PWA assets (' + sys.argv[1] + ')')
PYTHON
}
check create
docker restart "$container" >/dev/null
check restart
docker exec "$container" python backup.py /data/notes.sqlite3 /data/smoke-backup.tar.gz
docker exec "$container" python -c "import tarfile; a=tarfile.open('/data/smoke-backup.tar.gz'); assert {'accounts.sqlite3','notes.sqlite3'} <= set(a.getnames())"
