#!/usr/bin/env node
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

globalThis.__closedModeFetchInstalls = []
globalThis.__closedModeCdnTransforms = []
globalThis.__closedModeProxyCalls = []
globalThis.__closedModeFullPipelineCalls = []
globalThis.__closedModeWarnings = []
globalThis.__closedModeThrowFromCdn = false
globalThis.__closedModeMainCalls = []
globalThis.__closedModeRuntimeRecoveryPublications = []
globalThis.__closedModeConfig = {
    is_closed: 'Y',
    server_custom: 'https://proxy.invalid',
    cdn_mode: 'auto',
    upos_server: '',
    upos_replace_akamai: '',
}

class NativeXMLHttpRequest extends EventTarget {
    static instances = []

    constructor() {
        super()
        this.readyState = 0
        this.responseURL = ''
        this.response = null
        this.responseText = ''
        this._onreadystatechange = null
        NativeXMLHttpRequest.instances.push(this)
    }

    get onreadystatechange() {
        return this._onreadystatechange
    }

    set onreadystatechange(value) {
        if (this._onreadystatechange) {
            EventTarget.prototype.removeEventListener.call(this, 'readystatechange', this._onreadystatechange)
        }
        this._onreadystatechange = value
        if (value) {
            EventTarget.prototype.addEventListener.call(this, 'readystatechange', value)
        }
    }

    open(method, url) {
        this.method = method
        this.url = url
        this.readyState = 1
    }

    send(body) {
        this.requestBody = body
    }

    complete(response) {
        this.response = response
        this.responseText = typeof this.response === 'string'
            ? this.response
            : JSON.stringify(this.response)
        this.responseURL = new URL(this.url, document.location.href).href
        this.readyState = 4
        this.dispatchEvent(new Event('readystatechange'))
    }
}

installBrowserGlobals()

const bundle = await build({
    entryPoints: [path.join(rootDir, 'packages/unblock-area-limit/src/feature/bili/area_limit_xhr_.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    write: false,
    plugins: [closedModeStubPlugin()],
})
const source = bundle.outputFiles[0].text
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
const { area_limit_xhr } = await import(moduleUrl)

const originalXMLHttpRequest = window.XMLHttpRequest
area_limit_xhr()
assert.deepEqual(globalThis.__closedModeFetchInstalls, [], 'explicitly closed mode must not install Fetch')
assert.strictEqual(window.XMLHttpRequest, originalXMLHttpRequest, 'explicitly closed mode must not install XHR')
assert.equal(globalThis.__closedModeFullPipelineCalls.length, 0, 'explicitly closed mode must not enter the full pipeline')

const mainModuleUrl = await buildMainWiringModule()
globalThis.__closedModeMainCalls = []
await import(`${mainModuleUrl}#explicit-close`)
assert.equal(countMainCall('area_limit_xhr'), 1, 'explicit-close main wiring did not reach area_limit_xhr')
assert.equal(countMainCall('installCdnRecoveryMonitor'), 0, 'explicitly closed mode installed the CDN recovery monitor')
assert.equal(countMainCall('installCdnFinalDeliveryObservers'), 0, 'explicitly closed mode installed final-delivery observers')

await assertClosedDefaultRuntimeDoesNotScheduleFinalDeliveryRecovery()

globalThis.__closedModeConfig.is_closed = ''
globalThis.__closedModeConfig.server_custom = ''
area_limit_xhr()
assert.deepEqual(
    globalThis.__closedModeFetchInstalls,
    [{ cdnOnly: true }],
    'missing custom proxy must preserve CDN-only Fetch wiring',
)
assert.equal(globalThis.__closedModeFullPipelineCalls.length, 0, 'CDN-only mode must not enter the area-unblock pipeline')

globalThis.__closedModeMainCalls = []
await import(`${mainModuleUrl}#missing-custom-proxy`)
assert.equal(countMainCall('area_limit_xhr'), 1, 'missing-proxy main wiring did not reach area_limit_xhr')
assert.equal(countMainCall('installCdnRecoveryMonitor'), 1, 'missing custom proxy incorrectly disabled the CDN recovery monitor')
assert.equal(countMainCall('installCdnFinalDeliveryObservers'), 1, 'missing custom proxy incorrectly disabled final-delivery observers')

const endpointCases = [
    {
        label: 'x/player playurl',
        url: 'https://api.bilibili.com/x/player/playurl?cid=1',
        response: { code: 0, data: { dash: { video: [] } } },
        payload: value => value.data,
    },
    {
        label: 'x/player WBI playurl',
        url: 'https://api.bilibili.com/x/player/wbi/playurl?cid=1&w_rid=signed&wts=1',
        response: { code: 0, message: '0', ttl: 1, data: { dash: { video: [] } } },
        payload: value => value.data,
    },
    {
        label: 'interface v2 playurl',
        url: 'https://interface.bilibili.com/v2/playurl?cid=2',
        response: { dash: { video: [] } },
        payload: value => value,
    },
    {
        label: 'PGC v1 playurl',
        url: 'https://api.bilibili.com/pgc/player/web/playurl?cid=3',
        response: { code: 0, result: { dash: { video: [] } } },
        payload: value => value.result,
    },
    {
        label: 'PGC v2 playurl',
        url: 'https://api.bilibili.com/pgc/player/web/v2/playurl?cid=4',
        response: { code: 0, result: { video_info: { dash: { video: [] } } } },
        payload: value => value.result.video_info,
    },
]

for (const endpoint of endpointCases) {
    const nativeSnapshot = structuredClone(endpoint.response)
    const delivery = sendNativeRequest(endpoint.url, endpoint.response, `${endpoint.label}:body`)
    assert.equal(endpoint.payload(delivery.response).__cdnApplied, true, `${endpoint.label}: CDN transform was not applied`)
    assert.notStrictEqual(delivery.response, endpoint.response, `${endpoint.label}: transformed response reused the native payload object`)
    assert.deepEqual(endpoint.response, nativeSnapshot, `${endpoint.label}: native response payload was mutated`)
    assert.equal(delivery.native.url, endpoint.url, `${endpoint.label}: request URL was rewritten`)
    assert.equal(delivery.native.method, 'POST', `${endpoint.label}: request method was rewritten`)
    assert.equal(delivery.native.requestBody, `${endpoint.label}:body`, `${endpoint.label}: request body was rewritten`)
}

assert.equal(globalThis.__closedModeCdnTransforms.length, endpointCases.length)
assert.equal(globalThis.__closedModeProxyCalls.length, 0, 'closed mode must not invoke any proxy request path')

globalThis.__closedModeThrowFromCdn = true
const cdnOnlyFailureUrl = 'https://api.bilibili.com/x/player/wbi/playurl?cid=5&w_rid=cdn-only-failure&wts=2'
const failureResponse = {
    code: 0,
    data: {
        dash: {
            video: [{
                id: 80,
                baseUrl: 'https://cdn-only-failure.test.bilivideo.com/video.m4s?token=preserve',
            }],
        },
    },
}
const failureSnapshot = structuredClone(failureResponse)
const failureDelivery = sendNativeRequest(
    cdnOnlyFailureUrl,
    failureResponse,
    'failure-body',
)
assert.strictEqual(failureDelivery.response, failureResponse, 'CDN failure must expose the native response object')
assert.deepEqual(failureResponse, failureSnapshot, 'CDN failure must not partially mutate the native response')
assert.equal(failureDelivery.native.url, cdnOnlyFailureUrl, 'CDN-only WBI failure rewrote the signed URL')
assert.equal(failureDelivery.native.method, 'POST', 'CDN-only WBI failure rewrote the request method')
assert.equal(failureDelivery.native.requestBody, 'failure-body', 'CDN failure must not rewrite the request body')
assert.equal(globalThis.__closedModeWarnings.length, 1, 'CDN failure should be reported once')
globalThis.__closedModeThrowFromCdn = false

const malformedResponse = '{"code":0,"data":'
const malformedDelivery = sendNativeRequest(
    'https://api.bilibili.com/pgc/player/web/playurl?cid=6',
    malformedResponse,
    'malformed-body',
)
assert.strictEqual(malformedDelivery.response, malformedResponse, 'parse failure must expose the native response text')
assert.equal(malformedDelivery.native.requestBody, 'malformed-body', 'parse failure must not rewrite the request body')

const emptyEnvelope = { code: -404, message: 'not found' }
const emptyEnvelopeDelivery = sendNativeRequest(
    'https://interface.bilibili.com/v2/playurl?cid=7',
    emptyEnvelope,
    'empty-envelope-body',
)
assert.strictEqual(emptyEnvelopeDelivery.response, emptyEnvelope, 'payload-free envelopes must remain native')

const unrelatedResponse = { code: -404, data: null }
const unrelatedDelivery = sendNativeRequest(
    'https://api.bilibili.com/x/space/wbi/acc/info?mid=1',
    unrelatedResponse,
    'unrelated-body',
)
assert.strictEqual(unrelatedDelivery.response, unrelatedResponse, 'non-playurl responses must remain native')
assert.equal(unrelatedDelivery.native.requestBody, 'unrelated-body', 'non-playurl requests must remain native')
assert.equal(globalThis.__closedModeCdnTransforms.length, endpointCases.length + 1, 'only payload-bearing playurl envelopes should reach CDN selection')
assert.equal(globalThis.__closedModeProxyCalls.length, 0, 'closed mode must remain proxy-free after failure fallbacks')
assert.equal(globalThis.__closedModeFullPipelineCalls.length, 0, 'closed-mode XHR handling must remain isolated from area-unblock behavior')

window.XMLHttpRequest = NativeXMLHttpRequest
window.jQuery = undefined
globalThis.__closedModeConfig.is_closed = ''
globalThis.__closedModeConfig.server_custom = 'https://proxy.invalid'
const proxyCallsBeforeFullMode = globalThis.__closedModeProxyCalls.length
const { area_limit_xhr: fullAreaLimitXhr } = await import(`${moduleUrl}#full-mode`)
fullAreaLimitXhr()
const fullModeSignedMediaUrl = 'https://wbi-media.test.bilivideo.com/video.m4s?deadline=private&token=must-not-log'
const fullModeWbiResponse = {
    code: 0,
    message: '0',
    ttl: 1,
    data: { dash: { video: [{ id: 80, baseUrl: fullModeSignedMediaUrl }] } },
}
const fullModeWbiSnapshot = structuredClone(fullModeWbiResponse)
const fullModeWbiUrl = 'https://api.bilibili.com/x/player/wbi/playurl?cid=8&w_rid=signed&wts=1'
const fullModeLogStart = globalThis.__closedModeFullPipelineCalls.length
const fullModeWbiDelivery = sendNativeRequest(
    fullModeWbiUrl,
    fullModeWbiResponse,
    'full-mode-wbi-body',
)
assert.equal(fullModeWbiDelivery.response.data.__cdnApplied, true, 'full-mode WBI response must reach CDN selection')
assert.notStrictEqual(fullModeWbiDelivery.response, fullModeWbiResponse, 'full-mode WBI transform reused the native payload')
assert.deepEqual(fullModeWbiResponse, fullModeWbiSnapshot, 'full-mode WBI transform mutated the native payload')
assert.equal(
    globalThis.__closedModeProxyCalls.length,
    proxyCallsBeforeFullMode,
    'full-mode WBI request must preserve the native signed request instead of invoking a proxy path',
)
assert.equal(fullModeWbiDelivery.native.url, fullModeWbiUrl, 'full-mode WBI request URL was rewritten')
assert.equal(fullModeWbiDelivery.native.method, 'POST', 'full-mode WBI request method was rewritten')
assert.equal(fullModeWbiDelivery.native.requestBody, 'full-mode-wbi-body', 'full-mode WBI request body was rewritten')
assert.doesNotMatch(
    JSON.stringify(globalThis.__closedModeFullPipelineCalls.slice(fullModeLogStart)),
    /must-not-log|video\.m4s|deadline=private/,
    'full-mode WBI logging exposed a signed media URL',
)

globalThis.__closedModeThrowFromCdn = true
const fullModeFailureUrl = 'https://api.bilibili.com/x/player/wbi/playurl?cid=9&w_rid=failure-signed&wts=2'
const fullModeFailureResponse = {
    code: 0,
    data: { dash: { video: [{ id: 80, baseUrl: fullModeSignedMediaUrl }] } },
}
const fullModeFailureSnapshot = structuredClone(fullModeFailureResponse)
const warningsBeforeFullModeFailure = globalThis.__closedModeWarnings.length
const fullModeFailureDelivery = sendNativeRequest(
    fullModeFailureUrl,
    fullModeFailureResponse,
    'full-mode-failure-body',
)
assert.strictEqual(fullModeFailureDelivery.response, fullModeFailureResponse, 'full-mode WBI failure must expose the native response')
assert.deepEqual(fullModeFailureResponse, fullModeFailureSnapshot, 'full-mode WBI failure partially mutated the native response')
assert.equal(fullModeFailureDelivery.native.url, fullModeFailureUrl, 'failed full-mode WBI request URL was rewritten')
assert.equal(fullModeFailureDelivery.native.method, 'POST', 'failed full-mode WBI request method was rewritten')
assert.equal(fullModeFailureDelivery.native.requestBody, 'full-mode-failure-body', 'failed full-mode WBI request body was rewritten')
assert.equal(globalThis.__closedModeWarnings.length, warningsBeforeFullModeFailure + 1, 'full-mode WBI failure should warn once')
globalThis.__closedModeThrowFromCdn = false

console.log('cdn closed-mode wiring tests passed')

function installBrowserGlobals() {
    const location = new URL('https://www.bilibili.com/video/BV1closed')
    const document = {
        location,
        getElementById() {
            return null
        },
    }
    const window = {
        XMLHttpRequest: NativeXMLHttpRequest,
        Promise,
        console,
        document,
        location,
        top: null,
        parent: null,
        jQuery: {
            ajax() {
                globalThis.__closedModeProxyCalls.push('jquery.ajax')
            },
        },
    }
    window.top = window
    window.parent = window

    globalThis.window = window
    globalThis.document = document
    globalThis.location = location
    globalThis.XMLHttpRequest = NativeXMLHttpRequest
    globalThis.GM_info = {
        script: {
            name: '解除B站区域限制.closed-mode-test',
        },
    }
}

function sendNativeRequest(url, response, body) {
    const xhr = new window.XMLHttpRequest()
    let deliveredResponse
    xhr.open('POST', url)
    xhr.onreadystatechange = function () {
        if (this.readyState === 4) {
            deliveredResponse = this.response
        }
    }
    xhr.send(body)
    NativeXMLHttpRequest.instances.at(-1).complete(response)
    return {
        response: deliveredResponse,
        xhr,
        native: NativeXMLHttpRequest.instances.at(-1),
    }
}

function countMainCall(name) {
    return globalThis.__closedModeMainCalls.filter(call => call === name).length
}

async function buildMainWiringModule() {
    const result = await build({
        entryPoints: [path.join(rootDir, 'packages/unblock-area-limit/src/main.ts')],
        bundle: true,
        format: 'esm',
        platform: 'node',
        target: 'node20',
        write: false,
        define: {
            invokeBy: JSON.stringify('closed-mode-wiring-test'),
            __BALH_BUILD_VERSION__: JSON.stringify('test-build'),
        },
        plugins: [mainWiringStubPlugin()],
    })
    const bundledSource = result.outputFiles[0].text
    return `data:text/javascript;base64,${Buffer.from(bundledSource).toString('base64')}`
}

async function assertClosedDefaultRuntimeDoesNotScheduleFinalDeliveryRecovery() {
    const result = await build({
        entryPoints: [path.join(rootDir, 'packages/unblock-area-limit/src/feature/bili/cdn_runtime.ts')],
        bundle: true,
        format: 'esm',
        platform: 'node',
        target: 'node20',
        write: false,
        plugins: [closedModeStubPlugin()],
    })
    const bundledSource = result.outputFiles[0].text
    const runtimeModuleUrl = `data:text/javascript;base64,${Buffer.from(bundledSource).toString('base64')}`
    const originalSetTimeout = globalThis.setTimeout
    const scheduledCallbacks = []
    globalThis.__closedModeRuntimeRecoveryPublications = []
    globalThis.setTimeout = (callback, delayMs) => {
        scheduledCallbacks.push({ callback, delayMs })
        return scheduledCallbacks.length
    }

    try {
        const { observeFinalCdnDelivery } = await import(`${runtimeModuleUrl}#explicit-close`)
        const finalDelivery = { dash: { video: [] } }
        assert.strictEqual(
            observeFinalCdnDelivery(finalDelivery),
            finalDelivery,
            'closed default runtime changed the final-delivery payload',
        )
        assert.equal(globalThis.__closedModeRuntimeRecoveryPublications.length, 1)
        assert.equal(
            globalThis.__closedModeRuntimeRecoveryPublications[0].enabled,
            false,
            'closed default runtime enabled recovery publication',
        )
        assert.equal(scheduledCallbacks.length, 0, 'closed final delivery scheduled an automatic CDN probe')
    } finally {
        globalThis.setTimeout = originalSetTimeout
    }
}

function mainWiringStubPlugin() {
    const stubs = new Map([
        ['./feature/config', `export const balh_config = globalThis.__closedModeConfig`],
        ['./util/cookie', `export const cookieStorage = { set() {}, get() {} }`],
        ['./util/log', `
            export const logHub = { getAllMsg() { return [] } }
            export function util_debug() {}
            export function util_info() {}
        `],
        ['./util/ui', `export const ui = { alert() {} }`],
        ['./feature/bili/index', `
            const called = name => globalThis.__closedModeMainCalls.push(name)
            export function version_remind() { called('version_remind') }
            export function switch_to_old_player() { called('switch_to_old_player') }
            export function area_limit_for_vue() { called('area_limit_for_vue') }
            export function hide_adblock_tips() { called('hide_adblock_tips') }
            export function area_limit_xhr() { called('area_limit_xhr') }
            export function installCdnRecoveryMonitor() { called('installCdnRecoveryMonitor') }
            export function installCdnFinalDeliveryObservers() { called('installCdnFinalDeliveryObservers') }
            export function remove_pre_ad() { called('remove_pre_ad') }
            export function check_html5() { called('check_html5') }
            export function redirect_to_bangumi_or_insert_player() { called('redirect_to_bangumi_or_insert_player') }
            export function fill_season_page() { called('fill_season_page') }
            export function settings() {
                called('settings')
                return { show() {}, setup() {} }
            }
            export function jump_to_baipiao() { called('jump_to_baipiao') }
            export function biliplus_check_area_limit() { called('biliplus_check_area_limit') }
            export function sanitizeDiagnosticText(value) { return value }
            export function createDiagnosticReport() { return {} }
            export function probeCurrentPlayUrlCdn() {}
            export function clearCdnHealthCache() {}
            export function getCdnProbeStatus() { return {} }
            export function getCdnRecoveryStatus() { return {} }
            export const bilibili_login = {
                isLogin() { return false },
                isLoginBiliBili() { return false },
                showLogin() {},
                showLogout() {},
            }
        `],
    ])

    return {
        name: 'closed-mode-main-wiring-stubs',
        setup(esbuild) {
            esbuild.onResolve({ filter: /.*/ }, args => {
                if (!stubs.has(args.path)) return undefined
                return { path: args.path, namespace: 'closed-mode-main-wiring' }
            })
            esbuild.onLoad({ filter: /.*/, namespace: 'closed-mode-main-wiring' }, args => ({
                contents: stubs.get(args.path),
                loader: 'js',
            }))
        },
    }
}

function closedModeStubPlugin() {
    const proxyFailure = `
        function proxyFailure(name) {
            globalThis.__closedModeProxyCalls.push(name)
            return globalThis.Promise.reject(new Error('proxy path invoked: ' + name))
        }
    `
    const stubs = new Map([
        ['../../util/objects', `export const Objects = { convertKeyToSnakeCase: value => value, stringify: String }`],
        ['../../util/converters', `
            export const Converters = { replaceUpos: value => value }
            export const uposMap = {}
        `],
        ['../../util/react', `export function _() { globalThis.__closedModeFullPipelineCalls.push('react') }`],
        ['../../util/async', `${proxyFailure}
            export const Async = {
                ajax: (...args) => proxyFailure('Async.ajax'),
                ajaxByXhr: (...args) => proxyFailure('Async.ajaxByXhr'),
                timeout: (...args) => proxyFailure('Async.timeout'),
            }
            export const Promise = globalThis.Promise
        `],
        ['../../feature/r', `
            export const r = {
                const: { mode: {}, server: {} },
                regex: { bilibili_api_proxy: { test: () => false } },
            }
            export const _t = value => value
        `],
        ['../../util/log', `
            export function util_warn(...args) { globalThis.__closedModeWarnings.push(args) }
            export function util_error(...args) { globalThis.__closedModeFullPipelineCalls.push(['util_error', ...args]) }
            export function log(...args) { globalThis.__closedModeFullPipelineCalls.push(['log', ...args]) }
            export function util_debug() {}
        `],
        ['../../util/cookie', `export const cookieStorage = { set() { globalThis.__closedModeFullPipelineCalls.push('cookie') } }`],
        ['../../feature/config', `
            export const balh_config = globalThis.__closedModeConfig
            export function isClosed() { return balh_config.is_closed || !balh_config.server_custom }
        `],
        ['../config', `export const balh_config = globalThis.__closedModeConfig`],
        ['../r', `export const FALSE = ''`],
        ['../../feature/page', `
            const called = name => () => {
                globalThis.__closedModeFullPipelineCalls.push('util_page.' + name)
                return false
            }
            export const util_page = new Proxy({}, { get: (_, name) => called(String(name)) })
        `],
        ['../../api/bilibili-utils', `${proxyFailure}
            export const access_key_param_if_exist = () => proxyFailure('access_key_param_if_exist')
            export const platform_android_param_if_app_only = () => proxyFailure('platform_android_param_if_app_only')
        `],
        ['../../api/biliplus', `${proxyFailure}
            export const generateMobiPlayUrlParams = () => proxyFailure('generateMobiPlayUrlParams')
            export const getMobiPlayUrl = () => proxyFailure('getMobiPlayUrl')
            export const fixMobiPlayUrlJson = () => proxyFailure('fixMobiPlayUrlJson')
            export const fixThailandPlayUrlJson = () => proxyFailure('fixThailandPlayUrlJson')
        `],
        ['../../util/ui', `export const ui = new Proxy({}, { get: (_, name) => () => globalThis.__closedModeFullPipelineCalls.push('ui.' + String(name)) })`],
        ['../../util/strings', `export const Strings = { getSearchParam() { globalThis.__closedModeFullPipelineCalls.push('Strings.getSearchParam') } }`],
        ['../../util/initiator', `export function util_init() { globalThis.__closedModeFullPipelineCalls.push('util_init') }`],
        ['../../util/message', `export const util_ui_msg = { showOnNetErrorInPromise() { globalThis.__closedModeFullPipelineCalls.push('util_ui_msg') } }`],
        ['../../util/regexps', `
            export const RegExps = {
                url(value) {
                    const escaped = value.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&')
                    return new RegExp('^(?:https?:)?\\\\/\\\\/' + escaped)
                },
                urlPath(value) {
                    return new RegExp(value)
                },
            }
        `],
        ['./bilibili_login', `export const bilibili_login = {}`],
        ['../../feature/bili/area_limit_fetch', `
            export function injectFetch(options = {}) { globalThis.__closedModeFetchInstalls.push(options) }
            export function injectFetch4Mobile() { globalThis.__closedModeFullPipelineCalls.push('injectFetch4Mobile') }
        `],
        ['../../feature/bili/space_account_info_map', `export default {}`],
        ['../../feature/bili/area_limit_for_vue', `export function removeEpAreaLimit() { globalThis.__closedModeFullPipelineCalls.push('removeEpAreaLimit') }`],
        ['./subtitle_web_view', `
            export const isSubtitleBodyUrl = () => false
            export const rewriteSubtitleBodyJson = value => value
            export const rewriteSubtitleMetadataUrl = () => null
            export const rewriteSubtitleWebViewResponse = () => null
        `],
        ['./cdn_playurl', `
            export function beginFinalCdnPlayUrlDelivery() { return 1 }
            export function observeFinalCdnPlayUrlResponse(value) { return value }
            export function deliverFinalCdnPlayUrlResponse(value, deliveryOrder, deliver) {
                return deliver(value)
            }
            export function findPlayUrlPayload(value) {
                const candidates = [
                    value?.result?.video_info,
                    value?.data?.video_info,
                    value?.video_info,
                    value?.result,
                    value?.data,
                    value,
                ]
                return candidates.find(candidate => candidate && (candidate.dash || candidate.durl))
            }
            export function applyCdnPolicyToPlayUrlResponse(value) {
                const payload = findPlayUrlPayload(value)
                globalThis.__closedModeCdnTransforms.push(value)
                if (globalThis.__closedModeThrowFromCdn) {
                    if (payload) payload.__partialMutation = true
                    throw new Error('synthetic CDN failure')
                }
                if (payload) payload.__cdnApplied = true
                return value
            }
        `],
        ['./cdn_selection', `
            export function collectPlayUrlCdnGroups() {
                return [{
                    key: 'dash-video:0',
                    kind: 'dash-video',
                    candidates: [{
                        url: 'https://closed-runtime.test.bilivideo.com/video.m4s?deadline=1',
                        host: 'closed-runtime.test.bilivideo.com',
                        hostname: 'closed-runtime.test.bilivideo.com',
                        riskKinds: [],
                    }],
                }]
            }
            export function optimizePlayUrlCdn() {
                return { changed: false, groups: 1, diagnostics: [] }
            }
        `],
        ['./cdn_recovery_browser', `
            export function publishCdnRecoveryGroups(groups, enabled) {
                globalThis.__closedModeRuntimeRecoveryPublications.push({ groups, enabled })
            }
            export function prepareCdnRecoveryRequestUrl(url) {
                return {
                    decision: { url, routed: false },
                    commit() { return this.decision },
                    discard() {},
                }
            }
        `],
        ['./log', `
            export function util_debug() {}
        `],
        ['./scripts', `export const Scripts = { isDev: false }`],
    ])

    return {
        name: 'closed-mode-wiring-stubs',
        setup(esbuild) {
            esbuild.onResolve({ filter: /.*/ }, args => {
                if (!stubs.has(args.path)) return undefined
                return { path: args.path, namespace: 'closed-mode-wiring' }
            })
            esbuild.onLoad({ filter: /.*/, namespace: 'closed-mode-wiring' }, args => ({
                contents: stubs.get(args.path),
                loader: 'js',
            }))
        },
    }
}
