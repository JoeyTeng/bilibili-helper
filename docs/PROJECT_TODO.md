# Project TODO

Last updated: 2026-10-19

## Backlog

- [ ] Add a guided issue template link for diagnostic reports.
  - Keep the current report copy flow local-only, but prefill issue title/body only when the payload is small enough for a URL.

## Completed

- [x] 完成 UK-local 人工播放验收并授权准备 `v8.11.0` 发布。
  - Evidence and limits are recorded in
    [Native Bangumi Comments](project_journal/2026/10/2026-10-18-native-bangumi-comments.md).

- [x] 完成并合并 CDN selection Stage 3 stall recovery。
  - [PR #14](https://github.com/JoeyTeng/bilibili-helper/pull/14) 完成 future-request-only
    recovery、测试与可复用设计记录；三个 CDN selection 阶段现已全部进入 `dev`。
  - 约束与交付证据见
    [CDN Three-Stage Delivery](project_journal/2026/08/2026-08-05-cdn-three-stage-delivery-21b2.md)。

- [x] Add an in-script diagnostic report attachment flow.
  - Users can download a sanitized report from the settings panel, copy a short summary, and attach the report file to a GitHub issue.
  - Playback pages get a small bottom-right settings fallback tab when the original page mount point is unavailable; it stays collapsed while idle and hides during fullscreen and web-fullscreen playback.
  - The report includes runtime logs, current page URL, script version/build id, selected proxy settings, playback state, recent relevant playurl/subtitle/error logs, and token/proxy-credential redaction.

- [x] Investigate intermittent failure of Bilibili multi-language subtitles on region-unblocked Bangumi pages.
  - Root cause: the current Bilibili player can load subtitle metadata from binary `/x/v2/subtitle/web/view` responses instead of JSON `/x/player/v2` payloads.
  - Fix: BALH can now append generated Simplified/Traditional subtitle entries to the binary subtitle metadata and rewrite generated subtitle body URLs on newer subtitle hosts.
  - Validation: `pnpm run check` passed, and real Chrome/Tampermonkey testing showed the generated subtitle option in the player menu and successfully selected it.
