# 解除B站区域限制

这个分支只保存最新稳定版的 GreasyFork 分发文件。

- 最新分发文件：`unblock-area-limit.user.js`
- GreasyFork 同步 URL：`https://raw.githubusercontent.com/JoeyTeng/bilibili-helper/main/unblock-area-limit.user.js`
- 不可变版本产物：GitHub Releases 中的 `unblock-area-limit-<version>.user.js`
- 开发源码：`dev` 分支

这是新的 GreasyFork 分发脚本，不作为旧 `ipcjs` 脚本的自动升级路径发布。旧脚本用户需要按新脚本重新安装。

请不要直接在这个分支开发功能。修改源码后在 `dev` 分支打 tag，由 release workflow 刷新这里的稳定分发文件。
