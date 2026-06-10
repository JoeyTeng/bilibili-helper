---
id: 20260610-biliplus-authpoll
title: BiliPlus Authpoll Authorization
status: completed
created: 2026-06-10
updated: 2026-06-10
branch: fix/biliplus-authpoll
pr:
supersedes: []
superseded_by:
---

# BiliPlus Authpoll Authorization

## Summary
- Restored one-click BALH account authorization when BiliPlus stores the final token only in the auth polling response.
- Kept the existing BiliPlus cookie/localStorage credential bridge as a fallback path.

## Current State
- The BiliPlus userscript branch now watches `?act=authpoll` XHR responses and forwards `token_info.access_token`, `refresh_token`, and `expires_in` to the opener.
- Cached BiliPlus cookie/localStorage credentials are only forwarded on the auth page when BiliPlus reports a fresh logged-in session, so stale credentials cannot preempt a new authpoll token.
- Authpoll credentials are forwarded as one source-consistent set, so old cached expiration fields cannot be mixed into a newly authorized token.
- The opener continues to save `access_key`, `refresh_token`, and normalized OAuth expiration in Bilibili `localStorage`.
- Duplicate credential forwarding is suppressed after the first successful postMessage.

## Next Steps
- None.

## Evidence
- Temporary Chrome auth test confirmed the successful path was `authpoll`, with `hasTokenInfo`, `hasAccessToken`, and `hasRefreshToken` true.
- Temporary Chrome auth test confirmed the opener saved `access_key`, `refresh_token`, and expiration metadata.
- `pnpm run check` passed.
