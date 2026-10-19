# 解除B站区域限制

反馈问题前，先看这篇文档！！！大多数常见的问题，这里都有说明  
反馈问题前，先看这篇文档！！！大多数常见的问题，这里都有说明  
反馈问题前，先看这篇文档！！！大多数常见的问题，这里都有说明  

不要在Greasyfork中提交反馈，去GitHub，Greasyfork问题追踪系统太弱了，不好用。反馈前可以先在脚本设置页面点击“下载诊断文件&问题反馈”，然后把复制出来的摘要粘贴到 GitHub issue 描述里，并上传下载到本地的诊断文件。若播放页没有原来的设置入口，可使用页面右下角的贴边脚本设置入口；它默认折叠，全屏和网页全屏播放时会自动隐藏。

[点击进入设置页面](https://bangumi.bilibili.com/anime/5551)

![设置截图](https://user-images.githubusercontent.com/4396864/149929866-780bd8a2-413b-4539-a071-cdb66c5bc80e.png)

## 自定义代理服务器

由于用的人太多，前段时间BiliPlus直接被B站屏蔽了。故今后只能自己搭建代理服务器。  
这里简述几种可用的代理服务器，搭建完成后将网址添到脚本的“自定义代理服务”里面就行了。

**注意，代理服务器拥有你B站帐号的大部分访问权限，请不要使用不可信之人提供的代理服务器**

### 1. 反向代理

用Nginx反代`api.bilibili.com`，需要有VPS，比较贵，配置文件见[这里](https://github.com/ipcjs/bilibili-helper/pull/711#issue-542876230)

### 2. PHP空间

PHP空间相比VPS会便宜很多，目前有些小公司会提供PHP空间，php脚本用@zzc1086写的[这个](https://github.com/zzc10086/grocery_store/blob/master/bili_proxy/BPplayurl.php)就行

### 3. 阿里云函数计算

[阿里云函数计算](https://www.aliyun.com/product/fc)按次计费，还有免费额度，可以算是最便宜的了，配置也十分简单。@zzc1086也写了[函数计算版的php脚本](https://github.com/zzc10086/grocery_store/blob/master/bili_proxy/aliyun_Serverless_BPplayurl.php)，直接用就行

详细搭建方式，参考@realLyans写的[简易教程](https://github.com/ipcjs/bilibili-helper/issues/710#issuecomment-748976481)

### 4. 腾讯云CDN

CDN本质也是反向代理（  
详见@MoeACG-Xyrh写的教程：[使用腾讯云CDN解除哔哩哔哩番剧区域限制](https://www.lovewx.club/%e4%bd%bf%e7%94%a8%e8%85%be%e8%ae%af%e4%ba%91cdn%e8%a7%a3%e9%99%a4%e5%93%94%e5%93%a9%e5%93%94%e5%93%a9%e7%95%aa%e5%89%a7%e5%8c%ba%e5%9f%9f%e9%99%90%e5%88%b6/)

### 5. 网友搭建的服务器（**不保证**这些代理服务器是安全的，可信度需要你自己判断）

1. [公共解析服务器](https://github.com/yujincheng08/BiliRoaming/wiki/%E5%85%AC%E5%85%B1%E8%A7%A3%E6%9E%90%E6%9C%8D%E5%8A%A1%E5%99%A8)，哔哩漫游的服务器，脚本也能用，只要记得在地址前加上`https://`就行

| 提供者                                        | 类型       | 区域 | 网址                                                                                    |
| --------------------------------------------- | ---------- | ---- | --------------------------------------------------------------------------------------- |
| [@zzc10086](https://github.com/zzc10086)      | PHP空间    | 香港 | `https://bili-proxy.98e.org`                                                            |
| [@znAaron](https://github.com/znAaron)        | 阿里云函数 | 大陆 | `https://1985592077837091.cn-shanghai.fc.aliyuncs.com/2016-08-15/proxy/bili/bili_prox/` |
| [@AisukaYuki](https://github.com/AisukaYuki/) | 反向代理   | 台湾 | `https://bili.tuturu.top`                                                               |
| [@silicer](https://github.com/silicer)        | 腾讯云函数 | 香港 | `https://service-fi0gz11m-1252917345.hk.apigw.tencentcs.com`                            |

## 开发

项目使用 esbuild 打包脚本。克隆代码后执行`pnpm install`安装依赖，修改代码时执行`pnpm run dev`生成打包好的`dist/unblock-area-limit.user.js`。

当前维护版本是新的 GreasyFork 分发脚本，不作为旧 `ipcjs` 脚本的自动升级路径发布。旧脚本用户需要按新脚本重新安装。

## 问&答

### 番剧能播放，但评论区不显示？

部分地区受限的番剧播放页会把已有的原生评论组件隐藏。脚本启用后会恢复该组件的显示，评论仍直接从 B 站加载，不经过播放解析代理，也不依赖播放代理是否已配置。

在电脑版 `www.bilibili.com` 的脚本设置中点击“关闭评论区”即可立即隐藏，再点击“显示评论区”恢复。选择保存在当前浏览器配置的该网站本地存储中，重新打开页面后仍生效，同一配置的其他标签页也会同步；不会同步到其他浏览器或设备。清除网站数据后恢复默认显示。手机站不显示这个按钮。

评论区继续遵循 B 站的登录和访问要求：未登录时可能只能看到热评预览，完整评论和楼中楼仍可能要求登录。此功能不会恢复已关闭的评论区或已删除的评论，也不处理番剧详情页的短评、长评。

### 如何安装脚本？

使用脚本前必须安装扩展，各浏览器对应的扩展如下：

1. Firefox浏览器：[Tampermonkey](https://addons.mozilla.org/en-US/firefox/addon/tampermonkey/) 、Greasemonkey 4
2. Chrome浏览器：[Tampermonkey](https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
    * 访问不了[Chrome 网上应用店](https://chrome.google.com/webstore/category/extensions)的同鞋可以到下面的地址下载crx文件。下载下来的crx文件可能不能直接安装，需要手动拖到扩展管理界面（一般为`chrome://extensions/`）中，应该就能安装成功了：
        * [Tampermonkey各版本百度网盘](https://pan.baidu.com/s/1nuCc4Al)
        * [常用Crx离线安装包下载](https://yurl.sinaapp.com/crx2.php)
    * 国内的360极速浏览器、猎豹浏览器等其实上就是Chrome加个壳，装Tampermonkey就行了
    * 搜狗高速浏览器：[Tampermonkey Legacy](https://ie.sogou.com/app/app_4326.html)
    * Yandex Browser 手机版：详见：[希望可以支持一下手机版的网页](https://github.com/ipcjs/bilibili-helper/issues/112)
    * <del>傲游浏览器：[Violentmonkey](https://extension.maxthon.com/detail/index.php?view_id=1680)</del>（实测即使是最新版，也不兼容该脚本）
    * Edge：基于Chromium的新版Edge，理论上来说是支持的，老版不支持
3. Safari：不支持

### 脚本无效？

1. 如果在[番剧页面](https://bangumi.bilibili.com/anime/5551)中连设置按钮都看不到，说明你的浏览器版本太老了，请更新成最新版；如果还是不行，请换用最新版的[Firefox](https://www.mozilla.org/en-US/firefox/new/)或者[Chrome](https://www.google.com/chrome/browser/desktop/index.html)。
2. 确定你使用的播放器是**HTML5**版的。Flash版请在播放器界面的右上角切换成HTML5版。
3. 确定可以打开[代理服务器上的链接](https://biliplus.ipcjs.top/api/bangumi?season=5551)。 如果打不开，可以点开设置窗口，换个代理服务器试试
4. 对于一些已知错误，脚本会弹窗提示，请认真阅读提示信息，按提示进行操作。
5. 如果依然无效，可能确实是这个脚本的问题了，请到GitHub反馈给我。

### 授权无效？

Chrome 80+上有可能出现的问题，详见：https://github.com/ipcjs/bilibili-helper/issues/588#issuecomment-603830842

### 播放卡顿？

#### 视频 CDN 选择

设置页的“视频 CDN”有四种模式：

1. `safe`（默认）：保留 B 站返回的完整签名 URL，只稳定后移被识别为 MCDN/PCDN 风险层的候选；如果全部候选都有风险，则保留原始顺序。
2. `auto`：在 `safe` 基础上，以当前浏览器和当地网络为准做有预算的两阶段后台测速，结果仅用于之后取得的播放地址。这也是英国等海外地区推荐试用的模式。
3. `original`：完全保留 B 站原始候选顺序。
4. `manual`：保留旧的“替换 UPOS 视频服务器”功能，仅供显式手动选择。

自动选择不会猜测或拼接 CDN 域名，不会修改 URL 的路径、查询参数或签名，也不会把不同清晰度、音轨或分段的候选混在一起。Vue、Fetch、XHR 和 WBI playurl response 共用这条规则；`/x/player/wbi/playurl` 只处理返回的响应，BALH 不代理该请求，也不会重新计算或签署 `w_rid` / `wts`。只有显式选择 `manual` 才会运行旧版 UPOS host rewrite。

后台测速只会请求实际 URL 命中的受信任 Bilibili 媒体域名，不跟随重定向；IP、localhost、私网风格、未知域名、已知外部 PCDN 域和带 userinfo 的候选仍保留给播放器回退，但不会由 BALH 主动请求。选择器的软风险分类与网络准入是两条独立边界：命中受信任 `bilivideo.*` namespace 的 MCDN/`mirror14b`/`302` 风格 host 仍可参与本机测量，其风险标签只限制排序层级。请求固定使用 `credentials: "omit"`，默认不发送 `Range`。CORS 或浏览器策略使响应正文不可读时，候选只会标记为 `unprobeable`（无法测量），不会被判定为失效。

每轮 Stage 1 probe 会在动态 `2 MiB` 预算允许完整 `64 KiB` 样本时覆盖每个可准入的不同 host；成功结果中稳定排名前两名共享剩余 follow-up 预算，每个最多 `512 KiB`，并发最多 `2`。吞吐量与可靠 DASH bitrate margin 是主要证据，TTFB 是次要证据。请求和阶段通常限制在约 `2–4 s`，取消后的清理最多另给 `250 ms`。浏览器可能一次交付超过当前剩余量的完整 chunk，所以当前 batch 的 raw JavaScript/transport 实收量可以超出动态预算；只有 clip 到剩余预算的前缀进入计分，raw observed bytes 会阻止后续请求，整轮 accounted prefix 始终严格不超过 `2 MiB`。

host-only 持久化 cache 使用 `v2` schema 和 `20 min` TTL，并在候选 host 集合或粗粒度网络提示变化时失效。它只保存已准入 host（hostname 加显式非默认 port）级别的聚合测量，不保存完整 URL、path、query 或签名；日志和诊断也不记录 signed URL。不完整、预算受限、不可测或无法证明清理安全的轮次不会持久化。

即使没有配置自定义区域代理，只要没有显式选择“关闭脚本”，CDN 模式仍会处理平台已经返回的可播放地址；显式关闭脚本会同时禁用区域解锁与 CDN 选择。

可以在设置页点击“测试当前视频 CDN”运行上述有界两阶段 probe。在 `auto` 模式下，
Stage 3 为页面 Fetch/XHR 能看到的 exact media `GET` 监测播放停顿：只有页面可见、
未暂停或 seek、buffer 不超过 `0.5 s`，并连续 `3 s` 缺少有效播放推进时，才为之后的
请求切到同一候选组的下一个完整签名 URL。它绝不 abort、reload、reopen 或重放当前
请求；最小 `15 s` cooldown 和有上限的指数 backoff 防止来回切换。浏览器原生 media
loader 绕过 Fetch/XHR 时不在自动恢复范围内。MCDN/PCDN 始终是最后兜底；静态
candidate pool 不属于当前交付。

当兼容的第三方脚本在 BALH 之后继续变换 playurl response 时，BALH 会在页面收到响应
前透明观察最终 payload，并仅用其中的完整 exact candidates 刷新恢复 registry；不会
再次排序、替换 `Response` / XHR 对象或拼接 URL。最新版 CDN Switcher 的两种加载顺序
均由下列固定 snapshot gate 覆盖。

仓库的真实站点 live E2E gate 是自动辅助证据，不能替代 Joey 在 UK-local 环境的人工播放验收。三个阶段已经全部合并，且人工验收与 `v8.11.0` 发布授权已于 2026-10-19 完成。精确 live E2E 命令由仓库根 README 维护。

#### CDN Switcher 兼容性

| 项目 | 已验证版本 | 验证日期 | 范围 |
| --- | --- | --- | --- |
| [Bilibili Video CDN Switcher](https://greasyfork.org/scripts/500213-bilibili-video-cdn-switcher) | `0.1.5` | 2026-10-19 | 当前 latest；Fetch/XHR、两种脚本加载顺序与 future-route recovery |

上游身份固定为 Greasy Fork script `500213`，latest 下载地址是
`https://update.greasyfork.org/scripts/500213/Bilibili%20Video%20CDN%20Switcher.user.js`。
canonical latest metadata 地址是
`https://update.greasyfork.org/scripts/500213/Bilibili%20Video%20CDN%20Switcher.meta.js`；
兼容测试要求 metadata 与源码中的身份和版本完全一致。
userscript metadata 身份固定为 `@name Bilibili Video CDN Switcher` 与
`@namespace mailto:1332019995@qq.com`。
本次验证的 `0.1.5` 源文件 SHA-256 为
`39cb475d8377a892931d969ab5e16e1fb39023f2ef0fd1611df78126880c81b4`。
静态比较 `0.1.4` 与 `0.1.5` archive 源文件只发现版本和中文默认 CDN（`cos` 改为
`ali`）变化，Fetch/XHR 实现不变；archive 与 canonical 源文件的差异仅为 Greasy Fork
`downloadURL` / `updateURL` metadata。

该固定 snapshot 已在 Chrome `155.0.8059.80` 的 latest-source 组合 gate 通过。
`balh->cdn` 与 `cdn->balh` 的 Fetch/XHR 请求均使用 `compat-cdn.invalid`，结果都是
`primary -> primary -> alternate -> alternate`。测试使用 `en-US` 与自定义 CDN host；
没有覆盖新版中文默认 CDN host。Fetch/XHR 的后续恢复范围仅为本仓库已有契约中的
future request、cooldown 与稳定播放恢复。

仓库只保证上表中“当前 latest”的单一固定 snapshot，不维护 CDN Switcher 旧版本兼容矩阵。打稳定版 tag 前应显式运行下列命令：它会从 Greasy Fork 临时下载上游 latest 脚本，不在本仓库复制其源码；若 latest 版本或原始源码 bytes/SHA-256 变更，测试会要求先重新验证并更新此表。tag 触发的 release workflow 不再读取这个可变上游，避免已经冻结的 tag 因第三方后续更新而无法重跑。

```bash
pnpm run test:cdn-switcher:latest
```

#### “替换 UPOS 视频服务器”选项（手动模式）

**目前似乎存在替换upos后加载不出视频的问题！设为“不替换”可关闭该功能。**

在 CDN 模式中选择 `manual` 后，才会使用“替换 UPOS 视频服务器”选项。该功能会修改主机名，只作为旧功能兼容保留。

#### 改hosts

港澳台的视频解析出来的视频文件的域名是`upos-hz-mirrorakam.akamaized.net`，这家CDN貌似没有国内的节点，大多数情况下这个域名都会指向美国的IP，速度特别慢。他们是有香港/台湾节点的，速度会快很多。手动改hosts，将域名解析到较快的IP，能够缓解卡顿的问题。

参考链接:

1. [zz5678/akamBiliChecker: 测试Bilibili海外CDN的下载速度](https://github.com/zz5678/akamBiliChecker)
2. [miyouzi/akamTester: 批量测试B站海外CDN](https://github.com/miyouzi/akamTester)
3. [如何提高B站海外CDN连接速度](https://www.bilibili.com/read/cv3118508)
4. [播放番剧，5秒一卡，速度非常慢 · Issue #401](https://github.com/ipcjs/bilibili-helper/issues/401)

### 看不了1080P画质？

1. 确定你是B站的[大会员](https://big.bilibili.com/site/big.html)
2. 确定当前视频拥有1080P画质的版本
3. 确定你完成了帐号授权（点击脚本设置界面的“帐号授权”，在打开的 BiliPlus 窗口中登录）

### 看不了付费番剧/影视？

**观看付费番剧/影视的前提是，你完成了帐号授权（点击脚本设置界面的“帐号授权”，在打开的 BiliPlus 窗口中登录）！！**

相关事项说明：

1. [付费抢先看番剧](https://bangumi.bilibili.com/anime/6012/play#103819)支付金额在特定情况下会显示`9876547210.33`的问题，这是因为代理服务器的接口获取不到金额，为了防止[手抖误操作](https://bangumi.bilibili.com/anime/5852/play?aid=9815508#103960#reply238854223)，默认显示一个逸。使用支付宝/微信扫码可以看到真实金额。
2. 以前的付费接口是不会检测区域的，但最近（2017-10-12）的[一些动画电影](https://bangumi.bilibili.com/movie/12116)的付费接口也会检测区域了，所以即使使用该脚本解除了视频的区域限制，依然没办法付费，只能看前面几分钟。一个解决办法是直接冲B站的大会员，大会员看所有的视频都是不需要付费的🙄。
3. 最近也[有人反馈有些番剧能付费，但付费后依然看不了](https://greasyfork.org/zh-CN/forum/discussion/29953/x)，所以付费前请谨慎

### 关于“被永封的大会员？”选项

**（这个条目并不是说“使用这个脚本会导致你的会员被封”，而是说“如果你有个被永封的大会员帐号，可以通过这个脚本继续观看会员专属视频”）**

1. 注册并登录一个小号
2. 在脚本设置界面勾选“被永封的大会员？”选项
3. 在[代理服务器](https://www.biliplus.com/login)中使用账号密码登录被永封的大会员账号
4. 就可以用小号看1080P了<img src="https://bbs.saraba1st.com/2b/static/image/smiley/nq/001.gif" alt="(扭曲"/>

## 开源

1. 源码仓库：[JoeyTeng/bilibili-helper at dev](https://github.com/JoeyTeng/bilibili-helper/tree/dev)
2. 代码贡献者：[Contributions](https://github.com/JoeyTeng/bilibili-helper/graphs/contributors)
3. 部分源码取自：
    - 通知相关：[Yet Another Weibo Filter - 看真正想看的微博](https://tiansh.github.io/yawf/zh-cn.html)
    - 自动跳转相关：[我就是要跳轉(B站番劇投稿頁跳轉去番劇頁)](https://greasyfork.org/zh-CN/scripts/29151)
    - B站视频接口：[soimort/you-get](https://github.com/soimort/you-get)、[哔哩哔哩UWP](https://www.microsoft.com/zh-cn/store/p/%E5%93%94%E5%93%A9%E5%93%94%E5%93%A9uwp/9n7c87236453)

## 友链

0. [BiliPlus - ( ゜- ゜)つロ 乾杯~](https://www.biliplus.com/)
1. [yujincheng08/BiliRoaming: 哔哩漫游，解除B站客户端番剧区域限制的Xposed模块，并且提供其他小功能](https://github.com/yujincheng08/BiliRoaming)
2. [kghost/bilibili-area-limit: Bilibili 港澳台, 解除区域限制](https://github.com/kghost/bilibili-area-limit)

## [高级设置/更新日志/测试页面 等](https://github.com/JoeyTeng/bilibili-helper/blob/dev/packages/unblock-area-limit/README.dev.md)
