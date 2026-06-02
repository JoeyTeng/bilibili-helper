# Project TODO

Last updated: 2026-06-02

## Backlog

- [ ] Investigate intermittent failure of Bilibili multi-language subtitles on region-unblocked Bangumi pages.
  - User report: the page's multi-language subtitle feature is sometimes unavailable.
  - Status: recorded only; no investigation has started.
  - Likely starting points: `packages/unblock-area-limit/src/feature/bili/area_limit_xhr_.ts` subtitle handling, `/x/player/v2` responses, and `/bfs/subtitle/` response rewriting.
