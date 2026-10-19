---
id: 20261018-native-bangumi-comments
title: Restore Native Bangumi Comments
status: completed
created: 2026-10-18
updated: 2026-10-19
branch: wip/restore-bangumi-comments
pr: https://github.com/JoeyTeng/bilibili-helper/pull/16
supersedes: []
superseded_by:
---

# Restore Native Bangumi Comments

## Summary
- Restore the existing native comments component on Bangumi playback pages where its container has inline `display: none`.
- Keep comments on Bilibili's own API; no comment reverse proxy, credential forwarding, or replacement comment UI is introduced.
- Add a settings button to hide or show native Bangumi comments, with a persistent preference scoped to the current browser profile and Bilibili origin.

## Evidence and Scope
- Anonymous live fixture: `https://www.bilibili.com/bangumi/play/ep247270`, the first episode of media `md1376`.
- The region-blocked page already contained `#comment-module bili-comments` with `data-params="1,30638972"`, but its outer container was hidden.
- Showing the container triggered Bilibili's `/x/v2/reply/wbi/main` directly: HTTP 200, application code 0, nonempty replies, and an observed total of 54,405 comments.
- Anonymous reading showed a hot-comment preview. Expanding replies opened Bilibili's login dialog; authenticated pagination and full reply loading were not verified.
- The compiled recovery module was also executed against the real page and restored the container without changing its comment identifiers or adding a second component.
- The complete built userscript was then injected into the loaded real page with a test userscript-manager metadata shim. Its public script API initialized and the same native comment container was restored. This was an after-load integration smoke test, not a Tampermonkey installation or authenticated end-to-end test.

### Expanded Anonymous Checks

The same committed implementation was tested against five additional valid fixtures with build `20261018T221156076Z`. Each original page showed a region restriction and an inline-hidden comments container. After injecting the complete built userscript, each container became visible and its native comments loaded directly from `api.bilibili.com` with HTTP 200 and application code 0.

| Fixture | Playback route | Native comment object ID | Result |
| --- | --- | --- | --- |
| HITMAN REBORN!, episode 2 | `/bangumi/play/ep247271` | `891771160` | Native preview visible; direct anonymous request succeeded. |
| HITMAN REBORN!, episode 203 | `/bangumi/play/ep247472` | `976840906` | Native preview visible; native request succeeded. |
| Initial D First Stage, episode 1 | `/bangumi/play/ss207`, episode `403426` | `290461073` | Native preview visible; native request succeeded. |
| School Babysitters, episode 1 | `/bangumi/play/ss21775`, episode `403038` | `418043938` | Native preview visible; native request succeeded. |
| How to Keep a Mummy, episode 1 | `/bangumi/play/ss21720`, episode `183823` | `18224452` | Native component arrived late; restoration and native request succeeded. |

- Episode 2's native resource timing also confirmed direct HTTP 200 requests. Its application-level result was captured by replaying the page's existing signed main-comment request with `credentials: omit`: code 0 and 20 returned replies. The other four application-level results were recorded from cloned native fetch responses and contained three preview replies each. No cookies or request headers were read or forwarded.
- An old documented fixture, `https://bangumi.bilibili.com/anime/5551/play#96703`, redirected to `https://www.bilibili.com/bangumi/play/ss5551#96703` and displayed Bilibili's error page without a native comments component. It is unavailable evidence, not a passed recovery test or proof that all routes for that title are unavailable.
- The original native UI retained its login prompts. Full pagination and complete nested-reply flows remain unverified. All five valid pages had hidden comments in this browser region; this batch does not add a live already-visible-comments control.
- The source implementation was unchanged for these checks. The retained bounded report contains only fixture metadata, visibility, response summaries, and screenshot paths: `/Users/joey/.codex/visualizations/2026/10/18/01a14f86-9055-7f03-a04f-0fc64d233c88/comments-expanded-results.json`.

## Implementation
- Limit restoration to `www.bilibili.com/bangumi/play/ep*` and `/ss*` pages and containers holding a native component with valid positive decimal identifiers.
- When enabled, remove only the container's inline `display: none`, preserving other styles, component attributes, and native access controls. When explicitly hidden, enforce `display: none !important` on that same valid native container.
- Handle late containers/components, delayed identifier attributes, framework style resets, replacement containers, and BFCache returns with scoped mutation observation.
- Rediscover a replacement inserted before the prior container is removed, including separate mutation batches. Recheck route eligibility before observer-driven visibility changes to keep ordinary video comments outside this feature's scope.
- Keep lightweight route/discovery monitoring on the supported origin even when the initial path is an ordinary video page. Restore or hide comments only after entering an eligible Bangumi route, and preserve the latest site display declaration when overriding it for a hidden preference.
- Respect the script's global close setting without requiring a playback proxy configuration.
- Store the comments preference in localStorage, defaulting to visible. Apply changes immediately and synchronize same-profile tabs through storage events. Report a failed save in the settings UI. Clearing Bilibili site data restores the default.
- Show the preference control only on the supported `www.bilibili.com` origin; mobile settings cannot configure another origin's localStorage.

## Validation
- DOM mock regression tests passed for the restoration lifecycle, scope restrictions, persistent preferences, storage failures, cross-tab events, and observer cleanup.
- Type checking passed.
- `pnpm run check` passed after integrating current `dev`: type checking, async requests, subtitles, diagnostics, comments, XHR compatibility, CDN tests, and the final userscript build. The closed-mode startup fixture now checks the comments enable argument alongside its existing CDN assertions.
- The real settings button was tested with the complete built userscript injected after page load: hiding immediately applied `display: none !important` and saved the preference; a newly opened episode in the same profile kept comments hidden; showing comments synchronized the other tab back to `display: block`. This is a two-document browser smoke test, not a userscript-manager installation or browser-restart test.
- `node --check scripts/test-restore-comments.mjs` and `git diff --check` passed.
- The repository journal validator reported a pre-existing missing-frontmatter error in `docs/project_journal/2026/06/2026-06-05-diagnostic-report.md`; that unrelated file was left unchanged.
- Toolchain: Node.js v25.8.2 and pnpm 10.15.0. Regression tests use a DOM mock without requiring a browser download.
- Screenshot: `/Users/joey/.codex/visualizations/2026/10/18/01a14f86-9055-7f03-a04f-0fc64d233c88/bangumi-comments.jpg`.
- Settings screenshot: `/Users/joey/.codex/visualizations/2026/10/18/01a14f86-9055-7f03-a04f-0fc64d233c88/comments-toggle-visible.jpg`.
- Exact-head CI and independent review evidence belong to the associated PR. This change does not increment or publish a release version.

## UK Manual Release Acceptance — 2026-10-19

- The agent updated the existing `8.10.0` installation to the complete `8.11.0` candidate
  built from source commit `dc00e20` in the real local Chrome Codex profile using Tampermonkey
  `5.5.1`. The BALH candidate metadata used `@name 解除B站区域限制` and
  `@namespace https://github.com/JoeyTeng`.
- On `ep247368`, episode 99 playback advanced from `00:01` to `02:30`, and the native comments
  component displayed 90 comments. System audio remained muted throughout and muting was verified.
- Joey reviewed the installed candidate, said it looked good, and explicitly instructed us to
  continue with publication. This is the release-specific acceptance decision for normal playback
  and the installed native-comments trial. At acceptance time, the candidate had not been tagged
  or published. Real stall/cache recovery was not exercised and remains future field validation;
  this trial does not claim acceptance of those behaviors.
