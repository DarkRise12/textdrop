"""Build an allowlisted installation bundle without source or runtime secrets."""
import argparse
import hashlib
from pathlib import Path
import re
import tarfile

ROOT = Path(__file__).resolve().parents[1]
FILES = {
    'compose.yaml': 'compose.selfhost.yaml',
    '.env.example': 'deploy/selfhost.env.example',
    'deploy/setup-docker-secrets.py': 'deploy/setup-docker-secrets.py',
    'deploy/backup.sh': 'deploy/backup.sh',
    'README.md': 'README.md',
    'docs/INSTALL.md': 'docs/INSTALL.md',
    'LICENSE': 'LICENSE',
    'CHANGELOG.md': 'CHANGELOG.md',
    'SECURITY.md': 'SECURITY.md',
}


def package(version, destination, root=ROOT):
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', version):
        raise ValueError('Expected MAJOR.MINOR.PATCH without a v prefix.')
    for name in ('compose.selfhost.yaml', 'deploy/selfhost.env.example'):
        if f'ghcr.io/darkrise12/textdrop:{version}' not in (root / name).read_text():
            raise ValueError(f'Update the default image version in {name} first.')
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    archive = destination / f'textdrop-install-{version}.tar.gz'
    sums = destination / 'SHA256SUMS'
    if archive.exists() or sums.exists():
        raise FileExistsError('Release assets already exist; use an empty output directory.')
    try:
        with archive.open('xb') as output:
            with tarfile.open(fileobj=output, mode='w:gz') as bundle:
                for name, source in FILES.items():
                    info = bundle.gettarinfo(str(root / source), arcname=name)
                    info.uid = info.gid = 0
                    info.uname = info.gname = ''
                    info.mode = 0o644
                    with (root / source).open('rb') as content:
                        bundle.addfile(info, content)
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        with sums.open('x') as output:
            output.write(f'{digest}  {archive.name}\n')
    except Exception:
        archive.unlink(missing_ok=True)
        raise
    return archive


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('version')
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    print(package(args.version, args.destination))
