#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(rootDir, '.codex-tmp/tests')
const xhrOutFile = path.join(outDir, 'xhr-proxy-race.mjs')
const integrationOutFile = path.join(outDir, 'playurl-integration.mjs')

const config = {
    blocked_vip: false,
    cdn_mode: 'manual',
    upos_server: 'ali',
    upos_replace_akamai: 'Y',
    server_custom: '',
    server_custom_cn: '',
    server_custom_hk: '',
    server_custom_tw: '',
    server_custom_th: '',
    server_bilibili_api_proxy: undefined,
}

globalThis.__balhTestConfig = config
installBrowserGlobals()
installPromiseCompose()

await mkdir(outDir, { recursive: true })
await Promise.all([
    build({
        entryPoints: [path.join(rootDir, 'packages/unblock-area-limit/src/util/inject-xhr.ts')],
        outfile: xhrOutFile,
        bundle: true,
        format: 'esm',
        platform: 'browser',
        target: 'es2020',
    }),
    build({
        stdin: {
            contents: `
                export { injectFetch, jsonResponse } from './packages/unblock-area-limit/src/feature/bili/area_limit_fetch.ts'
                export { fixThailandPlayUrlJson } from './packages/unblock-area-limit/src/api/biliplus.ts'
                export {
                    applyCdnPolicyToPlayUrlResponse,
                    observeFinalCdnPlayUrlResponse,
                } from './packages/unblock-area-limit/src/feature/bili/cdn_playurl.ts'
                export { clearCdnHealthCache, getCdnProbeStatus } from './packages/unblock-area-limit/src/feature/bili/cdn_runtime.ts'
            `,
            resolveDir: rootDir,
            sourcefile: 'playurl-integration-entry.ts',
            loader: 'ts',
        },
        outfile: integrationOutFile,
        bundle: true,
        format: 'esm',
        platform: 'node',
        target: 'node20',
        plugins: [integrationStubPlugin()],
    }),
])

const { injectXhr } = await import(pathToFileURL(xhrOutFile).href)
await testXhrProxyRaces(injectXhr)

const {
    applyCdnPolicyToPlayUrlResponse,
    clearCdnHealthCache,
    fixThailandPlayUrlJson,
    getCdnProbeStatus,
    injectFetch,
    jsonResponse,
    observeFinalCdnPlayUrlResponse,
} = await import(pathToFileURL(integrationOutFile).href)
testWbiEnvelopeCandidateCapture(
    applyCdnPolicyToPlayUrlResponse,
    observeFinalCdnPlayUrlResponse,
    clearCdnHealthCache,
    getCdnProbeStatus,
)
await testFetchPgcFallbackCdnPolicy(injectFetch)
await testThailandUposMode(fixThailandPlayUrlJson, applyCdnPolicyToPlayUrlResponse)
await testJsonResponseCloneMetadata(jsonResponse)

console.log('playurl integration tests passed')

function installBrowserGlobals() {
    const location = new URL('https://www.bilibili.com/video/BV1test')
    const localStorage = createStorage()
    const document = {
        cookie: '',
        location,
        title: '',
        getElementById() {
            return null
        },
        querySelector() {
            return null
        },
    }
    const window = {
        Promise,
        fetch: globalThis.fetch.bind(globalThis),
        console,
        document,
        location,
        localStorage,
        top: null,
        parent: null,
        addEventListener() { },
        postMessage() { },
    }
    window.top = window
    window.parent = window

    globalThis.window = window
    globalThis.document = document
    globalThis.location = location
    globalThis.localStorage = localStorage
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: {},
    })
    globalThis.GM_info = {
        script: {
            name: '解除B站区域限制.test',
        },
    }
}

function installPromiseCompose() {
    if (typeof Promise.prototype.compose === 'function') return
    Object.defineProperty(Promise.prototype, 'compose', {
        configurable: true,
        writable: true,
        value(transformer) {
            return transformer ? transformer(this) : this
        },
    })
}

function createStorage(initial = {}) {
    const values = new Map(Object.entries(initial).map(([key, value]) => [key, String(value)]))
    const storage = {
        getItem(key) {
            return values.has(String(key)) ? values.get(String(key)) : null
        },
        setItem(key, value) {
            values.set(String(key), String(value))
        },
        removeItem(key) {
            values.delete(String(key))
        },
        clear() {
            values.clear()
        },
    }
    return new Proxy(storage, {
        get(target, prop, receiver) {
            if (typeof prop === 'string' && !(prop in target)) {
                return values.get(prop)
            }
            return Reflect.get(target, prop, receiver)
        },
        set(target, prop, value, receiver) {
            if (typeof prop === 'string' && !(prop in target)) {
                values.set(prop, String(value))
                return true
            }
            return Reflect.set(target, prop, value, receiver)
        },
        deleteProperty(target, prop) {
            if (typeof prop === 'string' && !(prop in target)) {
                return values.delete(prop)
            }
            return Reflect.deleteProperty(target, prop)
        },
    })
}

function integrationStubPlugin() {
    return {
        name: 'playurl-integration-stubs',
        setup(esbuild) {
            esbuild.onResolve({ filter: /.*/ }, args => {
                if (isConfigImport(args.path, args.importer)) {
                    return { path: 'config', namespace: 'playurl-test' }
                }
                if (args.path.endsWith('/feature/bili/bilibili_login')) {
                    return { path: 'bilibili-login', namespace: 'playurl-test' }
                }
                if (args.path.endsWith('/util/inject-xhr')) {
                    return { path: 'inject-xhr', namespace: 'playurl-test' }
                }
                if (/(^|\/)log$/.test(args.path)) {
                    return { path: 'log', namespace: 'playurl-test' }
                }
                return undefined
            })
            esbuild.onLoad({ filter: /.*/, namespace: 'playurl-test' }, args => {
                if (args.path === 'config') {
                    return {
                        contents: `
                            export const balh_config = globalThis.__balhTestConfig
                            export function isClosed() { return false }
                        `,
                        loader: 'js',
                    }
                }
                if (args.path === 'bilibili-login') {
                    return {
                        contents: `
                            export const bilibili_login = {
                                clearLoginFlag() {},
                                isLogin() { return false },
                                isLoginBiliBili() { return false },
                                showLogin() {},
                                showLogout() {},
                            }
                        `,
                        loader: 'js',
                    }
                }
                if (args.path === 'inject-xhr') {
                    return {
                        contents: `
                            export function addNoRefererHost() {}
                            export function injectXhr() {}
                        `,
                        loader: 'js',
                    }
                }
                return {
                    contents: `
                        const noop = () => {}
                        export { noop as log, noop as util_log, noop as util_info, noop as util_debug, noop as util_warn, noop as util_error }
                        export const logHub = { msg: noop, getAllMsg: () => '' }
                    `,
                    loader: 'js',
                }
            })
        },
    }
}

function isConfigImport(specifier, importer) {
    if (specifier.endsWith('/feature/config')) return true
    return specifier === '../config' && importer.includes('/feature/')
}

async function testXhrProxyRaces(injectXhr) {
    const urls = [
        'https://api.bilibili.com/x/player/playurl?cid=1',
        'https://api.bilibili.com/pgc/player/web/playurl?cid=1',
    ]
    for (const url of urls) {
        await testProxySuccessBeforeNative(injectXhr, url)
        await testNativeBeforeProxyFailure(injectXhr, url)
    }
}

async function testProxySuccessBeforeNative(injectXhr, url) {
    const request = createDeferred()
    const NativeXMLHttpRequest = createManualNativeXhr()
    window.XMLHttpRequest = NativeXMLHttpRequest
    let transformResponseCalls = 0
    injectXhr({
        transformRequest() {
            return request.promise
        },
        transformResponse() {
            transformResponseCalls += 1
            return { source: 'native-transformed' }
        },
    })

    const xhr = new window.XMLHttpRequest()
    const callbackResponses = []
    xhr.open('GET', url)
    xhr.onreadystatechange = function () {
        callbackResponses.push(this.response)
    }
    xhr.send()

    const proxyResponse = { source: 'proxy' }
    request.resolve(proxyResponse)
    await flushPromises()
    assert.deepEqual(callbackResponses, [], `${url}: proxy response must wait for native completion metadata`)

    const nativeResponse = { source: 'native' }
    NativeXMLHttpRequest.instances[0].complete(nativeResponse)
    await flushPromises()
    assert.deepEqual(callbackResponses, [proxyResponse], `${url}: proxy response should publish once after native completion`)
    assert.equal(xhr.response, proxyResponse, `${url}: native response must not replace proxy response`)
    assert.equal(transformResponseCalls, 0, `${url}: blocked native response must not enter transformResponse`)
    assert.deepEqual(nativeResponse, { source: 'native' }, `${url}: blocked native response must not be mutated`)
}

async function testNativeBeforeProxyFailure(injectXhr, url) {
    const request = createDeferred()
    const NativeXMLHttpRequest = createManualNativeXhr()
    window.XMLHttpRequest = NativeXMLHttpRequest
    let transformResponseCalls = 0
    injectXhr({
        transformRequest() {
            return request.promise
        },
        transformResponse() {
            transformResponseCalls += 1
            return { source: 'native-transformed' }
        },
    })

    const xhr = new window.XMLHttpRequest()
    const callbackResponses = []
    xhr.open('GET', url)
    xhr.onreadystatechange = function () {
        callbackResponses.push(this.response)
    }
    xhr.send()

    const nativeResponse = { source: 'native-fallback' }
    NativeXMLHttpRequest.instances[0].complete(nativeResponse)
    await flushPromises()
    assert.equal(callbackResponses.length, 0, `${url}: native response must wait for proxy outcome`)
    assert.equal(transformResponseCalls, 0, `${url}: pending native fallback must not enter transformResponse`)

    request.reject(new Error('proxy unavailable'))
    await flushPromises()
    assert.deepEqual(callbackResponses, [nativeResponse], `${url}: proxy failure should publish saved native response`)
    assert.equal(xhr.response, nativeResponse, `${url}: saved native response should remain available after fallback`)
}

function createManualNativeXhr() {
    return class NativeXMLHttpRequest extends EventTarget {
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

        send() { }

        complete(response) {
            this.response = response
            this.responseText = JSON.stringify(response)
            this.responseURL = new URL(this.url, document.location.href).href
            this.readyState = 4
            this.dispatchEvent(new Event('readystatechange'))
        }
    }
}

function createDeferred() {
    let resolve
    let reject
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
    })
    return { promise, resolve, reject }
}

function flushPromises() {
    return new Promise(resolve => setTimeout(resolve, 0))
}

function testWbiEnvelopeCandidateCapture(applyPolicy, observeFinal, clearHealth, getStatus) {
    config.cdn_mode = 'original'
    clearHealth()
    const signedUrl = 'https://wbi.test.bilivideo.com/media.m4s?w_rid=private&wts=1'
    const response = {
        code: 0,
        message: '0',
        ttl: 1,
        data: {
            dash: {
                video: [{ base_url: signedUrl, backup_url: [] }],
                audio: [],
            },
        },
    }
    const snapshot = structuredClone(response)
    assert.strictEqual(applyPolicy(response), response)
    assert.deepEqual(response, snapshot, 'original mode must preserve the WBI playurl envelope')
    assert.deepEqual(
        getStatus().candidateHosts,
        [],
        'inner policy transform must defer runtime publication until final delivery',
    )
    assert.strictEqual(observeFinal(response), response)
    assert.deepEqual(getStatus().candidateHosts, ['wbi.test.bilivideo.com'])
}

async function testFetchPgcFallbackCdnPolicy(injectFetch) {
    config.blocked_vip = false
    config.cdn_mode = 'manual'
    config.upos_server = 'ali'
    config.upos_replace_akamai = 'Y'
    const sourceUrl = 'https://origin.example/video/30080.m4s?token=fallback'
    const originJson = {
        code: -404,
        message: 'restricted',
        result: {
            dash: {
                video: [{ base_url: sourceUrl, backup_url: [] }],
                audio: [],
            },
        },
    }
    window.fetch = async () => new Response(JSON.stringify(originJson), {
        headers: { 'content-type': 'application/json' },
        status: 200,
    })
    injectFetch()

    const response = await window.fetch('https://api.bilibili.com/pgc/player/web/playurl?cid=1')
    const fallback = await response.json()
    assert.equal(
        new URL(fallback.result.dash.video[0].base_url).hostname,
        'upos-sz-mirrorali.bilivideo.com',
        'PGC non-entitlement proxy failure should apply the shared CDN policy to origin JSON',
    )
}

async function testThailandUposMode(fixThailandPlayUrlJson, applyCdnPolicyToPlayUrlResponse) {
    config.upos_server = 'ali'
    config.cdn_mode = 'safe'
    window.__segment_base_map__ = createSegmentBaseMap()
    const safeResult = await fixThailandPlayUrlJson(createThailandPlayUrl())
    assertThailandHosts(safeResult, 'upos-sz-mirrorhw.bilivideo.com', 'safe mode should ignore residual manual UPOS')
    const safeNormalizedHosts = collectThailandHosts(safeResult)
    applyCdnPolicyToPlayUrlResponse(safeResult)
    assert.deepEqual(
        [...collectThailandHosts(safeResult)].filter(host => !safeNormalizedHosts.has(host)),
        [],
        'safe delivery must not synthesize a new Thailand CDN host',
    )

    config.cdn_mode = 'manual'
    window.__segment_base_map__ = createSegmentBaseMap()
    const manualResult = await fixThailandPlayUrlJson(createThailandPlayUrl())
    assertThailandHosts(manualResult, 'upos-sz-mirrorhw.bilivideo.com', 'Thailand normalization should remain mode-neutral')
    applyCdnPolicyToPlayUrlResponse(manualResult)
    assertThailandAllHosts(manualResult, 'upos-sz-mirrorali.bilivideo.com', 'manual Akamai gate should select the configured UPOS at delivery')

    config.upos_replace_akamai = 'N'
    window.__segment_base_map__ = createSegmentBaseMap()
    const gatedResult = await fixThailandPlayUrlJson(createThailandPlayUrl({ includeBackupUrls: false }))
    assertThailandHosts(gatedResult, 'upos-sz-mirrorhw.bilivideo.com', 'manual Akamai gate should normalize through hw')
    assert.equal(
        collectThailandHosts(gatedResult).has('upos-hz-mirrorakam.akamaized.net'),
        true,
        'Thailand normalization should preserve the source Akamai candidate for the delivery gate',
    )
    const gatedSnapshot = structuredClone(gatedResult)
    applyCdnPolicyToPlayUrlResponse(gatedResult)
    assertThailandHosts(gatedResult, 'upos-sz-mirrorhw.bilivideo.com', 'shared manual delivery must preserve the Akamai gate')
    assert.deepEqual(gatedResult, gatedSnapshot, 'manual Akamai gate must be payload-level all-or-nothing')
}

function createThailandPlayUrl({ includeBackupUrls = true } = {}) {
    const akamai = 'https://upos-hz-mirrorakam.akamaized.net'
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
                    base_url: `${akamai}/audio/30280.m4s?token=audio`,
                    ...(includeBackupUrls ? { backup_url: [`${akamai}/audio/30280.m4s?token=audio-backup`] } : {}),
                }],
                stream_list: [{
                    stream_info: {
                        description: '1080P',
                        display_desc: '1080P',
                        new_description: '1080P',
                        quality: 80,
                    },
                    dash_video: {
                        audio_id: 30280,
                        bandwidth: 1_000_000,
                        base_url: `${akamai}/video/30080.m4s?token=video`,
                        ...(includeBackupUrls ? { backup_url: [`${akamai}/video/30080.m4s?token=video-backup`] } : {}),
                        codecid: 7,
                    },
                }],
            },
        },
    }
}

function createSegmentBaseMap() {
    return {
        30080: ['0-1', '2-3'],
        30280: ['0-1', '2-3'],
    }
}

function assertThailandHosts(result, expectedHost, message) {
    assert.equal(new URL(result.dash.video[0].base_url).hostname, expectedHost, `${message} (video)`)
    assert.equal(new URL(result.dash.audio[0].base_url).hostname, expectedHost, `${message} (audio)`)
}

function collectThailandHosts(result) {
    const urls = [...result.dash.video, ...result.dash.audio].flatMap(stream => [
        stream.base_url,
        ...(stream.backup_url || []),
    ])
    return new Set(urls.map(url => new URL(url).hostname))
}

function assertThailandAllHosts(result, expectedHost, message) {
    assert.deepEqual([...collectThailandHosts(result)], [expectedHost], message)
}

async function testJsonResponseCloneMetadata(jsonResponse) {
    const origin = new Response('origin', {
        headers: { 'x-origin': 'yes' },
        status: 206,
        statusText: 'Partial Content',
    })
    const metadata = {
        url: 'https://cdn.example/final.json',
        redirected: true,
        type: 'cors',
    }
    for (const [key, value] of Object.entries(metadata)) {
        Object.defineProperty(origin, key, { configurable: true, value })
    }

    const rewritten = jsonResponse({ ok: true }, origin)
    let generation = rewritten
    for (let index = 0; index < 12; index += 1) {
        assert.equal(generation.url, metadata.url, `clone generation ${index} should preserve url`)
        assert.equal(generation.redirected, metadata.redirected, `clone generation ${index} should preserve redirected`)
        assert.equal(generation.type, metadata.type, `clone generation ${index} should preserve type`)
        generation = generation.clone()
    }
    assert.deepEqual(await generation.json(), { ok: true })
    assert.equal(rewritten.status, origin.status)
    assert.equal(rewritten.statusText, origin.statusText)
    assert.equal(rewritten.headers.get('x-origin'), 'yes')
}
