const PLAYURL_PATHS_BY_HOST: ReadonlyMap<string, ReadonlySet<string>> = new Map([
    ['api.bilibili.com', new Set([
        '/x/player/playurl',
        '/x/player/wbi/playurl',
        '/pgc/player/web/playurl',
        '/pgc/player/web/v2/playurl',
        '/pugv/player/web/playurl',
    ])],
    ['interface.bilibili.com', new Set([
        '/v2/playurl',
    ])],
])
const LEGACY_PLAYURL_PATHS = new Set([
    '/player/web_api/playurl',
    '/player/web_api/v2/playurl',
])

/**
 * Classify the exact host/path pairs supported by BALH playurl adapters.
 * Protocol parsing and policy remain at the caller so legacy adapters can
 * preserve their existing absolute and protocol-relative URL behavior.
 */
export function isSupportedCdnPlayUrlEndpoint(hostname: string, pathname: string) {
    // RegExps.urlPath historically accepted either legacy path on any parsed
    // hostname. Keep that adapter-compatibility rule explicit; it is not a
    // generic path or Bilibili-suffix heuristic.
    if (hostname && LEGACY_PLAYURL_PATHS.has(pathname)) return true
    return PLAYURL_PATHS_BY_HOST.get(hostname)?.has(pathname) ?? false
}
