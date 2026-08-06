## [帮助/问题解答 等](./README.md)

## 高级设置

该脚本包含一些可设置项, 使用[解除B站區域限制輔助腳本](https://greasyfork.org/zh-TW/scripts/28907)或[BiliBili proxy setting helper](https://greasyfork.org/zh-TW/scripts/29378)可以帮助你进行一些选项的设置。

从5.6.0版开始，脚本（终于）内置了设置界面，点击[番剧页面](https://bangumi.bilibili.com/anime/5551)的右下角的图标打开。

或者直接手动设置：打开[这个番剧页面](https://bangumi.bilibili.com/anime/5551)，进入[控制台/Console](#控制台)中，执行命令：`bangumi_area_limit_hack.setCookie(key, value);`，其中`key`和`value`分别使用下面的值：

### 代理模式

`key`为`'balh_mode'`，可选的`value`为：

1. `'default'`或`undefined`：默认模式, 自动判断使用何种模式; **推荐**;
2. `'replace'`：替换模式, 只替换有区域限制的视频的接口的返回值; 
    - 进行了两次请求, 若代理服务器不稳定, 普通番剧不受影响; (代理服务器不稳定时, 推荐该模式)
3. `'redirect'`：重定向模式, 重定向所有番剧视频的接口到代理服务器; 
    - 进行一次请求, 若代理服务器不稳定, 普通番剧也可能加载不出视频; (代理服务器足够快时, 推荐该模式)

### 自定义代理服务器

key为`'balh_server'`，可选的`value`为：

1. `undefined`：默认代理服务器
2. `'https://www.your_server.com'`：自定义的代理服务器

### CDN 选择模式

`key`为`'balh_cdn_mode'`，可选的`value`为：

1. `'safe'`：仅保守后移被识别为 MCDN/PCDN 风险层的候选；
2. `'auto'`：额外使用当前浏览器的有界两阶段后台测速与 host-only `v2` cache；
3. `'original'`：保留平台原始候选顺序；
4. `'manual'`：启用旧的 UPOS 主机替换。

`balh_cdn_mode` 未设置或值无效时会解析为 `'safe'`；仅当检测到旧版 `balh_upos_server` 配置时迁移为 `'manual'`。迁移结果会写回 `balh_cdn_mode` cookie。

`auto` 的主动探测以候选实际 URL 为准，只准入 `bilivideo.com`、`bilivideo.cn`、
`bilivideo.net` 的 label-bound 域及精确 Bilibili Akamai 主机；不信任旁路 host
metadata，也不跟随重定向。未准入候选仍保留给播放器回退，但不读写 host health。
请求固定 `credentials: "omit"` 且默认不发送 `Range`；CORS 不可读结果是
`unprobeable`，不是 CDN 失败。

Stage 1 probe 在动态 `2 MiB` accounted-prefix 预算允许完整 `64 KiB` 样本时覆盖
每个可准入的不同 host，并发不超过 `2`；成功结果中稳定排名前两名共享 Stage 2
剩余预算，每个 follow-up 最多 `512 KiB`。吞吐量与可靠 DASH bitrate margin 是主要
证据，TTFB 是次要证据。请求/阶段默认边界约为 `2–4 s`，取消后的清理最多再给
`250 ms`。reader 返回的完整 chunk 可以让当前 batch 的 raw JavaScript/transport
实收量超出动态预算；只有 clip 到剩余预算的前缀进入计分，raw observed bytes 会
停止后续请求，accounted-prefix 总量仍硬限制在 `2 MiB`。

持久化 cache schema 是 `v2`、TTL 是 `20 min`，候选 host 集合或粗粒度网络提示变化
即失效。不完整、`budget-limited`、`unprobeable` 或无法证明清理安全的轮次不持久化。
cache、日志与诊断都不保存完整 signed URL、path、query 或签名。

Vue、Fetch、XHR 与 `/x/player/wbi/playurl` response 复用同一 CDN adapter；WBI 只
处理响应，禁止 proxy、重发或重新签署 `w_rid` / `wts`。只有 `'manual'` 允许显式
legacy UPOS host rewrite。

主动测试当前视频 CDN：

```javascript
await bangumi_area_limit_hack.testCurrentVideoCdn({ force: true })
```

清除 CDN 健康缓存：

```javascript
bangumi_area_limit_hack.clearCdnHealthCache()
```

Stage 1（响应适配）和 Stage 2（上述探测）已完成。Stage 3 将由独立后续 PR 实现：
只有页面可见、播放器未暂停/未 seeking 且 low-buffer grace 再确认后才判定 stall；
候选组只在内存保存，只重路由未来 Fetch/XHR 媒体请求，不 abort/reload 当前请求，
并使用 cooldown/backoff 避免 ping-pong。MCDN/PCDN 保持最后兜底；静态 candidate
pool 只允许作为非默认实验性排序提示，并且只能引用当前 exact signed candidate
group 中已经存在的 URL。

全部三个阶段合并且 Joey 完成 UK-local 人工播放验收前，稳定 tag/release 与 `main`
刷新均被阻塞。仓库 live E2E gate 只能提供自动辅助证据，不能替代人工验收；精确
命令由根 README 维护。

### 登录/登出

在控制台执行:

1. `bangumi_area_limit_hack.login()`，弹出登录窗口
2. `bangumi_area_limit_hack.logout()`，弹出登出窗口

## 更新日志

1. 6.1.0: 通过绕过的方式兼容GM4
1. 6.0.0: 适配B站的新页面
1. 5.7.0: 尝试支持[港澳台限定的av页面](http://search.bilibili.com/all?keyword=%E4%BB%85%E9%99%90%E5%8F%B0%E6%B9%BE%E5%9C%B0%E5%8C%BA)
1. 5.6.0: 添加设置界面
1. 5.5.0: 尝试支持`/movie/`页面
1. 5.4.0: 支持新的返回403的番剧页
1. 5.2.0：默认代理服务器支持HTTPS
1. 5.1.0：由[@FlandreDaisuki](https://github.com/FlandreDaisuki)增加从AVxxx自动跳转到番剧页的功能
1. 5.0.5：[what are those idiot programmers of bilibili doing??? by esterTion · Pull Request #4 · ipcjs/bilibili-helper](https://github.com/ipcjs/bilibili-helper/pull/4)
1. 5.0.3：紧急更新，修正一个逸单位的换算错误！
1. 5.0.2：检测到区域限制番剧时显示通知提示；
1. **5.0.0**：可切换三种代理模式，任何一种模式都不会卡界面了，详见[代理模式](#代理模式)；
2. 3.0.0：实现方式改为直接重定向请求；在第一次使用时会弹登录提示框；

## 名词解析

### 控制台

控制台可以用于运行命令，查看log等。

打开方式：Windows上，先按`F12`打开`开发者工具`，再切换到`控制台/Console`选项卡

反馈问题时，最好附上控制台截图。特别的，Edge浏览器，不会保留控制台log，需要先打开控制台，再刷新网页，才能记录下log。

## 测试页

1. appOnly测试：
    - [安达与岛村 _ 番剧 _ bilibili _ 哔哩哔哩弹幕视频网](https://www.bilibili.com/bangumi/media/md28230188/)
2. 解除区域限制测试：
    - 台：[吹響吧！上低音號 第二季（僅限台灣地區）_番剧](https://bangumi.bilibili.com/anime/5551)[[第1话](https://bangumi.bilibili.com/anime/5551/play#96703)]
    - 港：[食戟之靈 神之皿（僅限港澳台地區）](https://www.bilibili.com/bangumi/media/md28222747)
    - 内地：[小魔女学园 TV版_番剧](https://bangumi.bilibili.com/anime/5788)[[第1话](https://bangumi.bilibili.com/anime/5788/play#101761)]
    - 内地(新): [品酒要在成为夫妻后](https://bangumi.bilibili.com/anime/6423)
    - 付费抢先看：[全职高手_国产动画](https://bangumi.bilibili.com/anime/5852)[[第3话](https://bangumi.bilibili.com/anime/5852/play#103960)][[第5话](https://bangumi.bilibili.com/anime/6012/play#103819)]
    - 一个AV下多个视频：[普通女高中生要做当地偶像_番剧](https://bangumi.bilibili.com/anime/4124)[[第13话](https://bangumi.bilibili.com/anime/4124/play#100947)]
    - 影视：
        - 付费：[声之形](https://bangumi.bilibili.com/movie/12116)
        - 免费：[哆啦A梦：新·大雄的日本诞生（国语）](https://bangumi.bilibili.com/movie/11871)
    - av页面：
        - 港澳台：[【日剧/医疗】产科医鸿鸟2 02【2017】](https://www.bilibili.com/video/av15659129/)
        - 国内：[【5月】游戏王VRAINS 24【VRAINSTORM】](https://www.bilibili.com/video/av15730139/)
3. 自动跳转到番剧页测试
    - 舊番、av_id共用、不分P：[/av4044639/](https://www.bilibili.com/video/av4044639/) → [/3398/play#84776](https://bangumi.bilibili.com/anime/3398/play#84776)
    - 舊番、av_id共用、分P：[/av2182637/index_3.html](https://www.bilibili.com/video/av2182637/index_3.html) → [/4300/play#88679](https://bangumi.bilibili.com/anime/4300/play#88679)
    - 舊番、av_id獨立：[/av2229121/](https://www.bilibili.com/video/av2229121/) → [/1559/play#29944](https://bangumi.bilibili.com/anime/1559/play#29944)
    - 連載中：[/av9910182/](https://www.bilibili.com/video/av9910182/) → [/6001/play#103883](https://bangumi.bilibili.com/anime/6001/play#103883)
    - 连载中、av_id独立：[/av10181128/](https://www.bilibili.com/video/av10181128/) → [/6078/play#105028](https://bangumi.bilibili.com/anime/6078/play#105028)
