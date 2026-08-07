# 解除B站区域限制

这个仓库现在只保留“解除B站区域限制”用户脚本及其构建链路，其他独立用户脚本和旧物料已清理。

## 目录

- 源码：`packages/unblock-area-limit/`
- 本地生成脚本：`dist/unblock-area-limit.user.js`
- 使用说明：`packages/unblock-area-limit/README.md`
- 高级设置和测试页：`packages/unblock-area-limit/README.dev.md`
- CDN 选择器设计：`docs/design/cdn-selection.md`
- CDN stall recovery 状态机与可复用接入契约：`docs/design/cdn-stall-recovery.md`

## 开发

安装依赖：

```bash
pnpm install
```

监听构建：

```bash
pnpm run dev
```

生成脚本：

```bash
pnpm run build
```

类型检查：

```bash
pnpm run typecheck
```

运行完整的本地确定性门禁（类型检查、既有回归、XHR/CDN 测试与构建）：

```bash
pnpm run check
```

只运行 CDN selector、runtime、stall recovery、迁移与 adapter 回归：

```bash
pnpm run test:cdn
```

运行受控的真实 Chrome stall recovery gate（Fetch 与 XHR、held current request、
`3 s` grace、future exact route、稳定恢复与 cooldown）：

```bash
pnpm run test:cdn-recovery-browser
pnpm run test:cdn-recovery-browser --headed --timeout-ms 120000
```

该 gate 会自行构建 userscript，使用一次性浏览器 context 和完全受控的 Bilibili-origin
fixture；它不读取用户 profile、登录态或真实 signed media URL。

运行真实 Bilibili 视频与 CDN 的联网 E2E gate（会先重新构建本地用户脚本）：

```bash
pnpm run test:cdn-live-e2e
pnpm run test:cdn-live-e2e --headed --url https://www.bilibili.com/video/BV17x411w7KC/ --timeout-ms 120000
pnpm run test:cdn-live-e2e --stage3-capability --timeout-ms 180000
```

该 gate 使用一次性无登录浏览器上下文，不读取 `access_key`，也不配置 BALH 或第三方代理。
它通过 Playwright 的 `chrome` channel 启动本机已安装的 Google Chrome；仅安装依赖而没有
可用 Chrome 时会明确失败，而不会回退到其他浏览器。
`--timeout-ms` 限制浏览器操作阶段；退出时最多再给 Chrome 5 秒完成清理。
它要求视频实际播放推进、完成一轮可持久化的 CDN 探测，并在重载后的新 runtime 中以
`source: "cache"`、不新增网络探测的方式读回同一组 host。`partial`、`unprobeable` 或零次
探测会明确报告正向 cache coverage 未完成，而不会当作完整 PASS。它依赖真实站点、公开
媒体和当前网络；若仅因网络波动失败，应重试一次确认，而不能把失败当作通过。该自动 gate
不替代发布前的英国本地人工播放验收。

可选的 `--stage3-capability` 会在受限时间内尝试对真实页面的 future Fetch/XHR media
request 注入可恢复 stall，并输出 `PASS`、`FAIL`、`UNSUPPORTED` 或 `INCONCLUSIVE`。
四类退出码依次为 `0`、`1`、`2`、`3`；native media loader 绕过或证据不足不会被误报为
成功，也不单独证明生产代码有缺陷。该模式不会替代上面的默认 Stage 2 live gate。

XHR subclass 与异步 fallback 的组合兼容回归由 `pnpm run test:xhr-compat` 负责；
它也包含在 `pnpm run check` 中。

下载并验证当前支持的最新版 CDN Switcher：

```bash
pnpm run test:cdn-switcher:latest
```

当前已验证的 Bilibili Video CDN Switcher 版本为 `0.1.4`；兼容 gate 覆盖 Fetch/XHR、
两种脚本加载顺序、downstream 最终响应候选发布和 future-route recovery。完整范围和源文件校验值见
[CDN Switcher 兼容性](packages/unblock-area-limit/README.md#cdn-switcher-兼容性)。

该兼容测试应在创建稳定版 tag 前对 `dev` 的待发布提交显式运行。tag 触发的 release workflow 不下载可变的第三方 latest 源码，因此已冻结的 tag 不会因 CDN Switcher 后续发布而失去可重跑性。

## 分发

仓库采用源码分支和分发分支分离：

- `dev`：开发分支，保存源码、构建脚本、CI 和文档。
- `main`：GreasyFork 同步分支，只保存最新稳定单文件产物和必要文档。

这是新的 GreasyFork 分发脚本，不作为旧 `ipcjs` 脚本的自动升级路径发布。Userscript metadata 中的 `@namespace` 已切换到 `https://github.com/JoeyTeng`，旧脚本用户需要按新脚本重新安装。

CDN selection 的三个阶段全部合并，并且 Joey 完成 UK-local 人工播放验收前，
不得创建稳定版 tag、发布稳定版或刷新 `main`。真实站点 live E2E 只是自动辅助证据，
不替代这项人工验收。

发布新版本时，在 `dev` 分支打稳定版 `vX.Y.Z` tag。release workflow 会：

1. 用 tag 版本号构建 `dist/unblock-area-limit.user.js`。
2. 发布不可变 GitHub Release 附件和 SHA256 校验文件。
3. 用普通提交刷新 `main` 分支的 `unblock-area-limit.user.js`。

预发布 tag 会被 release workflow 跳过，不会用于发布 GitHub Release 或刷新 `main`，避免 GreasyFork 稳定同步源推送 RC 或 beta 版本。

GreasyFork 新脚本可以同步这个 URL：

```text
https://raw.githubusercontent.com/JoeyTeng/bilibili-helper/main/unblock-area-limit.user.js
```
