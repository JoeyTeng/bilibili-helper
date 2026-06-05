# Project TODO

Last updated: 2026-06-05

## Backlog

- [ ] Add a guided issue template link for diagnostic reports.
  - Keep the current report copy flow local-only, but prefill issue title/body only when the payload is small enough for a URL.

## Completed

- [x] Add an in-script diagnostic report attachment flow.
  - Users can download a sanitized report from the settings panel, copy a short summary, and attach the report file to a GitHub issue.
  - Playback pages get a small bottom-right settings fallback tab when the original page mount point is unavailable; it stays collapsed while idle and hides during fullscreen and web-fullscreen playback.
  - The report includes runtime logs, current page URL, script version/build id, selected proxy settings, playback state, recent relevant playurl/subtitle/error logs, and token/proxy-credential redaction.

- [x] Investigate intermittent failure of Bilibili multi-language subtitles on region-unblocked Bangumi pages.
  - Root cause: the current Bilibili player can load subtitle metadata from binary `/x/v2/subtitle/web/view` responses instead of JSON `/x/player/v2` payloads.
  - Fix: BALH can now append generated Simplified/Traditional subtitle entries to the binary subtitle metadata and rewrite generated subtitle body URLs on newer subtitle hosts.
  - Validation: `pnpm run check` passed, and real Chrome/Tampermonkey testing showed the generated subtitle option in the player menu and successfully selected it.
