# CDN Selection Architecture

状态：首轮实现与自动化验证已完成；实时 stall recovery 与真实站点手工播放验收
仍按本文明确延期。

本文定义 BALH 浏览器端 CDN 选择的规范边界。它适用于 Bilibili 原始
playurl 响应和 BALH 代理返回的 playurl 响应，也适用于 Vue、`fetch` 与
`XMLHttpRequest` 三条现有播放链路。除明确标为扩展点或延期项的内容外，
实现与测试应以本文为准。

## 实现索引

这组边界被拆成可在其他项目中复用的四层，而不是散落在每个播放入口中：

- `cdn_selection.ts`：纯候选提取、风险分类、稳定排序与原形写回，不读取配置、
  DOM、存储或网络。
- `cdn_runtime.ts`：配置 adapter、host-only 健康缓存、网络上下文失效和有界浏览器
  探测；播放响应路径只读取已有快照并异步安排探测。
- `cdn_playurl.ts`：把 Bilibili/BALH 的 response envelope 解包到唯一 playurl
  payload，再调用共享 runtime。
- Vue、Fetch、XHR adapter：只负责在各自“最终交付给播放器”边界调用 envelope
  helper；不得复制排序、探测或 host replacement 逻辑。

相应回归测试按相同边界拆分为 selector、runtime、配置迁移、playurl integration、
Fetch response compatibility、Vue cache/request boundary、无区域代理时的 CDN-only wiring、
XHR subclass/async fallback compatibility，以及 latest CDN Switcher browser
compatibility。新增播放入口时，优先扩展 envelope/adapter 和现有测试，而不是派生
第二套选择器。

## 目标

- 在不伪造签名媒体地址的前提下，从 Bilibili 为同一媒体对象返回的候选地址中
  选择更适合当前浏览器网络的地址。
- 让保守排序、自动探测与旧版手动换 host 共用一个纯选择核心，并在所有播放
  数据入口保持一致。
- 对 MCDN/PCDN 使用软分类：优先避开，但永远保留为最后兜底。
- 探测在用户本机浏览器中后台执行，具有明确的应用读取、并发、时间与隐私边界，
  并对底层传输做 best-effort cancel。
- 不影响 BALH 现有的区域解锁、代理重试、字幕和响应兼容逻辑；任何不确定性都
  应回退到未修改的数据或请求。
- 与最新版本的 Bilibili CDN Switcher 保持可测试的组合兼容性。

## 非目标

- 不维护一个“英国最快 CDN”名单，也不按时区、语言、IP 地理位置或预设地区
  对 host 加权。
- 不从 catalog、历史常量或第三方服务生成自动模式候选地址。
- 不在本阶段实现播放卡顿后的在线切换、媒体预取、Range 缓存、Service Worker
  接管或 WebRTC/P2P 屏蔽。
- 不承诺兼容旧版 Bilibili CDN Switcher；兼容窗口仅覆盖测试时的最新上游版本。
- 不改变 playurl 的授权、画质、编码、音轨或分段边界。

## 核心不变量

### 完整签名 URL 是唯一事实来源

`baseUrl` / `base_url`、`backupUrl` / `backup_url`，以及 legacy
`durl[].url` 与其 `backup_url` / `backupUrl` 中的完整 URL——包括 scheme（或
合法的 protocol-relative 前缀）、host、port、path、query 与签名参数——是自动
选择的唯一事实来源。

除 `manual` 模式的旧版 host 替换外，实现必须满足：

1. 只返回同一个 playurl 响应中、同一个媒体对象下已经存在的完整 URL。
2. 不通过替换 host、拼接 path/query、复制另一清晰度的签名或使用静态 host
   列表构造候选地址。
3. 不跨视频/音频、清晰度、codec、DASH representation 或 legacy segment
   混用 URL。
4. 某个候选无法解析、探测或请求时，不得因此删除原始候选。

这条边界既保护签名正确性，也限制候选来源。主动探测还有更窄的网络准入边界：
自动模式只会联系当前媒体对象中由 Bilibili 返回、且实际 URL hostname 命中下文
受信任媒体域名规则的候选；未知或高风险地址仍保留为播放器和排序回退，但不会由
BALH 主动发起请求。

### 按 representation 和 segment 分组

`candidate group`（候选组，即同一个媒体对象可互换的完整签名 URL 集合）是
最小选择单位，而不是整个 playurl 响应或全局 host 列表。

- DASH：每个 video/audio representation 各自形成一个候选组；camelCase 与
  snake_case 字段都要支持。
- DASH 的具体 segment/byte-range 请求只能从它匹配到的 representation 组派生
  segment-scoped view；候选完整 URL 仍来自该 representation，segment/range 只
  作为本次选择上下文，不能把其他 representation 的 host 或签名带入。
- Legacy `durl`：每个 segment 各自形成一个候选组。
- Dolby、FLAC 或后续新增音轨仍按各自 representation 分组。
- payload 中的重复 URL 与位置必须保留；完全相同的 URL 只允许在内部 probe
  调度中合并。同 host 但 path/query 不同的 URL 不得合并。
- 同一 host 的历史分数可以复用，但每个候选仍保留自己的完整 URL 与原始位置。

建议的纯数据模型如下；字段名是说明性契约，不要求运行时代码逐字采用：

```ts
type CandidateRisk = {
  kind: "ordinary" | "akamai" | "mcdn" | "pcdn" | "unknown"
  deprioritized: boolean
  reasons: string[]
}

type SignedCandidate = {
  url: string
  host: string
  originalIndex: number
  risk: CandidateRisk
}

type CandidateGroup = {
  key: string
  kind: "dash-video" | "dash-audio" | "durl-segment"
  segmentKey?: string
  candidates: SignedCandidate[]
}
```

`key` / `segmentKey` 只用于当前 playurl 对象内的稳定匹配，不应包含或持久化
账号、视频 ID 或完整签名 URL。

以 `//host/path?...` 返回的 protocol-relative URL 也是完整 signed candidate。
实现可以仅在解析/探测时临时补 `https:`，但非 `manual` 模式写回时必须保留上游
原始字符串形式，不能因为规范化而改变 URL 字节。

### MCDN/PCDN 是软分类

分类器可以结合以下非穷举信号标记风险：

- `*.mcdn.bilivideo.*` host；
- `os=mcdn` query；
- IP-literal 或已知 MCDN 样式 host；
- 非默认 port；
- 已知 PCDN/scheduler host 或 suffix；
- 后续通过测试加入的行为信号。

这些信号只产生 `deprioritized` 元数据，绝不能成为删除条件。排序必须遵守：

1. 有普通候选时，普通候选在前，MCDN/PCDN 候选按稳定顺序置后。
2. 普通候选不可用时，被降级的候选仍保留在末尾，供下游播放器按其原生
   fallback 机制使用；BALH 本阶段不接管媒体请求重试。
3. 只有 MCDN/PCDN 候选时，保留完整列表与原始顺序。
4. 未识别 host 按 `unknown` 处理，不因未知而判死刑。

因此，“避开 PCDN”表示降低优先级，不表示牺牲最后一条可播放路径。

Akamai、`mirrorov` 与 `bcache` 本身都不是 MCDN/PCDN 风险信号。旧版
`preferNonAkamaiDashUrls` 的固定偏好不进入 `safe`：对英国等海外网络，Akamai
可能反而是更好的候选，自动模式应由本机测量决定，而不是按供应商名称预判。
因此这些 host 与其他无风险/unknown 候选处于同一层，并保持原始顺序，只有
`auto` 的新鲜健康分数可以在层内调整它们。
`upos_replace_akamai` 仍只控制 `manual` 的 legacy all-or-nothing gate。

## 选择模式

四种模式必须共享相同的分组、解析与失败回退逻辑。

| Mode | 行为 | 是否后台探测 | 是否可构造新 URL |
| --- | --- | --- | --- |
| `original` | 保持每个候选组的原始顺序与值 | 否 | 否 |
| `safe` | 普通候选（含 Akamai）保持原始顺序，明显 MCDN/PCDN 风险候选在存在普通替代项时稳定置后 | 否 | 否 |
| `auto` | 先按软分类分层，再用本机浏览器探测结果排列可测 host；失败与不可测候选仍保留 | 是 | 否 |
| `manual` | 使用用户显式配置的旧版 host 替换规则 | 否 | 是，仅此模式 |

### `original`

- 是所有异常路径的最终回退。
- 不启动 CDN 探测，不读取探测分数来改变顺序。
- 选择器重复执行必须得到与第一次相同的 payload。

### `safe`

- 只依赖当前完整 URL 的软分类，不依赖网络测量或地理假设。
- 普通候选之间保持原始稳定顺序；被降级候选之间也保持原始稳定顺序。
- 如果分类器报错或没有可识别候选，等价于 `original`。

### `auto`

- 候选来源仍严格限于当前候选组中的完整签名 URL。
- 响应关键路径不得等待探测。首次或无有效缓存时先采用 `safe` 的确定性顺序，
  探测结果只影响下一次 playurl 处理，例如切换清晰度、切换 episode 或刷新后
  重新获取 playurl。本阶段没有当前媒体 segment request adapter，也不承诺在
  已开始的播放中即时换路。
- 在普通候选中优先使用有效、未过期的 host 分数；MCDN/PCDN 仍保留在最后。
- `unprobeable` 与已确认失败分开；浏览器无法证明响应可读时不是“CDN 不可用”。
  当前 timeout 计入 `failure`，而媒体/网络 generation 变化导致的主动取消整次
  丢弃，不形成 host 信誉。
- 所有普通候选都不可测或失败时，回退到 `safe` 排序；不得返回空列表。
- 分数相同或缺失时按原始位置稳定排序，保证重复处理不抖动。

### `manual`

`manual` 是为了兼容现有用户配置而保留的唯一 host 替换路径，不代表自动模式可
采用相同行为。

- 现有 `upos_server`、`upos_replace_akamai`、`uposMap` 与
  `Converters.replaceUpos` 构成 legacy UPOS replacement 契约。配置 adapter 应
  把它们映射到 `manual`，而不是在共享选择核心之后再运行第二次全对象替换。
- `manual` 把整个 playurl payload 作为一个原子兼容单元，调用或等价重现当前
  `Converters.replaceUpos(payload, uposMap[upos_server], upos_replace_akamai)`；
  不把 legacy 行为改写成每个 candidate group 独立决策。
- 当前 legacy gate 是 all-or-nothing：payload 任意位置包含 `akamaized.net` 且
  `upos_replace_akamai` 为 false 时，整次 UPOS replacement 不发生。该可观察行为
  必须由回归测试锁定。
- replacement 把匹配 URL 的完整 authority（含原始 port）换成配置 host，并保留
  scheme、path、query 与签名；protocol-relative URL 仍保持 `//` 形式。
- 缺失/无效 `upos_server`、未知 `uposMap` key、序列化失败或 replacement 异常时，
  整个 payload 原样返回。
- 已经指向目标 host 的 payload 重复执行不应改变结果，保证幂等。
- 诊断信息只记录源/目标 host 和原因，不记录完整 URL。

## 配置与迁移契约

持久化模式键是 `balh_cdn_mode`，合法值只有 `original`、`safe`、`auto` 与
`manual`。读取优先级必须稳定：

1. 已存在且合法的 `balh_cdn_mode` 优先，残留 `balh_upos_server` 不得覆盖它。
2. 新模式键缺失或非法、但 legacy `balh_upos_server` 非空时，迁移为 `manual`。
3. 两者都没有时默认 `safe`。

迁移只在读取旧配置时发生一次；它不删除 `balh_upos_server` 或
`balh_upos_replace_akamai`。UI/写入行为如下：

- 用户选择一个 UPOS server 时，同时把 `balh_cdn_mode` 设为 `manual`。
- 从 `manual` 切换到其他模式时保留旧 UPOS server 与 Akamai checkbox 值，方便
  以后切回，但选择核心必须忽略它们。
- `upos_replace_akamai` 仅在 `manual` 且 UPOS server 有效时启用；其他模式显示为
  保留的非活动设置。
- `manual` 中 server 为空或非法时不暗中改模式，而是按上节原样回退并在 UI 中
  显示未配置状态。
- 变更模式或手动 host 只影响下一次 playurl 处理；UI 应明确提示切换清晰度、
  episode 或刷新生效。

## 浏览器探测

### 执行位置与调度

探测必须在用户当前页面的浏览器网络环境中执行。这里的 “UK-local” 指验证与
实际选择来自英国本地浏览器连接，而不是远程测速服务或代码中的英国 CDN 偏好。
同一实现也必须能在其他地区按当地实测工作。

- 探测是低优先级后台工作，不阻塞 playurl 响应或首个媒体请求。
- 每轮必须限制候选数、并发数、单 host 超时、总轮次时间和最大 scored-prefix
  bytes（进入测量与计分的响应前缀字节数）。
- 视频、episode、质量或候选集合变化时，取消不再相关的工作。
- 页面隐藏、网络离线或浏览器不支持可读流时，可以推迟或跳过探测。
- 只有实际 URL（不能依赖候选旁路 metadata）的 hostname 命中受信任公开 Bilibili
  媒体域名准入规则时才能主动探测。IPv4/IPv6 literal、`localhost`、私网/链路本地
  风格地址与未知域名不进入探测 target；它们仍保留在原始候选和安全排序回退中。
- 同一 host 的并发探测应合并；完成、取消与超时都必须释放 reader、timer 和
  `AbortController`。

具体数值属于共享 runtime 的可测试配置，不应散落在 Vue、Fetch 与 XHR 各自
实现中。首轮实现的生产默认值为：

| Budget | Default |
| --- | --- |
| 每轮候选 | 按原顺序取前 `2` 个不同 host |
| 最大并发 | `2` |
| 采样阶段 | `2` |
| 单请求 scored prefix | `64 KiB` |
| 每轮 scored prefix | `192 KiB` |
| 单请求超时 | `3.5 s` |
| 单阶段超时 | `4 s` |
| 整轮超时 | `7.5 s` |
| host health TTL | `20 min` |

测试可向共享 runtime 注入更小的边界；生产入口不各自覆盖这些数值。调整排序
公式或缓存结构时必须更新统一 cache version。

### 请求契约

默认探测是一个有界前缀读取，而不是 Range 请求：

```ts
const init: RequestInit = {
  method: "GET",
  mode: "cors",
  cache: "no-store",
  credentials: "omit",
  redirect: "error",
  signal: controller.signal,
}
```

1. 使用候选组中已经存在的完整签名 URL，并根据该 URL 自身经 WHATWG URL parser
   解析出的 hostname 做准入；不得信任另一个 `host` / `hostname` metadata 字段。
2. 当前主动探测准入范围是 `bilivideo.com`、`bilivideo.cn`、`bilivideo.net` 的
   apex 或 label-bound 子域，以及精确主机
   `upos-hz-mirrorakam.akamaized.net`。匹配时只为域名判断移除末尾 DNS root dot；
   不使用子字符串或宽泛 `akamaized.net` 后缀匹配，也不准入携带 URL userinfo 的
   候选。这个规则把 DNS 控制视为 Bilibili 信任边界；浏览器代码无法在请求前可靠
   验证最终解析 IP。
3. 禁止自动跟随重定向，避免初始准入 host 把探测转到未准入目标。
4. 默认不发送 `Range`。自定义 `Range` 可能触发 CORS preflight，而且不同 CDN
   支持不一致；未来只有在独立能力检测和测试证明安全后才能作为显式扩展。
5. 读取 `ReadableStream` 的有限前缀，达到字节上限后调用 `reader.cancel()`，并在
   必要时中止请求。
6. 记录有限的 TTFB、读取字节、耗时与吞吐量；不保留响应正文。
7. `no-cors` 不可作为回退，因为 opaque response 无法区分正常内容与快速 403。
8. CORS 拒绝、缺少可读 body 或浏览器无法进一步区分的 Fetch/readability 错误，
   保守标记为 `unprobeable` 并保留候选；不要把它缓存成永久失败。

前缀上限严格约束进入测量、缓存和计分的字节；它不是 JavaScript 实际收到字节或
网络传输量的硬上限。默认 reader 的一次 `read()` 可能交付大于剩余预算的整块
数据，代码只能计入所需前缀并立即 cancel，因此实际读取最多可能再多一个由浏览器
决定大小的 chunk。浏览器、代理或网络栈在 cancel 生效前也可能额外缓冲或传输。
候选数、timeout、reader cancel 与 abort 共同提供 best-effort transport bound
（尽力限制链路传输），文档和 UI 不得把它描述为精确流量上限。

探测会把当前已准入签名 URL 发送给该 URL 自身的 host，这是选择功能不可避免的
最小外发面。未准入 URL 不发请求，也不能通过重定向进入第二个 host。实现不得把
URL 再发送到分析、代理测速或遥测服务。

### 排名

排名使用延迟、有效吞吐量和成功/失败样本。浏览器 Fetch 通常无法可靠区分 CORS
拒绝、部分网络策略错误和缺少可读 body，因此这些情况保守合并为
`unprobeable`，不产生负面信誉；HTTP 非成功响应与超时合并为 `failure`。媒体
上下文或网络变化触发的主动取消会丢弃整次旧 generation 结果，不进入排名或缓存。
排序函数必须是纯函数；评分或缓存语义变化时必须提升统一 cache version。

```ts
type ProbeOutcome = "success" | "failure" | "unprobeable"
```

推荐的稳定次序是：

1. 普通/unknown 候选，包括 Akamai、`mirrorov` 与 `bcache`；
2. MCDN/PCDN 候选，作为完整最后兜底。

每个 tier 内，有新鲜 `ok` 分数的候选按分数降序，其余候选按原始位置；最终
tie-break 始终是 `originalIndex`。

`unknown` 且没有风险信号的候选属于未降级层。只有具有足够成功样本的 health
参与分数排序；其他候选保持原始位置。主动取消不会生成可写入持久化缓存的
outcome，也不能降低 host 信誉；`unprobeable` 不能等同已确认失败。

## Host-only 缓存与隐私边界

可持久化缓存以已准入候选的 `URL.host.toLowerCase()` 为唯一媒体路由键。这里
`host` 是 hostname 加显式非默认 port；浏览器会省略默认 port。域名准入时的末尾
root dot 规范化不改写这个键，显式 port 也不会被丢弃，因此不同 authority 不会
合并。这样仍然不包含 scheme、path 或 query。缓存值只能包含选择所需的 host 级
聚合，例如：

```ts
type HostProbeCacheEntry = {
  host: string
  measuredAt: number
  successes?: number
  failures?: number
  samples?: number
  ttfbMs?: number
  throughputKbps?: number
}
```

缓存 envelope 还绑定统一 cache version、保存时间、当前候选 host 集合的
非加密 FNV-1a 变更检测摘要，以及浏览器公开的粗粒度网络提示（`type`、
`effectiveType`、`saveData`）。该摘要不是安全 hash，也不用于隐藏 host；原始 host
集合不会作为 key 另行持久化。网络提示变化时必须使同一 runtime 的内存分数和
持久化命中一起失效；该提示不得加入 IP、SSID、locale、timezone 或其他可识别
网络/用户的字段。

边界如下：

- 不持久化完整 URL、path、query、签名、CID、BVID、episode ID、账号标识、
  cookie、IP、locale 或 timezone。
- IP-literal、localhost、私网/链路本地风格与其他未准入 candidate 不主动探测，
  不读写 host health；旧 cache envelope 中相应 entry 也按 miss 忽略。
- 准入按 candidate URL 判断、health 按 host 聚合：同一 `URL.host` 同时有准入和
  未准入 URL 时，只选择准入 URL 探测并保留该 host 的 health；未准入 duplicate
  不把整个 host 标成 `unprobeable`。只有该 host 不再有任何准入候选时才忽略其
  health。
- 不以视频或用户为缓存 key，也不把缓存同步到远程服务。
- signed URL 只在当前页面的短生命周期内存中存在；媒体上下文变化时清除。
- 诊断、日志与导出只允许 host、时间、测量摘要和分类原因。
- `credentials: "omit"` 与 `cache: "no-store"` 是探测请求的强制设置；播放器原始
  请求的 credentials/cache 语义不得被探测设置污染。
- 缓存有有限 TTL、统一 version 和最大 host 数；生产调度只更新每轮前两个不同
  host，因此自生成 cache 至多包含两个 health entry。损坏或未知版本数据按
  cache miss 处理。
- `unprobeable` 只在当前 candidate/network generation 内存中抑制 `60 s` 的重复
  非强制探测；`force` 绕过该抑制，且它不会持久化为跨长周期负面信誉。
- host 分数只在同一风险层内排序，不能覆盖当前完整 URL 的 port/query/host 风险
  分类，也不能把 MCDN/PCDN 提升到普通候选之前。

Host-only 缓存不改变候选身份：应用缓存分数时，仍返回当前候选组里的原始完整
URL，而不是从缓存重建 URL。

## 统一处理流水线

### 支持的 envelope

对 source、proxy、mobile 与 hydration 结果，adapter 按以下固定顺序查找第一个
直接拥有 `dash` 或 `durl` 的对象：

1. `result.video_info`;
2. `data.video_info`;
3. root `video_info`;
4. `result`;
5. `data`;
6. root payload。

找不到时原样返回。DASH adapter 读写每个 representation 的
`baseUrl` / `base_url` 与 `backupUrl` / `backup_url`；legacy adapter 读写每个
`durl` segment 的 `url` 与存在时的 `backupUrl` / `backup_url`。字段风格、未知
字段、重复项和 envelope 层级必须保持不变。

### 纯核心

所有入口调用同一套纯函数：

```text
playurl payload
  -> locate supported media containers
  -> manual: apply the atomic legacy UPOS adapter and return
  -> otherwise: extract per-representation/per-segment candidate groups
  -> classify complete signed candidates
  -> apply original/safe/auto policy
  -> write ordered candidates back without changing response shape
```

核心模块不读 DOM、`localStorage`、全局配置或网络。浏览器 runtime 负责提供已经
规范化的模式、手动 host 和 host-only 分数快照。

迁移前 Fetch/Vue 路径各自包含相似的 proxy playurl 归一化和
`preferNonAkamaiDashUrls` 调用，而 XHR 只执行可选的 `Converters.replaceUpos`。
首轮集成已让三条路径在既有 proxy normalization 之后调用共享选择核心：`safe`
接管风险候选的稳定后移，`manual` 接管 legacy replacement。后续入口不得在共享
核心前后继续叠加旧重排或全对象 host 替换。

### Source 与 proxy 数据

`source path`（源路径，即 Bilibili 原始 playurl 响应）和 `proxy path`（代理路径，
即 BALH 区域代理成功返回并完成既有格式归一化后的响应）使用相同选择核心：

- source 响应可播放时，在交给播放器前执行选择。
- source 受区域限制而 proxy 成功时，只对最终 proxy playurl 执行选择。
- proxy 候选、地区和重试仍由现有 BALH 逻辑拥有；CDN 选择不得改变代理服务器
  的选取或错误判定。
- 若 source 与 proxy 都经过某个共享对象，重复选择必须是幂等的，不能来回翻转
  顺序或再次替换手动 host。
- 显式 `balh_config.is_closed` 表示整个脚本关闭，不安装 CDN adapter；仅缺少
  `server_custom` 时，区域代理路径保持禁用，但 CDN-only Fetch/XHR 与已有
  hydration playinfo 仍可调用共享选择核心，且不得触发任何区域代理请求。

现有泰区 mobile proxy normalization 是共享 selector 之前的区域兼容 adapter：它
可以把泰区 API 的 IP/Akamai transport 形式规范化到既有 `hw` UPOS，但这不属于
`safe`/`auto` 构造候选。若 Akamai primary 因该兼容步骤被改写，adapter 必须把原始
完整 Akamai URL 保留为同一 stream 的 backup provenance（候选来源证据），使最终
`manual` 的 payload-level `upos_replace_akamai` gate 仍能观察原始来源；手选 UPOS
只能由共享 selector 在最终交付边界应用。

### Vue 路径

在 `area_limit_for_vue.ts` 中，选择应发生在 proxy playurl 完成现有
snake_case/形状归一化之后、写入 Vue player config、
`__PLAYURL_HYDRATE_DATA__` 或 `reqHttpPlayUrlInfo` 之前。session cache 只保存尚未
应用 CDN 策略的规范化 playurl；每次交付先克隆 raw cache，再按当前模式选择，
保证模式或手动 host 变化后不会复用旧的改写结果。过期 request/episode 必须在
策略、runtime 候选更新、cache 写入或共享对象变更前拒绝。既有 proxy fallback
顺序保持不变。

`main.ts` 当前先安装 Vue/hydration 路径，再由 XHR 初始化过程安装 Fetch/XHR
拦截。共享核心必须对该启动顺序无感，不能依赖某个 hook 一定先看到 payload。

### Fetch 路径

在 `area_limit_fetch.ts` 中，source 或 proxy payload 被确定后、重建
`Response` 前执行选择。必须保留原有 status、statusText、URL 路由、JSON envelope
与仍适用于新 body 的 headers；`Content-Encoding`、`Content-Length`、validator
和 range 等描述旧 representation 的 headers 必须移除。探测失败不得使 `fetch`
promise reject。

### XHR 路径

在 `area_limit_xhr_.ts` 中，source/proxy playurl 归一化完成后、结果暴露给页面前
执行选择。必须保留 XHR 的 readyState、status、`readystatechange` 顺序以及当前
错误回退语义。
不要为了 CDN 选择新增第二套 XHR hook。注入层必须向页面返回真实 native XHR
实例，保留外部 subclass 的 private field、WeakMap identity 与 WebIDL brand；每次
`open()` 或 `abort()` 都必须使旧异步 generation 失效，非法/重复 `send()` 不得先
启动代理副作用。同步与异步完成都保持 callback receiver、真实 native 完成后的
可观察响应元数据，以及 property/listener 两种 `readystatechange` 交付；跨 realm
thenable 不能被当作普通响应对象。当前注入契约不延迟或重放 `load`、`error`、
`loadend`、`progress` 等其他 native 生命周期事件，因此依赖这些事件读取 BALH replacement
body 的外部 wrapper 不在单方兼容保证内，组合测试必须如实报告。

### 幂等性

- 对同一 payload、模式、配置和分数快照，重复运行应得到 byte-equivalent 的 URL
  字段顺序和值。
- 稳定排序必须使用 `originalIndex` 作为最终 tie-breaker。
- `manual` 对已经指向目标 host 的 payload 重复执行必须得到相同结果。
- 选择逻辑不得添加可枚举的私有字段到 playurl payload。
- 任一入口无法证明对象是受支持的 playurl 形状时，返回原对象。

## 无硬编码 UK CDN

自动模式的 candidate universe（候选全集）只来自当前 playurl 候选组。代码和
测试不得把某个 host 标记为“英国默认”“英国首选”或永远最快，也不得因浏览器
timezone/locale 推断地区。

允许硬编码的内容只包括：

- 用于软分类的风险信号；
- 有界探测参数；
- 测试中的合成 host；
- `manual` 模式的用户显式配置兼容规则。

即使某个 host 在英国验收时获胜，也只能以带 TTL 的本地 host 分数存在。

## 与 Bilibili CDN Switcher 的兼容测试

兼容目标仅为测试时的最新 Bilibili CDN Switcher，不维护旧版本矩阵。测试必须：

1. 以 README 的兼容记录作为 canonical upstream identity。该记录必须包含唯一的
   project/source URL、latest/version metadata URL、userscript `@name` / `@namespace`
   身份，以及最近验证的 exact version、commit/digest 和日期。若该记录尚未建立，
   兼容 gate 是 blocked，测试不得猜测同名项目。
2. 在测试执行时从该 canonical upstream 获取源码，不把第三方脚本复制进仓库或
   固定为本地 fixture。
3. 独立解析版本/发布标识并验证它确实是当时的 latest；实际源码身份必须与 README
   记录的 `@name` / `@namespace` 一致。
4. 把本次实际验证的 exact version、commit/digest 与日期写回 README 的兼容记录；
   本文不复制那些易变值。
5. 在隔离 harness 中覆盖两种加载顺序：
   - BALH first, CDN Switcher second;
   - CDN Switcher first, BALH second.
6. 组合 harness 至少验证 Fetch 与 XHR wrapper 不递归、不丢失原始调用语义、
   playurl shape 与媒体 URL path/query 不损坏。共享选择核心的同一 payload 幂等、
   BALH 内部异常 fail-open 由仓库内确定性测试覆盖；外部 wrapper 自己的失败仍
   明确报告为不兼容。
7. harness 使用真实浏览器 context，并在 `document-start` 等价阶段注入两份完整
   userscript；GM API、页面响应与网络出口由测试控制，不能复用用户 profile、
   cookie 或登录状态。
8. Vue/source/proxy envelope 与 fail-open 由 BALH 自身的确定性测试覆盖；当前 CDN
   Switcher 只包装 Fetch/XHR，因此第三方组合矩阵聚焦这两个共享 hook。真实站点与
   userscript manager smoke 可作为人工补充，但不作为可重现的自动门禁。

上游获取失败、版本无法证明为最新或 README 记录与实际版本不一致时，兼容测试
应明确失败或跳过为“外部依赖不可验证”，不能静默使用陈旧本地副本。

这项检查在创建稳定版 tag 前显式运行，不放入 tag 触发的 release workflow。
原因是 latest 上游可变，而 tag 已冻结：若第三方在 tag 创建后更新，旧 tag 的
workflow 不能通过修改仓库分支来恢复。release workflow 只消费已经验证并冻结在
tag 内的 BALH 源码与兼容记录。

## 失败与回退契约

| Failure | Required fallback |
| --- | --- |
| 不支持的 payload shape | 原样返回 payload |
| URL 解析失败 | 保留该原始字符串及其位置 |
| 分类器异常 | 将候选视为 `unknown`，不删除 |
| 缓存缺失、损坏或过期 | cache miss；使用当前模式的无缓存排序 |
| CORS 阻止探测 | `unprobeable`；候选保留 |
| IP literal、localhost、私网/链路本地风格或未知 host | 不发主动请求、不使用 health cache；候选保留为原始播放/排序回退 |
| 准入 host 返回 redirect | Fetch 以 `redirect: "error"` 拒绝跟随；按不可测失败路径保留候选 |
| 探测超时或明确的 HTTP/network failure | 记录有限失败样本；候选保留且失败/无分数项维持稳定顺序 |
| 所有普通候选不可用 | MCDN/PCDN 仍保留在末尾供下游播放器 fallback |
| 所有探测结果不可用 | `safe`，最终可回到 `original` |
| `manual` host 无效 | 原样返回整个 playurl payload |
| Fetch/XHR/Vue integration 抛错 | 记录 host-only 摘要并返回未修改结果 |
| BALH 自己的 wrapper 内部异常 | 调用 BALH 安装时捕获的 predecessor |
| 外部 wrapper 在 BALH 调用前/后自行抛错或覆盖 descriptor | 超出 BALH 单方 fail-open 保证；兼容测试必须报告失败 |

选择器不得返回空的 `baseUrl`/`backupUrl`、空 segment、部分签名或只含探测成功
项的列表。若无法安全完成整个候选组的转换，应保留该组原值。

## 延期：stall recovery

播放停顿后的实时恢复不属于首轮实现。后续扩展必须另行满足：

- 只在可见页面、经过 grace period 且缓冲确实不足时判断 stall，避免把后台 tab
  throttle 当成 CDN 故障。
- 不终止已经在进行的播放器请求；只影响后续请求。
- 在同一候选组的完整签名 URL 内轮换，除 `manual` 外不做 host synthesis。
- 区分播放器 timeout、HTTP/network failure、CORS 不可测与扩展主动取消。
- 合并重复信号，并使用有上限的指数退避，避免 host ping-pong。
- 所有普通候选用尽后仍保留并尝试 MCDN/PCDN 最后兜底。
- 新的视频/episode/质量切换会清除旧恢复状态。

在这些状态机、观察信号与真实浏览器测试齐备前，`auto` 只做后台探测并影响下一
次 playurl 排序，不宣称具备当前播放换路或 stall recovery。

## 测试边界

### Pure unit tests

- 固定顺序的六种 playurl envelope 与 camelCase/snake_case 字段。
- DASH video/audio、Dolby、FLAC 与每个 `durl` segment 的分组隔离。
- `durl[].url`/backup 提取、protocol-relative URL 原样写回、payload 重复 URL
  保留、probe 调度去重与禁止跨组混用。
- MCDN/PCDN 软分类、最后兜底和 unknown host 行为。
- 四种模式、稳定 tie-break、重复执行幂等。
- `manual` 的有效/无效 host、已有目标 host、protocol-relative URL、Akamai
  all-or-nothing gate 与整份 payload 原子回退。
- 新模式键优先、legacy UPOS 迁移、默认 `safe` 与 UI 保留/启用规则。
- host-only cache schema、显式 port 隔离、TTL、统一 cache version、health 聚合与
  隐私字段拒绝。
- 主动探测 hostname 准入：普通 `bilivideo`、精确 Bilibili Akamai、显式 port、
  IPv4/IPv6 literal、localhost、私网/链路本地与 URL/域名混淆形式。

### Browser/runtime tests

- 有界前缀读取达到上限后 cancel；timeout 或媒体/网络 generation 失效后无遗留任务。
- 验证 scored-prefix bytes 上限，并明确默认 reader 可能多交付一个 chunk；不对
  JavaScript 实收或底层 transport bytes 作错误断言。
- 请求包含 `credentials: "omit"`、`cache: "no-store"`、`redirect: "error"`，默认
  没有 `Range`。
- 浏览器无法证明响应可读的 Fetch/policy error 产生 `unprobeable` 而不是永久失败。
- 探测不阻塞 playurl 返回，并且不会消费播放器自己的 response body。
- Vue、Fetch、XHR 各自覆盖 source success、proxy success、解析失败和 fail-open。
- 页面上下文变化取消过期探测，host-only 缓存不含 path/query/ID/signature。

### Compatibility and acceptance

- README canonical identity 指向的 latest CDN Switcher，在受控的真实浏览器
  userscript harness 中覆盖两种加载顺序。
- 延期的英国本地人工浏览器验收只验证本机测量生效，不断言固定 host 获胜；它不
  是首轮可重现自动化门禁。
- 至少覆盖一个普通候选优先、风险候选仍留作播放器 fallback，以及全部候选
  不可测时仍保持可播放 URL 的案例。
- 精确验证过的 CDN Switcher 版本记录在 README，而不是本文。

## 复用清单

在另一个播放路径或项目复用本架构时，逐项确认：

- [ ] 找到了授权 playurl 的唯一边界，没有从静态 host 列表造 URL。
- [ ] 按 representation/segment 建组，没有跨媒体对象混用签名。
- [ ] 枚举了实际 envelope、`durl[].url` 和 protocol-relative URL 的原样写回。
- [ ] 分类只降级不删除，MCDN/PCDN 仍是最后兜底。
- [ ] `original`、`safe`、`auto`、`manual` 语义与回退一致。
- [ ] 默认模式与 legacy 配置迁移有确定优先级。
- [ ] 探测本机执行、后台、有界、无 credentials、no-store、默认无 Range。
- [ ] 无法证明可测的浏览器错误与已确认 HTTP/timeout failure 分开处理。
- [ ] 持久化数据以 host 为边界，不含完整 URL、签名或用户/视频标识。
- [ ] source/proxy 只在最终 payload 上选择一次，入口重复处理仍幂等。
- [ ] selector 前若有地区/mobile URL normalization，原始候选 provenance 仍保留，
  不会绕过最终 `manual` 原子 gate。
- [ ] Fetch/XHR/Vue 的原始响应和错误语义得到保留。
- [ ] legacy `upos_server` / `upos_replace_akamai` 只映射到 `manual`，没有与新核心
  发生二次 replacement。
- [ ] 没有硬编码地区 CDN 或隐式地理偏好。
- [ ] fail-open 只承诺回到 BALH 捕获的 predecessor，不替外部 wrapper 作保证。
- [ ] README 定义第三方 canonical identity；兼容测试取 latest 上游源码并记录实际
  验证版本。

## 扩展点

- `risk classifier`：可以增加新信号，但新信号默认仍是软降级并需要 fixture。
- `score policy`：可以调整吞吐/延迟权重，但必须 bump 统一 cache version 并保持稳定
  tie-break。
- `probe transport`：Range 只能作为通过独立 CORS 能力验证的 opt-in 路径；默认
  前缀读取契约不变。
- `cache backend`：可以从内存升级到持久化存储，但 host-only 与隐私字段限制不变。
- `delivery adapter`：可增加新的 player/global hook，但只能调用共享核心，不能复制
  选择逻辑。
- `stall recovery`：按上文延期契约单独设计和验收。

## 独立重实现参考

本设计借鉴了以下 MIT 项目的公开概念，并按 BALH 的数据流、隐私约束和兼容需求
独立重实现。本文不表示、也不要求复制这些项目的源代码。

| Reference | 固定版本 | 参考概念 | 本设计的明确差异 |
| --- | --- | --- | --- |
| [siwei-yuan/bili-pilot](https://github.com/siwei-yuan/bili-pilot/tree/2baca4178fcfb449d40a30662bcd711c9e4d8121) | commit `2baca4178fcfb449d40a30662bcd711c9e4d8121`, MIT | 完整签名候选、按 representation/segment 规划、MCDN/PCDN 风险元数据、普通候选失败后保留降级候选、fail-open | 不采用其预取/Range cache；本阶段不做 stall recovery，默认探测也不发送 Range |
| [realzza/bilibili-accelerator](https://github.com/realzza/bilibili-accelerator/tree/6cba8c8b23ad01a152d186420081284b6eda1f77) | v0.4.0, commit `6cba8c8b23ad01a152d186420081284b6eda1f77`, MIT | 浏览器本地吞吐探测、`credentials: "omit"`、`cache: "no-store"`、无 Range 的前缀读取与 cancel、Fetch/XHR 组合入口、仅记录 host 的诊断思路 | 不采用静态 candidate pool、地区默认 host 或自动 host synthesis；缓存也不按 timezone/locale 分区 |
| [SukkaW/Make-Bilibili-Great-Than-Ever-Before](https://github.com/SukkaW/Make-Bilibili-Great-Than-Ever-Before/tree/800ca13061df9b87fb6f38c0b2b2346ebd6812f9) (MBGTEB) | commit `800ca13061df9b87fb6f38c0b2b2346ebd6812f9`, MIT | 从 `baseUrl`/`backupUrl` 为每个 representation 收集关联 URL、识别 MCDN/PCDN 风险、在多入口请求链中匹配媒体对象 | 自动模式不采用随机选择、固定 fallback host、proxy wrapping 或跨响应收集 host；完整签名 URL 始终来自当前候选组 |
| [MareDevi/bilibili-tui](https://github.com/MareDevi/bilibili-tui/tree/98737ce7d50a317455f4b959bab0d320577298c1) | commit `98737ce7d50a317455f4b959bab0d320577298c1`, MIT | 分别为 video/audio stream 排列候选、按 host 复用短期探测分数、区分延迟/吞吐/可靠性并设置 TTL | 浏览器实现不使用远程 catalog、地区 host 合成、文件系统历史或默认 Range probe；只缓存最小 host 级摘要 |

引用固定提交是为了让概念审计可重复；运行时不会下载或依赖这些项目。第三方许可
仍由各自仓库的 `LICENSE` 文件定义。
