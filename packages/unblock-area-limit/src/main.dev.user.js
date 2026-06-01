// ==UserScript==
// @name         解除B站区域限制.dev
// @namespace    https://github.com/JoeyTeng
// @version      8.4.3
// @description  通过替换获取视频地址接口的方式, 实现解除B站区域限制;
// @author       ipcjs
// @supportURL   https://github.com/JoeyTeng/bilibili-helper
// @compatible   chrome
// @compatible   firefox
// @license      MIT
// @match        *://www.bilibili.com/video/av*
// @match        *://www.bilibili.com/video/BV*
// @match        *://www.bilibili.com/bangumi/play/ep*
// @match        *://www.bilibili.com/bangumi/play/ss*
// @match        *://m.bilibili.com/bangumi/play/ep*
// @match        *://m.bilibili.com/bangumi/play/ss*
// @match        *://bangumi.bilibili.com/anime/*
// @match        *://bangumi.bilibili.com/movie/*
// @match        *://www.bilibili.com/bangumi/media/md*
// @match        *://www.bilibili.com/blackboard/html5player.html*
// @match        *://www.bilibili.com/watchroom/*
// @match        *://space.bilibili.com/*
// @match        https://www.bilibili.com/
// @match        https://www.bilibili.com/?*
// @match        https://www.biliplus.com/*
// @match        https://www.mcbbs.net/template/mcbbs/image/special_photo_bg.png*
// @run-at       document-start
// @grant        none
// @require      file:///C:/GitHub/bilibili-helper/dist/unblock-area-limit.user.js
// ==/UserScript==

`
使用@require的方式执行本地磁盘中的脚本, 达到使用外部编辑器编辑脚本的目的:
1. 给脚本管理扩展(Tampermonkey等)赋予文件访问权限
2. 新建本地脚本, 将当前文件内容粘贴进去
3. 依据你本地文件路径, 修改@require部分的url
4. pnpm install, 安装依赖
5. pnpm run dev, 打包最终的脚本文件
6. 编辑本地代码后, 刷新网页, 就可让新的内容生效
`;
console.log(`${GM_info.script.name} running`);
