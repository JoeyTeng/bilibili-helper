---
id: 20260605-async-fetch-request
title: Async Fetch Request
status: completed
created: 2026-06-05
updated: 2026-06-05
branch: wip/async-fetch-request
pr:
supersedes: []
superseded_by:
---

# Async Fetch Request

## Summary
- Replaced the old jQuery-first `Async.ajax` request path with a fetch-first helper.
- Kept XHR as a compatibility fallback for unavailable fetch, network failures, HTTP failures, and parse failures.
- Removed the unused `@types/greasemonkey` package after confirming the repo-local Greasemonkey v3 declarations cover the current code.

## Current State
- `Async.ajax` no longer waits up to three seconds for `window.$` before requesting JSON/text endpoints.
- Fetch requests include credentials and preserve the previous Basic Auth URL rewrite behavior.
- Fetch and XHR fallback responses share the same JSON/text/XML parser, preserving HTML text for media page parsing and XML documents for the legacy Bilibili XML playurl path.
- XHR fallback network errors keep a jQuery-compatible `statusText: "error"` shape so existing backup proxy handling still triggers.
- Runtime dependency surface is unchanged: `opencc-js` remains required for subtitle conversion.

## Next Steps
- None.

## Evidence
- `pnpm run test:async` passed.
- `pnpm run typecheck` passed after removing `@types/greasemonkey`.
- `pnpm run check` passed and built `dist/unblock-area-limit.user.js` with build id `20260605T091638399Z`.
- Chrome smoke with `https://atri.ink` passed: local build `20260605T091638399Z` loaded, proxy playurl probe returned DASH, and video reached `paused:false`, `readyState:4`, `currentTime≈5.17`.
- Local review found missing XML/text XHR fallback semantics and network error shape compatibility; the fixes add fallback HTML/XML and `statusText: "error"` coverage in `scripts/test-async-request.mjs`.
