---
id: 20260804-cdn-selection-integration-21b2
title: CDN Selection Integration
status: completed
created: 2026-08-04
updated: 2026-08-04
branch: wip/cdn-selection-integration
pr:
supersedes: []
superseded_by:
---

# CDN Selection Integration

## Summary

- 在 `dev` 的待交付范围内完成浏览器端 CDN 选择首轮实现，并把可复用架构记录在
  `docs/design/cdn-selection.md`。
- `original`、`safe`、`auto` 与 `manual` 四种模式现已共用同一选择核心，并覆盖
  Vue、Fetch、XHR 的 source/proxy 交付边界。
- 兼容窗口只承诺测试时最新版 Bilibili Video CDN Switcher；当前固定并验证
  `0.1.4`。

## Delivered

- 纯选择层只重排当前 playurl 已授权的完整 signed URL，按 representation 或
  `durl` segment 隔离候选；protocol-relative 字符串、重复项、字段风格与
  MCDN/PCDN 最后兜底均原样保留。
- runtime 提供 host-only 健康缓存、网络上下文失效、无凭据且有预算的浏览器探测，
  playurl 关键路径不等待探测结果。主动探测只准入实际 URL 命中的受信任 Bilibili
  媒体域名并拒绝 redirect；IP literal、localhost、私网风格、未知域和 PCDN 候选
  继续作为播放器回退，但不发主动请求、不读写 health。
- 新配置键缺失或非法时，只有既有 legacy UPOS 配置会迁移到 `manual`；其他情况
  默认 `safe`。旧 UPOS/Akamai 设置只在有效 `manual` 模式下生效。
- 无自定义区域代理但脚本未显式关闭时，仍安装 CDN-only Fetch/XHR，并处理现有
  hydration 数据；显式“关闭脚本”保持完全关闭。
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

## Decisions

- 自动模式不得从静态 candidate pool、catalog 或历史 host 构造媒体 URL，也不按
  locale、timezone、IP 地理位置或“英国常用 CDN”硬编码偏好。
- Probe 准入按 candidate URL 判断、health 按 host 聚合；同 host 的未准入 duplicate
  不污染可安全探测 URL 的 health。禁止自动跟随 30x，避免准入 host 二跳到未准入
  地址。
- MCDN/PCDN 只软降级，不删除；下游播放器继续拥有媒体请求 fallback。
- 探测只影响之后取得的 playurl；当前播放的 stall recovery 明确延期。
- 持久化记录只包含 host 级聚合、统一 cache version、时间、候选集合摘要和粗粒度
  网络提示，不包含 path、query、签名、视频或用户标识。
- 共享核心的幂等、fail-open 与 envelope 边界由仓库内确定性测试负责；第三方组合
  harness 聚焦 CDN Switcher 与 BALH 的 Fetch/XHR hook chain。
- XHR replacement 只保证 property/listener 两种 `readystatechange`；native-first
  补发事件的 `isTrusted` 为 false，且不暂停或重放 `load`、`error`、`loadend`、
  `progress`。

## Validation

- `pnpm run check` 已通过：TypeScript、既有 async/subtitle/diagnostics 测试、XHR
  compatibility、全部 CDN 自动化测试与 production build 均通过。
- `pnpm run test:cdn-switcher:latest` 已在文件系统沙箱外通过，以便启动已安装的
  Chrome：
  - Chrome `151.0.7922.72`；
  - Bilibili Video CDN Switcher `0.1.4`；
  - SHA-256 `261e2dee00acd83ed40f1cc26cf8c5feffc599c41b95952d44b98c09af8dc0d4`；
  - `balh->cdn` 与 `cdn->balh` 的 Fetch/XHR 均得到 `compat-cdn.invalid`。
- 最后一次文档更新后，`git diff --check` 已通过。

## Deferred and Non-goals

- 未执行真实 Bilibili 登录态/英国线路的人工播放验收；自动模式不宣称已证明某个
  固定 host 在英国最快。
- 当前播放中的 stall detection、segment request switching、Range cache、预取和
  Service Worker 接管不属于首轮范围。
- 不维护旧版 CDN Switcher 兼容矩阵；上游 latest 变化时必须重新验证并更新固定
  version/SHA-256。

## Next Steps

- 本工作流没有后续步骤。延期的 stall recovery 需要独立设计与验收计划。

## Evidence

- 架构：`docs/design/cdn-selection.md`
- 目标分支：`dev`
- 确定性测试：`scripts/test-cdn-*.mjs`、`scripts/test-playurl-integration.mjs`、
  `scripts/test-fetch-response-compat.mjs`、`scripts/test-vue-cdn-boundaries.mjs` 与
  `scripts/test-xhr-*.mjs`
- 最新版兼容门禁：`scripts/test-cdn-switcher-latest.mjs`
- 完整仓库的 project-journal 验证仍被无关的既有
  `docs/project_journal/2026/06/2026-06-05-diagnostic-report.md` 阻塞，因为该文件没有
  frontmatter；本条日志已单独验证。
- 参考提交：
  - `siwei-yuan/bili-pilot@2baca4178fcfb449d40a30662bcd711c9e4d8121`
  - `realzza/bilibili-accelerator@6cba8c8b23ad01a152d186420081284b6eda1f77` (`v0.4.0`)
  - `SukkaW/Make-Bilibili-Great-Than-Ever-Before@800ca13061df9b87fb6f38c0b2b2346ebd6812f9`
  - `MareDevi/bilibili-tui@98737ce7d50a317455f4b959bab0d320577298c1`
