import { BiliPlusApi } from "../../api/biliplus"
import { Async } from "../../util/async"
import { log, util_debug } from "../../util/log"
import { RegExps } from "../../util/regexps"
import { Strings } from "../../util/strings"
import { balh_config } from "../config"
import { isSubtitleBodyUrl, rewriteSubtitleBodyJson, rewriteSubtitleWebViewResponse } from "./subtitle_web_view"
import space_account_info_map from "./space_account_info_map"

export function injectFetch() {
    const originFetch = window.fetch;
    window.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        const originResponse = await originFetch(input, init)
        const url = getFetchUrl(input)
        if (url) {
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
