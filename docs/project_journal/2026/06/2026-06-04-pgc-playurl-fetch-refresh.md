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
- Stabilized proxy playurl refreshes for mid-episode playback and normal-reload subtitle checks.

## Current State
- PGC `/pgc/player/web/playurl` and `/pgc/player/web/v2/playurl` fetch calls now fall back to configured BALH proxy candidates when the original response is region-blocked or unusable.
- Proxy candidate selection uses page area hints, cached season area, and the configured custom area servers.
- Proxy playurl requests retry short-lived parser failures, including HTTP 200 JSON error payloads and negative proxy server error codes, plus entitlement-like errors when an `access_key` is configured.
- DASH stream URLs are normalized to prefer non-Akamai URLs before Akamai backups, reducing the chance that Bilibili's player lands on a flaky fallback during segment refreshes.
- The debug Bangumi script can now probe page-level PGC playurl fetches, seek through playback positions, skip episode switching, and run normal reload cycles for subtitle/load testing.
- Follow-up log collection work is tracked in `docs/PROJECT_TODO.md`.

## Next Steps
- None.

## Evidence
- `pnpm run check` passed.
- `git diff --check` passed.
- `node --check scripts/debug-bangumi.mjs` passed.
- Real Chrome/Tampermonkey test log: `.codex-tmp/playwright-logs/seek-fetch-pgc-20260604T1437.log`.
- Direct fetch interception probe log: `.codex-tmp/playwright-logs/fetch-pgc-probe-20260604T1431.log`.
- Real Chrome/Playwright seek test for `ep669522`: `.codex-tmp/playwright-logs/seek-ep669522-retry-fix-20260604T1728.log`.
- Final local userscript smoke for `ep669522`: `.codex-tmp/playwright-logs/seek-ep669522-final-smoke-20260604T1731.log`.
- Post-review `pnpm run check` built `dist/unblock-area-limit.user.js` with build id `20260604T185136159Z`.
