# Project State

Last updated: 2026-08-06

## Current State

- CDN selection Stage 1（精确响应选择）与 Stage 2（本机两阶段探测）实现范围已完成；
  Stage 3 stall recovery 由独立后续 PR 交付。
- 兼容范围仅覆盖 latest Bilibili Video CDN Switcher；当前固定 snapshot 是 `0.1.4`，
  SHA-256 `261e2dee00acd83ed40f1cc26cf8c5feffc599c41b95952d44b98c09af8dc0d4`。

## Recovery

- Source branch: `dev`.
- Distribution branch: `main`, refreshed by the release workflow from stable `vX.Y.Z` tags.
- Current release target: next stable `v8.10.x` patch/minor from `dev`, subject to the CDN
  three-stage release gate below.
- Active CDN program:
  [2026-08-05-cdn-three-stage-delivery-21b2.md](project_journal/2026/08/2026-08-05-cdn-three-stage-delivery-21b2.md).
- Backlog entrypoint: [PROJECT_TODO.md](PROJECT_TODO.md).

## Global Blockers

- 不得创建稳定版 tag、发布稳定版或刷新 `main`，直到三个 CDN selection 阶段全部
  合并，且 Joey 在 UK-local 环境完成人工播放验收。
- 自动 live E2E 只是辅助证据，不能替代 Joey 的人工验收。
