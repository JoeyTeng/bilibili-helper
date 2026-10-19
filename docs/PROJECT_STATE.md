# Project State

Last updated: 2026-10-19

## Current State

- CDN selection Stage 1（精确响应选择）、Stage 2（本机两阶段探测）与 Stage 3
  stall recovery 均已完成；UK-local 人工播放验收及发布授权已于 2026-10-19 完成。
- 本次验收并批准发布的版本为稳定版 `v8.11.0`；发布按常规 tag/Release/`main` 流程进行。
- 兼容范围仅覆盖 latest Bilibili Video CDN Switcher；固定 snapshot 详情见
  [兼容性文档](../packages/unblock-area-limit/README.md#cdn-switcher-兼容性)。

## Recovery

- Source branch: `dev`.
- Distribution branch: `main`, refreshed by the release workflow from stable `vX.Y.Z` tags.
- Approved release version: stable `v8.11.0` from `dev`.
- Completed CDN program:
  [2026-08-05-cdn-three-stage-delivery-21b2.md](project_journal/2026/08/2026-08-05-cdn-three-stage-delivery-21b2.md).
- Backlog entrypoint: [PROJECT_TODO.md](PROJECT_TODO.md).

## Release Notes

- UK-local manual playback acceptance and explicit authorization for `v8.11.0` are complete.
  Automated live E2E remains supporting evidence only.
