"""Create missing Compose secrets without replacing existing credentials."""
import getpass
import os
from pathlib import Path
import secrets
import sys


def check(root):
    problems = []
    for name, minimum in [('password', 12), ('session', 32)]:
        path = root / name
        if not path.is_file():
            problems.append(f'Отсутствует файл {path}')
        elif len(path.read_text()) < minimum:
            problems.append(f'Файл {path} слишком короткий; существующий секрет не изменён.')
    return problems


def prepare(root):
    # Validate existing files before creating anything. Never rotate credentials
    # implicitly when repairing an interrupted setup.
    for name, minimum in [('password', 12), ('session', 32)]:
        path = root / name
        if path.exists() and (not path.is_file() or len(path.read_text()) < minimum):
            raise ValueError(f'Проверьте {path}: ожидается файл минимум из {minimum} символов.')
    values = {}
    if not (root / 'password').exists():
        password = getpass.getpass('Пароль для входа (минимум 12 символов): ')
        if len(password) < 12 or any(c in password for c in '\r\n\x00'):
            raise ValueError('Нужен пароль от 12 символов без переводов строк.')
        if password != getpass.getpass('Повторите пароль: '):
            raise ValueError('Пароли не совпадают.')
        values['password'] = password
    if not (root / 'session').exists():
        values['session'] = secrets.token_hex(32)
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(root, 0o700)
    for name, value in values.items():
        # Compose bind mounts retain host file ownership. Parent mode 0700
        # protects host access; mounted files are readable by the container UID.
        fd = os.open(root / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o444)
        with os.fdopen(fd, 'w') as out:
            out.write(value)
        os.chmod(root / name, 0o444)


if __name__ == '__main__':
    root = Path(__file__).resolve().parents[1] / '.secrets'
    try:
        if '--check' not in sys.argv:
            prepare(root)
        problems = check(root)
        if problems:
            raise ValueError('\n'.join(problems) + '\nВыполните: python3 deploy/setup-docker-secrets.py')
        print('Оба файла секретов готовы. Существующие значения сохранены.')
    except (ValueError, OSError) as exc:
        raise SystemExit(str(exc))
