---
id: 20260604-pgc-playurl-fetch-refresh
title: PGC Playurl Fetch Refresh
status: completed
created: 2026-06-04
updated: 2026-06-04
branch: wip/pgc-playurl-fetch-refresh
pr:
supersedes: []
superseded_by:
---

# PGC Playurl Fetch Refresh

## Summary
- Fixed a playback refresh path where the current Bilibili Bangumi player can request PGC playurl data through `fetch`, bypassing the existing XHR interception.

## Current State
- PGC `/pgc/player/web/playurl` and `/pgc/player/web/v2/playurl` fetch calls now fall back to configured BALH proxy candidates when the original response is region-blocked or unusable.
- Proxy candidate selection uses page area hints, cached season area, and the configured custom area servers.
- The debug Bangumi script can now probe page-level PGC playurl fetches and seek through playback positions for segment-refresh testing.

## Next Steps
- None.

## Evidence
- `pnpm run check` passed.
- Real Chrome/Tampermonkey test log: `.codex-tmp/playwright-logs/seek-fetch-pgc-20260604T1437.log`.
- Direct fetch interception probe log: `.codex-tmp/playwright-logs/fetch-pgc-probe-20260604T1431.log`.
