import { BiliBiliApi } from "../../api/bilibili"
import { access_key_param_if_exist } from "../../api/bilibili-utils"
import { BiliPlusApi, fixMobiPlayUrlJson, fixThailandPlayUrlJson, generateMobiPlayUrlParams, getMobiPlayUrl } from "../../api/biliplus"
import { Async, Promise as NativePromise } from "../../util/async"
import { BalhDb } from "../../util/balh-db"
import { Converters, uposMap } from "../../util/converters"
import { cookieStorage } from "../../util/cookie"
import { util_init } from "../../util/initiator"
import { log, util_warn } from "../../util/log"
import { Objects } from "../../util/objects"
import { _ } from "../../util/react"
import { Strings } from "../../util/strings"
import { ui } from "../../util/ui"
import { ifNotNull } from "../../util/utils"
import { Windows } from "../../util/windows"
import { balh_config, isClosed } from "../config"
import { util_page } from "../page"
import { FALSE, r } from "../r"
import pageTemplate from './bangumi-play-page-template.html'
import { bilibili_login } from "./bilibili_login"

let callbackCount = 1000
function appendScript(
    node: Node,
    innerHTML: string,
    props: {
        type: string | '',
        src: string | '',
        crossOrigin: string | null,
    },
) {
    // log(`fuck: ${JSON.stringify(props)}`)
    return new Promise((resolve, reject) => {
        let onLoad
        if (props.src) {
            onLoad = resolve
        } else if (!props.type || props.type === 'text/javascript') {
            const anyWindow = window as any
            const key: string = `balh_appendScript_${callbackCount++}`
            anyWindow[key] = resolve
            innerHTML = `try { ${innerHTML} } finally { window['${key}'](); } `
        } else {
            setTimeout(resolve, 0)
        }
        node.appendChild(_('script', {
            // 所有属性为null/''时都替换成undefined
            type: props.type || undefined,
            src: props.src || undefined,
            crossOrigin: props.crossOrigin || undefined,
            // 无论成功失败, 都需要让异步方法继续执行下去
            event: { load: onLoad, error: onLoad },
        }, innerHTML))
    })
}
async function cloneChildNodes(fromNode: Node, toNode: Node) {
    // 坑1: 一定要倒序遍历, forEach内部使用的顺序遍历实现, 直接remove()会让顺序混乱
    for (let i = toNode.childNodes.length - 1; i >= 0; i--) {
        toNode.childNodes[i].remove()
    }

    for (let i = 0; i < fromNode.childNodes.length; i++) {
        const it = fromNode.childNodes[i]
        if (it instanceof HTMLScriptElement) {
            // 坑2: 要让script内容正常执行, 一定要重新构建script标签
            await appendScript(toNode, it.innerHTML, { type: it.type, src: it.src, crossOrigin: it.crossOrigin })
        } else {
            // 坑3: 不clone可能导致forEach方法出问题...
            toNode.appendChild(it.cloneNode(true))
        }
    }
}

interface TemplateArgs {
    id: any,
    aid: any,
    cid: any,
    bvid: any,
    title: any,
    titleFormat: any,
    htmlTitle: any,
    mediaInfoTitle: any,
    mediaInfoId: any,
    evaluate: any,
    cover: any,
    ssId: any,
    episodes?: any,
    appOnly: boolean,
}

async function fixThailandSeason(ep_id: string, season_id: string) {
    // 部分泰区番剧通过 bangumi 无法取得数据或者数据不完整
    // 通过泰区 api 补全
    // https://github.com/yujincheng08/BiliRoaming/issues/112
    const thailandApi = new BiliBiliApi(balh_config.server_custom_th)
    const origin = await thailandApi.getSeasonInfoByEpSsIdOnThailand(ep_id, season_id)
    if (origin.code === 401)
        bilibili_login.clearLoginFlag()
    origin.result.actors = origin.result.actor.info
    origin.result.is_paster_ads = 0
    origin.result.jp_title = origin.result.origin_name
    origin.result.newest_ep = origin.result.new_ep
    origin.result.season_status = origin.result.status
    origin.result.season_title = origin.result.title
    origin.result.rights.watch_platform = 1

    origin.result.episodes = []
    if (origin.result.modules.length > 0) {
        origin.result.modules[0].data.episodes.forEach((ep) => {
            ep.episode_status = ep.status
            ep.ep_id = ep.id
            ep.index = ep.title
            ep.index_title = ep.long_title
            origin.result.episodes?.push(ep)
            if (season_id !== '5551')
                BalhDb.setSsId(ep.id, season_id)//
                    .catch((e) => util_warn('setSsId failed', e))
        })
        origin.result.total = origin.result.modules[0].data.episodes.length
    }
    origin.result.total_ep = origin.result.total
    origin.result.style = []
    origin.result.styles?.forEach((it) => {
        origin.result.style.push(it.name)
    })
    return { code: origin.code, message: origin.message, data: origin.result }
}

let invalidInitialState: StringAnyObject | undefined
function fixBangumiPlayPage() {
    util_init(async () => {
        if (util_page.bangumi_md()) {
            // 临时保存当前的season_id
            cookieStorage.set('balh_curr_season_id', window?.__INITIAL_STATE__?.mediaInfo?.season_id, '')
        }
        if (util_page.anime_ep() || util_page.anime_ss()) {
            if (document.getElementById('__next') || document.getElementById('__NEXT_DATA__')) {
                return
            }
            // 旧版偶尔会出现client-app，why？
            const $app = document.getElementById('app') || document.getElementById('client-app');
            if ((!$app || invalidInitialState) && !window.__NEXT_DATA__) {
                // 这个fixBangumiPlayPage()函数，本来是用来重建appOnly页面的，不过最近这样appOnly的页面基本上没有了，反而出现了一批非appOnly但页面也需要重建的情况
                // 如：https://www.bilibili.com/bangumi/media/md28235576
                // 故当前默认值改为false🤔
                let appOnly = invalidInitialState?.mediaInfo?.rights?.appOnly ?? false
                try {
                    // 读取保存的season_id
                    let season_id = (window.location.pathname.match(/\/bangumi\/play\/ss(\d+)/) || ['', cookieStorage.get('balh_curr_season_id')])[1]
                    const ep_id = (window.location.pathname.match(/\/bangumi\/play\/ep(\d+)/) || ['', ''])[1]
                    const bilibiliApi = new BiliBiliApi(balh_config.server_bilibili_api_proxy)
                    let templateArgs: TemplateArgs | null = null

                    // 不限制地区的接口，可以查询泰区番剧，该方法前置给代理服务器和BP节省点请求
                    // 如果该接口失效，自动尝试后面的方法
                    try {
                        let result = await bilibiliApi.getSeasonInfoById(season_id, ep_id)
                        if (result.code == -404) {
                            if (season_id) {
                                try {
                                    let mediaInfo = await bilibiliApi.getMediaInfoBySeasonId(season_id)
                                    if (mediaInfo.season_id) {
                                        mediaInfo.refine_cover = decodeURI(mediaInfo.cover)
                                        mediaInfo.share_copy = mediaInfo.title
                                        mediaInfo.share_url = `https://www.bilibili.com/bangumi/play/ss${mediaInfo.season_id}`
                                        mediaInfo.short_link = `https://b23.tv/ss${mediaInfo.season_id}`
                                        mediaInfo.status = mediaInfo.season_status
                                        mediaInfo.rights.area_limit = 0
                                        mediaInfo.rights.ban_area_show = 0
                                        mediaInfo.rights.is_preview = 0
                                        mediaInfo.staff = { info: mediaInfo.staff }
                                        result = { code: 0, data: mediaInfo, message: "success" }
                                    }
                                } catch (error) {
                                }
                            }
                        }
                        if (result.code != 0 && balh_config.server_custom_th) {
                            result = await fixThailandSeason(ep_id, season_id)
                            appOnly = true
                        }
                        if (result.code != 0) {
                            throw result
                        }
                        if (ep_id != '') season_id = result.data.season_id.toString()
                        result.result = result.data
                        result.result.modules?.forEach((module: { data: { [x: string]: any }; id: any }, mid: number) => {
                            if (module.data) {
                                let sid = module.id ? module.id : mid + 1
                                module.data['id'] = sid
                            }
                        })
                        let seasons: any[] = []
                        result.result.modules?.forEach((module: { data: { seasons?: any[], episodes?: any[] } }) => {
                            if (module.data.seasons) {
                                module.data.seasons.forEach(season => {
                                    seasons.push(season)
                                })
                            } else if (module.data.episodes) {
                                module.data.episodes.forEach(ep => {
                                    seasons.push(ep)
                                })
                            }
                        })
                        result.result['seasons'] = seasons
                        if (!result.result.episodes) {
                            const section = await bilibiliApi.getSeasonSectionBySsId(season_id)
                            result.result['episodes'] = section.result.main_section.episodes
                            result.result['section'] = section.result.section
                            result.result['positive'] = { id: section.result.main_section.id, title: section.result.main_section.title }
                        }

                        if (result.result.episodes.length > 0) {
                            const episodeInfo = await bilibiliApi.getEpisodeInfoByEpId(result.result.episodes[0].id)
                            if (episodeInfo.code = 0) {
                                result.result['up_info'] = episodeInfo.data.related_up[0]
                            }
                            result.result.episodes.forEach((ep: { [x: string]: any; id: any }) => {
                                ep['bvid'] = Converters.aid2bv(ep.aid)
                                ep['ep_id'] = ep.id
                                ep['link'] = `https://www.bilibili.com/bangumi/play/ep${ep.id}`
                                ep['rights'] = { allow_download: 1, area_limit: 0, allow_dm: 1 }
                                ep['short_link'] = `https://b23.tv/ep${ep.id}`
                            })
                        }
                        if (result.result.section) {
                            result.result.section.forEach(section => {
                                section.episodes.forEach((ep: { [x: string]: any; id: any }) => {
                                    ep['bvid'] = Converters.aid2bv(ep.aid)
                                    ep['ep_id'] = ep.id
                                    ep['link'] = `https://www.bilibili.com/bangumi/play/ep${ep.id}`
                                    ep['rights'] = { allow_download: 1, area_limit: 0, allow_dm: 1 }
                                    ep['short_link'] = `https://b23.tv/ep${ep.id}`
                                })
                            })
                        }
                        const ep = ep_id != '' ? result.result.episodes.find(ep => ep.ep_id === +ep_id) : result.result.episodes[0]
                        const eps = JSON.stringify(result.result.episodes.map((item, index) => {
                            // 返回的数据是有序的，不需要另外排序                                
                            if (/^\d+(\.\d+)?$/.exec(item.title)) {
                                item.titleFormat = "第" + item.title + "话 " + item.long_title
                            } else {
                                item.titleFormat = item.long_title
                            }
                            item.index_title = item.long_title
                            item.loaded = true
                            item.epStatus = item.status
                            item.sectionType = 0
                            item.id = +item.ep_id
                            item.i = index
                            item.link = 'https://www.bilibili.com/bangumi/play/ep' + item.ep_id
                            item.title = item.titleFormat
                            if (item.jump) item['skip'] = item.jump
                            return item
                        }))
                        let titleForma
                        if (ep?.index_title) {
                            titleForma = ep.index_title
                        } else {
                            titleForma = "第" + ep?.index + "话"
                        }
                        templateArgs = {
                            id: ep?.ep_id,
                            aid: ep?.aid,
                            cid: ep?.cid,
                            bvid: ep?.bvid,
                            title: ep?.index,
                            titleFormat: Strings.escapeSpecialChars(titleForma),
                            htmlTitle: result.result.title,
                            mediaInfoId: result.result.media_id,
                            mediaInfoTitle: result.result.title,
                            evaluate: Strings.escapeSpecialChars(result.result.evaluate),
                            cover: result.result.cover,
                            episodes: eps,
                            ssId: result.result.season_id,
                            appOnly: appOnly,
                        }
                    } catch (e) {
                        util_warn('通过bangumi接口获取ep信息失败', e)
                    }

                    if (balh_config.server_bilibili_api_proxy && !templateArgs) {
                        try {
                            const result = await bilibiliApi.getSeasonInfoByEpSsId(ep_id, season_id)
                            if (result.code) {
                                throw result
                            }
                            const ep = result.result.episodes.find(ep => ep.id === +ep_id)
                            if (!ep) {
                                throw `未找到${ep_id}对应的视频信息`
                            }
                            const eps = JSON.stringify(result.result.episodes.map((item, index) => {
                                item.loaded = true
                                item.epStatus = item.status
                                item.sectionType = 0
                                item.titleFormat = "第" + item.title + "话 " + item.long_title
                                item.i = index
                                return item
                            }))
                            templateArgs = {
                                id: ep.id,
                                aid: ep.aid,
                                cid: ep.cid,
                                bvid: ep.bvid,
                                title: ep.title,
                                titleFormat: ep.long_title,
                                htmlTitle: result.result.season_title,
                                mediaInfoId: result.result.media_id,
                                mediaInfoTitle: result.result.season_title,
                                evaluate: result.result.evaluate,
                                cover: result.result.cover,
                                episodes: eps,
                                ssId: result.result.season_id,
                                appOnly: appOnly,
                            }
                        } catch (e) {
                            // 很多balh_config.server_bilibili_api_proxy并不支持代理所有Api
                            // catch一下, 回退到用biliplus的api的读取ep的信息
                            util_warn('通过自定义代理服务器获取ep信息失败', e)
                        }
                    }
                    if (!templateArgs) {
                        if (!season_id) {
                            throw '无法获取season_id, 请先刷新动画对应的www.bilibili.com/bangumi/media/md页面'
                        }
                        const result = await BiliPlusApi.season(season_id)
                        if (result.code) {
                            throw result
                        }
                        const ep = result.result.episodes.find((ep) => ep.episode_id === ep_id)
                        if (!ep) {
                            throw '无法查询到ep信息, 请先刷新动画对应的www.bilibili.com/bangumi/media/md页面'
                        }
                        let pvCounter = 1
                        const ep_length = result.result.episodes.length
                        const eps = JSON.stringify(result.result.episodes.map((item) => {
                            if (/^\d+$/.exec(item.index)) {
                                item.titleFormat = "第" + item.index + "话 " + item.index_title
                                item.i = +item.index - 1
                            } else {
                                item.titleFormat = item.index
                                item.i = ep_length - pvCounter
                                pvCounter++
                                item.index_title = item.index
                            }
                            item.link = 'https://www.bilibili.com/bangumi/play/ep' + item.episode_id
                            item.bvid = Converters.aid2bv(+item.av_id)
                            item.badge = ''
                            item.badge_info = { "bg_color": "#FB7299", "bg_color_night": "#BB5B76", "text": "" }
                            item.badge_type = 0
                            item.title = item.index
                            item.id = +item.episode_id
                            item.cid = +item.danmaku
                            item.aid = +item.av_id
                            item.loaded = true
                            item.epStatus = item.episode_status
                            item.sectionType = item.episode_type
                            item.rights = { 'allow_demand': 0, 'allow_dm': 1, 'allow_download': 0, 'area_limit': 0 }
                            return item
                        }).sort((a, b) => {
                            return a.i - b.i  // BP接口返回的数据是无序的，需要排序
                        }))
                        templateArgs = {
                            id: ep.episode_id,
                            aid: ep.av_id,
                            cid: ep.danmaku,
                            bvid: Converters.aid2bv(+ep.av_id),
                            title: ep.index,
                            titleFormat: ep.index_title,
                            htmlTitle: result.result.title,
                            mediaInfoTitle: result.result.title,
                            mediaInfoId: result.result.media?.media_id ?? 28229002,
                            evaluate: result.result.evaluate,
                            cover: result.result.cover,
                            episodes: eps,
                            ssId: season_id,
                            appOnly: appOnly,
                        }
                    }
                    const pageTemplateString = Strings.replaceTemplate(pageTemplate, templateArgs)
                    const template = new DOMParser().parseFromString(pageTemplateString, 'text/html')
                    await cloneChildNodes(template.getElementsByTagName('head')[0], document.head)
                    await cloneChildNodes(template.getElementsByTagName('body')[0], document.body)
                    window.bangumi_area_limit_hack._setupSettings()
                } catch (e: any) {
                    util_warn('重建ep页面失败', e)
                    ui.alert(Objects.stringify(e as any))
                }
            }
        }
        if (util_page.new_bangumi()) {
            let $eplist_module = document.getElementById('eplist_module')
            if (!$eplist_module) {
                const $danmukuBox = document.getElementById('danmukuBox')
                if (!$danmukuBox) {
                    util_warn('danmukuBox not found!')
                    return
                }
                // 插入eplist_module的位置和内容一定要是这样... 不能改...
                // 写错了会导致Vue渲染出错, 比如视频播放窗口消失之类的(╯°口°)╯(┴—┴
                const $template = _('template', {}, `<div id="eplist_module" class="ep-list-wrapper report-wrap-module"><div class="list-title clearfix"><h4 title="正片">正片</h4> <span class="mode-change" style="position:relative"><i report-id="click_ep_switch" class="iconfont icon-ep-list-detail"></i> <!----></span> <!----> <span class="ep-list-progress">8/8</span></div> <div class="list-wrapper" style="display:none;"><ul class="clearfix" style="height:-6px;"></ul></div></div>`.trim())
                $danmukuBox.parentElement?.replaceChild($template.content.firstElementChild!, $danmukuBox.nextSibling!.nextSibling!)
            }
        }
    })
}

export function removeEpAreaLimit(ep: StringAnyObject) {
    if (!ep) return
    if (ep.epRights) {
        ep.epRights.area_limit = false
        ep.epRights.allow_dm = 1
    }
    if (ep.rights) {
        ep.rights.area_limit = 0
        ep.rights.allow_dm = 1
    }
    if (ep.badge === '受限' || ep.badge_info?.text === '受限') {
        ep.badge = ''
        ep.badge_info = { "bg_color": "#FB7299", "bg_color_night": "#BB5B76", "text": "" }
        ep.badge_type = 0
    }
}

function removeSeasonRightsAreaLimit(rights: StringAnyObject | undefined) {
    if (!rights) return
    rights.area_limit = 0
    rights.ban_area_show = 0
    rights.can_watch = 1
}

function removeSeasonAreaLimit(season: StringAnyObject | undefined) {
    if (!season) return
    removeSeasonRightsAreaLimit(season.rights)
    removeSeasonRightsAreaLimit(season.mediaInfo?.rights)
    removeSeasonRightsAreaLimit(season.seasonInfo?.mediaInfo?.rights)
    season.episodes?.forEach(removeEpAreaLimit)
    season.initEpList?.forEach(removeEpAreaLimit)
    season.mediaInfo?.episodes?.forEach(removeEpAreaLimit)
    season.seasonInfo?.mediaInfo?.episodes?.forEach(removeEpAreaLimit)
    season.sections?.forEach((section: StringAnyObject) => section?.episodes?.forEach(removeEpAreaLimit))
    season.section?.forEach((section: StringAnyObject) => section?.episodes?.forEach(removeEpAreaLimit))
    if (season.epMap) {
        Object.keys(season.epMap).forEach(epId => removeEpAreaLimit(season.epMap[epId]))
    }
}

export function area_limit_for_vue() {
    if (isClosed()) return

    if (!(
        (util_page.av() && balh_config.enable_in_av) || util_page.new_bangumi()
    )) {
        return
    }
    function forceBangumiEpisodeFullNavigation() {
        if (!(util_page.anime_ep() || util_page.anime_ss())) return
        const resolveEpisodeUrl = (url: string | URL | null | undefined) => {
            if (!url) return undefined
            try {
                const resolved = new URL(url, window.location.href)
                if (resolved.origin !== window.location.origin || !resolved.pathname.match(/^\/bangumi\/play\/ep\d+/)) return undefined
                if (resolved.pathname === window.location.pathname) return undefined
                return resolved
            } catch (_) {
                return undefined
            }
        }
        const forceNavigation = (url: URL, source: string, replace = false) => {
            log('force full navigation for bangumi episode', {
                source,
                from: window.location.href,
                to: url.href,
                replace,
            })
            if (replace) {
                window.location.replace(url.href)
            } else {
                window.location.assign(url.href)
            }
        }
        document.addEventListener('click', (event) => {
            if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
            const target = event.target as Element | null
            const anchor = target?.closest?.('a[href*="/bangumi/play/ep"]') as HTMLAnchorElement | null
            if (!anchor?.href || anchor.target) return
            const url = resolveEpisodeUrl(anchor.href)
            if (!url) return
            event.preventDefault()
            event.stopImmediatePropagation()
            forceNavigation(url, 'click')
        }, true)
        const wrapHistory = <T extends typeof history.pushState>(method: T, replace = false): T => {
            return function (this: History, data: any, unused: string, url?: string | URL | null) {
                const episodeUrl = resolveEpisodeUrl(url)
                if (episodeUrl) {
                    forceNavigation(episodeUrl, method.name, replace)
                    return
                }
                return method.apply(this, arguments as any)
            } as T
        }
        history.pushState = wrapHistory(history.pushState)
        history.replaceState = wrapHistory(history.replaceState as typeof history.pushState, true)
    }
    function replacePlayInfo() {
        const initialPlayInfo = window.__playinfo__
        log("window.__playinfo__", initialPlayInfo)
        window.__playinfo__origin = initialPlayInfo
        let playinfo: any = undefined
        let currentPlayInfoPromise: Promise<any> | undefined
        let currentPlayInfoEpId: string | undefined
        let currentPlayInfoRequestId = 0
        let playerStatusRequestId: number | undefined
        const proxyPlayInfoCachePrefix = 'balh_proxy_playinfo_v1:'
        const proxyPlayInfoReloadPrefix = 'balh_proxy_playinfo_reload_v1:'
        const proxyPlayInfoCacheTtl = 10 * 60 * 1000
        const proxyPlayUrlRequestTimeout = 8000
        const transientProxyRetryDelays = [500, 1200]
        const entitlementProxyRetryDelays = [700, 1600]
        const bangumiAreaCacheKey = 'balh_bangumi_area_cache'
        type ProxyArea = '' | 'cn' | 'th' | 'hk' | 'tw'
        type ProxyCandidate = { proxyHost: string, area: ProxyArea, label: string }
        function shouldReplaceHydrationPlayInfo(value: any) {
            return (util_page.anime_ep() || util_page.anime_ss())
                && value?.result?.supplement?.ogv_episode_info
                && value?.result?.supplement?.ogv_season_info
                && value?.result?.play_video_type === 'none'
        }
        function getPlayInfoEpId(value: any) {
            const epId = value?.result?.supplement?.ogv_episode_info?.episode_id
            return epId == null ? undefined : String(epId)
        }
        function getCurrentEpId() {
            return window.location.pathname.match(/\/bangumi\/play\/ep(\d+)/)?.[1]
        }
        function getPlayInfoCacheKey(value: any) {
            const epId = getPlayInfoEpId(value)
            const cid = value?.result?.arc?.cid
            if (!epId || !cid) return undefined
            return `${epId}:${cid}`
        }
        function getPlayInfoSeasonId(value: any) {
            const seasonId = value?.result?.supplement?.ogv_season_info?.season_id
                ?? value?.result?.season_id
                ?? util_page.ssId
            return seasonId == null ? undefined : String(seasonId)
        }
        function readBangumiAreaCache() {
            try {
                return JSON.parse(localStorage.getItem(bangumiAreaCacheKey) || '{}')
            } catch (error) {
                util_warn('bangumi area cache read failed', error)
                return {}
            }
        }
        function getCachedBangumiArea(value: any): ProxyArea | undefined {
            const seasonId = getPlayInfoSeasonId(value)
            if (!seasonId) return undefined
            const area = readBangumiAreaCache()[seasonId]
            return area === 'cn' || area === 'th' || area === 'hk' || area === 'tw' ? area : undefined
        }
        function storeBangumiArea(value: any, area: ProxyArea) {
            if (!area) return
            const seasonId = getPlayInfoSeasonId(value)
            if (!seasonId) return
            try {
                const cache = readBangumiAreaCache()
                cache[seasonId] = area
                localStorage.setItem(bangumiAreaCacheKey, JSON.stringify(cache))
            } catch (error) {
                util_warn('bangumi area cache write failed', error)
            }
        }
        function getProxyHostForArea(area: ProxyArea) {
            switch (area) {
                case 'cn':
                    return balh_config.server_custom_cn
                case 'th':
                    return balh_config.server_custom_th
                case 'hk':
                    return balh_config.server_custom_hk
                case 'tw':
                    return balh_config.server_custom_tw
                default:
                    return balh_config.server_custom
            }
        }
        function getProxyAreaLabel(area: ProxyArea) {
            switch (area) {
                case 'cn':
                    return '大陆'
                case 'th':
                    return '泰国'
                case 'hk':
                    return '香港'
                case 'tw':
                    return '台湾'
                default:
                    return '首选'
            }
        }
        function getBangumiAreaHintText(value?: any) {
            const initialState = (window as any).__INITIAL_STATE__ || {}
            const seasonInfo = value?.result?.supplement?.ogv_season_info || {}
            const episodeInfo = value?.result?.supplement?.ogv_episode_info || {}
            const fields = [
                document.title,
                seasonInfo.title,
                seasonInfo.season_title,
                seasonInfo.origin_name,
                seasonInfo.show_title,
                episodeInfo.title,
                episodeInfo.long_title,
                initialState.h1Title,
                initialState.mediaInfo?.title,
                initialState.mediaInfo?.originName,
                initialState.mediaInfo?.origin_name,
                initialState.mediaInfo?.seasonTitle,
                initialState.mediaInfo?.season_title,
                initialState.epInfo?.titleFormat,
                initialState.epInfo?.longTitle,
                initialState.epInfo?.long_title,
            ]
            return fields
                .filter((item): item is string | number => typeof item === 'string' || typeof item === 'number')
                .map(item => String(item))
                .join('\n')
        }
        function getHintedProxyArea(value?: any): ProxyArea | undefined {
            const hintText = getBangumiAreaHintText(value)
            if (/(僅|仅)限?港澳(臺|台)?/.test(hintText)) return 'hk'
            if (/(僅|仅)限?(臺|台)(灣|湾)/.test(hintText)) return 'tw'
            return undefined
        }
        function describeProxyError(error: any) {
            if (error instanceof Error) return error.message
            if (error?.message) return error.message
            if (error?.code != null) return `${error.code}${error.message ? ` ${error.message}` : ''}`
            if (error?.status != null) return `HTTP ${error.status}`
            return Objects.stringify(error)
        }
        function getProxyErrorPriority(error: any) {
            const message = describeProxyError(error)
            if (error?.code === -10403 || /(大会员|大會員|会员专享|會員專享|付费|付費|承包|权限|權限)/.test(message)) return 300
            if (error?.code === 403 || error?.code === -40301 || /(地区限制|地區限制|区域限制|區域限制)/.test(message)) return 200
            if (error instanceof Error) return 100
            if (error?.status != null) return 80
            if (error?.code != null) return 60
            return 0
        }
        function choosePreferredProxyError(current: any, next: any) {
            if (!current) return next
            return getProxyErrorPriority(next) > getProxyErrorPriority(current) ? next : current
        }
        function isEntitlementProxyError(error: any) {
            return getProxyErrorPriority(error) >= 300
        }
        function describeProxyErrorForUser(error: any) {
            if (isEntitlementProxyError(error)) {
                return '大会员专享限制：当前账号没有该集播放权限。脚本只解除地区限制，不能绕过大会员或付费限制。'
            }
            return describeProxyError(error)
        }
        function isCurrentPlayInfoRequest(epId: string | undefined, requestId: number) {
            const currentEpId = getCurrentEpId()
            return requestId === currentPlayInfoRequestId
                && (!epId || !currentEpId || epId === currentEpId)
        }
        function hidePlayerStatusForRequest(requestId: number, delay = 0) {
            if (playerStatusRequestId !== requestId) return
            playerStatusRequestId = undefined
            ui.hidePlayerStatus(delay)
        }
        function clearPlayerStatusForNewRequest() {
            if (playerStatusRequestId === undefined) return
            playerStatusRequestId = undefined
            ui.hidePlayerStatus(0)
        }
        function playerStatusForRequest(epId: string | undefined, requestId: number, message: string, options?: Parameters<typeof ui.playerStatus>[1]) {
            if (!isCurrentPlayInfoRequest(epId, requestId)) return
            playerStatusRequestId = requestId
            ui.playerStatus(message, options)
        }
        function isElementActive(element: Element | null) {
            if (!(element instanceof HTMLElement)) return false
            const style = window.getComputedStyle(element)
            const rect = element.getBoundingClientRect()
            const hiddenByPlayerStatus = ui.isPlayerStatusHiddenElement(element)
            return style.display !== 'none'
                && (hiddenByPlayerStatus || (style.visibility !== 'hidden' && style.visibility !== 'collapse'))
                && rect.width > 0
                && rect.height > 0
        }
        function hasActiveBlockingPanel() {
            return isElementActive(document.querySelector('#big-block-panel'))
                || Array.from(document.querySelectorAll('.bilibili-player-video-panel-text')).some(isElementActive)
        }
        function hasPlayerErrorText() {
            return document.body?.innerText?.includes('错误码：3001')
        }
        function hidePlayerStatusWhenVideoReady(epId: string | undefined, requestId: number) {
            let retries = 0
            const wait = () => {
                if (!isCurrentPlayInfoRequest(epId, requestId)) {
                    hidePlayerStatusForRequest(requestId)
                    return
                }
                const video = document.querySelector('video') as HTMLVideoElement | null
                const hasVideoSource = !!(video?.currentSrc || video?.src)
                const hasUsableVideo = hasVideoSource
                    && video.readyState >= HTMLMediaElement.HAVE_METADATA
                    && !hasActiveBlockingPanel()
                    && !hasPlayerErrorText()
                if (hasUsableVideo) {
                    hidePlayerStatusForRequest(requestId, 500)
                    return
                }
                if (retries++ < 60) {
                    setTimeout(wait, 500)
                } else {
                    hidePlayerStatusForRequest(requestId)
                }
            }
            setTimeout(wait, 500)
        }
        function getStoredProxyPlayInfo(value: any) {
            const key = getPlayInfoCacheKey(value)
            if (!key) return undefined
            try {
                const raw = sessionStorage.getItem(`${proxyPlayInfoCachePrefix}${key}`)
                if (!raw) return undefined
                const cached = JSON.parse(raw)
                if (!cached?.value || Date.now() - cached.savedAt > proxyPlayInfoCacheTtl) {
                    sessionStorage.removeItem(`${proxyPlayInfoCachePrefix}${key}`)
                    return undefined
                }
                log('proxy playinfo cache hit', {
                    epId: getPlayInfoEpId(cached.value),
                    videoCount: cached.value?.result?.video_info?.dash?.video?.length,
                })
                return cached.value
            } catch (error) {
                util_warn('proxy playinfo cache read failed', error)
                return undefined
            }
        }
        function storeProxyPlayInfo(value: any) {
            const key = getPlayInfoCacheKey(value)
            if (!key) return
            try {
                sessionStorage.setItem(`${proxyPlayInfoCachePrefix}${key}`, JSON.stringify({
                    savedAt: Date.now(),
                    value,
                }))
            } catch (error) {
                util_warn('proxy playinfo cache write failed', error)
            }
        }
        function reloadOnceAfterProxyReady(value: any, delay = 0) {
            const key = getPlayInfoCacheKey(value)
            if (!key) return
            const reloadKey = `${proxyPlayInfoReloadPrefix}${key}`
            if (sessionStorage.getItem(reloadKey)) return
            setTimeout(() => {
                const video = document.querySelector('video') as HTMLVideoElement | null
                const hasVideoSource = !!(video?.currentSrc || video?.src)
                const hasBlockingPanel = hasActiveBlockingPanel()
                const hasPlayerError = hasPlayerErrorText()
                if (hasVideoSource && !hasBlockingPanel && !hasPlayerError) return
                sessionStorage.setItem(reloadKey, '1')
                log('reload page to apply cached proxy playinfo', {
                    epId: getPlayInfoEpId(value),
                    hasBlockingPanel,
                    hasPlayerError,
                })
                window.location.replace(window.location.href)
            }, delay)
        }
        function reloadExistingPlayerWithProxyPlayInfo(value: any) {
            if (value?.result?.play_video_type !== 'dash') return false
            const key = getPlayInfoCacheKey(value)
            if (!key) return false
            const anyWindow = window as any
            if (anyWindow.__balh_proxy_player_reload_key__ === key) return false
            anyWindow.__balh_proxy_player_reload_key__ = key
            let retries = 0
            const tryReload = () => {
                const player = anyWindow.player
                if (!player?.updateRequestConfig || !player?.reload) {
                    if (retries++ < 40) setTimeout(tryReload, 250)
                    return
                }
                const video = document.querySelector('video') as HTMLVideoElement | null
                const hasVideoSource = !!(video?.currentSrc || video?.src)
                const hasBlockingPanel = hasActiveBlockingPanel()
                const hasPlayerError = hasPlayerErrorText()
                if (hasVideoSource && !hasBlockingPanel && !hasPlayerError) return
                log('reload existing player with proxy playinfo', {
                    epId: getPlayInfoEpId(value),
                    hasVideoSource,
                    hasBlockingPanel,
                    hasPlayerError,
                })
                try {
                    player.updateRequestConfig({
                        reqHttpPlayUrlInfo: () => NativePromise.resolve({ status: 200, data: value }),
                    })
                    const result = player.reload()
                    if (result?.catch) {
                        result.catch((error: any) => util_warn('reload existing player failed', error))
                    }
                } catch (error) {
                    util_warn('reload existing player failed', error)
                }
            }
            setTimeout(tryReload, 0)
            return true
        }
        function shouldApplyProxyPlayInfo(value: any, requestId?: number) {
            const currentEpId = getCurrentEpId()
            const playInfoEpId = getPlayInfoEpId(value)
            const requestIsStale = requestId !== undefined && requestId !== currentPlayInfoRequestId
            const episodeIsStale = !!currentEpId && !!playInfoEpId && currentEpId !== playInfoEpId
            if (!requestIsStale && !episodeIsStale) return true
            log('ignore stale proxy playinfo', {
                currentEpId,
                playInfoEpId,
                requestId,
                currentPlayInfoRequestId,
            })
            return false
        }
        function findEpisodeInSeason(season: any, epId: string): any {
            if (!season) return undefined
            const isTargetEpisode = (ep: any) => {
                const id = ep?.ep_id ?? ep?.episode_id ?? ep?.id
                return id != null && String(id) === epId && ep?.cid
            }
            const findInList = (list: any[] | undefined) => Array.isArray(list) ? list.find(isTargetEpisode) : undefined
            return (season.epMap && isTargetEpisode(season.epMap[epId]) && season.epMap[epId])
                || findInList(season.episodes)
                || findInList(season.initEpList)
                || findInList(season.mediaInfo?.episodes)
                || findInList(season.seasonInfo?.mediaInfo?.episodes)
                || season.sections?.map((section: any) => findInList(section?.episodes)).find(Boolean)
                || season.section?.map((section: any) => findInList(section?.episodes)).find(Boolean)
        }
        function findCurrentEpisode() {
            const epId = getCurrentEpId()
            if (!epId) return undefined
            const nextQueries = (window as any).__NEXT_DATA__?.props?.pageProps?.dehydratedState?.queries
            if (Array.isArray(nextQueries)) {
                for (const query of nextQueries) {
                    const episode = findEpisodeInSeason(query?.state?.data, epId)
                    if (episode) return episode
                }
            }
            return findEpisodeInSeason((window as any).__INITIAL_STATE__, epId)
        }
        function buildPlayInfoFromEpisode(episode: any) {
            const epId = episode?.ep_id ?? episode?.episode_id ?? episode?.id
            if (!episode?.cid || !epId) return undefined
            const seasonId = episode?.season_id ?? episode?.seasonId ?? episode?.ss_id ?? util_page.ssId
            return {
                result: {
                    play_video_type: 'none',
                    arc: {
                        aid: episode.aid,
                        cid: episode.cid,
                    },
                    supplement: {
                        ogv_episode_info: {
                            episode_id: epId,
                        },
                        ogv_season_info: {
                            season_id: seasonId,
                        },
                    },
                    plugins: [],
                },
            }
        }
        function removePlayInfoAreaLimit(value: any) {
            const plugins = value?.result?.plugins
            if (!Array.isArray(plugins)) return
            for (const plugin of plugins) {
                if (plugin?.name === 'AreaLimitPanel') {
                    plugin.config = { ...plugin.config, is_block: false }
                }
            }
        }
        function normalizeProxyPlayUrl(playUrl: any) {
            if (!playUrl) return playUrl
            if (playUrl.dash) {
                Objects.convertKeyToSnakeCase(playUrl.dash)
            }
            let normalized = playUrl
            if (!window.__balh_app_only__ && balh_config.upos_server) {
                normalized = Converters.replaceUpos(normalized, uposMap[balh_config.upos_server], balh_config.upos_replace_akamai ?? FALSE)
            }
            preferNonAkamaiDashUrls(normalized?.dash)
            return normalized
        }
        function preferNonAkamaiDashUrls(dash: any) {
            if (!dash) return
            const streams = [
                ...(Array.isArray(dash.video) ? dash.video : []),
                ...(Array.isArray(dash.audio) ? dash.audio : []),
                ...(Array.isArray(dash.dolby?.audio) ? dash.dolby.audio : []),
            ]
            if (dash.flac?.audio) streams.push(dash.flac.audio)
            for (const stream of streams) {
                preferNonAkamaiStreamUrls(stream)
            }
        }
        function preferNonAkamaiStreamUrls(stream: any) {
            if (!stream || typeof stream !== 'object') return
            const baseUrl = stream.base_url ?? stream.baseUrl
            const backupUrls = [
                ...(Array.isArray(stream.backup_url) ? stream.backup_url : []),
                ...(Array.isArray(stream.backupUrl) ? stream.backupUrl : []),
            ]
            const urls = uniqueStrings([baseUrl, ...backupUrls])
            if (urls.length < 2) return
            const nonAkamaiUrls = urls.filter(url => !isAkamaiUrl(url))
            if (!nonAkamaiUrls.length) return
            const reorderedUrls = [...nonAkamaiUrls, ...urls.filter(isAkamaiUrl)]
            const [nextBaseUrl, ...nextBackupUrls] = reorderedUrls
            stream.base_url = nextBaseUrl
            stream.baseUrl = nextBaseUrl
            stream.backup_url = nextBackupUrls
            stream.backupUrl = nextBackupUrls
        }
        function uniqueStrings(items: any[]) {
            const seen = new Set<string>()
            return items.filter((item): item is string => {
                if (typeof item !== 'string' || !item) return false
                if (seen.has(item)) return false
                seen.add(item)
                return true
            })
        }
        function isAkamaiUrl(url: string) {
            return /(^|\/\/)[^/]*akamaized\.net\//.test(url)
        }
        function isTransientProxyError(error: any) {
            const message = describeProxyError(error)
            return error instanceof Error
                || error?.status === 0
                || error?.status >= 500
                || error?.code >= 500
                || error?.code === -500
                || error?.code === -502
                || error?.code === -412
                || /(timeout|解析服务器错误|解析伺服器錯誤|server error|network|failed to fetch)/i.test(message)
        }
        function getProxyRetryDelay(error: any, retryIndex: number) {
            const delays = isEntitlementProxyError(error) && hasAccessKey()
                ? entitlementProxyRetryDelays
                : isTransientProxyError(error)
                ? transientProxyRetryDelays
                : []
            return delays[retryIndex]
        }
        function hasAccessKey() {
            try {
                return !!localStorage.access_key
            } catch (_) {
                return false
            }
        }
        function requestProxyJson(url: string): Promise<any> {
            return NativePromise.race([
                Async.ajaxByXhr<any>(url),
                Async.timeout(proxyPlayUrlRequestTimeout).then(() => NativePromise.reject(new Error('proxy playurl timeout'))),
            ])
        }
        function requestProxyCandidateWithRetry<T>(
            candidate: ProxyCandidate,
            epId: string,
            requestId: number,
            request: () => Promise<T>,
            retryIndex = 0,
            preferredError?: any,
        ): Promise<T> {
            return request().catch(error => {
                const nextPreferredError = choosePreferredProxyError(preferredError, error)
                const delay = getProxyRetryDelay(error, retryIndex)
                if (delay === undefined) return NativePromise.reject(nextPreferredError)
                playerStatusForRequest(epId, requestId, `正在重试${candidate.label}解析服务器`, {
                    detail: `${describeProxyError(error)}，${delay}ms 后重试`,
                })
                util_warn('replace playinfo by proxy candidate retry', describeProxyCandidate(candidate), {
                    attempt: retryIndex + 1,
                    delay,
                    error: describeProxyError(error),
                })
                return Async.timeout(delay).then(() => requestProxyCandidateWithRetry(candidate, epId, requestId, request, retryIndex + 1, nextPreferredError))
            })
        }
        function redactProxyHost(proxyHost: string) {
            try {
                const url = new URL(proxyHost)
                url.username = ''
                url.password = ''
                return url.href.replace(/\/$/, '')
            } catch (_) {
                return proxyHost.replace(/\/\/[^/@]+@/, '//<redacted>@')
            }
        }
        function describeProxyCandidate(candidate: { proxyHost: string, area: string }) {
            return {
                proxyHost: redactProxyHost(candidate.proxyHost),
                area: candidate.area,
            }
        }
        function fetchPlayInfoByProxy(value: any, requestId: number) {
            const arc = value?.result?.arc
            const episode = value?.result?.supplement?.ogv_episode_info
            if (!arc?.cid || !episode?.episode_id) return undefined
            const epId = String(episode.episode_id)
            const startedAt = Date.now()
            log('replace playinfo by proxy start', {
                epId,
                aid: arc.aid,
                cid: arc.cid,
                currentEpId: getCurrentEpId(),
                requestId,
            })
            const candidates: ProxyCandidate[] = []
            const addCandidate = (proxyHost: string | undefined, area: ProxyArea, label = getProxyAreaLabel(area)) => {
                if (!proxyHost) return
                proxyHost = proxyHost.replace(/\/$/, '')
                if (candidates.some(it => it.proxyHost === proxyHost && it.area === area)) return
                candidates.push({ proxyHost, area, label })
            }
            const hintedArea = getHintedProxyArea(value)
            if (hintedArea) {
                addCandidate(getProxyHostForArea(hintedArea), hintedArea, `页面提示${getProxyAreaLabel(hintedArea)}`)
            }
            const cachedArea = getCachedBangumiArea(value)
            if (cachedArea) {
                addCandidate(getProxyHostForArea(cachedArea), cachedArea, `缓存${getProxyAreaLabel(cachedArea)}`)
            }
            addCandidate(balh_config.server_custom, '')
            addCandidate(balh_config.server_custom_cn, 'cn')
            addCandidate(balh_config.server_custom_th, 'th')
            addCandidate(balh_config.server_custom_hk, 'hk')
            addCandidate(balh_config.server_custom_tw, 'tw')
            if (!candidates.length) return undefined
            playerStatusForRequest(epId, requestId, '解除B站区域限制正在运行', {
                detail: '检测到受限番剧，正在解析播放地址',
            })
            const params = new URLSearchParams({
                avid: String(arc.aid || ''),
                cid: String(arc.cid),
                qn: '64',
                type: '',
                otype: 'json',
                ep_id: String(episode.episode_id),
                fourk: '1',
                fnver: '0',
                fnval: '4048',
                session: '',
                module: 'bangumi',
            })
            let lastCandidateError: any
            const requestCandidate = (index: number): Promise<any> => {
                const candidate = candidates[index]
                if (!candidate) return NativePromise.reject(lastCandidateError || new Error('proxy playurl failed'))
                const candidateParams = new URLSearchParams(params)
                if (candidate.area) candidateParams.set('area', candidate.area)
                const query = `${candidateParams}${access_key_param_if_exist(true)}`
                const originUrl = `//api.bilibili.com/pgc/player/web/playurl?${candidateParams}`
                const isBilibiliApiProxy = r.regex.bilibili_api_proxy.test(candidate.proxyHost)
                const shouldUseMobiPlayUrl = candidate.area === 'th' || window.__balh_app_only__ === true
                if (shouldUseMobiPlayUrl && !localStorage.access_key) {
                    util_warn('skip mobi proxy candidate without access_key', describeProxyCandidate(candidate))
                    return requestCandidate(index + 1)
                }
                playerStatusForRequest(epId, requestId, `正在尝试${candidate.label}解析服务器`, {
                    detail: `${index + 1}/${candidates.length} ${redactProxyHost(candidate.proxyHost)}`,
                })
                const url = (() => {
                    if (shouldUseMobiPlayUrl) {
                        return isBilibiliApiProxy
                            ? getMobiPlayUrl(originUrl, candidate.proxyHost, candidate.area)
                            : `${candidate.proxyHost}?${generateMobiPlayUrlParams(originUrl, candidate.area)}`
                    }
                    return isBilibiliApiProxy
                        ? `${candidate.proxyHost}/pgc/player/web/playurl?${query}`
                        : `${candidate.proxyHost}?${query}`
                })()
                return requestProxyCandidateWithRetry(candidate, epId, requestId, () => requestProxyJson(url)
                    .then(json => {
                        const playUrl = shouldUseMobiPlayUrl && json?.data?.video_info
                            ? fixThailandPlayUrlJson(json)
                            : window.__balh_app_only__ === true && json?.type === 'DASH'
                            ? fixMobiPlayUrlJson(json)
                            : NativePromise.resolve(json?.result?.video_info ?? json?.data?.video_info ?? json?.result ?? json?.data)
                        return playUrl.then(playUrl => ({ json, playUrl }))
                    }).then(({ json, playUrl }) => {
                        const normalizedPlayUrl = normalizeProxyPlayUrl(playUrl)
                        if ((json?.code === 0 || normalizedPlayUrl?.code === 0 || (shouldUseMobiPlayUrl && normalizedPlayUrl?.dash)) && normalizedPlayUrl?.dash) {
                            log('replace playinfo by proxy success', {
                                epId,
                                proxyHost: redactProxyHost(candidate.proxyHost),
                                area: candidate.area,
                                videoCount: normalizedPlayUrl.dash?.video?.length,
                                audioCount: normalizedPlayUrl.dash?.audio?.length,
                            })
                            value.result.play_video_type = 'dash'
                            delete value.result.play_check
                            value.result.video_info = normalizedPlayUrl
                            value.video_info = normalizedPlayUrl
                            removePlayInfoAreaLimit(value)
                            storeBangumiArea(value, candidate.area)
                            playerStatusForRequest(epId, requestId, '解析成功，正在启动播放器', {
                                detail: `${candidate.label}服务器，用时${Date.now() - startedAt}ms`,
                                state: 'success',
                            })
                            hidePlayerStatusWhenVideoReady(getPlayInfoEpId(value), requestId)
                            return value
                        }
                        return NativePromise.reject(json)
                    }))
                    .catch(error => {
                    lastCandidateError = choosePreferredProxyError(lastCandidateError, error)
                    playerStatusForRequest(epId, requestId, `正在尝试下一个解析服务器`, {
                        detail: `${candidate.label}失败：${describeProxyError(error)}`,
                    })
                    util_warn('replace playinfo by proxy candidate failed', describeProxyCandidate(candidate), error)
                    return requestCandidate(index + 1)
                })
            }
            return requestCandidate(0).catch(error => {
                if (!isCurrentPlayInfoRequest(epId, requestId)) {
                    hidePlayerStatusForRequest(requestId)
                    return NativePromise.reject(error)
                }
                playerStatusForRequest(epId, requestId, isEntitlementProxyError(error) ? '当前账号无该集播放权限' : '解析播放地址失败', {
                    detail: describeProxyErrorForUser(error),
                    state: 'error',
                })
                return NativePromise.reject(error)
            })
        }
        function beginCurrentPlayInfoRequest(epId: string | undefined) {
            clearPlayerStatusForNewRequest()
            currentPlayInfoPromise = undefined
            currentPlayInfoEpId = epId
            currentPlayInfoRequestId += 1
            return currentPlayInfoRequestId
        }
        function setCurrentPlayInfoPromise(playInfoPromise: Promise<any>, epId: string | undefined, requestId?: number) {
            if (requestId !== undefined && requestId !== currentPlayInfoRequestId) {
                log('ignore stale current playinfo promise', {
                    epId,
                    requestId,
                    currentPlayInfoRequestId,
                })
                return requestId
            }
            currentPlayInfoPromise = playInfoPromise
            currentPlayInfoEpId = epId
            if (requestId === undefined) {
                clearPlayerStatusForNewRequest()
                currentPlayInfoRequestId += 1
                requestId = currentPlayInfoRequestId
            }
            return requestId
        }
        function deferNanoCreatePlayer(playInfoPromise: Promise<any>, value: any, requestId?: number) {
            setCurrentPlayInfoPromise(playInfoPromise, getPlayInfoEpId(value), requestId)
            const installCreatePlayerWrapper = (nano: any): boolean => {
                if (!nano) return false
                if (nano.__balh_create_player_deferred__) return true
                if (!nano.createPlayer) {
                    if (nano.__balh_waiting_create_player__) return true
                    nano.__balh_waiting_create_player__ = true
                    let createPlayerValue = nano.createPlayer
                    Object.defineProperty(nano, 'createPlayer', {
                        configurable: true,
                        enumerable: true,
                        get: () => createPlayerValue,
                        set: (value) => {
                            createPlayerValue = value
                            installCreatePlayerWrapper(nano)
                        },
                    })
                    return true
                }
                nano.__balh_create_player_deferred__ = true
                const createPlayer = nano.createPlayer
                nano.createPlayer = function (config: any) {
                    log('nano.createPlayer', {
                        currentEpId: getCurrentEpId(),
                        prefetchType: config?.prefetch?.playUrl?.result?.play_video_type,
                        prefetchEpId: getPlayInfoEpId(config?.prefetch?.playUrl),
                        currentPlayInfoEpId,
                    })
                    if (config?.prefetch?.playUrl?.result?.play_video_type !== 'none') {
                        return createPlayer.apply(this, arguments as any)
                    }
                    config.prefetch.playUrl = undefined
                    config.requestConfig = {
                        ...config.requestConfig,
                        reqHttpPlayUrlInfo: () => {
                            log('reqHttpPlayUrlInfo before sync', {
                                currentEpId: getCurrentEpId(),
                                currentPlayInfoEpId,
                                hasCurrentPlayInfoPromise: !!currentPlayInfoPromise,
                            })
                            syncCurrentPlayInfoWithLocation()
                            const currentEpId = getCurrentEpId()
                            log('reqHttpPlayUrlInfo after sync', {
                                currentEpId,
                                currentPlayInfoEpId,
                                hasCurrentPlayInfoPromise: !!currentPlayInfoPromise,
                            })
                            if (currentEpId && currentPlayInfoEpId !== currentEpId) {
                                return NativePromise.reject(new Error('proxy playurl missing for current episode'))
                            }
                            const pendingPlayInfo = currentPlayInfoPromise
                            const pendingRequestId = currentPlayInfoRequestId
                            if (!pendingPlayInfo) {
                                return NativePromise.reject(new Error('proxy playurl missing'))
                            }
                            return pendingPlayInfo.then(value => {
                                if (pendingRequestId !== currentPlayInfoRequestId) {
                                    return NativePromise.reject(new Error('stale proxy playurl'))
                                }
                                cachePlayInfo(value, false)
                                ;(window as any).__PLAYURL_HYDRATE_DATA__ = value
                                return { status: 200, data: value }
                            })
                            .catch(error => {
                                util_warn('replace playinfo by proxy failed', error)
                                return NativePromise.reject(error)
                            })
                        },
                    }
                    return createPlayer.apply(this, arguments as any)
                }
                return true
            }
            const currentNano = (window as any).nano
            if (installCreatePlayerWrapper(currentNano)) return
            const anyWindow = window as any
            if (anyWindow.__balh_waiting_nano__) return
            anyWindow.__balh_waiting_nano__ = true
            let nanoValue = currentNano
            Object.defineProperty(window, 'nano', {
                configurable: true,
                enumerable: true,
                get: () => nanoValue,
                set: (value) => {
                    nanoValue = value
                    installCreatePlayerWrapper(value)
                },
            })
            if (nanoValue) {
                anyWindow.nano = nanoValue
            }
        }
        function replaceHydrationPlayInfo(value: any): boolean {
            if (!shouldReplaceHydrationPlayInfo(value)) return false
            if (!value?.result?.arc?.cid || !value?.result?.supplement?.ogv_episode_info?.episode_id) return false
            const cachedPlayInfo = getStoredProxyPlayInfo(value)
            if (cachedPlayInfo) {
                if (!shouldApplyProxyPlayInfo(cachedPlayInfo)) return true
                const requestId = beginCurrentPlayInfoRequest(getPlayInfoEpId(cachedPlayInfo))
                playerStatusForRequest(getPlayInfoEpId(cachedPlayInfo), requestId, '读取缓存播放地址，正在启动播放器', {
                    detail: `ep${getPlayInfoEpId(cachedPlayInfo)}`,
                    state: 'success',
                })
                cachePlayInfo(cachedPlayInfo, false)
                ;(window as any).__PLAYURL_HYDRATE_DATA__ = cachedPlayInfo
                deferNanoCreatePlayer(NativePromise.resolve(cachedPlayInfo), cachedPlayInfo, requestId)
                const playerReloadScheduled = reloadExistingPlayerWithProxyPlayInfo(cachedPlayInfo)
                reloadOnceAfterProxyReady(cachedPlayInfo, playerReloadScheduled ? 3000 : 0)
                hidePlayerStatusWhenVideoReady(getPlayInfoEpId(cachedPlayInfo), requestId)
                return true
            }
            const requestId = beginCurrentPlayInfoRequest(getPlayInfoEpId(value))
            const playInfoPromise = fetchPlayInfoByProxy(value, requestId)
            if (!playInfoPromise) return false
            log('replace hydration playinfo', {
                epId: getPlayInfoEpId(value),
                currentEpId: getCurrentEpId(),
            })
            cachePlayInfo(value, false)
            deferNanoCreatePlayer(playInfoPromise, value, requestId)
            const pendingRequestId = requestId
            playInfoPromise.then(value => {
                if (!shouldApplyProxyPlayInfo(value, pendingRequestId)) return
                cachePlayInfo(value, false)
                ;(window as any).__PLAYURL_HYDRATE_DATA__ = value
                storeProxyPlayInfo(value)
                const playerReloadScheduled = reloadExistingPlayerWithProxyPlayInfo(value)
                reloadOnceAfterProxyReady(value, playerReloadScheduled ? 3000 : 0)
            }).catch(error => util_warn('replace hydration playinfo failed', error))
            return true
        }
        function syncCurrentPlayInfoWithLocation() {
            const currentEpId = getCurrentEpId()
            if (!currentEpId || currentPlayInfoEpId === currentEpId) return
            log('sync current playinfo with location', {
                currentEpId,
                currentPlayInfoEpId,
            })
            const episode = findCurrentEpisode()
            const value = buildPlayInfoFromEpisode(episode)
            if (value) {
                replaceHydrationPlayInfo(value)
            } else {
                util_warn('current episode data not found for playinfo sync', {
                    currentEpId,
                    hasNextData: !!(window as any).__NEXT_DATA__,
                    hasInitialState: !!(window as any).__INITIAL_STATE__,
                })
            }
        }
        function cachePlayInfo(value: any, updateCurrentPromise = true) {
            playinfo = value
            if (value && updateCurrentPromise) {
                setCurrentPlayInfoPromise(NativePromise.resolve(value), getPlayInfoEpId(value))
            }
        }
        replaceHydrationPlayInfo(initialPlayInfo)
        // 将__playinfo__置空, 让播放器去重新加载它...
        Object.defineProperty(window, '__playinfo__', {
            configurable: true,
            enumerable: true,
            get: () => {
                log('__playinfo__', 'get')
                return playinfo
            },
            set: (value) => {
                // debugger
                log('__playinfo__', 'set')
                // 原始的playinfo为空, 且页面在loading状态, 说明这是html中对playinfo进行的赋值, 这个值可能是有区域限制的, 不能要
                if (!window.__playinfo__origin && window.document.readyState === 'loading') {
                    log('__playinfo__', 'init in html', value)
                    window.__playinfo__origin = value
                    if (replaceHydrationPlayInfo(value)) {
                        return
                    }
                    return
                }
                if (replaceHydrationPlayInfo(value)) {
                    return
                }
                cachePlayInfo(value)
            },
        })
    }
    forceBangumiEpisodeFullNavigation()

    function processUserStatus(value: StringAnyObject | undefined) {
        if (value) {
            // 区域限制
            // todo      : 调用areaLimit(limit), 保存区域限制状态
            // 2019-08-17: 之前的接口还有用, 这里先不保存~~
            value.area_limit = 0
            // 会员状态
            if (balh_config.blocked_vip && value.vip_info) {
                value.vip_info.status = 1
                value.vip_info.type = 2
            }
        }
    }

    function replaceUserState() {
        Windows.proxyGlobalField('__PGC_USERSTATE__', {
            onWrite: (value) => {
                processUserStatus(value)
                return value
            }
        })
    }

    /** 拦截处理新页面的初始数据 */
    function replaceNextData() {
        Windows.proxyGlobalField('__NEXT_DATA__', {
            onWrite: (value) => {
                // 结构变了很多，新版是SSR可能一开始会取不到或者是个dom，无论如何先try一下
                try {
                    // 一开始是个dom，放里面一起try了
                    if (value instanceof Element) {
                        value = JSON.parse(value.innerHTML)
                    }
                    const queries = value.props.pageProps.dehydratedState.queries
                    if (!queries) return value
                    for (const query of queries) {
                        const data = query.state.data
                        switch (query.queryKey?.[0]) {
                            case 'pgc/view/web/season':
                                if (data.epMap) {
                                    // 最重要的一项数据, 直接决定页面是否可播放
                                    removeSeasonAreaLimit(data)
                                    // 其他字段对结果似乎没有影响, 故注释掉(
                                    // data.mediaInfo.hasPlayableEp = true
                                    // data.initEpList.forEach(removeEpAreaLimit)
                                    // data.rights.area_limit = false
                                    // data.rights.allow_dm = 1
                                } else if (data.seasonInfo?.mediaInfo?.episodes?.length > 0) {
                                    removeSeasonAreaLimit(data)
                                } else if (data.seasonInfo && !data.seasonInfo.mediaInfo?.rights?.can_watch) {
                                    // 新版没有Playable的是预告 PV，不能直接跳过，can_watch=false 才替换
                                    return;
                                }
                                break;
                            case 'pgc/view/web/simple/season':
                                removeSeasonAreaLimit(data)
                                break;
                            case 'pgc/view/web/ep/list':
                                data.episodes?.forEach(removeEpAreaLimit)
                                data.sections?.forEach((section: StringAnyObject) => section?.episodes?.forEach(removeEpAreaLimit))
                                break;
                            case 'season/user/status':
                                processUserStatus(data)
                                break;
                        }
                    }
                    return value
                } catch {
                    return
                }
            },
            onRead: (value) => {
                // debugger
                return value
            }
        })
    }

    /** 拦截处理老页面的数据 */
    function replaceInitialState() {
        Windows.proxyGlobalField('__INITIAL_STATE__', {
            onWrite: (value) => {
                if (value?.epInfo?.id === -1 && value?.epList?.length === 0 && value?.mediaInfo?.rights?.limitNotFound === true) {
                    invalidInitialState = value
                    return undefined
                }
                if (value && value.epInfo && value.epList && balh_config.blocked_vip) {
                    for (let ep of [value.epInfo, ...value.epList]) {
                        // 13貌似表示会员视频, 2为普通视频
                        if (ep.epStatus === 13) {
                            log('epStatus 13 => 2', ep)
                            ep.epStatus = 2
                        }
                    }
                }
                if (value?.mediaInfo?.rights?.appOnly === true) {
                    value.mediaInfo.rights.appOnly = false
                    window.__balh_app_only__ = true
                }
                ifNotNull(value?.epInfo?.rights, (it) => it.area_limit = 0)
                value?.epList?.forEach((it: any) => ifNotNull(it?.rights, (it) => it.area_limit = 0))
                return value
            }
        })
    }
    replaceNextData()

    replaceInitialState()
    replaceUserState()
    replacePlayInfo()
    fixBangumiPlayPage()

    Windows.proxyGlobalField('BilibiliPlayer', {
        onWrite: (value) => {
            return value
        },
        onRead: (value) => {

        }
    })
}
