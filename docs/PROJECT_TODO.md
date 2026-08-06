# Project TODO

Last updated: 2026-08-06

## Backlog

- [ ] 在独立后续 PR 中完成并合并 CDN selection Stage 3 stall recovery；约束与交付
  状态见
  [CDN Three-Stage Delivery](project_journal/2026/08/2026-08-05-cdn-three-stage-delivery-21b2.md)。
- [ ] 三个阶段全部合并后，由 Joey 在 UK-local 环境执行人工播放验收。自动 live
  E2E 不能替代该门禁。
- [ ] **Blocked:** 在 Stage 3 合并及 Joey 人工验收完成前，不创建稳定版 tag、发布
  稳定版或刷新 `main`。

- [ ] Add a guided issue template link for diagnostic reports.
  - Keep the current report copy flow local-only, but prefill issue title/body only when the payload is small enough for a URL.

## Completed

- [x] Add an in-script diagnostic report attachment flow.
  - Users can download a sanitized report from the settings panel, copy a short summary, and attach the report file to a GitHub issue.
  - Playback pages get a small bottom-right settings fallback tab when the original page mount point is unavailable; it stays collapsed while idle and hides during fullscreen and web-fullscreen playback.
  - The report includes runtime logs, current page URL, script version/build id, selected proxy settings, playback state, recent relevant playurl/subtitle/error logs, and token/proxy-credential redaction.

- [x] Investigate intermittent failure of Bilibili multi-language subtitles on region-unblocked Bangumi pages.
  - Root cause: the current Bilibili player can load subtitle metadata from binary `/x/v2/subtitle/web/view` responses instead of JSON `/x/player/v2` payloads.
  - Fix: BALH can now append generated Simplified/Traditional subtitle entries to the binary subtitle metadata and rewrite generated subtitle body URLs on newer subtitle hosts.
  - Validation: `pnpm run check` passed, and real Chrome/Tampermonkey testing showed the generated subtitle option in the player menu and successfully selected it.
