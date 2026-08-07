---
id: 20260805-cdn-three-stage-delivery-21b2
title: CDN Three-Stage Delivery
status: active
created: 2026-08-05
updated: 2026-08-07
branch:
pr: 14
supersedes: []
superseded_by:
---

# CDN Three-Stage Delivery

## Summary

- CDN selection 按三个阶段交付。Stage 1 与 Stage 2 由
  [PR #13](https://github.com/JoeyTeng/bilibili-helper/pull/13) 交付；Stage 3 由
  [PR #14](https://github.com/JoeyTeng/bilibili-helper/pull/14) 交付，三个阶段均已进入
  `dev`。
- 三个阶段全部合并且 Joey 在 UK-local 环境完成人工播放验收前，整体状态保持
  `active`。
- UK-local 人工播放验收完成且 Joey 明确授权发布前，不得创建稳定版 tag、发布稳定版或
  刷新 `main`。

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
  后，inner policy 仅变换私有 payload；只有被接受的 final token 才提交全局状态。旧
  response 晚到为零 collection/publication/schedule，不会以“旧组 -> snapshot 恢复”重置
  当前 activation、timer、attempt 或 override；同步 Vue/hydration delivery 同样会
  supersede 更早的 pending transport。有效 JSON 错误响应以同 token 发布空组，清除旧
  signed registry。显式关闭脚本则既不安装这些观察器，也不会安排 auto probe。
- final observer 与 Fetch/XHR adapters 共享现代 exact host/path 加 legacy path 的 endpoint
  classifier；observer 仍只接收解析后的 HTTPS。无关 GET 在 router eligibility 阶段直接
  返回，不查询 video DOM、读取媒体属性或重排 monitor timer。
- 本阶段实现、确定性测试、受控真实 Chrome gate、真实站点 capability classifier 与
  latest CDN Switcher 组合 gate 已完成。`safe` / `original` / `manual`、显式关闭、native
  loader bypass 和证据歧义仍按设计禁用或 fail-open。

## Fresh-context Review Closure — 2026-08-07

- 冻结范围 `dcec657..1d284b` 的本地 fresh-context Codex review 提出 5 项 findings；
  本分支均已修复并补确定性回归：cooldown 观测区间、有效错误 envelope 空交付、完整
  supported endpoint classifier、stale response 零全局发布、无关 GET 零 DOM hot-path。
- 后续聚焦审计又补齐播放器替换后的 decision re-prepare、同步重入 final commit 串行化
  （包括 status listener 与 mode reader 两个重入点的 supersession fence）、非 JSON XHR
  responseType fail-open，以及“缺失/明显过短 cooldown 必须先判 FAIL”的 classifier
  顺序；每项均有直接回归。
- 最终 `origin/dev..Stage 3 head` 整段 fresh-context review 另确认两个交付边界：jQuery
  区域代理 Promise 的最终 payload 必须压过内部 raw XHR，且可信 `OPENED` listener
  同步重入 `open()` 后外层 route transaction 不得提交。修复使用 jQuery transport XHR
  identity 绑定 request-start token，并在一次 final observation 后统一交付 option
  `success` / `.done()`；XHR transaction 以 applied generation 拒绝已被内层取代的外层
  commit。真实 wrapper、旁路 XHR、乱序、组合回调与 inner-open 均有直接回归。
- 新 head 的下一轮整段 review 又发现 jQuery `.done()` gate 若只在 `ajax()` 返回后安装，
  用户 `beforeSend` 或全局 `ajaxSend` 中更早注册的 callback 仍会读取 raw payload。修复
  改为在用户 `beforeSend` 前安装、hook 返回后幂等修复、`ajax()` 返回后再次兜底；只把
  内部 resolver 绑定到 predecessor Deferred 一次。真实生命周期 harness 分离 jqXHR
  facade 与 native transport，并覆盖 hook receiver/args/return、用户替换 `.done`、
  `beforeSend`/`ajaxSend`/链式/重入/late memory 的顺序和同一 final object。
- 提交前生命周期审计继续拦下 global `ajaxSettings.beforeSend` 被 request wrapper 遮蔽、
  option `success` 被错误固定在早期 `.done()` 之前、Deferred context/三参数丢失，以及
  fixture 把 native transport 建在 `ajaxSend` 之前四个问题。最终实现按真实注册顺序统一
  排队，只替换 data；保留 receiver、`textStatus`、jqXHR、全局 hook 合并与 `false` 取消，
  并用 `beforeSend -> option registration -> ajaxSend -> factory/open/send` 的模型直接回归。
- 冻结范围 `e7b8a988..38a3c1e9` 的正式 fresh-context review 又提出 2 项 P2：后置未知
  accessor repair 必须停用被 wrapper 捕获的旧 Fetch/XHR observer；页面 `.done()` 抛错
  不能被 Promise catch 误报为 AJAX error。修复对未知 accessor 保持 getter/setter 零调用
  并保守停用 predecessor；成功 callback list 在抛错点停止，exact error 由独立 task
  重抛。Fetch/XHR accessor 与 early/option/returned callback throw 都有直接回归；新的
  签名 head 仍需重新执行完整测试、secret admission 与整段 fresh-context review。
- 新 head `44c71b9` 的整段 fresh-context rereview 再提出 1 项 P2：隐藏页面中健康推进
  超过 `5 s` 仍会触发 stable reset，错误清除 CDN failure history。修复让稳定恢复与低
  buffer 确认一样要求 `visible`；fake-clock 回归覆盖 `waiting-retry` / `exhausted`、
  `visible=false/null` 跨窗不变，以及随后可见连续推进仍按契约重置。该修复进入新的
  签名 head；合并门禁仍以该 head 的完整测试、secret admission 与整段 fresh-context
  review 结果为准。
- 签名 head `ab829be` 的整段 fresh-context review 提出 1 项 P1：stall 确认时过早把
  尚未发出的 alternate 写入 `candidateIndex` / attempted，可能在没有 future GET 时跨
  cooldown 跳过多个候选；若原请求先自行恢复，还会把未使用 alternate 当成成功项。
  修复把 committed candidate、persistent override 与 pending intent 分离；只有 Fetch
  predecessor 接受或 native XHR `open()` 成功后的 commit 才消费候选。pending 未 commit
  时保持 `waiting-retry` 且不再 advance，稳定恢复则取消 pending、以最后真实 candidate
  重置。最终签名 head 仍按完整测试、secret admission 与新的整段 fresh-context review
  重新验收。
- 对上述修复的 live capability 聚焦审计继续拦下 5 个 false-PASS 边界：浏览器请求窗口
  不能证明哪个请求导致 commit、cooldown 锚到了最后 pending 样本、终点可能使用陈旧
  observer snapshot、健康样本可跨隐藏/暂停间隔，以及 stable reset 可改写 deadline。
  修复后的页面 hook 只在 Fetch predecessor 返回或 native XHR `open()` 成功后记录单调
  acceptance；coordinator 以同一次同步时钟公开不含 URL 的 `routeCommittedAt`。gate 要求
  acceptance 在冻结 intent 序列后且不晚于 commit；committed status 读取前的 hook
  fence 必须已包含该 acceptance，并精确验证
  `retryAt >= routeCommittedAt + 15,000 ms`；终点持续检查 page-hook route，稳定窗口限制
  相邻样本不超过 `700 ms`，reset 只能使用前一采样已证明的窗口且必须原样保留 commit
  时间和 deadline。无法建立因果关系的 XHR delayed-send 等情况降级为 `INCONCLUSIVE`，
  不再误报 `FAIL` 或 `PASS`。
- `routeCommittedAt` 接入审计还发现 accepted-request `commit()` 之前的 monitor wake 可能
  恰好完成 `5 s` stable window，先取消已被 predecessor 接受的 pending intent。browser
  composition 现在把 video identity synchronization 与 playback sample 拆开：eligible
  prepare 与 native acceptance 后只同步 video/context，route commit 线性化并写入 commit
  时间后才执行普通 wake。组合回归把 stable window 固定在 `4,999 ms`，于第 `5,000 ms`
  接受 alternate，并断言 candidate 被真实提交、deadline 从该 commit 补满 `15,000 ms`。
- capability hook 本身也保持 fail-open：先让 predecessor 返回/抛出原结果，再 best-effort
  解码 method/URL 与记录 acceptance；观测时钟或 history 写入失败只设置 sticky
  evidence-incomplete，不改变 Fetch promise/throw 或 XHR native outcome。classifier 同时严格
  校验 accepted sequence、逐 candidate transport count 与 schema；任何缺失、畸形或计数不一致
  都只能 `INCONCLUSIVE`，不能因静默丢记录而在 cooldown 终点假通过。
- `pnpm run check` 在最终 findings 修复树上完整通过；聚合 gate 新增
  jQuery-final-delivery、empty-final-delivery 与 live cooldown assessment 回归，且 build
  成功。
- 受控 Chrome `151.0.7922.108` recovery E2E 在最终修复树重新通过：Fetch grace
  `3024 ms`、XHR grace `3012 ms`，两者均保持 current request；grace 后只安装 pending
  intent，future predecessor 接受后才 commit alternate 并从真实 commit 时刻补满 cooldown，
  cooldown、predecessor/player identity、cleanup 与隐私门禁均通过。
- 固定 CDN Switcher `0.1.4` / SHA-256
  `261e2dee00acd83ed40f1cc26cf8c5feffc599c41b95952d44b98c09af8dc0d4` 重新通过两种
  load order；Chrome `151.0.7922.108` 中 Fetch/XHR 均为
  `primary -> primary -> alternate -> alternate`。
- committed/pending route 分离后的真实 Bilibili live E2E 使用公开 BVID `BV1xx411c7mD`
  完整通过：2 个 candidate/probed host 均 healthy，`completed=4` / `total=4`，cache 以
  `source="cache"` / `hostCount=2` 无网络复用。最终候选树的首次 live 运行出现一次
  `cdn-cache-coverage: not-exercised`，同一代码、BVID 与命令在新的浏览器 context 立即
  重试即得到上述完整 `4/4` 与 cache reuse；结合受控 fixture 未变，按外部请求瞬态记录，
  不归类为代码失败。Stage 3 capability 仍严格
  返回 `INCONCLUSIVE` / `exit 3`，原因是 `no-unique-exact-group`，没有降级为 generic
  PASS。
- 最终合并门禁把 `origin/dev@e7b8a988` 到新签名 head 的整个真实 PR merge-base 范围
  作为唯一验收范围，重新执行 secret admission 与 fresh-context Codex review；旧 review
  结果只用于 findings closure，不作为最终清洁结论。
- 最终签名 head `9835f398` 的 exact-secret admission 为 `clean`，临时清理完整；唯一
  fresh-context Codex review 结论为 `No findings.`。PR #14 的 CI `check` 通过后以
  `c1d136e` squash 合并；合并后的 `origin/dev` tree 与受测 head tree
  `ef97c0d29ba090f8e80ceff6886ad64acb13f42a` 完全一致，GitHub commit verification 为
  `verified=true` / `reason=valid`。

## Compatibility Contract

- 兼容范围只覆盖 latest Bilibili Video CDN Switcher，不维护旧版矩阵。
- 当前固定 snapshot 是 `0.1.4`，SHA-256
  `261e2dee00acd83ed40f1cc26cf8c5feffc599c41b95952d44b98c09af8dc0d4`。
- latest-upstream browser gate 使用不同的 source/post-CDN host，分别覆盖两种
  BALH/CDN Switcher 加载顺序和 Fetch/XHR response transport；只有 post-CDN exact
  candidates 可以激活 future-route recovery。最终合并证据必须来自 strengthened gate
  的完整通过结果，不能沿用候选本来就在目标 host 上的旧 fixture 结果。
- strengthened gate 已在 Chrome `151.0.7922.108` 通过：`balh->cdn` 与 `cdn->balh`
  的 Fetch/XHR 均为 `primary -> primary -> alternate -> alternate`；固定上游身份仍是
  `0.1.4` 与上述 SHA-256。测试同时门禁 post-CDN publication、pre-CDN 零激活、当前
  请求不重放、实际 grace/cooldown、稳定恢复、transport health 与隐私 surface。

## Release Gate

- 三个阶段的实现已经全部合并；稳定发布门禁当前只等待 UK-local 人工验收。
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
- UK-local 人工验收完成且 Joey 明确授权前，不创建稳定版 tag、不发布稳定版，也不刷新
  `main`。

## Next Steps

1. 由 Joey 执行 UK-local 人工播放验收。
2. 仅在人工门禁通过并收到明确授权后，恢复稳定 tag/release/`main` 刷新流程。

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
