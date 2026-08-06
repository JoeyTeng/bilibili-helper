#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(rootDir, '.codex-tmp/tests')
const outFile = path.join(outDir, 'fetch-response-compat.mjs')
const staleBodyHeaders = [
    'accept-ranges',
    'content-digest',
    'content-encoding',
    'content-length',
    'content-md5',
    'content-range',
    'digest',
    'etag',
    'last-modified',
    'repr-digest',
    'transfer-encoding',
]
const state = {
    binaryRewriteCalls: 0,
    cdnCalls: 0,
    metadataRewriteCalls: 0,
    proxyCalls: 0,
    throwFromCdn: false,
}
const config = {
    blocked_vip: true,
    cdn_mode: 'manual',
    generate_sub: true,
    server_custom: 'https://proxy.invalid',
    server_custom_cn: '',
    server_custom_hk: '',
    server_custom_tw: '',
    server_custom_th: '',
    upos_replace_akamai: 'Y',
    upos_server: 'ali',
}

globalThis.__fetchResponseCompatState = state
globalThis.__fetchResponseCompatConfig = config
installBrowserGlobals()

await mkdir(outDir, { recursive: true })
await build({
    stdin: {
        contents: `
            export { injectFetch, jsonResponse } from './packages/unblock-area-limit/src/feature/bili/area_limit_fetch.ts'
        `,
        resolveDir: rootDir,
        sourcefile: 'fetch-response-compat-entry.ts',
        loader: 'ts',
    },
    outfile: outFile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    plugins: [compatStubPlugin()],
})

const { injectFetch, jsonResponse } = await import(pathToFileURL(outFile).href)

await testJsonResponseCompatibility(jsonResponse)
await testBinarySubtitleResponseCompatibility(injectFetch)
await testCdnOnlyIsolation(injectFetch)
await testWbiFetchModes(injectFetch)

console.log('fetch response compatibility tests passed')

function installBrowserGlobals() {
    const location = new URL('https://www.bilibili.com/video/BV1compat')
    const document = {
        body: { textContent: '' },
        cookie: '',
        location,
        title: '',
        querySelector() {
            return null
        },
    }
    const localStorage = createStorage()
    const window = {
        Promise,
        console,
        document,
        fetch: globalThis.fetch.bind(globalThis),
        location,
        localStorage,
        top: null,
        parent: null,
    }
    window.top = window
    window.parent = window

    globalThis.window = window
    globalThis.document = document
    globalThis.location = location
    globalThis.localStorage = localStorage
}

function createStorage() {
    const values = new Map()
    return new Proxy({
        getItem(key) {
            return values.has(String(key)) ? values.get(String(key)) : null
        },
        setItem(key, value) {
            values.set(String(key), String(value))
        },
    }, {
        get(target, prop, receiver) {
            if (typeof prop === 'string' && !(prop in target)) return values.get(prop)
            return Reflect.get(target, prop, receiver)
        },
        set(target, prop, value, receiver) {
            if (typeof prop === 'string' && !(prop in target)) {
                values.set(prop, String(value))
                return true
            }
            return Reflect.set(target, prop, value, receiver)
        },
    })
}

function compatStubPlugin() {
    return {
        name: 'fetch-response-compat-stubs',
        setup(esbuild) {
            esbuild.onResolve({ filter: /.*/ }, args => {
                const stub = stubName(args.path)
                return stub ? { path: stub, namespace: 'fetch-compat' } : undefined
            })
            esbuild.onLoad({ filter: /.*/, namespace: 'fetch-compat' }, args => ({
                contents: stubContents(args.path),
                loader: 'js',
            }))
        },
    }
}

function stubName(specifier) {
    if (specifier.endsWith('/api/bilibili-utils')) return 'bilibili-utils'
    if (specifier.endsWith('/api/biliplus')) return 'biliplus'
    if (specifier.endsWith('/util/async')) return 'async'
    if (specifier.endsWith('/util/log')) return 'log'
    if (specifier.endsWith('/util/objects')) return 'objects'
    if (specifier.endsWith('/util/strings')) return 'strings'
    if (specifier.endsWith('/feature/config')) return 'config'
    if (specifier === '../config') return 'config'
    if (specifier.endsWith('/feature/r')) return 'r'
    if (specifier === '../r') return 'r'
    if (specifier.endsWith('/feature/bili/cdn_playurl') || specifier === './cdn_playurl') return 'cdn-playurl'
    if (specifier.endsWith('/feature/bili/subtitle_web_view') || specifier === './subtitle_web_view') return 'subtitle'
    if (specifier.endsWith('/feature/bili/space_account_info_map') || specifier === './space_account_info_map') return 'space-map'
    return undefined
}

function stubContents(name) {
    switch (name) {
        case 'bilibili-utils':
            return `export function access_key_param_if_exist() { return '' }`
        case 'biliplus':
            return `
                export const BiliPlusApi = { playurl() {}, playurl_for_mp4() {} }
                export function fixMobiPlayUrlJson(value) { return value }
                export function fixThailandPlayUrlJson(value) { return value }
                export function generateMobiPlayUrlParams() { return '' }
                export function getMobiPlayUrl() { return '' }
            `
        case 'async':
            return `
                export const Promise = globalThis.Promise
                export const Async = {
                    ajaxByXhr() {
                        globalThis.__fetchResponseCompatState.proxyCalls += 1
                        return globalThis.Promise.reject(new Error('unexpected proxy request'))
                    },
                    timeout() { return globalThis.Promise.resolve() },
                    wrapper(promise, success, failure) { return globalThis.Promise.resolve(promise).then(success, failure) },
                }
            `
        case 'log':
            return `
                const noop = () => {}
                export { noop as log, noop as util_debug, noop as util_warn }
            `
        case 'objects':
            return `export const Objects = { convertKeyToSnakeCase() {} }`
        case 'strings':
            return `export const Strings = { getSearchParam() { return '' } }`
        case 'config':
            return `export const balh_config = globalThis.__fetchResponseCompatConfig`
        case 'r':
            return `export const r = { regex: { bilibili_api_proxy: /^$/ } }`
        case 'cdn-playurl':
            return `
                export function applyCdnPolicyToPlayUrlResponse(value) {
                    globalThis.__fetchResponseCompatState.cdnCalls += 1
                    const candidates = [
                        value?.result?.video_info,
                        value?.data?.video_info,
                        value?.video_info,
                        value?.result,
                        value?.data,
                        value,
                    ]
                    const payload = candidates.find(candidate => candidate && (candidate.dash || candidate.durl))
                    if (globalThis.__fetchResponseCompatState.throwFromCdn) {
                        if (payload) payload.partialCdnMutation = true
                        throw new Error('synthetic CDN policy failure')
                    }
                    if (payload) payload.cdnApplied = true
                    return value
                }
            `
        case 'subtitle':
            return `
                export function isSubtitleBodyUrl(url) { return url.includes('/bfs/subtitle/') }
                export function rewriteSubtitleBodyJson() { return null }
                export function rewriteSubtitleMetadataUrl() {
                    globalThis.__fetchResponseCompatState.metadataRewriteCalls += 1
                    return undefined
                }
                export function rewriteSubtitleWebViewResponse() {
                    globalThis.__fetchResponseCompatState.binaryRewriteCalls += 1
                    return new Uint8Array([9, 8, 7, 6])
                }
            `
        case 'space-map':
            return `export default {}`
        default:
            throw new Error(`Missing stub contents for ${name}`)
    }
}

async function testJsonResponseCompatibility(jsonResponse) {
    const metadata = {
        url: 'https://cdn.example/final.json',
        redirected: true,
        type: 'cors',
    }
    const origin = responseWithMetadata('origin', metadata, 'text/plain')
    const rewritten = jsonResponse({ ok: true }, origin)

    assertRebuiltResponse(rewritten, origin, metadata, 'application/json; charset=utf-8')
    const finalGeneration = assertCloneMetadata(rewritten, metadata, 64)
    assert.deepEqual(await finalGeneration.json(), { ok: true })

    const other = new Response('other body', {
        headers: { 'x-other': 'yes' },
        status: 201,
        statusText: 'Created',
    })
    const otherClone = rewritten.clone.call(other)
    assert.equal(await otherClone.text(), 'other body')
    assert.equal(otherClone.status, 201)
    assert.equal(otherClone.headers.get('x-other'), 'yes')

    const otherMetadata = {
        url: 'https://cdn.example/other.json',
        redirected: false,
        type: 'basic',
    }
    const otherRewritten = jsonResponse({ source: 'other' }, responseWithMetadata('other', otherMetadata, 'text/plain'))
    const reboundClone = rewritten.clone.call(otherRewritten)
    assertMetadata(reboundClone, otherMetadata, 'clone called with another rebuilt response')
    assert.deepEqual(await reboundClone.json(), { source: 'other' })

    assert.throws(
        () => rewritten.clone.call({}),
        TypeError,
        'clone should preserve the native invalid-receiver failure',
    )
}

async function testBinarySubtitleResponseCompatibility(injectFetch) {
    resetState()
    const url = 'https://api.bilibili.com/x/v2/subtitle/web/view?aid=1&cid=2'
    const metadata = {
        url: `${url}&final=1`,
        redirected: true,
        type: 'cors',
    }
    const origin = responseWithMetadata(new Uint8Array([1, 2, 3]), metadata, 'application/x-protobuf')
    const receiver = { name: 'receiver-sensitive outer fetch' }
    const init = { credentials: 'include' }
    let predecessorCalls = 0

    window.fetch = async function (input, requestInit) {
        predecessorCalls += 1
        assert.equal(this, receiver, 'captured predecessor fetch should receive the wrapper call receiver')
        assert.equal(input, url)
        assert.equal(requestInit, init)
        return origin
    }
    injectFetch()

    const rewritten = await window.fetch.call(receiver, url, init)
    assert.equal(predecessorCalls, 1)
    assert.equal(state.binaryRewriteCalls, 1)
    assertRebuiltResponse(rewritten, origin, metadata, 'application/x-protobuf')
    const finalGeneration = assertCloneMetadata(rewritten, metadata, 64)
    assert.deepEqual([...new Uint8Array(await finalGeneration.arrayBuffer())], [9, 8, 7, 6])
}

async function testCdnOnlyIsolation(injectFetch) {
    resetState()
    const responses = []
    const receiver = { name: 'closed-mode fetch receiver' }
    window.fetch = async function (input) {
        assert.equal(this, receiver)
        const url = String(input)
        let response
        if (url.includes('/playurl')) {
            const playUrlEnvelope = url.includes('/x/player/wbi/playurl')
                ? {
                    code: 0,
                    message: '0',
                    ttl: 1,
                    data: { dash: { video: [], audio: [] } },
                }
                : {
                    code: 0,
                    result: {
                        video_info: {
                            dash: { video: [], audio: [] },
                        },
                    },
                }
            response = responseWithMetadata(
                url.includes('malformed=1')
                    ? '{"code":0,"result":'
                    : JSON.stringify(playUrlEnvelope), {
                    url,
                    redirected: false,
                    type: 'cors',
                }, 'application/json')
        } else {
            response = responseWithMetadata(new Uint8Array([1, 2, 3]), {
                url,
                redirected: false,
                type: 'cors',
            }, 'application/x-protobuf')
        }
        responses.push(response)
        return response
    }
    injectFetch({ cdnOnly: true })

    for (const { url, payload } of [
        {
            url: 'https://api.bilibili.com/pgc/player/web/playurl?ep_id=1',
            payload: json => json.result.video_info,
        },
        {
            url: 'https://api.bilibili.com/x/player/playurl?cid=1',
            payload: json => json.result.video_info,
        },
        {
            url: 'https://api.bilibili.com/x/player/wbi/playurl?cid=1&w_rid=signed&wts=1',
            payload: json => json.data,
        },
    ]) {
        const response = await window.fetch.call(receiver, url)
        const json = await response.json()
        assert.equal(payload(json).cdnApplied, true, `${url}: CDN transform should run`)
    }
    assert.equal(state.cdnCalls, 3)
    assert.equal(state.proxyCalls, 0, 'CDN-only fetch must not attempt a PGC proxy')

    const malformedUrl = 'https://api.bilibili.com/x/player/playurl?cid=2&malformed=1'
    const malformedResponse = await window.fetch.call(receiver, malformedUrl)
    assert.strictEqual(malformedResponse, responses.at(-1), 'malformed JSON must return the predecessor response')
    assert.equal(await malformedResponse.text(), '{"code":0,"result":')

    state.throwFromCdn = true
    const policyFailureUrl = 'https://api.bilibili.com/x/player/playurl?cid=3'
    const policyFailureResponse = await window.fetch.call(receiver, policyFailureUrl)
    assert.strictEqual(policyFailureResponse, responses.at(-1), 'CDN policy failure must return the predecessor response')
    assert.deepEqual(await policyFailureResponse.json(), {
        code: 0,
        result: {
            video_info: {
                dash: { video: [], audio: [] },
            },
        },
    }, 'CDN policy failure must not partially mutate the predecessor body')
    state.throwFromCdn = false
    assert.equal(state.cdnCalls, 4)

    const subtitleUrl = 'https://api.bilibili.com/x/v2/subtitle/web/view?aid=1&cid=2'
    const subtitleResponse = await window.fetch.call(receiver, subtitleUrl)
    assert.equal(subtitleResponse, responses.at(-1), 'CDN-only subtitle response should retain native identity')

    const accountUrl = 'https://api.bilibili.com/x/space/wbi/acc/info?mid=11783021'
    const accountResponse = await window.fetch.call(receiver, accountUrl)
    assert.equal(accountResponse, responses.at(-1), 'CDN-only account response should retain native identity')
    assert.equal(state.binaryRewriteCalls, 0, 'CDN-only fetch must not rewrite subtitle bodies')
    assert.equal(state.metadataRewriteCalls, 0, 'CDN-only fetch must not rewrite subtitle request URLs')
}

async function testWbiFetchModes(injectFetch) {
    for (const mode of [
        { label: 'full', options: undefined },
        { label: 'CDN-only', options: { cdnOnly: true } },
    ]) {
        resetState()
        const receiver = { name: `${mode.label} WBI receiver` }
        const calls = []
        const responses = []
        const signedMediaUrl = 'https://fetch-wbi.test.bilivideo.com/video.m4s?deadline=private&token=preserve'
        window.fetch = async function (input, init) {
            assert.equal(this, receiver, `${mode.label}: predecessor receiver changed`)
            calls.push({ input, init })
            const envelope = {
                code: 0,
                message: '0',
                ttl: 1,
                data: { dash: { video: [{ id: 80, baseUrl: signedMediaUrl }], audio: [] } },
            }
            const response = responseWithMetadata(JSON.stringify(envelope), {
                url: String(input),
                redirected: false,
                type: 'cors',
            }, 'application/json')
            responses.push(response)
            return response
        }
        injectFetch(mode.options)

        const successUrl = 'https://api.bilibili.com/x/player/wbi/playurl?cid=11&w_rid=success-signed&wts=101'
        const successInit = {
            method: 'POST',
            body: 'signed-request-body',
            headers: { 'x-request-fixture': 'preserve' },
        }
        const successResponse = await window.fetch.call(receiver, successUrl, successInit)
        assert.equal(calls[0].input, successUrl, `${mode.label}: WBI URL changed`)
        assert.strictEqual(calls[0].init, successInit, `${mode.label}: WBI init changed`)
        assert.notStrictEqual(successResponse, responses[0], `${mode.label}: successful WBI response was not rebuilt`)
        const successJson = await successResponse.json()
        assert.equal(successJson.data.cdnApplied, true, `${mode.label}: WBI CDN transform did not run`)
        assert.equal(successJson.data.dash.video[0].baseUrl, signedMediaUrl, `${mode.label}: signed media URL changed`)

        state.throwFromCdn = true
        const failureUrl = 'https://api.bilibili.com/x/player/wbi/playurl?cid=12&w_rid=failure-signed&wts=102'
        const failureInit = {
            method: 'POST',
            body: 'failure-request-body',
            headers: { 'x-request-fixture': 'preserve-failure' },
        }
        const failureResponse = await window.fetch.call(receiver, failureUrl, failureInit)
        assert.equal(calls[1].input, failureUrl, `${mode.label}: failed WBI URL changed`)
        assert.strictEqual(calls[1].init, failureInit, `${mode.label}: failed WBI init changed`)
        assert.strictEqual(failureResponse, responses[1], `${mode.label}: WBI failure did not return the predecessor response`)
        assert.deepEqual(await failureResponse.json(), {
            code: 0,
            message: '0',
            ttl: 1,
            data: {
                dash: {
                    video: [{ id: 80, baseUrl: signedMediaUrl }],
                    audio: [],
                },
            },
        }, `${mode.label}: WBI failure partially mutated the predecessor body`)
        assert.equal(state.cdnCalls, 2, `${mode.label}: unexpected WBI CDN transform count`)
        assert.equal(state.proxyCalls, 0, `${mode.label}: signed WBI request entered a proxy path`)
    }
}

function responseWithMetadata(body, metadata, contentType) {
    const headers = new Headers({
        'cache-control': 'private, max-age=60',
        'content-language': 'zh-CN',
        'content-type': contentType,
        'x-relevant': 'preserved',
    })
    for (const header of staleBodyHeaders) headers.set(header, staleHeaderValue(header))
    const response = new Response(body, {
        headers,
        status: 206,
        statusText: 'Partial Content',
    })
    for (const [key, value] of Object.entries(metadata)) {
        Object.defineProperty(response, key, { configurable: true, value })
    }
    return response
}

function staleHeaderValue(header) {
    if (header === 'content-length') return '9999'
    if (header === 'content-range') return 'bytes 0-2/9999'
    if (header === 'accept-ranges') return 'bytes'
    if (header === 'content-encoding') return 'gzip'
    if (header === 'transfer-encoding') return 'chunked'
    if (header === 'last-modified') return 'Tue, 04 Aug 2026 00:00:00 GMT'
    return 'stale-validator'
}

function assertRebuiltResponse(rewritten, origin, metadata, expectedContentType) {
    assert.equal(rewritten.status, origin.status)
    assert.equal(rewritten.statusText, origin.statusText)
    assert.equal(rewritten.headers.get('content-type'), expectedContentType)
    assert.equal(rewritten.headers.get('cache-control'), origin.headers.get('cache-control'))
    assert.equal(rewritten.headers.get('content-language'), origin.headers.get('content-language'))
    assert.equal(rewritten.headers.get('x-relevant'), 'preserved')
    for (const header of staleBodyHeaders) {
        assert.equal(rewritten.headers.get(header), null, `${header} must be removed after a body rewrite`)
        assert.notEqual(origin.headers.get(header), null, `${header} should not be removed from the origin response`)
    }
    assertMetadata(rewritten, metadata, 'rebuilt response')
}

function assertCloneMetadata(response, metadata, generations) {
    let generation = response
    for (let index = 0; index < generations; index += 1) {
        assertMetadata(generation, metadata, `clone generation ${index}`)
        generation = generation.clone()
    }
    assertMetadata(generation, metadata, `clone generation ${generations}`)
    return generation
}

function assertMetadata(response, metadata, label) {
    assert.equal(response.url, metadata.url, `${label}: url`)
    assert.equal(response.redirected, metadata.redirected, `${label}: redirected`)
    assert.equal(response.type, metadata.type, `${label}: type`)
}

function resetState() {
    state.binaryRewriteCalls = 0
    state.cdnCalls = 0
    state.metadataRewriteCalls = 0
    state.proxyCalls = 0
    state.throwFromCdn = false
}
