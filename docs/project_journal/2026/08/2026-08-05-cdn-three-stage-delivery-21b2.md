---
id: 20260805-cdn-three-stage-delivery-21b2
title: CDN Three-Stage Delivery
status: active
created: 2026-08-05
updated: 2026-08-06
branch: wip/cdn-selection-integration
pr:
supersedes: []
superseded_by:
---

# CDN Three-Stage Delivery

## Summary

- CDN selection 按三个阶段交付。Stage 1 与 Stage 2 的实现范围已经完成；Stage 3
  仍由独立后续 PR 评审和合并。
- 三个阶段全部合并且 Joey 在 UK-local 环境完成人工播放验收前，整体状态保持
  `active`。
- 两项条件同时满足前，不得创建稳定版 tag、发布稳定版或刷新 `main`。

## Stage Status

### Stage 1：精确响应选择 — completed

- 候选组保留每个 DASH representation 或 legacy `durl` segment 返回的 exact signed
  URL；自动模式不构造 URL，也不跨组混用。
- Vue、Fetch、XHR 与 WBI response adapter 共用选择核心。WBI
  `/x/player/wbi/playurl` 只处理响应；BALH 绝不 proxy、重发或重新签署请求的
  `w_rid` / `wts`。
- 无自定义区域代理时，CDN-only Vue 交付边界会处理 `__playinfo__` 与
  `__PLAYURL_HYDRATE_DATA__` 的已有值和之后可拦截的赋值；对克隆应用
  CDN policy，不改写 source object，也不发起区域代理请求。
- 风险排序只降级 MCDN/PCDN，并始终把它们保留为最后兜底。只有用户显式选择
  `manual` 才运行 legacy host rewrite。

### Stage 2：本机两阶段探测 — completed

- 动态 `2 MiB` accounted-prefix 预算允许完整 `64 KiB` Stage 1 样本时，浏览器探测
  每个可准入的不同 host；并发永不超过 `2`。
- Stage 1 成功结果稳定排名，前两名共享剩余 follow-up 预算，每个 host 最多
  `512 KiB`。吞吐量与可靠 DASH bitrate margin 是主要证据，TTFB 是次要证据。
- 请求/阶段 deadline 约为 `2–4 s`，清理 slack 最多 `250 ms`。完整 chunk 可以让
  当前 batch 的 raw 实收量 overshoot（超出当前批次预算）；只有 clipped prefix
  进入计分，raw observed bytes 会停止后续请求，accounted prefix 仍硬限制在
  `2 MiB`。
- Probe 请求不携带凭据，也不发送 `Range`。CORS 不可读结果是 `unprobeable`，不是
  CDN 失败证据。
- Host-only cache schema `v2` 的 TTL 是 `20 min`，candidate-set 或粗粒度网络变化即
  失效。不完整、budget-limited、unprobeable 或清理不安全的轮次不持久化。Signed
  URL 永不进入持久化 cache 或日志。
- 新 candidate generation 在旧 controller drain 期间到达时，每个 drain 只保留一个
  continuation，并将其 generation/host-hash 意图更新为最新上下文；旧清理不会
  与新 probe 重叠，最新候选或网络 generation 也不会被丢失。
  cancel 终止但 reject 时可解除调度 fence，但该轮仍保持 cleanup-unsafe 且
  不可缓存；永不 settle 的 cleanup 仍保持 fence。

### Stage 3：Stall recovery — planned follow-up PR

- 只有页面可见、播放器未暂停、未 seeking，并且经过 grace period 后 low buffer 仍存在，
  才能确认 stall。
- exact candidate groups 只保存在内存，只重路由未来 Fetch/XHR 媒体请求；绝不
  abort、reload 或重放已经在进行的请求。
- 使用 cooldown 和有上限的 backoff，避免 host ping-pong。普通候选之后仍以
  MCDN/PCDN 为最后兜底。
- 静态 candidate pool 只允许作为显式、非默认实验性排序提示，并且只能引用当前
  exact signed candidate group 已有 URL；不得引入外部 host/URL。

## Compatibility Contract

- 兼容范围只覆盖 latest Bilibili Video CDN Switcher，不维护旧版矩阵。
- 当前固定 snapshot 是 `0.1.4`，SHA-256
  `261e2dee00acd83ed40f1cc26cf8c5feffc599c41b95952d44b98c09af8dc0d4`。
- 当前交付证据中的 latest-upstream browser gate 已覆盖并通过两种 BALH/CDN Switcher
  加载顺序。

## Release Gate

- 三个阶段的实现必须全部合并，稳定发布门禁才可以继续。
- 随后必须由 Joey 在 UK-local 环境人工验收播放与恢复行为。
- 2026-08-06 的仓库 live E2E gate 已通过：BVID `BV17x411w7KC` 在 Chrome
  `151.0.7922.72` 中真实播放推进；2 个 candidate/probed host 均 healthy，probe
  attempts 为 `completed=4` / `total=4`，持久化 2 个 host，并在重载后的新 runtime
  中以 `source="cache"`、`hostCount=2` 无网络复用。这只是自动辅助证据，不满足
  Joey 的人工验收。
- 合并与人工条件同时满足前，不创建稳定版 tag、不发布稳定版，也不刷新 `main`。

## Next Steps

1. 在独立后续 PR 中交付 Stage 3，包含确定性状态机与浏览器覆盖。
2. 确认三个阶段全部合并。
3. 由 Joey 执行 UK-local 人工播放验收。
4. 仅在上述门禁通过后恢复稳定 tag/release/`main` 刷新流程。

## Evidence

- 详细架构：`docs/design/cdn-selection.md`
- 已完成的 Stage 1/2 工作流：
  `docs/project_journal/2026/08/2026-08-04-cdn-selection-integration-21b2.md`
- CDN Switcher canonical identity 与固定 snapshot：
  `packages/unblock-area-limit/README.md#cdn-switcher-兼容性`
- 精确 live E2E CLI 继续由仓库根 README 维护。
