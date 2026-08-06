#!/usr/bin/env node
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const vueConfig = {
    is_closed: false,
    cdn_mode: 'manual',
    upos_server: 'ali',
    upos_replace_akamai: 'Y',
    server_custom: 'https://proxy.example',
    server_custom_cn: '',
    server_custom_hk: '',
    server_custom_tw: '',
    server_custom_th: '',
    enable_in_av: false,
    blocked_vip: false,
}

globalThis.__vueBoundaryConfig = vueConfig
globalThis.__vueBoundaryRequests = []
globalThis.__vueBoundaryPolicyCalls = []
globalThis.__vueBoundaryPolicyThrows = false
globalThis.__vueBoundaryWarnings = []
installBrowserGlobals()

const [vueBundle, thaiBundle] = await Promise.all([
    build({
        stdin: {
            contents: `export { area_limit_for_vue } from './packages/unblock-area-limit/src/feature/bili/area_limit_for_vue.ts'`,
            resolveDir: rootDir,
            sourcefile: 'vue-cdn-boundary-entry.ts',
            loader: 'ts',
        },
        bundle: true,
        format: 'esm',
        platform: 'node',
        target: 'node20',
        write: false,
        plugins: [vueBoundaryStubPlugin()],
    }),
    build({
        stdin: {
            contents: `
                export { fixThailandPlayUrlJson } from './packages/unblock-area-limit/src/api/biliplus.ts'
                export { applyCdnPolicyToPlayUrlResponse } from './packages/unblock-area-limit/src/feature/bili/cdn_playurl.ts'
            `,
            resolveDir: rootDir,
            sourcefile: 'thai-upos-boundary-entry.ts',
            loader: 'ts',
        },
        bundle: true,
        format: 'esm',
        platform: 'node',
        target: 'node20',
        write: false,
        plugins: [thaiStubPlugin()],
    }),
])

const { area_limit_for_vue } = await importBundle(vueBundle)
const { applyCdnPolicyToPlayUrlResponse, fixThailandPlayUrlJson } = await importBundle(thaiBundle)

await testStaleResultsAndRawCache(area_limit_for_vue)
await testProxyFailureFailOpen(area_limit_for_vue)
await testMissingProxyCdnDelivery(area_limit_for_vue)
await testLateMissingProxyCdnDelivery(area_limit_for_vue)
await testAccessorMissingProxyCdnDelivery(area_limit_for_vue)
await testCloneFailureMissingProxyCdnDelivery(area_limit_for_vue)
await testCdnPolicyFailureFailOpen(area_limit_for_vue)
await testExplicitlyDisabledMode(area_limit_for_vue)
await testNonConfigurableMissingProxyFailOpen(area_limit_for_vue)
await testThailandManualAkamaiGate(fixThailandPlayUrlJson, applyCdnPolicyToPlayUrlResponse)

console.log('vue CDN boundary tests passed')

async function testStaleResultsAndRawCache(areaLimitForVue) {
    const firstSource = createRestrictedPlayInfo(101, 201)
    resetVuePage(firstSource, { clearSession: true })
    areaLimitForVue()
    assert.equal(globalThis.__vueBoundaryRequests.length, 1)

    const secondSource = createRestrictedPlayInfo(101, 201)
    window.__playinfo__ = secondSource
    assert.equal(globalThis.__vueBoundaryRequests.length, 2)

    globalThis.__vueBoundaryRequests[0].resolve(createProxyResponse('https://raw-one.example/video.m4s'))
    await flushPromises()
    assertRestricted(firstSource, 'stale requestId result mutated its source')
    assert.equal(findProxyCacheKeys().length, 0, 'stale requestId result was cached')
    assert.equal(globalThis.__vueBoundaryPolicyCalls.length, 0, 'stale requestId result reached CDN runtime state')

    window.location.pathname = '/bangumi/play/ep102'
    globalThis.__vueBoundaryRequests[1].resolve(createProxyResponse('https://raw-two.example/video.m4s'))
    await flushPromises()
    assertRestricted(secondSource, 'stale episode result mutated its source')
    assert.equal(findProxyCacheKeys().length, 0, 'stale episode result was cached')
    assert.equal(globalThis.__vueBoundaryPolicyCalls.length, 0, 'stale episode result reached CDN runtime state')

    window.location.pathname = '/bangumi/play/ep101'
    const currentSource = createRestrictedPlayInfo(101, 201)
    window.__playinfo__ = currentSource
    const currentRequest = globalThis.__vueBoundaryRequests.at(-1)
    currentRequest.resolve(createProxyResponse('https://raw-current.example/video.m4s'))
    await flushPromises()

    assertRestricted(currentSource, 'fresh proxy result mutated shared hydration input')
    assert.equal(hostname(window.__PLAYURL_HYDRATE_DATA__), 'upos-sz-mirrorali.bilivideo.com')
    assert.equal(hostname(window.__PLAYURL_HYDRATE_DATA__.video_info), 'upos-sz-mirrorali.bilivideo.com')

    const cacheKeys = findProxyCacheKeys()
    assert.deepEqual(cacheKeys, ['balh_proxy_playinfo_v2:101:201'])
    const cached = JSON.parse(sessionStorage.getItem(cacheKeys[0]))
    assert.equal(hostname(cached.value), 'raw-current.example', 'session cache stored a mode-transformed URL')
    assert.equal(hostname(cached.value.video_info), 'raw-current.example', 'session cache root alias was transformed')

    const requestCount = globalThis.__vueBoundaryRequests.length
    vueConfig.cdn_mode = 'original'
    resetVuePage(createRestrictedPlayInfo(101, 201))
    areaLimitForVue()
    assert.equal(globalThis.__vueBoundaryRequests.length, requestCount, 'raw cache miss triggered a proxy request')
    assert.equal(hostname(window.__PLAYURL_HYDRATE_DATA__), 'raw-current.example', 'original mode could not recover the raw URL')

    vueConfig.cdn_mode = 'manual'
    vueConfig.upos_server = 'ks3'
    resetVuePage(createRestrictedPlayInfo(101, 201))
    areaLimitForVue()
    assert.equal(hostname(window.__PLAYURL_HYDRATE_DATA__), 'upos-sz-mirrorks3.bilivideo.com', 'cache hit kept the previous manual host')
}

async function testMissingProxyCdnDelivery(areaLimitForVue) {
    const serverCustom = vueConfig.server_custom
    vueConfig.server_custom = ''
    vueConfig.cdn_mode = 'manual'
    vueConfig.upos_server = 'ali'
    const playInfo = createPlayablePlayInfo('https://closed-playinfo.example/video.m4s')
    const hydration = createPlayablePlayInfo('https://closed-hydration.example/video.m4s')
    resetVuePage(playInfo, { hydration })
    const requestCount = globalThis.__vueBoundaryRequests.length

    areaLimitForVue()

    assert.equal(hostname(window.__playinfo__), 'upos-sz-mirrorali.bilivideo.com')
    assert.equal(hostname(window.__PLAYURL_HYDRATE_DATA__), 'upos-sz-mirrorali.bilivideo.com')
    assert.equal(globalThis.__vueBoundaryRequests.length, requestCount, 'closed mode entered the proxy path')
    vueConfig.server_custom = serverCustom
}

async function testLateMissingProxyCdnDelivery(areaLimitForVue) {
    const serverCustom = vueConfig.server_custom
    vueConfig.server_custom = ''
    vueConfig.cdn_mode = 'manual'
    vueConfig.upos_server = 'ali'
    resetVuePage(undefined, { hydration: undefined })
    const requestCount = globalThis.__vueBoundaryRequests.length

    areaLimitForVue()
    await flushPromises()

    const latePlayInfo = createPlayablePlayInfo('https://late-playinfo.example/video.m4s')
    const lateHydration = createPlayablePlayInfo('https://late-hydration.example/video.m4s')
    const expectedLatePlayInfo = structuredClone(latePlayInfo)
    const expectedLateHydration = structuredClone(lateHydration)
    window.__playinfo__ = latePlayInfo
    window.__PLAYURL_HYDRATE_DATA__ = lateHydration
    await flushPromises()

    assert.equal(hostname(window.__playinfo__), 'upos-sz-mirrorali.bilivideo.com')
    assert.equal(hostname(window.__PLAYURL_HYDRATE_DATA__), 'upos-sz-mirrorali.bilivideo.com')
    assert.equal(hostname(latePlayInfo), 'late-playinfo.example', 'late playinfo source object was mutated')
    assert.equal(hostname(lateHydration), 'late-hydration.example', 'late hydration source object was mutated')
    assert.deepEqual(latePlayInfo, expectedLatePlayInfo)
    assert.deepEqual(lateHydration, expectedLateHydration)
    assert.equal(globalThis.__vueBoundaryRequests.length, requestCount, 'late CDN-only delivery entered the proxy path')
    vueConfig.server_custom = serverCustom
}

async function testAccessorMissingProxyCdnDelivery(areaLimitForVue) {
    const serverCustom = vueConfig.server_custom
    vueConfig.server_custom = ''
    vueConfig.cdn_mode = 'manual'
    vueConfig.upos_server = 'ali'
    resetVuePage(undefined, { hydration: undefined })
    let backing = createPlayablePlayInfo('https://accessor-one.example/video.m4s')
    let setterCalls = 0
    Object.defineProperty(window, '__playinfo__', {
        configurable: true,
        enumerable: true,
        get() { return backing },
        set(value) {
            setterCalls += 1
            backing = value
        },
    })
    const requestCount = globalThis.__vueBoundaryRequests.length

    areaLimitForVue()

    assert.equal(hostname(window.__playinfo__), 'upos-sz-mirrorali.bilivideo.com')
    backing.result.video_info.dash.video[0].base_url = 'https://accessor-two.example/updated.m4s?sig=two'
    const expectedBacking = structuredClone(backing)
    const updatedDelivery = window.__playinfo__
    assert.equal(hostname(updatedDelivery), 'upos-sz-mirrorali.bilivideo.com')
    assert.equal(new URL(updatedDelivery.result.video_info.dash.video[0].base_url).pathname, '/updated.m4s')
    assert.equal(hostname(backing), 'accessor-two.example', 'accessor backing object was mutated')
    assert.deepEqual(backing, expectedBacking)

    const assigned = createPlayablePlayInfo('https://accessor-three.example/assigned.m4s?sig=three')
    const expectedAssigned = structuredClone(assigned)
    window.__playinfo__ = assigned
    assert.equal(setterCalls, 1, 'original accessor setter was not preserved')
    const assignedDelivery = window.__playinfo__
    assert.equal(hostname(assignedDelivery), 'upos-sz-mirrorali.bilivideo.com')
    assert.equal(new URL(assignedDelivery.result.video_info.dash.video[0].base_url).pathname, '/assigned.m4s')
    assert.equal(hostname(assigned), 'accessor-three.example', 'accessor assignment source was mutated')
    assert.deepEqual(assigned, expectedAssigned)
    assert.equal(globalThis.__vueBoundaryRequests.length, requestCount, 'accessor CDN-only delivery entered the proxy path')
    vueConfig.server_custom = serverCustom
}

async function testCloneFailureMissingProxyCdnDelivery(areaLimitForVue) {
    const serverCustom = vueConfig.server_custom
    vueConfig.server_custom = ''
    resetVuePage(undefined, { hydration: undefined })
    const circular = createPlayablePlayInfo('https://circular.example/video.m4s')
    circular.self = circular
    const requestCount = globalThis.__vueBoundaryRequests.length

    areaLimitForVue()

    assert.doesNotThrow(() => { window.__playinfo__ = circular })
    assert.strictEqual(window.__playinfo__, circular, 'clone failure did not fail open to the source value')
    assert.equal(hostname(window.__playinfo__), 'circular.example')
    assert.equal(globalThis.__vueBoundaryRequests.length, requestCount, 'clone failure entered the proxy path')
    vueConfig.server_custom = serverCustom
}

async function testProxyFailureFailOpen(areaLimitForVue) {
    const cases = [
        { label: 'rejected proxy', settle: request => request.reject({ code: 400, message: 'rejected' }) },
        { label: 'malformed proxy result', settle: request => request.resolve({ code: 0, result: { unexpected: true } }) },
    ]
    for (const testCase of cases) {
        const source = createRestrictedPlayInfo(101, 201)
        resetVuePage(source, { clearSession: true })
        const requestIndex = globalThis.__vueBoundaryRequests.length
        areaLimitForVue()
        const request = globalThis.__vueBoundaryRequests[requestIndex]
        assert.ok(request, `${testCase.label} did not start the proxy request`)

        testCase.settle(request)
        await flushPromises()

        assertRestricted(source, `${testCase.label} mutated the shared source`)
        assertRestricted(window.__playinfo__, `${testCase.label} did not leave a restricted fail-open delivery`)
        assert.equal(findProxyCacheKeys().length, 0, `${testCase.label} was cached`)
    }
}

async function testCdnPolicyFailureFailOpen(areaLimitForVue) {
    const serverCustom = vueConfig.server_custom
    vueConfig.server_custom = ''
    vueConfig.cdn_mode = 'manual'
    vueConfig.upos_server = 'ali'
    const playInfo = createPlayablePlayInfo('https://policy-failure-playinfo.example/video.m4s')
    const hydration = createPlayablePlayInfo('https://policy-failure-hydration.example/video.m4s')
    resetVuePage(playInfo, { hydration })
    globalThis.__vueBoundaryPolicyThrows = true

    areaLimitForVue()

    assert.equal(hostname(window.__playinfo__), 'policy-failure-playinfo.example')
    assert.equal(hostname(window.__PLAYURL_HYDRATE_DATA__), 'policy-failure-hydration.example')
    globalThis.__vueBoundaryPolicyThrows = false
    vueConfig.server_custom = serverCustom
}

async function testExplicitlyDisabledMode(areaLimitForVue) {
    vueConfig.is_closed = 'Y'
    const playInfo = createPlayablePlayInfo('https://disabled-playinfo.example/video.m4s')
    const hydration = createPlayablePlayInfo('https://disabled-hydration.example/video.m4s')
    resetVuePage(playInfo, { hydration })
    const requestCount = globalThis.__vueBoundaryRequests.length

    areaLimitForVue()

    assert.equal(hostname(window.__playinfo__), 'disabled-playinfo.example')
    assert.equal(hostname(window.__PLAYURL_HYDRATE_DATA__), 'disabled-hydration.example')
    assert.equal(globalThis.__vueBoundaryPolicyCalls.length, 0, 'explicitly disabled mode applied CDN policy')
    assert.equal(globalThis.__vueBoundaryRequests.length, requestCount, 'explicitly disabled mode entered the proxy path')
    vueConfig.is_closed = false
}

async function testNonConfigurableMissingProxyFailOpen(areaLimitForVue) {
    const serverCustom = vueConfig.server_custom
    vueConfig.server_custom = ''
    resetVuePage(undefined, { hydration: undefined })
    Object.defineProperty(window, '__playinfo__', {
        configurable: false,
        enumerable: true,
        writable: true,
        value: undefined,
    })
    globalThis.__vueBoundaryWarnings.length = 0
    const requestCount = globalThis.__vueBoundaryRequests.length

    areaLimitForVue()

    assert.ok(globalThis.__vueBoundaryWarnings.some(args => (
        args.includes('cannot watch non-configurable CDN-only playinfo; transformed current value only')
        && args.includes('__playinfo__')
    )))
    const lateValue = createPlayablePlayInfo('https://non-configurable.example/video.m4s')
    window.__playinfo__ = lateValue
    assert.strictEqual(window.__playinfo__, lateValue, 'non-configurable fallback did not fail open')
    assert.equal(hostname(window.__playinfo__), 'non-configurable.example')
    assert.equal(globalThis.__vueBoundaryRequests.length, requestCount, 'non-configurable fallback entered the proxy path')
    vueConfig.server_custom = serverCustom
}

async function testThailandManualAkamaiGate(fixThailandPlayUrlJson, applyCdnPolicyToPlayUrlResponse) {
    const cases = [
        { mode: 'original', gate: 'Y', expectedDelivery: 'upos-sz-mirrorhw.bilivideo.com' },
        { mode: 'safe', gate: 'Y', expectedDelivery: 'upos-sz-mirrorhw.bilivideo.com' },
        { mode: 'manual', gate: 'N', expectedDelivery: 'upos-sz-mirrorhw.bilivideo.com' },
        { mode: 'manual', gate: 'Y', expectedDelivery: 'upos-sz-mirrorali.bilivideo.com' },
    ]
    for (const testCase of cases) {
        vueConfig.cdn_mode = testCase.mode
        vueConfig.upos_server = 'ali'
        vueConfig.upos_replace_akamai = testCase.gate
        window.__segment_base_map__ = {
            30080: ['0-1', '2-3'],
            30280: ['0-1', '2-3'],
        }
        const result = await fixThailandPlayUrlJson(createThailandPlayUrl({ includeBackupUrls: false }))
        assert.equal(hostname(result), 'upos-sz-mirrorhw.bilivideo.com', `${testCase.mode}/${testCase.gate} normalized video host`)
        assert.equal(new URL(result.dash.audio[0].base_url).hostname, 'upos-sz-mirrorhw.bilivideo.com', `${testCase.mode}/${testCase.gate} normalized audio host`)
        const normalized = structuredClone(result)
        applyCdnPolicyToPlayUrlResponse(result)
        assert.equal(hostname(result), testCase.expectedDelivery, `${testCase.mode}/${testCase.gate} delivered video host`)
        assert.equal(new URL(result.dash.audio[0].base_url).hostname, testCase.expectedDelivery, `${testCase.mode}/${testCase.gate} delivered audio host`)
        if (testCase.mode === 'manual' && testCase.gate !== 'Y') {
            assert.deepEqual(result, normalized, 'manual Akamai gate should keep the whole normalized payload unchanged')
        }
    }
}

function createRestrictedPlayInfo(epId, cid) {
    return {
        result: {
            arc: { aid: 301, cid },
            supplement: {
                ogv_episode_info: { episode_id: epId },
                ogv_season_info: { season_id: 401 },
            },
            play_video_type: 'none',
            play_check: { code: 1 },
            plugins: [{ name: 'AreaLimitPanel', config: { is_block: true } }],
        },
    }
}

function createPlayablePlayInfo(url) {
    return { result: { video_info: { dash: { video: [{ base_url: url, backup_url: [] }], audio: [] } } } }
}

function createProxyResponse(url) {
    return { code: 0, result: { code: 0, dash: { video: [{ base_url: url, backup_url: [] }], audio: [] } } }
}

function createThailandPlayUrl({ includeBackupUrls = true } = {}) {
    const host = 'https://upos-hz-mirrorakam.akamaized.net'
    return {
        code: 0,
        message: '0',
        data: {
            video_info: {
                timelength: 60_000,
                quality: 80,
                dash_audio: [{
                    id: 30280,
                    bandwidth: 128_000,
                    base_url: `${host}/audio/30280.m4s`,
                    ...(includeBackupUrls ? { backup_url: [`${host}/audio/30280.m4s?backup=1`] } : {}),
                }],
                stream_list: [{
                    stream_info: { description: '1080P', display_desc: '1080P', new_description: '1080P', quality: 80 },
                    dash_video: {
                        audio_id: 30280,
                        bandwidth: 1_000_000,
                        base_url: `${host}/video/30080.m4s`,
                        ...(includeBackupUrls ? { backup_url: [`${host}/video/30080.m4s?backup=1`] } : {}),
                        codecid: 7,
                    },
                }],
            },
        },
    }
}

function assertRestricted(value, message) {
    assert.equal(value.result.play_video_type, 'none', message)
    assert.equal(value.result.video_info, undefined, message)
    assert.equal(value.video_info, undefined, message)
    assert.equal(value.result.plugins[0].config.is_block, true, message)
}

function hostname(value) {
    const payload = value?.result?.video_info ?? value?.video_info ?? value
    return new URL(payload.dash.video[0].base_url).hostname
}

function findProxyCacheKeys() {
    return [...sessionStorage.values.keys()].filter(key => key.startsWith('balh_proxy_playinfo_')).sort()
}

function resetVuePage(playInfo, options = {}) {
    if (options.clearSession) sessionStorage.clear()
    globalThis.__vueBoundaryPolicyCalls.length = 0
    window.location.pathname = '/bangumi/play/ep101'
    Object.defineProperty(window, '__playinfo__', { configurable: true, enumerable: true, writable: true, value: playInfo })
    Object.defineProperty(window, '__PLAYURL_HYDRATE_DATA__', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: options.hydration,
    })
    Object.defineProperty(window, 'nano', { configurable: true, enumerable: true, writable: true, value: undefined })
    delete window.__playinfo__origin
    delete window.__balh_waiting_nano__
    delete window.__balh_proxy_player_reload_key__
    delete window.player
    globalThis.history = createHistory()
    window.history = globalThis.history
}

function installBrowserGlobals() {
    const location = new URL('https://www.bilibili.com/bangumi/play/ep101')
    const document = {
        location,
        title: '',
        readyState: 'complete',
        body: { innerText: '' },
        addEventListener() {},
        querySelector() { return null },
        querySelectorAll() { return [] },
        getElementById() { return {} },
    }
    const local = createStorage()
    const session = createStorage()
    const window = {
        Promise,
        console,
        document,
        location,
        localStorage: local,
        sessionStorage: session,
        top: null,
        parent: null,
        addEventListener() {},
    }
    window.top = window
    window.parent = window
    globalThis.window = window
    globalThis.document = document
    globalThis.location = location
    globalThis.localStorage = local
    globalThis.sessionStorage = session
    globalThis.history = createHistory()
    window.history = globalThis.history
    globalThis.GM_info = { script: { name: '解除B站区域限制.vue-cdn-boundaries' } }
    globalThis.setTimeout = () => 0
    globalThis.clearTimeout = () => {}
}

function createHistory() {
    return { pushState() {}, replaceState() {} }
}

function createStorage() {
    const values = new Map()
    return {
        values,
        getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null },
        setItem(key, value) { values.set(String(key), String(value)) },
        removeItem(key) { values.delete(String(key)) },
        clear() { values.clear() },
        get access_key() { return values.get('access_key') },
        set access_key(value) { values.set('access_key', String(value)) },
    }
}

async function flushPromises() {
    for (let index = 0; index < 12; index += 1) await Promise.resolve()
}

async function importBundle(result) {
    const source = result.outputFiles[0].text
    return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
}

function vueBoundaryStubPlugin() {
    const stubs = new Map([
        ['../../api/bilibili', `export class BiliBiliApi {}`],
        ['../../api/bilibili-utils', `export const access_key_param_if_exist = () => ''`],
        ['../../api/biliplus', `
            export const BiliPlusApi = {}
            export const fixMobiPlayUrlJson = value => Promise.resolve(value)
            export const fixThailandPlayUrlJson = value => Promise.resolve(value)
            export const generateMobiPlayUrlParams = () => ''
            export const getMobiPlayUrl = () => ''
        `],
        ['../../util/async', `
            export const Promise = globalThis.Promise
            export const Async = {
                ajaxByXhr(url) {
                    return new globalThis.Promise((resolve, reject) => {
                        globalThis.__vueBoundaryRequests.push({ url, resolve, reject })
                    })
                },
                timeout() { return new globalThis.Promise(() => {}) },
            }
        `],
        ['../../util/balh-db', `export const BalhDb = { setSsId: () => Promise.resolve() }`],
        ['../../util/converters', `export const Converters = { aid2bv: String }`],
        ['../../util/cookie', `export const cookieStorage = { get: () => '', set() {} }`],
        ['../../util/initiator', `export function util_init() {}`],
        ['../../util/log', `
            export function log() {}
            export function util_warn(...args) { globalThis.__vueBoundaryWarnings.push(args) }
        `],
        ['../../util/objects', `export const Objects = { convertKeyToSnakeCase() {}, stringify: JSON.stringify }`],
        ['../../util/react', `export function _() { return {} }`],
        ['../../util/strings', `export const Strings = { escapeSpecialChars: String, replaceTemplate: String }`],
        ['../../util/ui', `export const ui = { playerStatus() {}, hidePlayerStatus() {}, isPlayerStatusHiddenElement: () => false, alert() {} }`],
        ['../../util/utils', `export function ifNotNull(value, callback) { if (value != null) callback(value) }`],
        ['../../util/windows', `export const Windows = { proxyGlobalField() {} }`],
        ['../config', `
            export const balh_config = globalThis.__vueBoundaryConfig
            export const isClosed = () => globalThis.__vueBoundaryConfig.is_closed || !globalThis.__vueBoundaryConfig.server_custom
        `],
        ['../page', `
            export const util_page = {
                av: () => false,
                new_bangumi: () => true,
                anime_ep: () => true,
                anime_ss: () => false,
                bangumi_md: () => false,
                ssId: '401',
            }
        `],
        ['../r', `export const r = { regex: { bilibili_api_proxy: { test: () => false } } }`],
        ['./bangumi-play-page-template.html', `export default ''`],
        ['./bilibili_login', `export const bilibili_login = { clearLoginFlag() {} }`],
        ['./cdn_playurl', `
            const hosts = {
                ali: 'upos-sz-mirrorali.bilivideo.com',
                ks3: 'upos-sz-mirrorks3.bilivideo.com',
            }
            function payload(value) {
                return [value?.result?.video_info, value?.data?.video_info, value?.video_info, value?.result, value?.data, value]
                    .find(candidate => candidate && (candidate.dash || candidate.durl))
            }
            function rewrite(value, host) {
                if (typeof value === 'string') {
                    try {
                        const url = new URL(value)
                        url.hostname = host
                        return url.href
                    } catch { return value }
                }
                if (!value || typeof value !== 'object') return value
                for (const key of Object.keys(value)) value[key] = rewrite(value[key], host)
                return value
            }
            export function applyCdnPolicyToPlayUrlResponse(value) {
                const playUrl = payload(value)
                if (!playUrl) return value
                globalThis.__vueBoundaryPolicyCalls.push(value)
                const config = globalThis.__vueBoundaryConfig
                if (globalThis.__vueBoundaryPolicyThrows) {
                    rewrite(playUrl, 'partial-policy-mutation.example')
                    throw new Error('synthetic CDN policy failure')
                }
                if (config.cdn_mode === 'manual') rewrite(playUrl, hosts[config.upos_server])
                return value
            }
            export function observeFinalCdnPlayUrlResponse(value) { return value }
        `],
    ])
    return stubPlugin('vue-cdn-boundaries', stubs)
}

function thaiStubPlugin() {
    return {
        name: 'thai-upos-boundaries',
        setup(esbuild) {
            esbuild.onResolve({ filter: /.*/ }, args => {
                if (args.path.endsWith('/feature/config')
                    || (args.path === '../config' && args.importer.includes('/feature/'))) {
                    return { path: 'config', namespace: 'thai-upos-boundaries' }
                }
                if (args.path.endsWith('/feature/bili/bilibili_login')) return { path: 'login', namespace: 'thai-upos-boundaries' }
                if (args.path.endsWith('/util/inject-xhr')) return { path: 'inject', namespace: 'thai-upos-boundaries' }
                if (/(^|\/)log$/.test(args.path)) return { path: 'log', namespace: 'thai-upos-boundaries' }
                return undefined
            })
            esbuild.onLoad({ filter: /.*/, namespace: 'thai-upos-boundaries' }, args => ({
                loader: 'js',
                contents: args.path === 'config'
                    ? `export const balh_config = globalThis.__vueBoundaryConfig`
                    : args.path === 'login'
                    ? `export const bilibili_login = { clearLoginFlag() {} }`
                    : args.path === 'inject'
                    ? `export function addNoRefererHost() {}`
                    : `
                        export function log() {}
                        export function util_log() {}
                        export function util_info() {}
                        export function util_debug() {}
                        export function util_warn() {}
                        export function util_error() {}
                        export const logHub = { msg() {}, getAllMsg: () => '' }
                    `,
            }))
        },
    }
}

function stubPlugin(name, stubs) {
    return {
        name,
        setup(esbuild) {
            esbuild.onResolve({ filter: /.*/ }, args => stubs.has(args.path)
                ? { path: args.path, namespace: name }
                : undefined)
            esbuild.onLoad({ filter: /.*/, namespace: name }, args => ({ contents: stubs.get(args.path), loader: 'js' }))
        },
    }
}
