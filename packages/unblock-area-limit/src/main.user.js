// ==UserScript==
// @name         解除B站区域限制
// @namespace    https://github.com/JoeyTeng
// @version      8.6.0
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
// ==/UserScript==

const log = console.log.bind(console, 'injector:')

if (location.href.match(/^https:\/\/www\.biliplus\.com\//) != null) {
    const allowedOrigins = ['https://www.bilibili.com', 'https://m.bilibili.com', 'https://bangumi.bilibili.com', 'https://space.bilibili.com']
    const readCookie = (name) => {
        return document.cookie.split('; ').reduce((result, item) => {
            if (result) {
                return result
            }
            const [key, ...valueParts] = item.split('=')
            return key === name ? decodeURIComponent(valueParts.join('=')) : ''
        }, '')
    }
    const pickCredential = (...values) => values.find((value) => value && value !== 'deleted') || ''
    const hasSourceCredential = (credentials) => !!(credentials.access_key || credentials.access_token)
    const normalizeAuthPollCredentials = (data) => {
        const tokenInfo = data?.data?.token_info
        if (data?.code !== 0 || !tokenInfo) {
            return undefined
        }
        return {
            access_key: tokenInfo.access_token || tokenInfo.access_key || '',
            refresh_token: tokenInfo.refresh_token || '',
            expires_in: tokenInfo.expires_in || '',
        }
    }
    const params = new URLSearchParams(location.search)
    const authOrigin = params.get('balh_auth_origin')
    if (params.get('balh_auth') === '1' && allowedOrigins.includes(authOrigin)) {
        sessionStorage.balh_auth_origin = authOrigin
    }
    const isBalhAuthPage = params.get('balh_auth') === '1'
    const isFreshBiliPlusLogin = () => {
        if (!window.loginInfo?.isLogin) {
            return false
        }
        const expiresAt = Number(window.loginInfo.expires || '')
        return !Number.isFinite(expiresAt) || expiresAt <= 0 || Date.now() < expiresAt * 1000
    }

    let credentialsSent = false
    const postCredentials = (sourceCredentials = {}) => {
        if (credentialsSent) {
            return true
        }
        const targetOrigin = sessionStorage.balh_auth_origin
        if (!window.opener || !allowedOrigins.includes(targetOrigin)) {
            return true
        }

        if (isBalhAuthPage && !hasSourceCredential(sourceCredentials) && !isFreshBiliPlusLogin()) {
            return false
        }

        const sourceHasCredential = hasSourceCredential(sourceCredentials)
        const accessKey = sourceHasCredential
            ? pickCredential(sourceCredentials.access_key, sourceCredentials.access_token)
            : pickCredential(readCookie('access_key'), readCookie('access_token'), localStorage.access_key, localStorage.access_token)
        if (!accessKey) {
            return false
        }

        const credentials = sourceHasCredential
            ? {
                access_key: accessKey,
                refresh_token: sourceCredentials.refresh_token || '',
                oauth_expires_at: pickCredential(sourceCredentials.oauth_expires_at, sourceCredentials.expires_at, sourceCredentials.expire),
                expires_in: sourceCredentials.expires_in || '',
            }
            : {
                access_key: accessKey,
                refresh_token: pickCredential(readCookie('refresh_token'), localStorage.refresh_token),
                oauth_expires_at: pickCredential(readCookie('oauth_expires_at'), readCookie('expires_at'), readCookie('expire'), readCookie('expires'), localStorage.oauth_expires_at, localStorage.expires_at),
                expires_in: pickCredential(readCookie('expires_in'), localStorage.expires_in),
            }
        window.opener.postMessage('balh-login-credentials: ' + JSON.stringify(credentials), targetOrigin)
        credentialsSent = true
        document.documentElement.innerHTML = '<title>BALH - 授权</title><meta charset="UTF-8" name="viewport" content="width=device-width">授权信息已发送，稍候会自动关闭此窗口。'
        setTimeout(() => window.close(), 1500)
        return true
    }
    const installAuthPollInterceptor = () => {
        const open = XMLHttpRequest.prototype.open
        const send = XMLHttpRequest.prototype.send
        XMLHttpRequest.prototype.open = function (method, url, ...args) {
            this.__balh_auth_url = String(url || '')
            return open.call(this, method, url, ...args)
        }
        XMLHttpRequest.prototype.send = function (...args) {
            if (/(^|[?&])act=authpoll(&|$)/.test(this.__balh_auth_url || '')) {
                this.addEventListener('load', function () {
                    try {
                        const credentials = normalizeAuthPollCredentials(JSON.parse(this.responseText))
                        credentials && postCredentials(credentials)
                    } catch (e) {
                        // Ignore non-JSON or unrelated responses.
                    }
                })
            }
            return send.apply(this, args)
        }
    }

    installAuthPollInterceptor()

    let retry = 0
    if (!postCredentials()) {
        const timer = setInterval(() => {
            retry++
            if (postCredentials() || retry > 300) {
                clearInterval(timer)
            }
        }, 1000)
    }
    return
}

if (location.href.match(/^https:\/\/www\.mcbbs\.net\/template\/mcbbs\/image\/special_photo_bg\.png/) != null) {
    if (location.href.match('access_key') != null && window.opener != null) {
        window.stop();
        document.children[0].innerHTML = '<title>BALH - 授权</title><meta charset="UTF-8" name="viewport" content="width=device-width">正在跳转……';
        window.opener.postMessage('balh-login-credentials: ' + location.href, '*');
    }
    return
}

function injector() {
    if (document.getElementById('balh-injector-source')) {
        log(`脚本已经注入过, 不需要执行`)
        return
    }
    let $script = document.createElement('script')
    $script.id = 'balh-injector-source'
    $script.appendChild(document.createTextNode(`
        ;(function(GM_info){
            ${scriptSource.toString()}
            ${scriptSource.name}('${GM_info.scriptHandler}.${injector.name}')
        })(${JSON.stringify(GM_info)})
    `))
    document.head.appendChild($script)
    log('注入完成')
}

if (!Object.getOwnPropertyDescriptor(window, 'XMLHttpRequest').writable) {
    log('XHR对象不可修改, 需要把脚本注入到页面中', GM_info.script.name, location.href, document.readyState)
    injector()
    return
}

/** 脚本的主体部分, 在GM4中, 需要把这个函数转换成字符串, 注入到页面中, 故不要引用外部的变量 */
function scriptSource(invokeBy) {
    // @template-content
}

scriptSource(GM_info.scriptHandler);
