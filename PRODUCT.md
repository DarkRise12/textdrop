# Product

<!-- impeccable:product-schema 1 -->

## Platform
web

## Users
The owner moves text between their own devices, currently through Telegram Saved Messages.

## Product Purpose
Provide the same persistent text content on every device.

## Capabilities and Constraints
Initial scope: text only. Deploy on this server. Commit each functional addition.

## Open Implementation Assumptions
Single shared password, Python standard library and SQLite, responsive browser interface, polling synchronization. These choices implement the requested first version; they are not confirmed long-term product requirements. The owner confirmed successful cross-device use at https://share.nikitalebe.dev, behind the existing Docker Caddy container caddy-caddy-1 on caddy_default.
