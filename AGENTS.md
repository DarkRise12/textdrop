# Repository Guidelines

## Project Structure & Module Organization

`server.py` implements the HTTP API, password sessions, and SQLite storage using Python's standard library. `static/` contains the Russian-language interface: `index.html`, `style.css`, and `app.js`. `tests/` holds unit and HTTP-handler tests. `deploy/` contains a user systemd unit, a Caddy example, and an interactive configuration generator. Runtime records live in `data/notes.sqlite3`; credentials live in `.env`. Neither belongs in Git.

## Build, Test, and Development Commands

- `python3 -m unittest discover -s tests -v`: run storage, authentication, and HTTP-handler checks without opening a network socket.
- `node --check static/app.js`: check JavaScript syntax; Node is not needed in production.
- `python3 server.py`: start the server after setting `TEXTDROP_PASSWORD` and `TEXTDROP_SECRET`. It defaults to loopback port 8765.
- `python3 deploy/setup-env.py`: create protected deployment configuration; refuses to overwrite existing secrets.

There is no frontend build or dependency installation step. See `README.md` for HTTPS and service installation.

## Coding Style & Naming Conventions

Use four-space indentation and snake_case in Python. JavaScript uses two-space indentation, camelCase functions, and native browser APIs. Keep API paths under `/api/`. Render user text with `textContent`, never HTML interpolation. Keep interface copy in Russian and maintain accessible labels and keyboard navigation.

## Testing Guidelines

Use `unittest` and name tests `test_*.py`. Cover persistent storage, authentication boundaries, and request validation when changing backend behavior. There is no numerical coverage requirement. In-memory HTTP tests do not establish that deployment networking or browser behavior works.

## Commit & Pull Request Guidelines

Commit each completed functional addition. Existing commits use `feat:` and `chore:` prefixes with imperative descriptions. Pull requests should describe changed behavior, validation, deployment impact, and relevant issues. Include desktop/mobile screenshots for interface changes when browser verification is available. Never commit passwords, session secrets, or database contents.
