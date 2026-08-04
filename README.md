# 解除B站区域限制

这个仓库现在只保留“解除B站区域限制”用户脚本及其构建链路，其他独立用户脚本和旧物料已清理。

## 目录

- 源码：`packages/unblock-area-limit/`
- 本地生成脚本：`dist/unblock-area-limit.user.js`
- 使用说明：`packages/unblock-area-limit/README.md`
- 高级设置和测试页：`packages/unblock-area-limit/README.dev.md`
- CDN 选择器设计：`docs/design/cdn-selection.md`

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

只运行 CDN selector、runtime、迁移与 adapter 回归：

```bash
pnpm run test:cdn
```

XHR subclass 与异步 fallback 的组合兼容回归由 `pnpm run test:xhr-compat` 负责；
它也包含在 `pnpm run check` 中。

下载并验证当前支持的最新版 CDN Switcher：

```bash
pnpm run test:cdn-switcher:latest
```

当前已验证的 Bilibili Video CDN Switcher 版本为 `0.1.4`；完整范围和源文件校验值见[CDN Switcher 兼容性](packages/unblock-area-limit/README.md#cdn-switcher-兼容性)。

该兼容测试应在创建稳定版 tag 前对 `dev` 的待发布提交显式运行。tag 触发的 release workflow 不下载可变的第三方 latest 源码，因此已冻结的 tag 不会因 CDN Switcher 后续发布而失去可重跑性。

## 分发

仓库采用源码分支和分发分支分离：

- `dev`：开发分支，保存源码、构建脚本、CI 和文档。
- `main`：GreasyFork 同步分支，只保存最新稳定单文件产物和必要文档。

这是新的 GreasyFork 分发脚本，不作为旧 `ipcjs` 脚本的自动升级路径发布。Userscript metadata 中的 `@namespace` 已切换到 `https://github.com/JoeyTeng`，旧脚本用户需要按新脚本重新安装。

发布新版本时，在 `dev` 分支打稳定版 `vX.Y.Z` tag。release workflow 会：

1. 用 tag 版本号构建 `dist/unblock-area-limit.user.js`。
2. 发布不可变 GitHub Release 附件和 SHA256 校验文件。
3. 用普通提交刷新 `main` 分支的 `unblock-area-limit.user.js`。

预发布 tag 会被 release workflow 跳过，不会用于发布 GitHub Release 或刷新 `main`，避免 GreasyFork 稳定同步源推送 RC 或 beta 版本。

GreasyFork 新脚本可以同步这个 URL：

```text
https://raw.githubusercontent.com/JoeyTeng/bilibili-helper/main/unblock-area-limit.user.js
```
