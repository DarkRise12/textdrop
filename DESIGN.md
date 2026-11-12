# Textdrop interface

Operate mode: a quiet personal text inbox. The composer precedes the feed on both desktop and mobile. Single column, newest records first, no decorative imagery.

## Tokens

- Background `#f2f5f3`, paper `#ffffff`, text `#242d28`.
- Secondary text `#626b64`, accent `#296244`, destructive action `#a02d25`.
- Native system font stack for familiar operating controls and Cyrillic coverage.
- Content width 832px; desktop padding 32px, mobile padding 20px.
- Composer radius 14px; inputs/buttons 8px. Feed records use separators.
- Responsive breakpoint 600px; minimum metadata text 12px.

## Behavior

Keyboard focus remains visible. Text preserves whitespace and never becomes HTML. Entry errors retain the draft. Destructive deletion uses a confirmation dialog. Polling does not re-render unchanged content. Reduced-motion preference suppresses transitions.

## Verification limits

HTTP handlers verified through in-memory requests; visual/browser review and actual network serving were unavailable because socket creation is denied in the execution sandbox. Design assumptions are provisional pending owner feedback.
