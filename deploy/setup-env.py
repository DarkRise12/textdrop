"""Create local secrets without overwriting an existing configuration."""
import getpass
import os
from pathlib import Path
import secrets

path = Path(__file__).resolve().parents[1] / '.env'
password = getpass.getpass('Пароль для входа (минимум 12 символов): ')
if len(password) < 12 or any(c in password for c in '\r\n\x00'):
    raise SystemExit('Нужен пароль от 12 символов без переводов строк.')
if password != getpass.getpass('Повторите пароль: '):
    raise SystemExit('Пароли не совпадают.')
# systemd EnvironmentFile quoted-value escaping.
escaped = password.replace('\\', '\\\\').replace('"', '\\"')
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as out:
    out.write(f'TEXTDROP_PASSWORD="{escaped}"\nTEXTDROP_SECRET={secrets.token_hex(32)}\nTEXTDROP_SECURE=1\n')
print('Создан .env с правами 600. Используйте HTTPS перед входом.')
