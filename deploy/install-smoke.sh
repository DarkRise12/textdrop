#!/bin/sh
# Exercise the actual release bundle and Compose secrets in a disposable project.
set -eu
image=${1:?image required}
version=${2:-1.1.1}
work=$(mktemp -d)
project="textdrop-install-smoke-$$"
cleanup() {
    if [ -f "$work/install/compose.yaml" ]; then
        (cd "$work/install" && docker compose -p "$project" down -v) >/dev/null 2>&1 || true
    fi
    rm -rf "$work"
}
trap cleanup EXIT HUP INT TERM
python3 deploy/package-release.py "$version" "$work/assets"
mkdir "$work/install"
tar -xzf "$work/assets/textdrop-install-$version.tar.gz" -C "$work/install"
cd "$work/install"
# Synthetic password supplied to the real interactive helper; no installation data.
python3 - <<'PY'
from unittest.mock import patch
import runpy
with patch('getpass.getpass', return_value='install-test-password'):
    runpy.run_path('deploy/setup-docker-secrets.py', run_name='__main__')
PY
python3 deploy/setup-docker-secrets.py --check
printf 'TEXTDROP_IMAGE=%s\nTEXTDROP_SECURE=0\nTEXTDROP_PORT=18765\n' "$image" > .env
docker compose -p "$project" up -d --wait --wait-timeout 120
python3 - <<'PY'
import http.cookiejar
import json
import urllib.request
client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
base = 'http://127.0.0.1:18765'
assert json.load(client.open(base + '/api/session')) == {'authenticated': False}
request = urllib.request.Request(base + '/api/login', data=json.dumps({'username': 'admin', 'password': 'install-test-password'}).encode(), headers={'Content-Type': 'application/json'})
assert json.load(client.open(request))['user']['username'] == 'admin'
assert json.load(client.open(base + '/api/session'))['authenticated']
print('PASS: generated install bundle, first-run secrets, Compose health and admin login')
PY
# Reuse the real shipped backup helper with this isolated Compose project.
COMPOSE_PROJECT_NAME="$project" sh deploy/backup.sh
