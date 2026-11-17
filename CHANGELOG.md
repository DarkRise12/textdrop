# Changelog

## 1.1.1

- After a successful send, clear the category filter together with search so the new, uncategorized message stays visible.

## 1.1.0

- Seven preset message categories: Important, Work, Personal, Ideas, Read, Later and Done (Russian labels with emoji).
- Multiple categories per message, shown as reaction chips; click a chip to remove it.
- A compact category filter works across the full history, combines with body/filename search and supports trash.
- Memberships synchronize across devices, remain private to each account, survive editing/trash/restore and are included in backups.
- Additive `note_categories` migration; rollback to 1.0.0 keeps the data but hides the feature.
- Lightweight browser-native picker with a fallback for older browsers; no new runtime dependency.

## 1.0.0

First packaged self-hosted release.

- Private text chat across devices, search, editing, copying and 30-day trash.
- Up to 10 attachments per message, 125 MiB per file and 3 GiB shared storage by default.
- Lazy image previews, light/dark themes, compact mobile and desktop layouts.
- Owner-managed accounts with separate histories, files and browser drafts.
- Installable PWA with a public-only offline shell and guarded updates.
- Docker images for Linux AMD64 and ARM64; independent Compose installation.
- Persistent SQLite storage, manual consistent backups and restore instructions.

The interface is currently Russian. Public registration, shared spaces, system
share targets and an offline send queue are not included.
