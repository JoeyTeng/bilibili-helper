import { RegExps, Scripts, Windows, injectXhr, util_info, noop } from "../unblock-area-limit/index";

const log = Scripts.isDev ? util_info : noop

const LONG_VIDEO_DURATION = 10 * 60

const isSpamVideo = (value: any = window.__INITIAL_STATE__) => {
    if (!value?.videoData?.stat) return false
    return value.videoData.stat.like < 1000
        || value.videoData.argue_info?.argue_type === 2
}
const isShortVideo = (value: any = window.__INITIAL_STATE__) => {
    if (!value?.videoData) return false
    return value.videoData.duration < LONG_VIDEO_DURATION
}

const filterRelatedVideos = (array: any[], factor = 1) => {
    const results = array.filter(it =>
        (it.duration >= LONG_VIDEO_DURATION * factor && it.stat?.like > 1_0000 * factor)
        || it.stat?.like > 50_0000 * factor)
    log('filterRelatedVideos', array, results)
    return results
}

const clearPlayer = (value: any = window.__playinfo__) => {
    value.code = 404
    value.data = {}
    value.message = 'Not Found'
    return value
}

Windows.proxyGlobalField('__INITIAL_STATE__', {
    onWrite: (value) => {
        log('STATE', value)

        let removeRelated = false
        if (isSpamVideo(value)) {
            removeRelated = true
            clearPlayer()
        }
        if (isShortVideo(value)) {
            removeRelated = true
        }
        if (removeRelated) {
            // 在这里移除相关推荐, 会把界面搞崩掉...暂时不移除
            false && (value.related = filterRelatedVideos(value.related))
            value.availableVideoList = []
        }
        return value
    }
})

Windows.proxyGlobalField('__NEXT_DATA__', {
    onWrite: (value) => {
        log('NEXT_DATA', value)
        return value
    }
})

Windows.proxyGlobalField('__playinfo__', {
    onWrite: (value) => {
        log('INFO', value)
        return value
    }
})

Windows.proxyGlobalField('__pinia', {
    onWrite: (value) => {
        log('PINIA', value)
        if (value?.feed?.data?.recommend?.item) {
            value.feed.data.recommend.item = filterRelatedVideos(value.feed.data.recommend.item)
        }
        if (value?.feed?.data?.head?.recommend) {
            value.feed.data.head.recommend = filterRelatedVideos(value.feed.data.head.recommend)
        }
        return value
    }
})

injectXhr({
    transformResponse: ({ url, response, xhr, container }: any) => {
        if (url.match(RegExps.url('api.bilibili.com/x/player/wbi/playurl'))) {
            if (isSpamVideo()) {
                return clearPlayer({})
            }
        } else if (url.match(RegExps.url('api.bilibili.com/x/web-interface/wbi/view/detail'))) {
            const json = JSON.parse(xhr.responseText)
            json.data.Related = filterRelatedVideos(json.data.Related)
            return json
        }
        return null
    },
    transformRequest: ({ url, container }: any) => {
        return null
    }
})

function injectFetch() {
    const originFetch = window.fetch;
    window.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        const originResponse = await originFetch(input, init)
        if (typeof input === 'string') {
            if (input.match(RegExps.url('api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd'))) {
                const json = await originResponse.json()
                // 刷新时系数调低点, 防止刷不出视频
                json.data.item = filterRelatedVideos(json.data.item, 0.5)
                return new Response(JSON.stringify(json))
            }
        }
        return originResponse
    }
}
injectFetch()