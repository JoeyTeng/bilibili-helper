import { _t } from "../feature/r"
import { Async } from "./async"
import { util_error, util_info, util_log } from "./log"
import { Objects } from "./objects"
import { _ } from "./react"

export namespace ui {
    type PlayerStatusState = 'loading' | 'success' | 'error'

    interface PlayerStatusOptions {
        detail?: string
        state?: PlayerStatusState
        timeout?: number
    }

    let playerStatusRetryTimer: number | undefined
    let playerStatusHideTimer: number | undefined
    let pendingPlayerStatus: { message: string, options: PlayerStatusOptions } | undefined

    function ensurePlayerStatusStyle() {
        if (document.getElementById('balh-player-status-style')) return
        document.head.appendChild(_('style', { id: 'balh-player-status-style' }, [_('text', `
#balh-player-status {
    position: fixed;
    z-index: 2147483000;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    color: #fff;
    background: rgba(12, 18, 28, .92);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
#balh-player-status .balh-player-status-box {
    display: flex;
    align-items: center;
    gap: 12px;
    max-width: min(520px, calc(100% - 48px));
    padding: 14px 18px;
    border: 1px solid rgba(255, 255, 255, .16);
    background: rgba(18, 26, 38, .78);
    box-shadow: 0 12px 36px rgba(0, 0, 0, .28);
}
#balh-player-status .balh-player-status-spinner {
    width: 20px;
    height: 20px;
    flex: 0 0 auto;
    border: 2px solid rgba(255, 255, 255, .28);
    border-top-color: #00aeec;
    border-radius: 50%;
    animation: balh-player-status-spin .8s linear infinite;
}
#balh-player-status[data-state="success"] .balh-player-status-spinner {
    border-color: #30d158;
    animation: none;
}
#balh-player-status[data-state="error"] .balh-player-status-spinner {
    border-color: #ff6b6b;
    animation: none;
}
#balh-player-status .balh-player-status-title {
    font-weight: 600;
}
#balh-player-status .balh-player-status-detail {
    margin-top: 2px;
    color: rgba(255, 255, 255, .72);
    font-size: 12px;
}
body.balh-player-status-active #big-block-panel,
body.balh-player-status-active .bilibili-player-video-panel-text,
body.balh-player-status-active .bpx-player-toast-wrap {
    visibility: hidden !important;
}
@keyframes balh-player-status-spin {
    to { transform: rotate(360deg); }
}`)]))
    }

    function findPlayerStatusTarget() {
        const candidates = [
            '#bilibili-player',
            '.bpx-player-container',
            '.bilibili-player',
            '#player_module',
            '.player-module',
            '.player-wrapper',
        ].map(selector => document.querySelector(selector) as HTMLElement | null)
            .filter((element): element is HTMLElement => !!element)
        return candidates.find(element => {
            const rect = element.getBoundingClientRect()
            return rect.width >= 200 && rect.height >= 100
        }) || candidates[0]
    }

    function positionPlayerStatus(status: HTMLElement, target: HTMLElement) {
        const rect = target.getBoundingClientRect()
        status.style.left = `${Math.max(0, rect.left)}px`
        status.style.top = `${Math.max(0, rect.top)}px`
        status.style.width = `${Math.max(0, rect.width)}px`
        status.style.height = `${Math.max(0, rect.height)}px`
    }

    export function playerStatus(message: string, options: PlayerStatusOptions = {}) {
        ensurePlayerStatusStyle()
        pendingPlayerStatus = { message, options: { ...options } }
        if (playerStatusHideTimer !== undefined) {
            clearTimeout(playerStatusHideTimer)
            playerStatusHideTimer = undefined
        }

        const target = findPlayerStatusTarget() as HTMLElement | null
        if (!target) {
            if (playerStatusRetryTimer === undefined) {
                playerStatusRetryTimer = window.setTimeout(() => {
                    playerStatusRetryTimer = undefined
                    if (pendingPlayerStatus) {
                        playerStatus(pendingPlayerStatus.message, pendingPlayerStatus.options)
                    }
                }, 100)
            }
            return
        }
        if (playerStatusRetryTimer !== undefined) {
            clearTimeout(playerStatusRetryTimer)
            playerStatusRetryTimer = undefined
        }
        pendingPlayerStatus = undefined

        let status = document.getElementById('balh-player-status')
        if (!status) {
            status = _('div', { id: 'balh-player-status' }, [
                _('div', { className: 'balh-player-status-box' }, [
                    _('div', { className: 'balh-player-status-spinner' }),
                    _('div', { className: 'balh-player-status-copy' }, [
                        _('div', { className: 'balh-player-status-title' }),
                        _('div', { className: 'balh-player-status-detail' }),
                    ]),
                ]),
            ])
        }
        if (status.parentElement !== document.body) {
            document.body.appendChild(status)
        }
        positionPlayerStatus(status, target)
        status.dataset.state = options.state || 'loading'
        const title = status.querySelector('.balh-player-status-title')
        const detail = status.querySelector('.balh-player-status-detail') as HTMLElement | null
        if (title) title.textContent = message
        if (detail) {
            detail.textContent = options.detail || ''
            detail.style.display = options.detail ? '' : 'none'
        }
        document.body?.classList.add('balh-player-status-active')

        if (options.timeout != null) {
            hidePlayerStatus(options.timeout)
        }
    }

    export function hidePlayerStatus(delay = 0) {
        pendingPlayerStatus = undefined
        if (playerStatusRetryTimer !== undefined) {
            clearTimeout(playerStatusRetryTimer)
            playerStatusRetryTimer = undefined
        }
        if (playerStatusHideTimer !== undefined) {
            clearTimeout(playerStatusHideTimer)
        }
        playerStatusHideTimer = window.setTimeout(() => {
            document.getElementById('balh-player-status')?.remove()
            document.body?.classList.remove('balh-player-status-active')
            playerStatusHideTimer = undefined
        }, delay)
    }

    export const alert = function (message: string, resolve?: Function, reject?: Function) {
        setTimeout(() => {
            if (resolve) {
                if (window.confirm(message)) {
                    resolve()
                } else {
                    if (reject) {
                        reject()
                    }
                }
            } else {
                window.alert(message)
            }
        }, 500)
    }

    export async function prompt(message?: string, defaultValue?: string) {
        await Async.timeout(500)
        return window.prompt(message, defaultValue)
    }

    export const copy = function (text: string, textarea: HTMLTextAreaElement) {
        textarea.value = text
        textarea.select()
        try {
            return document.execCommand('copy')
        } catch (e) {
            util_error('复制文本出错', e)
        }
        return false
    }

    interface PopParam {
        /** 内容元素数组/HTML */
        content: any
        /** 是否显示确定按钮 */
        showConfirm?: boolean
        /** 确定按钮的文字 */
        confirmBtn?: string
        /** 关闭按钮的文字 */
        closeBtn?: string
        /** 确定回调 */
        onConfirm?: Function
        /** 关闭回调 */
        onClose?: Function
    }

    /**
     * 确定弹窗
     */
    export const pop = function (param: PopParam) {
        if (typeof param.content === 'string') {
            let template = _('template');
            template.innerHTML = param.content.trim()
            param.content = Array.from(template.content.childNodes)
        } else if (!(param.content instanceof Array)) {
            util_log(`param.content(${param.content}) 不是数组`)
            return;
        }

        if (document.getElementById('AHP_Notice_style') == null) {
            let noticeWidth = Math.min(500, innerWidth - 40);
            document.head.appendChild(_('style', { id: 'AHP_Notice_style' }, [_('text', `#AHP_Notice{ line-height:normal;position:fixed;left:0;right:0;top:0;height:0;z-index:20000;transition:.5s;cursor:default;pointer-events:none } .AHP_down_banner{ margin:2px;padding:2px;color:#FFFFFF;font-size:13px;font-weight:bold;background-color:green } .AHP_down_btn{ margin:2px;padding:4px;color:#1E90FF;font-size:14px;font-weight:bold;border:#1E90FF 2px solid;display:inline-block;border-radius:5px } body.ABP-FullScreen{ overflow:hidden } @keyframes pop-iframe-in{0%{opacity:0;transform:scale(.7);}100%{opacity:1;transform:scale(1)}} @keyframes pop-iframe-out{0%{opacity:1;transform:scale(1);}100%{opacity:0;transform:scale(.7)}} #AHP_Notice>div{ position:absolute;bottom:0;left:0;right:0;font-size:15px } #AHP_Notice>div>div{ border:1px #AAA solid;width:${noticeWidth}px;margin:0 auto;padding:20px 10px 5px;background:#EFEFF4;color:#000;border-radius:5px;box-shadow:0 0 5px -2px;pointer-events:auto;white-space:pre-wrap } #AHP_Notice>div>div *{ margin:5px 0; } #AHP_Notice input[type=text]{ border: none;border-bottom: 1px solid #AAA;width: 60%;background: transparent } #AHP_Notice input[type=text]:active{ border-bottom-color:#4285f4 } #AHP_Notice input[type=button] { border-radius: 2px; border: #adadad 1px solid; padding: 3px; margin: 0 5px; min-width:50px } #AHP_Notice input[type=button]:hover { background: #FFF; } #AHP_Notice input[type=button]:active { background: #CCC; } .noflash-alert{display:none}`)]));
        }

        document.querySelector('#AHP_Notice')?.remove();

        let div = _('div', { id: 'AHP_Notice' });
        let children = [];
        if (param.showConfirm || param.confirmBtn || param.onConfirm) {
            children.push(_('input', { value: param.confirmBtn || _t('ok'), type: 'button', className: 'confirm', event: { click: param.onConfirm } }));
        }
        children.push(_('input', {
            value: param.closeBtn || _t('close'), type: 'button', className: 'close', event: {
                click: function () {
                    param.onClose && param.onClose();
                    div.style.height = '0';
                    setTimeout(function () { div.remove(); }, 500);
                }
            }
        }));
        div.appendChild(_('div', {}, [_('div', {},
            param.content.concat([_('hr'), _('div', { style: { textAlign: 'right' } }, children)])
        )]));
        document.body.appendChild(div);
        div.style.height = (div.firstChild as HTMLElement).offsetHeight + 'px';
    }

    export const playerMsg = function (message: string) {
        const msg = Objects.stringify(message)
        util_info('player msg:', msg)
        const $panel = document.querySelector('.bilibili-player-video-panel-text')
        if ($panel) {
            let stage = $panel.children.length + 1000 // 加1000和B站自己发送消息的stage区别开来
            $panel.appendChild(_('div', { className: 'bilibili-player-video-panel-row', stage: stage }, [_('text', `[${GM_info.script.name}] ${msg}`)]))
        }
    }


    export const popFrame = function (iframeSrc: string) {
        if (!document.getElementById('balh-style-login')) {
            var style = document.createElement('style');
            style.id = 'balh-style-login';
            document.head.appendChild(style).innerHTML = '@keyframes pop-iframe-in{0%{opacity:0;transform:scale(.7);}100%{opacity:1;transform:scale(1)}}@keyframes pop-iframe-out{0%{opacity:1;transform:scale(1);}100%{opacity:0;transform:scale(.7)}}.GMBiliPlusCloseBox{position:absolute;top:5%;right:8%;font-size:40px;color:#FFF}';
        }

        var div = document.createElement('div');
        div.id = 'GMBiliPlusLoginContainer';
        div.innerHTML = '<div style="position:fixed;top:0;left:0;z-index:10000;width:100%;height:100%;background:rgba(0,0,0,.5);animation-fill-mode:forwards;animation-name:pop-iframe-in;animation-duration:.5s;cursor:pointer"><iframe src="' + iframeSrc + '" style="background:#e4e7ee;position:absolute;top:10%;left:10%;width:80%;height:80%"></iframe><div class="GMBiliPlusCloseBox">×</div></div>';
        div.firstChild!.addEventListener('click', function (this: any, e) {
            if (e.target === this || (e.target as HTMLElement).className === 'GMBiliPlusCloseBox') {
                if (!confirm('确认关闭？')) {
                    return false;
                }
                ; (div.firstChild as HTMLElement).style.animationName = 'pop-iframe-out';
                setTimeout(function () {
                    div.remove();
                }, 5e2);
            }
        });
        document.body.appendChild(div);
    }

}
