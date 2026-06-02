// ==UserScript==
// @name         解除B站区域限制.dev.local.loader
// @namespace    https://github.com/JoeyTeng
// @version      0.1.1
// @description  Loads the local built BALH userscript from the dev server.
// @author       ipcjs
// @supportURL   https://github.com/JoeyTeng/bilibili-helper
// @compatible   chrome
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
// ==/UserScript==

(() => {
    const defaultScriptUrl = 'http://127.0.0.1:48711/unblock-area-limit.user.js'
    const scriptUrl = localStorage.balh_dev_loader_url || defaultScriptUrl
    const url = `${scriptUrl}${scriptUrl.includes('?') ? '&' : '?'}balh_loader_ts=${Date.now()}`
    const startedAt = Date.now()

    try {
        const xhr = new XMLHttpRequest()
        xhr.open('GET', url, false)
        xhr.send()

        if (xhr.status !== 200) {
            throw new Error(`HTTP ${xhr.status}`)
        }

        const source = xhr.responseText
        const buildId = source.match(/const __BALH_BUILD_VERSION__ = "([^"]+)"/)?.[1] || 'unknown'
        const info = {
            script: {
                name: '解除B站区域限制.dev.local',
                version: `loader-${buildId}`,
            },
            scriptHandler: 'Tampermonkey-loader',
        }
        console.debug(`BALH dev loader: loaded ${scriptUrl} (${buildId}) in ${Date.now() - startedAt}ms`)
        new Function('GM_info', `${source}\n//# sourceURL=${scriptUrl}`)(info)
    } catch (error) {
        console.warn(`BALH dev loader: failed to load ${scriptUrl}`, error)
    }
})()
