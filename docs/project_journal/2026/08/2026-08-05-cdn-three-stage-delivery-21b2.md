---
id: 20260805-cdn-three-stage-delivery-21b2
title: CDN Three-Stage Delivery
status: active
created: 2026-08-05
updated: 2026-08-06
branch: wip/cdn-stall-recovery
pr:
supersedes: []
superseded_by:
---

# CDN Three-Stage Delivery

## Summary

- CDN selection 按三个阶段交付。Stage 1 与 Stage 2 的实现范围已经完成并由
  [PR #13](https://github.com/JoeyTeng/bilibili-helper/pull/13) 交付；Stage 3 在独立
  WIP 分支实现、评审和合并。
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

### Stage 3：Stall recovery — completed

- 只有页面可见、播放器未暂停、未 seeking，并且经过 grace period 后 low buffer 仍存在，
  才能确认 stall。
- exact candidate groups 只保存在内存，只重路由未来 Fetch/XHR 媒体请求；绝不
  abort、reload 或重放已经在进行的请求。
- 使用 cooldown 和有上限的 backoff，避免 host ping-pong。普通候选之后仍以
  MCDN/PCDN 为最后兜底。
- 静态 candidate pool 只允许作为显式、非默认实验性排序提示，并且只能引用当前
  exact signed candidate group 已有 URL；不得引入外部 host/URL。
- 设计门禁已经完成并记录在 `docs/design/cdn-stall-recovery.md`：每个被唯一请求命中
  的 exact group 独立运行状态机；low buffer threshold 为 `0.5 s`，grace 为
  `3,000 ms`，最小 cooldown 为 `15,000 ms`，指数 backoff 从 `5,000 ms` 增长且
  封顶 `60,000 ms`。
- Fetch 只在 predecessor 前映射未来 `GET` input；XHR 只在唯一 native `open()` 前
  映射 primitive string `GET` URL。歧义、DOM 不可读、构造失败、wrapper 异常或
  native media loader 绕过都 fail-open；浏览器 gate 必须区分 `PASS`、`FAIL`、
  `UNSUPPORTED` 与 `INCONCLUSIVE`。
- CDN Switcher 等兼容 response transformer 可能在 BALH policy adapter 之后继续变换
  candidates。assignment-aware 最终响应观察器会把后来赋值的 Fetch/XHR wrapper 放在
  透明观察层之内，并在页面拿到响应前重新发布 downstream final exact groups；它不
  二次运行 selector、不替换 `Response` / XHR identity，也不合成 URL。这样两种加载
  顺序都以页面实际收到的候选作为 Stage 2/3 权威输入。
- playurl Fetch/XHR 在 predecessor 开始前取得 monotonic delivery token。新请求先完成
  后，旧 response 晚到只会触发恢复最近接受的 immutable final-group snapshot，不能
  覆盖当前 candidates/registry；同步 Vue/hydration delivery 同样会 supersede 更早的
  pending transport。显式关闭脚本则既不安装这些观察器，也不会安排 auto probe。
- 本阶段实现、确定性测试、受控真实 Chrome gate、真实站点 capability classifier 与
  latest CDN Switcher 组合 gate 已完成。`safe` / `original` / `manual`、显式关闭、native
  loader bypass 和证据歧义仍按设计禁用或 fail-open。

## Compatibility Contract

- 兼容范围只覆盖 latest Bilibili Video CDN Switcher，不维护旧版矩阵。
- 当前固定 snapshot 是 `0.1.4`，SHA-256
  `261e2dee00acd83ed40f1cc26cf8c5feffc599c41b95952d44b98c09af8dc0d4`。
- latest-upstream browser gate 使用不同的 source/post-CDN host，分别覆盖两种
  BALH/CDN Switcher 加载顺序和 Fetch/XHR response transport；只有 post-CDN exact
  candidates 可以激活 future-route recovery。最终合并证据必须来自 strengthened gate
  的完整通过结果，不能沿用候选本来就在目标 host 上的旧 fixture 结果。
- strengthened gate 已在 Chrome `151.0.7922.72` 通过：`balh->cdn` 与 `cdn->balh`
  的 Fetch/XHR 均为 `primary -> primary -> alternate -> alternate`；固定上游身份仍是
  `0.1.4` 与上述 SHA-256。测试同时门禁 post-CDN publication、pre-CDN 零激活、当前
  请求不重放、实际 grace/cooldown、稳定恢复、transport health 与隐私 surface。

## Release Gate

- 三个阶段的实现必须全部合并，稳定发布门禁才可以继续。
- 随后必须由 Joey 在 UK-local 环境人工验收播放与恢复行为。
- 2026-08-06 的仓库 live E2E gate 已通过：BVID `BV17x411w7KC` 在 Chrome
  `151.0.7922.72` 中真实播放推进；2 个 candidate/probed host 均 healthy，probe
  attempts 为 `completed=4` / `total=4`，持久化 2 个 host，并在重载后的新 runtime
  中以 `source="cache"`、`hostCount=2` 无网络复用。这只是自动辅助证据，不满足
  Joey 的人工验收。
- 同一实现树的受控 recovery browser gate 已通过 Fetch/XHR：当前请求保持 in-flight，
  future exact route 切到 alternate，cooldown 保持 alternate，predecessor/player
  identity、浏览器 cleanup 与 exact-URL 隐私均验证完成。
- live Stage 3 capability classifier 对同一 BVID 返回 `INCONCLUSIVE` / `exit 3`，原因是
  `no-unique-exact-group`。这正确保留了证据不足与成功之间的边界，不替代受控正向 gate，
  也不表示生产代码失败。
- 合并与人工条件同时满足前，不创建稳定版 tag、不发布稳定版，也不刷新 `main`。

## Next Steps

1. 合并 Stage 1/2 PR #13 与独立 Stage 3 PR，确认三个阶段全部进入 `dev`。
2. 由 Joey 执行 UK-local 人工播放验收。
3. 仅在上述门禁通过后恢复稳定 tag/release/`main` 刷新流程。

## Evidence

- 详细架构：`docs/design/cdn-selection.md`
- Stage 3 可复用状态机与接入契约：`docs/design/cdn-stall-recovery.md`
- 已完成的 Stage 1/2 工作流：
  `docs/project_journal/2026/08/2026-08-04-cdn-selection-integration-21b2.md`
- CDN Switcher canonical identity 与固定 snapshot：
  `packages/unblock-area-limit/README.md#cdn-switcher-兼容性`
- 精确 live E2E CLI 继续由仓库根 README 维护。
- Stage 3 本地交付门禁：`pnpm run check`、
  `pnpm run test:cdn-recovery-browser --timeout-ms 120000`、
  `pnpm run test:cdn-switcher:latest`、
  `pnpm run test:cdn-live-e2e --timeout-ms 120000` 与可选
  `--stage3-capability` classifier。
