# Project State

Last updated: 2026-10-19

## Current State

- CDN selection Stage 1（精确响应选择）、Stage 2（本机两阶段探测）与 Stage 3
  stall recovery 均已完成。对 `v8.11.0`，Joey 接受了已安装候选的正常播放与原生评论试用，
  并明确指示继续发布。
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

- The `v8.11.0` release-specific manual acceptance covers normal playback and the installed
  native-comments trial, followed by Joey's explicit publication instruction. Real stall/cache
  recovery was not manually exercised and remains follow-up field validation. Automated gates
  provide supporting evidence; they do not replace the UK-local manual trial.
