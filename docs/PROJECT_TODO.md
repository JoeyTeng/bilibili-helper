# Project TODO

Last updated: 2026-06-04

## Backlog

- [ ] Design an in-script log collection and one-click bug report flow.
  - Goal: help users export the BALH runtime log, current page URL, script version/build id, selected proxy settings, recent player/playurl errors, and redacted network diagnostics without exposing cookies or access keys.
  - Keep the first version local-only: copy/download a sanitized report payload that users can paste into an issue.

## Completed

- [x] Investigate intermittent failure of Bilibili multi-language subtitles on region-unblocked Bangumi pages.
  - Root cause: the current Bilibili player can load subtitle metadata from binary `/x/v2/subtitle/web/view` responses instead of JSON `/x/player/v2` payloads.
  - Fix: BALH can now append generated Simplified/Traditional subtitle entries to the binary subtitle metadata and rewrite generated subtitle body URLs on newer subtitle hosts.
  - Validation: `pnpm run check` passed, and real Chrome/Tampermonkey testing showed the generated subtitle option in the player menu and successfully selected it.
