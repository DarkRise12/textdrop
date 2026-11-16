# Security

Use the latest released patch version. Older releases do not have a separate
maintenance branch. Textdrop is intended for small, trusted self-hosted groups.
The server stores readable content in SQLite; this is not end-to-end encryption.

Please do not open public issues with exploits, credentials or user data.
Use [GitHub private vulnerability reporting](https://github.com/DarkRise12/textdrop/security/advisories/new)
when available; otherwise open a minimal issue asking for a private contact,
without disclosing exploit details. Reports are handled on a best-effort basis.

Serve internet-facing installations over HTTPS, keep `TEXTDROP_SECURE=1`, and
expose only your reverse proxy. Keep installation secrets and backups private,
use distinct passwords and retain backups outside the server. Public repository
access does not grant access to your installation or its data.
