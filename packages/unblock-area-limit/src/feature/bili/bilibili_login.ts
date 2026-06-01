import { cookieStorage } from "../../util/cookie"
import { util_init } from "../../util/initiator"
import { _ } from "../../util/react"
import { ui } from "../../util/ui"
import { balh_config } from "../config"
import { util_page } from "../page"
import { FALSE, TRUE, r } from "../r"


function isLogin() {
    if (!localStorage.access_key) {
        return false
    }
    if (!localStorage.oauth_expires_at) {
        return true
    }
    return Date.now() < +localStorage.oauth_expires_at
}

function clearLoginFlag() {
    delete localStorage.oauth_expires_at
    delete localStorage.access_key
    delete localStorage.refresh_token
}

function showLogout() {
    ui.alert('确定取消授权登出?', () => {
        // 登出, 则应该清除所有授权相关的字段
        delete localStorage.oauth_expires_at
        delete localStorage.access_key
        delete localStorage.refresh_token
    })
}

function isLoginBiliBili() {
    return cookieStorage['DedeUserID'] !== undefined
}
// 当前在如下情况才会弹一次登录提示框:
// 1. 第一次使用
// 2. 主站+服务器都退出登录后, 再重新登录主站
function checkLoginState() {
    // 给一些状态，设置初始值
    localStorage.balh_must_remind_login_v3 === undefined && (localStorage.balh_must_remind_login_v3 = TRUE)

    if (isLoginBiliBili()) {
        if (!localStorage.balh_old_isLoginBiliBili // 主站 不登录 => 登录
            || localStorage.balh_pre_server !== balh_config.server // 代理服务器改变了
            || localStorage.balh_must_remind_login_v3) { // 设置了"必须提醒"flag
            if (!isLogin()) {
                // 保证一定要交互一次, 才不提醒
                localStorage.balh_must_remind_login_v3 = TRUE;
                ui.pop({
                    content: [
                        _('text', `${GM_info.script.name}\n要不要考虑进行一下授权？\n\n授权后可以观看区域限定番剧的1080P\n（如果你是大会员或承包过这部番的话）\n\n你可以随时在设置中打开授权页面`)
                    ],
                    onConfirm: () => {
                        localStorage.balh_must_remind_login_v3 = FALSE;
                        showLogin();
                        document.querySelector('#AHP_Notice')?.remove()
                    },
                    closeBtn: '不再提醒',
                    onClose: () => {
                        localStorage.balh_must_remind_login_v3 = FALSE;
                    }
                })
            }
        }
    }
    localStorage.balh_old_isLoginBiliBili = isLoginBiliBili() ? TRUE : FALSE
    localStorage.balh_pre_server = balh_config.server
}

function normalizeExpiresAt(value: string | null) {
    if (!value) {
        return ''
    }
    const timestamp = Number(value)
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
        return ''
    }
    return String(timestamp < 1e12 ? timestamp * 1000 : timestamp)
}

function saveCredentials(credentials: StringStringObject) {
    if (!credentials.access_key) {
        return false
    }

    localStorage.access_key = credentials.access_key
    if (credentials.refresh_token) {
        localStorage.refresh_token = credentials.refresh_token
    } else {
        delete localStorage.refresh_token
    }

    const oauthExpiresAt = normalizeExpiresAt(credentials.oauth_expires_at || credentials.expires_at || '')
    const expiresIn = Number(credentials.expires_in || '')
    if (oauthExpiresAt) {
        localStorage.oauth_expires_at = oauthExpiresAt
    } else if (Number.isFinite(expiresIn) && expiresIn > 0) {
        localStorage.oauth_expires_at = String(Date.now() + expiresIn * 1000)
    } else {
        delete localStorage.oauth_expires_at
    }
    localStorage.balh_must_remind_login_v3 = FALSE
    return true
}

function readCredentials(message: string) {
    const payload = message.slice('balh-login-credentials:'.length).trim()
    if (payload.startsWith('{')) {
        return JSON.parse(payload)
    }

    const params = new URL(payload).searchParams
    return {
        access_key: params.get('access_key') || params.get('access_token') || '',
        refresh_token: params.get('refresh_token') || '',
        oauth_expires_at: params.get('oauth_expires_at') || params.get('expires_at') || '',
        expires_in: params.get('expires_in') || '',
    }
}

function showLogin() {
    const authUrl = new URL('/login', r.const.server.S1)
    authUrl.searchParams.set('balh_auth', '1')
    authUrl.searchParams.set('balh_auth_origin', location.origin)

    const balh_auth_window = window.open(authUrl.href, 'balh_auth_window')
    if (!balh_auth_window) {
        ui.alert('授权窗口被浏览器拦截了，请允许弹窗后重试')
        return
    }
    window.balh_auth_window = balh_auth_window

    ui.pop({
        content: [
            _('text', '已打开 BiliPlus 授权窗口。\n\n请在新窗口完成登录；登录成功后脚本会自动保存 access_key。')
        ],
        closeBtn: '我知道了',
    })
}

window.addEventListener('message', function (e) {
    if (e.origin !== r.const.server.S1 || typeof e.data !== 'string' || !e.data.startsWith('balh-login-credentials:')) {
        return
    }

    try {
        const credentials = readCredentials(e.data)
        if (!saveCredentials(credentials)) {
            ui.alert('授权返回中没有 access_key，请确认 BiliPlus 登录是否成功')
            return
        }
        window.balh_auth_window?.close()
        document.querySelector('#AHP_Notice')?.remove()
        ui.alert('授权成功，access_key 已保存')
    } catch (error: any) {
        ui.alert(error?.message ?? '授权返回解析失败')
    }
})

util_init(() => {
    if (!(util_page.player() || util_page.av())) {
        checkLoginState()
    }
}, util_init.PRIORITY.DEFAULT, util_init.RUN_AT.DOM_LOADED_AFTER)

export const bilibili_login = {
    showLogin,
    showLogout,
    isLogin,
    isLoginBiliBili,
    clearLoginFlag,
}
