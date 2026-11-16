# Contributing to Textdrop

Open an issue before substantial product or architecture changes. For bugs,
include the release, architecture, browser, reproduction steps and sanitized logs.
Do not attach databases, passwords, cookies or private messages.

Use Python 3.12+, install `requirements.txt` in a virtual environment, and follow
[AGENTS.md](AGENTS.md) for code conventions. Run:

```sh
python3 -m unittest discover -s tests -v
node --test tests/*.test.cjs
node --check static/app.js
```

Browser regressions in `tests/*.browser.cjs` need Node 22+, Playwright and Chromium;
they use disposable synthetic data. Include responsive screenshots for UI changes.

Use `feat:`, `fix:` or `docs:` commit subjects. Pull requests should explain the
problem, behavior, validation and any storage/deployment impact. Keep existing
accounts and stored data compatible; document migration and rollback limits.
Never add runtime data or credentials. Contributions are made under [MIT](LICENSE).
