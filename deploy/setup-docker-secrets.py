"""Create Compose secret files; refuses to overwrite existing credentials."""
import getpass
import os
from pathlib import Path
import secrets

root = Path(__file__).resolve().parents[1] / '.secrets'
if root.exists():
    raise SystemExit('.secrets уже существует. Существующие секреты не изменены.')
password = getpass.getpass('Пароль для входа (минимум 12 символов): ')
if len(password) < 12 or any(c in password for c in '\r\n\x00'):
    raise SystemExit('Нужен пароль от 12 символов без переводов строк.')
if password != getpass.getpass('Повторите пароль: '):
    raise SystemExit('Пароли не совпадают.')
root.mkdir(mode=0o700)
for name, value in [('password', password), ('session', secrets.token_hex(32))]:
    # Compose bind-mounts files without remapping ownership. The non-root
    # container must read them; parent mode 0700 protects host access.
    fd = os.open(root / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o444)
    with os.fdopen(fd, 'w') as out:
        out.write(value)
    os.chmod(root / name, 0o444)
print('Секреты созданы в .secrets (каталог доступен только владельцу).')
