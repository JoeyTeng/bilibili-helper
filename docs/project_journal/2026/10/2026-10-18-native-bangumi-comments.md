---
id: 20261018-native-bangumi-comments
title: Restore Native Bangumi Comments
status: active
created: 2026-10-18
updated: 2026-10-18
branch: wip/restore-bangumi-comments
pr:
supersedes: []
superseded_by:
---

# Restore Native Bangumi Comments

## Summary
- Restore the existing native comments component on Bangumi playback pages where its container has inline `display: none`.
- Keep comments on Bilibili's own API; no comment reverse proxy, credential forwarding, or replacement comment UI is introduced.

## Evidence and Scope
- Anonymous live fixture: `https://www.bilibili.com/bangumi/play/ep247270`, the first episode of media `md1376`.
- The region-blocked page already contained `#comment-module bili-comments` with `data-params="1,30638972"`, but its outer container was hidden.
- Showing the container triggered Bilibili's `/x/v2/reply/wbi/main` directly: HTTP 200, application code 0, nonempty replies, and an observed total of 54,405 comments.
- Anonymous reading showed a hot-comment preview. Expanding replies opened Bilibili's login dialog; authenticated pagination and full reply loading were not verified.
- The compiled recovery module was also executed against the real page and restored the container without changing its comment identifiers or adding a second component.
- The complete built userscript was then injected into the loaded real page with a test userscript-manager metadata shim. Its public script API initialized and the same native comment container was restored. This was an after-load integration smoke test, not a Tampermonkey installation or authenticated end-to-end test.

## Implementation
- Limit restoration to `www.bilibili.com/bangumi/play/ep*` and `/ss*` pages and containers holding a native component with valid positive decimal identifiers.
- Remove only the container's inline `display: none`, preserving other styles, component attributes, and native access controls.
- Handle late containers/components, delayed identifier attributes, framework style resets, replacement containers, and BFCache returns with scoped mutation observation.
- Respect the script's global close setting without requiring a playback proxy configuration.

## Validation
- DOM mock regression tests passed for the restoration lifecycle and scope restrictions.
- Type checking passed.
- `pnpm run check` passed: type checking, async requests, subtitles, diagnostics, comments, and the final userscript build.
- `node --check scripts/test-restore-comments.mjs` and `git diff --check` passed.
- The repository journal validator reported a pre-existing missing-frontmatter error in `docs/project_journal/2026/06/2026-06-05-diagnostic-report.md`; that unrelated file was left unchanged.
- Toolchain: Node.js v25.8.2 and pnpm 10.15.0. Regression tests use a DOM mock without requiring a browser download.
- Screenshot: `/Users/joey/.codex/visualizations/2026/10/18/01a14f86-9055-7f03-a04f-0fc64d233c88/bangumi-comments.jpg`.
- Formal independent review was not run. The installed review workflow requires version-bound instruction-isolation receipts; neither the subagent receipt nor a validated receipt for the installed Codex CLI 0.163.0 was available during the bounded preflight. No clean-review claim is made.

## Next Steps
- Complete formal review under a verified isolation profile before treating this local candidate as fully reviewed. No push, release, or installed userscript update is part of this task.
