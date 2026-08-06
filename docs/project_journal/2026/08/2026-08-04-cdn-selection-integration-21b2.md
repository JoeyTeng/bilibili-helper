---
id: 20260804-cdn-selection-integration-21b2
title: CDN Selection Integration (Stages 1 and 2)
status: completed
created: 2026-08-04
updated: 2026-08-06
branch: wip/cdn-selection-integration
pr:
supersedes: []
superseded_by:
---

# CDN Selection Integration (Stages 1 and 2)

## Summary

- 在 `dev` 的待交付范围内完成 CDN 选择 Stage 1（响应适配）与 Stage 2（本机
  两阶段探测），并把可复用架构记录在 `docs/design/cdn-selection.md`。
- `original`、`safe`、`auto` 与 `manual` 四种模式现已共用同一选择核心，并覆盖
  Vue、Fetch、XHR 的 source/proxy 交付边界以及 WBI response-only 边界。
- 兼容窗口只承诺测试时最新版 Bilibili Video CDN Switcher；当前固定并验证
  `0.1.4` / SHA-256
  `261e2dee00acd83ed40f1cc26cf8c5feffc599c41b95952d44b98c09af8dc0d4`。

## Delivered

- 纯选择层只重排当前 playurl 已授权的完整 signed URL，按 representation 或
  `durl` segment 隔离候选；protocol-relative 字符串、重复项、字段风格与
  MCDN/PCDN 最后兜底均原样保留。
- runtime 提供 host-only `v2` 健康缓存、`20 min` TTL、网络上下文失效和无凭据的
  两阶段浏览器探测，playurl 关键路径不等待结果。Stage 1 在动态 `2 MiB` 预算允许
  完整 `64 KiB` 样本时覆盖每个可准入不同 host；成功结果的稳定前两名共享剩余
  Stage 2 follow-up，每个最多 `512 KiB`，并发最多 `2`。吞吐量与可靠 DASH bitrate
  margin 是主要证据，TTFB 是次要证据。
- 主动探测只准入实际 URL 命中的受信任 Bilibili 媒体域名并拒绝 redirect；请求
  使用 `credentials: "omit"` 且默认无 `Range`。IP literal、localhost、私网风格、
  未知域、已知外部 PCDN 域和带 userinfo 的候选继续作为播放器回退，但不发主动
  请求、不读写 health；受信任 `bilivideo.*` namespace 内的 MCDN/`mirror14b`/
  `302` 风格风险标签只限制排序层级，不额外改变网络准入。CORS 不可读结果保持
  `unprobeable`。
- 整轮 accounted prefix 硬限制为 `2 MiB`；reader 交付的完整 chunk 可以使当前
  batch 的 raw 实收量超出动态预算，但只有 clipped prefix 进入计分，raw observed
  bytes 会阻止后续请求。请求/阶段维持约 `2–4 s` 默认边界，取消后的清理最多
  `250 ms`。不完整、预算受限、不可测或清理不安全的轮次不持久化。
- 新配置键缺失或非法时，只有既有 legacy UPOS 配置会迁移到 `manual`；其他情况
  默认 `safe`。旧 UPOS/Akamai 设置只在有效 `manual` 模式下生效。
- 无自定义区域代理但脚本未显式关闭时，仍安装 CDN-only Fetch/XHR；Vue
  路径同时 watch `__playinfo__` 与 `__PLAYURL_HYDRATE_DATA__`，因而能处理
  document-start 之后可拦截的赋值。交付时克隆 raw playinfo 再应用 CDN policy，
  configurable accessor 每次从当前 raw value 重建 delivery；不改写 source object，也不
  触发区域代理。Non-configurable descriptor 按当前能力 best-effort 处理、告警并
  fail-open；显式“关闭脚本”保持完全关闭。
- Vue session cache 只保存未应用 CDN 策略的规范化 playurl，每次交付克隆后使用
  当前配置；过期 episode/request 结果不会更新 runtime、缓存或共享对象，策略部分
  修改后抛错也会从 raw playurl 重新克隆并 fail-open。
- 泰区 mobile normalization 固定使用与模式无关的 `hw` 兼容形式，并把被替换的
  Akamai primary 保留为 backup provenance，最终 `manual` 原子 gate 不再被绕过。
- Fetch 重建响应时保留可复用的 status、headers 与多代 clone 元数据，并移除描述
  旧 body 的长度、编码、range 与 validator headers；解析失败或 CDN policy 抛错时
  返回 predecessor response，丢弃 clone 上的部分修改。
- XHR 返回真实 native 实例，保留外部 subclass、私有字段、WeakMap identity 与
  native brand；`send()` 先由 native 验证，`abort()` 和成功的 `open()` 使旧
  generation 失效，而同步失败的 `open()` 完整保留已有 replacement、pending
  conversion 与被扣留的 `DONE`。跨 realm thenable、异步 race、失败回退、callback
  异常与实例复用均有确定性回归覆盖。代理 body 只在真实 native `DONE` 后发布，
  不伪造 status、URL 或 headers。
- CDN Switcher 门禁从 canonical `.user.js` 与 `.meta.js` 获取 latest，强制固定
  version 和 SHA-256，并在真实浏览器 context 测试两种加载顺序。
- `/x/player/wbi/playurl` 只在已返回的 Fetch/XHR response 上运行共享 CDN adapter；
  BALH 不 proxy、重发或重新签署请求的 `w_rid` / `wts`。
- 候选变化会中止旧 generation；若新自动回调在旧 controller drain 前到达，
  runtime 每个 drain 只保留一个 continuation，并将意图更新为最新 generation/
  candidate-host hash。drain 后重新交给 background scheduler，不重叠 probe，也不
  静默丢失最新候选；旧 run 收尾时发现网络 generation 改变也会重排。
- Active-controller fence 只保护未终止的应用层清理。cancel 最终 reject 且
  abort/request 已终止时会解除调度 fence，但该轮仍是 cleanup-unsafe、停止
  后续阶段并且不写 cache；永不 settle 的 cancel 继续阻断新 probe。

## Decisions

- 自动模式不得从静态 candidate pool、catalog 或历史 host 构造媒体 URL，也不按
  locale、timezone、IP 地理位置或“英国常用 CDN”硬编码偏好。
- Probe 准入按 candidate URL 判断、health 按 host 聚合；同 host 的未准入 duplicate
  不污染可安全探测 URL 的 health。禁止自动跟随 30x，避免准入 host 二跳到未准入
  地址。
- MCDN/PCDN 是唯一风险降级层，只软降级、不删除；下游播放器继续拥有媒体请求
  fallback。
- Stage 2 探测只影响之后取得的 playurl；当前播放的 stall recovery 属于独立
  Stage 3 PR。
- 持久化记录只包含 host 级聚合、统一 `v2` cache version、时间、候选集合摘要和
  粗粒度网络提示，不包含 path、query、signed URL、视频或用户标识；日志也不记录
  signed URL。
- 共享核心的幂等、fail-open 与 envelope 边界由仓库内确定性测试负责；第三方组合
  harness 聚焦 CDN Switcher 与 BALH 的 Fetch/XHR hook chain。
- XHR replacement 只保证 property/listener 两种 `readystatechange`；native-first
  补发事件的 `isTrusted` 为 false，且不暂停或重放 `load`、`error`、`loadend`、
  `progress`。

## Validation

- 2026-08-06 在最终 pre-review 实现树运行 `pnpm run check` 已通过：TypeScript、
  async/subtitle/diagnostics、XHR compatibility、全部 CDN selector/runtime/adapter
  回归与 production build 均通过。
- 2026-08-06 运行
  `pnpm run test:cdn-live-e2e -- --timeout-ms 120000` 已通过，目标 BVID
  `BV17x411w7KC`、Chrome `151.0.7922.72`：
  - `probeState=ready`；
  - candidate/probed/healthy host 数分别为 `2/2/2`，failed/unprobeable/
    budget-limited 分别为 `0/0/0`；
  - probe attempts `completed=4`、`total=4`；
  - 持久化 `cachedHosts=2`；页面重载后的新 runtime 以 `source="cache"`、
    `hostCount=2` 复用，未启动新的网络 probe。
- 2026-08-06 的 `pnpm run test:cdn-switcher:latest` 已在文件系统沙箱外通过，以便
  下载固定 snapshot 并启动已安装的 Chrome：
  - Chrome `151.0.7922.72`；
  - Bilibili Video CDN Switcher `0.1.4`；
  - SHA-256 `261e2dee00acd83ed40f1cc26cf8c5feffc599c41b95952d44b98c09af8dc0d4`；
  - `balh->cdn` 与 `cdn->balh` 的 Fetch/XHR 均得到 `compat-cdn.invalid`。
- 最后一次文档更新后，`git diff --check` 已通过。

## Program Boundary

- 未执行真实 Bilibili 登录态/英国线路的人工播放验收；自动模式不宣称已证明某个
  固定 host 在英国最快。
- Stage 3 在独立后续 PR 中实现 stall recovery：只在页面可见、未暂停、未 seeking
  且 low-buffer grace 再确认后触发；exact candidate groups 只存内存，只重路由
  未来 Fetch/XHR 媒体请求，不 abort/reload 当前请求，并使用 cooldown/backoff
  避免 ping-pong。MCDN/PCDN 保持最后兜底；静态 pool 只允许作为引用当前 exact
  signed candidate group 已有 URL 的非默认实验性排序提示。
- Range cache、预取和 Service Worker 接管不属于 Stage 1/2。
- 不维护旧版 CDN Switcher 兼容矩阵；上游 latest 变化时必须重新验证并更新固定
  version/SHA-256。

## Next Steps

- Stage 1/2 集成工作流已完成；后续交付转到
  `2026-08-05-cdn-three-stage-delivery-21b2.md`。
- 由独立 PR 完成并合并 Stage 3；三个阶段全部合并后，由 Joey 在 UK-local 环境
  完成人工播放验收。
- 在上述两项完成前，不创建稳定版 tag、不发布稳定版，也不刷新 `main`。仓库 live
  E2E gate 不能替代人工验收。

## Evidence

- 架构：`docs/design/cdn-selection.md`
- 目标分支：`dev`
- 确定性测试：`scripts/test-cdn-*.mjs`、`scripts/test-playurl-integration.mjs`、
  `scripts/test-fetch-response-compat.mjs`、`scripts/test-vue-cdn-boundaries.mjs` 与
  `scripts/test-xhr-*.mjs`
- 最新版兼容门禁：`scripts/test-cdn-switcher-latest.mjs`
- 完整仓库的 project-journal 验证仍被无关的既有
  `docs/project_journal/2026/06/2026-06-05-diagnostic-report.md` 阻塞，因为该文件没有
  frontmatter；helper 没有单文件验证模式，因此不宣称完整 journal validation 已
  通过。
- 参考提交：
  - `siwei-yuan/bili-pilot@2baca4178fcfb449d40a30662bcd711c9e4d8121`
  - `realzza/bilibili-accelerator@6cba8c8b23ad01a152d186420081284b6eda1f77` (`v0.4.0`)
  - `SukkaW/Make-Bilibili-Great-Than-Ever-Before@800ca13061df9b87fb6f38c0b2b2346ebd6812f9`
  - `MareDevi/bilibili-tui@98737ce7d50a317455f4b959bab0d320577298c1`
