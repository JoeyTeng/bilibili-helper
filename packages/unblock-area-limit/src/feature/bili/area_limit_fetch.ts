import { access_key_param_if_exist } from "../../api/bilibili-utils"
import { BiliPlusApi, fixMobiPlayUrlJson, fixThailandPlayUrlJson, generateMobiPlayUrlParams, getMobiPlayUrl } from "../../api/biliplus"
import { Async, Promise as NativePromise } from "../../util/async"
import { Converters, uposMap } from "../../util/converters"
import { log, util_debug, util_warn } from "../../util/log"
import { Objects } from "../../util/objects"
import { RegExps } from "../../util/regexps"
import { Strings } from "../../util/strings"
import { balh_config } from "../config"
import { FALSE, r } from "../r"
import { isSubtitleBodyUrl, rewriteSubtitleBodyJson, rewriteSubtitleMetadataUrl, rewriteSubtitleWebViewResponse } from "./subtitle_web_view"
import space_account_info_map from "./space_account_info_map"

type ProxyArea = '' | 'cn' | 'th' | 'hk' | 'tw'
type ProxyCandidate = { proxyHost: string, area: ProxyArea, label: string }
const proxyPlayUrlRequestTimeout = 8000
const transientProxyRetryDelays = [500, 1200]
const entitlementProxyRetryDelays = [700, 1600]

export function injectFetch() {
    const originFetch = window.fetch;
    window.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        const request = rewriteSubtitleMetadataFetchInput(input, init)
        const originResponse = await originFetch(request.input, request.init)
        const url = request.url
        if (url) {
            if (isPgcPlayUrlUrl(url)) {
                return handlePgcPlayUrlFetch(url, originResponse)
            }
            if (url.match(RegExps.url('api.bilibili.com/x/space/wbi/acc/info?'))) {
                const json = await originResponse.json()
                if (json.code === -404) {
                    const mid = new URL(url, document.location.href).searchParams.get('mid')
                    if (mid && space_account_info_map[mid || '']) {
                        return jsonResponse(space_account_info_map[mid], originResponse)
                    }
                }
                return jsonResponse(json, originResponse)
            }
            if (url.match(RegExps.url('api.bilibili.com/x/v2/subtitle/web/view'))) {
                if (!balh_config.generate_sub) return originResponse
                try {
                    const buffer = await originResponse.clone().arrayBuffer()
                    const response = rewriteSubtitleWebViewResponse(buffer, { generateSub: true })
                    if (response) {
                        log('/x/v2/subtitle/web/view', 'generated subtitle by fetch')
                        return new Response(response, responseInit(originResponse))
                    }
                } catch (error) {
                    log('/x/v2/subtitle/web/view fetch rewrite failed', error)
                }
                return originResponse
            }
            if (isSubtitleBodyUrl(url) && new URL(url, document.location.href).searchParams.get('translate') === '1') {
                try {
                    const text = await originResponse.clone().text()
                    const json = JSON.parse(text)
                    const response = rewriteSubtitleBodyJson(json, url)
                    if (response) {
                        log('/subtitle', 'fetch', url)
                        return jsonResponse(response, originResponse)
                    }
                } catch (error) {
                    log('/subtitle fetch rewrite failed', error)
                }
                return originResponse
            }
        }
        return originResponse
    }
}

function rewriteSubtitleMetadataFetchInput(input: RequestInfo | URL, init?: RequestInit) {
    const url = getFetchUrl(input)
    if (!url) return { input, init, url }

    const rewrittenUrl = rewriteSubtitleMetadataUrl(url, getCurrentSubtitleMetadataIds())
    if (!rewrittenUrl) return { input, init, url }

    log('subtitle metadata request fixed', {
        path: new URL(rewrittenUrl).pathname,
        from: redactSubtitleMetadataUrl(url),
        to: redactSubtitleMetadataUrl(rewrittenUrl),
    })
    if (typeof input === 'string') return { input: rewrittenUrl, init, url: rewrittenUrl }
    if (input instanceof URL) return { input: new URL(rewrittenUrl), init, url: rewrittenUrl }
    if (input instanceof Request) return { input: new Request(rewrittenUrl, input), init, url: rewrittenUrl }
    return { input, init, url }
}

function getCurrentSubtitleMetadataIds() {
    const anyWindow = window as any
    const playInfo = anyWindow.__PLAYURL_HYDRATE_DATA__ || anyWindow.__playinfo__
    const result = playInfo?.result || {}
    const videoInfo = result.video_info || {}
    const arc = result.arc || {}
    const episode = result.supplement?.ogv_episode_info || {}
    const initialState = anyWindow.__INITIAL_STATE__ || {}
    const initialEp = initialState.epInfo || {}
    const video = document.querySelector('video')
    return {
        aid: firstValidParam(arc.aid, episode.aid, initialEp.aid, initialState.aid),
        cid: firstValidParam(arc.cid, episode.cid, initialEp.cid, initialState.cid),
        durationMs: firstDurationMs(
            milliseconds(videoInfo.timelength),
            milliseconds(result.timelength),
            milliseconds(episode.duration),
            milliseconds(initialEp.duration),
            secondsToMilliseconds(arc.duration),
            secondsToMilliseconds(video?.duration),
        ),
    }
}

function firstValidParam(...values: any[]) {
    return values.find(isValidMetadataParam)
}

function isValidMetadataParam(value: any) {
    if (value == null) return false
    const text = String(value)
    return text !== '' && text !== '0' && text !== 'null' && text !== 'undefined' && text !== 'NaN'
}

function firstDurationMs(...values: Array<number | undefined>) {
    return values.find((value) => value && value > 0)
}

function milliseconds(value: any) {
    const duration = Number(value)
    if (!Number.isFinite(duration) || duration <= 0) return undefined
    return Math.round(duration)
}

function secondsToMilliseconds(value: any) {
    const duration = Number(value)
    if (!Number.isFinite(duration) || duration <= 0) return undefined
    return Math.round(duration * 1000)
}

function redactSubtitleMetadataUrl(url: string) {
    const parsedUrl = new URL(url, document.location.href)
    return `${parsedUrl.origin}${parsedUrl.pathname}?${parsedUrl.searchParams}`
}

function isPgcPlayUrlUrl(url: string) {
    return (url.match(RegExps.url('api.bilibili.com/pgc/player/web/playurl'))
        || url.match(RegExps.url('api.bilibili.com/pgc/player/web/v2/playurl')))
        && !new URL(url, document.location.href).searchParams.get('balh_ajax')
}

async function handlePgcPlayUrlFetch(url: string, originResponse: Response): Promise<Response> {
    let originJson: any
    try {
        originJson = await originResponse.clone().json()
    } catch (error) {
        util_warn('fetch pgc playurl parse failed', error)
        return originResponse
    }
    const reqUrl = new URL(url, document.location.href)
    const isV1 = reqUrl.pathname === '/pgc/player/web/playurl'
    const originPlayUrl = getPlayUrlPayload(originJson, isV1)
    if (!balh_config.blocked_vip && !originJson?.code && !isAreaLimitForPlayUrl(originPlayUrl)) {
        return originResponse
    }
    try {
        const proxiedPlayUrl = await fetchPgcPlayUrlByProxy(reqUrl)
        const result = isV1
            ? { code: 0, result: proxiedPlayUrl, message: '0' }
            : { code: 0, message: 'success', result: { video_info: proxiedPlayUrl } }
        log('fetch pgc playurl replaced by proxy', {
            path: reqUrl.pathname,
            videoCount: proxiedPlayUrl?.dash?.video?.length,
            audioCount: proxiedPlayUrl?.dash?.audio?.length,
        })
        return jsonResponse(result, originResponse)
    } catch (error) {
        util_warn('fetch pgc playurl proxy failed', error)
        if (isEntitlementProxyError(error)) {
            return jsonResponse(proxyErrorResponse(error), originResponse)
        }
        return jsonResponse(originJson, originResponse)
    }
}

function getPlayUrlPayload(json: any, isV1: boolean) {
    return isV1
        ? json?.result?.video_info ?? json?.result
        : json?.result?.video_info
}

function isAreaLimitForPlayUrl(playUrl: any) {
    if (!playUrl) return true
    return (playUrl.errorcid && playUrl.errorcid === '8986943')
        || (playUrl.durl && playUrl.durl.length === 1 && playUrl.durl[0].length === 15126 && playUrl.durl[0].size === 124627)
        || (!playUrl.video_info && !playUrl.dash && !playUrl.durl)
}

function fetchPgcPlayUrlByProxy(reqUrl: URL): Promise<any> {
    const candidates = getProxyCandidates()
    if (!candidates.length) return NativePromise.reject(new Error('proxy playurl server not configured'))
    const originUrl = toPgcPlayUrl(reqUrl)
    let lastError: any
    const requestCandidate = (index: number): Promise<any> => {
        const candidate = candidates[index]
        if (!candidate) return NativePromise.reject(lastError || new Error('proxy playurl failed'))
        const useMobi = candidate.area === 'th' || window.__balh_app_only__ === true
        if (useMobi && !localStorage.access_key) {
            util_warn('skip fetch mobi proxy candidate without access_key', describeProxyCandidate(candidate))
            return requestCandidate(index + 1)
        }
        const requestUrl = buildProxyPlayUrl(originUrl, candidate, useMobi)
        return requestProxyCandidateWithRetry(candidate, () => requestProxyJson(requestUrl)
            .then(json => normalizeProxyResponse(json, useMobi))
            .then(({ json, playUrl }) => {
                if (playUrl?.dash || playUrl?.durl) {
                    if (candidate.area) storeBangumiArea(candidate.area)
                    log('fetch pgc playurl proxy success', {
                        proxyHost: redactProxyHost(candidate.proxyHost),
                        area: candidate.area,
                        videoCount: playUrl?.dash?.video?.length,
                        audioCount: playUrl?.dash?.audio?.length,
                    })
                    return playUrl
                }
                return NativePromise.reject(json || playUrl)
            }))
            .catch(error => {
                lastError = choosePreferredProxyError(lastError, error)
                util_warn('fetch pgc playurl proxy candidate failed', describeProxyCandidate(candidate), error)
                return requestCandidate(index + 1)
            })
    }
    return requestCandidate(0)
}

function requestProxyJson(url: string): Promise<any> {
    return NativePromise.race([
        Async.ajaxByXhr<any>(url),
        Async.timeout(proxyPlayUrlRequestTimeout).then(() => NativePromise.reject(new Error('proxy playurl timeout'))),
    ])
}

function requestProxyCandidateWithRetry<T>(
    candidate: ProxyCandidate,
    request: () => Promise<T>,
    retryIndex = 0,
    preferredError?: any,
): Promise<T> {
    return request().catch(error => {
        const nextPreferredError = choosePreferredProxyError(preferredError, error)
        const delay = getProxyRetryDelay(error, retryIndex)
        if (delay === undefined) return NativePromise.reject(nextPreferredError)
        util_warn('fetch pgc playurl proxy candidate retry', describeProxyCandidate(candidate), {
            attempt: retryIndex + 1,
            delay,
            error: describeProxyError(error),
        })
        return Async.timeout(delay).then(() => requestProxyCandidateWithRetry(candidate, request, retryIndex + 1, nextPreferredError))
    })
}

function toPgcPlayUrl(reqUrl: URL) {
    const params = new URLSearchParams(reqUrl.search)
    if (isBangumiPage() && !params.has('module')) {
        params.set('module', 'bangumi')
    }
    return `//api.bilibili.com/pgc/player/web/playurl?${params}`
}

function getProxyCandidates() {
    const candidates: ProxyCandidate[] = []
    const addCandidate = (proxyHost: string | undefined, area: ProxyArea, label = getProxyAreaLabel(area)) => {
        if (!proxyHost) return
        proxyHost = proxyHost.replace(/\/$/, '')
        if (candidates.some(it => it.proxyHost === proxyHost && it.area === area)) return
        candidates.push({ proxyHost, area, label })
    }
    const hintedArea = getHintedProxyArea()
    if (hintedArea) addCandidate(getProxyHostForArea(hintedArea), hintedArea, `页面提示${getProxyAreaLabel(hintedArea)}`)
    const cachedArea = getCachedBangumiArea()
    if (cachedArea) addCandidate(getProxyHostForArea(cachedArea), cachedArea, `缓存${getProxyAreaLabel(cachedArea)}`)
    addCandidate(balh_config.server_custom, '')
    addCandidate(balh_config.server_custom_cn, 'cn')
    addCandidate(balh_config.server_custom_th, 'th')
    addCandidate(balh_config.server_custom_hk, 'hk')
    addCandidate(balh_config.server_custom_tw, 'tw')
    return candidates
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

function getBangumiAreaHintText() {
    const initialState = (window as any).__INITIAL_STATE__ || {}
    const fields = [
        document.title,
        initialState.h1Title,
        initialState.mediaInfo?.title,
        initialState.mediaInfo?.originName,
        initialState.mediaInfo?.origin_name,
        initialState.mediaInfo?.seasonTitle,
        initialState.mediaInfo?.season_title,
        initialState.epInfo?.titleFormat,
        initialState.epInfo?.longTitle,
        initialState.epInfo?.long_title,
        document.body?.textContent?.slice(0, 3000),
    ]
    return fields
        .filter((item): item is string | number => typeof item === 'string' || typeof item === 'number')
        .map(item => String(item))
        .join('\n')
}

function getHintedProxyArea(): ProxyArea | undefined {
    const hintText = getBangumiAreaHintText()
    if (/(僅|仅)限?港澳(臺|台)?/.test(hintText)) return 'hk'
    if (/(僅|仅)限?(臺|台)(灣|湾)/.test(hintText)) return 'tw'
    return undefined
}

const bangumiAreaCacheKey = 'balh_bangumi_area_cache'

function getCurrentSeasonId() {
    const initialState = (window as any).__INITIAL_STATE__ || {}
    const seasonId = initialState.mediaInfo?.season_id
        ?? initialState.mediaInfo?.seasonId
        ?? initialState.epInfo?.season_id
        ?? initialState.epInfo?.seasonId
        ?? window.location.pathname.match(/\/bangumi\/play\/ss(\d+)/)?.[1]
        ?? new URL(window.location.href).searchParams.get('season_id')
    return seasonId == null ? undefined : String(seasonId)
}

function readBangumiAreaCache() {
    try {
        return JSON.parse(localStorage.getItem(bangumiAreaCacheKey) || '{}')
    } catch (error) {
        util_warn('fetch bangumi area cache read failed', error)
        return {}
    }
}

function getCachedBangumiArea(): ProxyArea | undefined {
    const seasonId = getCurrentSeasonId()
    if (!seasonId) return undefined
    const area = readBangumiAreaCache()[seasonId]
    return area === 'cn' || area === 'th' || area === 'hk' || area === 'tw' ? area : undefined
}

function storeBangumiArea(area: ProxyArea) {
    if (!area) return
    const seasonId = getCurrentSeasonId()
    if (!seasonId) return
    try {
        const cache = readBangumiAreaCache()
        cache[seasonId] = area
        localStorage.setItem(bangumiAreaCacheKey, JSON.stringify(cache))
    } catch (error) {
        util_warn('fetch bangumi area cache write failed', error)
    }
}

function buildProxyPlayUrl(originUrl: string, candidate: ProxyCandidate, useMobi: boolean) {
    const isBilibiliApiProxy = r.regex.bilibili_api_proxy.test(candidate.proxyHost)
    if (useMobi) {
        return isBilibiliApiProxy
            ? getMobiPlayUrl(originUrl, candidate.proxyHost, candidate.area)
            : `${candidate.proxyHost}?${generateMobiPlayUrlParams(originUrl, candidate.area)}`
    }
    const params = new URLSearchParams(originUrl.split('?')[1])
    if (candidate.area) params.set('area', candidate.area)
    const query = `${params}${access_key_param_if_exist(true)}`
    return isBilibiliApiProxy
        ? `${candidate.proxyHost}/pgc/player/web/playurl?${query}`
        : `${candidate.proxyHost}?${query}`
}

function normalizeProxyResponse(json: any, useMobi: boolean): Promise<{ json: any, playUrl: any }> {
    const playUrl = useMobi && json?.data?.video_info
        ? fixThailandPlayUrlJson(json)
        : window.__balh_app_only__ === true && json?.type === 'DASH'
        ? fixMobiPlayUrlJson(json)
        : NativePromise.resolve(json?.result?.video_info ?? json?.data?.video_info ?? json?.result ?? json?.data)
    return playUrl.then(playUrl => ({
        json,
        playUrl: normalizeProxyPlayUrl(playUrl),
    }))
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

function isBangumiPage() {
    return /\/bangumi\/play\//.test(window.location.pathname)
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

function proxyErrorResponse(error: any) {
    return {
        code: error?.code ?? -1,
        message: describeProxyError(error),
    }
}

function getFetchUrl(input: RequestInfo | URL): string | undefined {
    if (typeof input === 'string') return input
    if (input instanceof URL) return input.href
    if (input instanceof Request) return input.url
    return undefined
}

function responseInit(response: Response): ResponseInit {
    return {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
    }
}

function jsonResponse(json: unknown, response: Response): Response {
    const headers = new Headers(response.headers)
    headers.set('content-type', 'application/json; charset=utf-8')
    return new Response(JSON.stringify(json), {
        ...responseInit(response),
        headers,
    })
}

export function injectFetch4Mobile() {
    util_debug('injectFetch4Mobile')
    window.fetch = Async.wrapper(window.fetch,
        resp => new Proxy(resp, {
            get: function (target, prop, receiver) {
                if (prop === 'json') {
                    return Async.wrapper(target.json.bind(target),
                        oriResult => {
                            util_debug('injectFetch:', target.url)
                            if (target.url.match(RegExps.urlPath('/player/web_api/v2/playurl/html5'))) {
                                let cid = Strings.getSearchParam(target.url, 'cid')
                                return BiliPlusApi.playurl(cid)
                                    .then(result => {
                                        if (result.code) {
                                            return Promise.reject('error: ' + JSON.stringify(result))
                                        } else {
                                            return BiliPlusApi.playurl_for_mp4(cid)
                                                .then(url => {
                                                    util_debug(`mp4地址, 移动版: ${url}, pc版: ${result.durl[0].url}`)
                                                    return {
                                                        "code": 0,
                                                        "cid": `http://comment.bilibili.com/${cid}.xml`,
                                                        "timelength": result.timelength,
                                                        "src": url || result.durl[0].url, // 只取第一个片段的url...
                                                    }
                                                })
                                        }
                                    })
                                    .catch(e => {
                                        // 若拉取视频地址失败, 则返回原始的结果
                                        log('fetch mp4 url failed', e)
                                        return oriResult
                                    })
                            }
                            return oriResult
                        },
                        error => error)
                }
                return target[prop]
            }
        }),
        error => error,
    ) as any
}
