# Product

<!-- impeccable:product-schema 1 -->

## Platform
web

## Users
The owner moves text between their own devices, currently through Telegram Saved Messages.

## Product Purpose
Provide the same persistent text content on every device.

## Capabilities and Constraints
Text messages and one-file messages with optional captions. Deploy on this server. Commit each functional addition.

## Open Implementation Assumptions
Single shared password, Python HTTP server, SQLite and an isolated Pillow thumbnail worker, responsive browser interface, polling synchronization. These choices implement the requested first version; they are not confirmed long-term product requirements. The owner confirmed successful cross-device use at https://share.nikitalebe.dev, behind the existing Docker Caddy container caddy-caddy-1 on caddy_default.

## Scope Decisions

Message pinning is explicitly excluded by the owner. Deleted messages are recoverable in a 30-day trash. HTTP/HTTPS links are clickable without interpreting user HTML.

History export and import are explicitly excluded by the owner. History stays in Textdrop and is accessed through the service on every device.

File messages support private downloads, editable captions, 30-day trash and restore. Current defaults are 125 MiB per file and 3 GiB total file payload, configurable on the server. Image previews load lazily; the native viewer uses cached thumbnails and offers the untouched original as a separate download. Preview processing is bounded to keep the application lightweight.
