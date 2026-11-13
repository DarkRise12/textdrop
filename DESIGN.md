---
name: Textdrop
description: Personal text chat across devices
colors:
  primary: "#733bb8"
  background: "#f5f3f8"
  paper: "#ffffff"
  ink: "#2b2433"
  muted: "#6b6176"
  bubble: "#ede5f7"
  dark-background: "#17131d"
  dark-paper: "#211b29"
  dark-ink: "#f0eaf5"
  dark-muted: "#b9acc7"
  dark-primary: "#733bb8"
  dark-bubble: "#31233f"
rounded:
  control: "10px"
  message: "14px"
spacing:
  compact: "8px"
  control: "12px"
  message: "16px"
  desktop: "28px"
---
# Textdrop interface

## Overview

Operate mode: a personal chat, explicitly requested by the owner. Use the owner-selected purple accent #733bb8 with quiet violet-tinted surfaces. No decorative imagery. The history occupies available space above the bottom composer.

## Colors

Light and dark themes use role-based CSS custom properties. First visit follows system preference; the toggle persists an explicit choice on that device. Apply the theme before styles load to avoid a light flash. Inputs, modal, focus, scrollbars and browser theme color follow the selected palette.

## Typography

Retain the established system font stack for operating controls and Cyrillic. Message text is 15px with 1.65 line height; inputs are 16px to avoid mobile zoom. Metadata and keyboard hints use 12px minimum. Preserve whitespace, wrap long strings, never interpret messages as HTML.

## Layout

The application fits the dynamic viewport. The global header and chat header remain outside the independently scrolling history. Chat width is capped at 960px. Breakpoint: 600px; mobile content padding drops to 12–16px. Respect bottom safe areas and visual viewport resize. On every device the section buttons, message count, status indicator and search toggle share one approximately 50px toolbar. Hide the large avatar and footer shortcut hints; retain 15px message text, 40px action targets, and the send-button shortcut tooltip. Newest messages are at the bottom; short conversations rest near the composer.

## Elevation & Depth

Use flat tonal surfaces and thin borders. Only the floating new-message button has a soft downward shadow.

## Shapes

Right-aligned message bubbles have 14px corners and a 4px lower-right corner. Composer uses a 14px outline, avatar 14px, buttons 10px. Icons are consistent stroked SVG geometry.

## Components

- Feedback: distinguish connectivity, server/protocol failure and authentication expiry. Preserve the last loaded history on failed reads. Clear load errors on recovery, keep failed-send feedback until the user acts. Offer retry on chat and login screens.
- History: chronological messages grouped by local date. Follow new messages only when already near the bottom. Preserve the visible message anchor when reading older content; show a button to jump to new messages.
- Composer: grows to 180px maximum, leaves history visible, disables empty submissions. Enter adds a line; Ctrl/Cmd+Enter sends, except during IME composition. Keep text after a failed send. Show a quiet local-draft status below the input, or an error-colored warning when browser storage is unavailable; draft contents never appear on the login screen.
- Search: collapsed behind a labelled toggle on every screen size. Opening focuses the field; close/Escape clears the filter and returns focus to the toggle. Keep an active query visible across width changes. Search remains above history; sending clears the filter so the saved message is visible.
- Editor: one inline form at a time, reusing the message bubble. Keep the field and caret during polling. Save/Cancel and Ctrl/Cmd+Enter/Esc; show both versions on conflict with explicit accept or save-my-version actions. Preserve the in-memory edit across network/auth errors; disable saving if the record was deleted remotely.
- Trash: a separate section with a 30-day retention hint and per-record expiry. Restore is reversible; permanent deletion has its own confirmation. Keep the compose draft intact when switching sections and block switching while an edit is unsaved. Deleted records use full-width rows with the established message palette.
- Links: underline HTTP/HTTPS URLs using accent ink in both themes. New tabs use noopener/noreferrer; the surrounding text and punctuation stay literal.
- Actions: copy, edit and delete use 40px SVG icon buttons on all devices. Preserve accessible names, tooltips, focus and copy confirmation; keep actions on one row to avoid tall bubbles. Destructive deletion uses the existing confirmation dialog.
- Header: wordmark reads `text->drop`, with the arrow in accent ink. Theme control has a tinted outlined surface; logout is a solid accent button. The chat header shows message count and sync status, with no Saved Messages title.
- Theme: visible on both login and chat screens; accessible name announces the destination theme. Focus remains visible and reduced-motion preference suppresses transitions.

## Do's and Don'ts

Do preserve personal text as literal content and retain existing data/API behavior. Do test both themes on desktop and mobile. Don't force-scroll a reader on polling, hide actions behind hover, or store message contents with theme preferences.
