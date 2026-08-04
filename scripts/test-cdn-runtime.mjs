#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(rootDir, '.codex-tmp/tests')
const outFile = path.join(outDir, 'cdn-runtime.mjs')

await mkdir(outDir, { recursive: true })
await build({
    entryPoints: [path.join(rootDir, 'packages/unblock-area-limit/src/feature/bili/cdn_runtime.ts')],
    outfile: outFile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
})

class MemoryStorage {
    constructor(initial = {}) {
        this.values = new Map(Object.entries(initial))
        this.setCalls = 0
    }

    getItem(key) {
        return this.values.get(key) ?? null
    }

    setItem(key, value) {
        this.setCalls += 1
        this.values.set(key, String(value))
    }

    removeItem(key) {
        this.values.delete(key)
    }
}

const capturedFetchCalls = []
const capturedFetchImpl = async (url, init) => {
    capturedFetchCalls.push({ url, init })
    return streamResponse([new Uint8Array(4)])
}
globalThis.fetch = capturedFetchImpl
globalThis.localStorage = new MemoryStorage()
globalThis.location = new URL('https://www.bilibili.com/video/BV1test')
Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'CdnRuntimeTest/1.0', language: 'en', connection: { effectiveType: '4g' } },
    configurable: true,
})
globalThis.GM_info = { script: { name: 'balh.test', version: 'test' } }
const silentConsole = { log() { }, info() { }, debug() { }, warn() { }, error() { } }
globalThis.document = { cookie: '', location: globalThis.location }
globalThis.window = {
    location: globalThis.location,
    console: silentConsole,
    top: null,
    parent: null,
    addEventListener() { },
    postMessage() { },
}
globalThis.window.top = globalThis.window
globalThis.window.parent = globalThis.window
globalThis.window.document = globalThis.document

const runtimeModule = await import(`${pathToFileURL(outFile).href}?t=${Date.now()}`)
const {
    CDN_HEALTH_CACHE_KEY,
    CDN_HEALTH_CACHE_TTL_MS,
    CDN_UNPROBEABLE_RETRY_SUPPRESSION_MS,
    createCdnRuntime,
    replaceManualCdnHosts,
    applyCdnPolicy: applyDefaultPolicy,
    probeCurrentPlayUrlCdn: probeDefaultRuntime,
} = runtimeModule

function candidateGroups(playUrl) {
    return [{
        key: 'test',
        kind: 'dash-video',
        candidates: playUrl.urls.map(url => {
            const parsed = new URL(url)
            const ipLiteral = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(parsed.hostname)
            return {
                url,
                host: parsed.host,
                hostname: parsed.hostname,
                riskKinds: ipLiteral ? ['ip-literal'] : [],
            }
        }),
    }]
}

function streamResponse(chunks, tracker = {}) {
    let index = 0
    return {
        ok: true,
        type: 'basic',
        body: {
            getReader() {
                return {
                    async read() {
                        tracker.reads = (tracker.reads ?? 0) + 1
                        if (index >= chunks.length) return { done: true, value: undefined }
                        return { done: false, value: chunks[index++] }
                    },
                    cancel() {
                        tracker.cancels = (tracker.cancels ?? 0) + 1
                        return Promise.resolve()
                    },
                    releaseLock() {
                        tracker.releases = (tracker.releases ?? 0) + 1
                    },
                }
            },
        },
    }
}

function makeRuntime(overrides = {}) {
    return createCdnRuntime({
        storage: null,
        getMode: () => 'original',
        getNetworkHint: () => 'wifi:test',
        collectGroups: candidateGroups,
        log() { },
        ...overrides,
    })
}

function candidateHostHash(hosts) {
    let hash = 0x811c9dc5
    for (const character of [...new Set(hosts)].sort().join('\n')) {
        hash ^= character.charCodeAt(0)
        hash = Math.imul(hash, 0x01000193)
    }
    return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`
}

async function flushMicrotasks(rounds = 5) {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve()
}

const signedUrl = 'https://cdn-a.test.bilivideo.com:8443/video/segment.m4s?deadline=999&token=do-not-persist'

{
    const protocolRelative = {
        dash: {
            base_url: '//legacy.example/video/main.m4s?deadline=9&sig=keep-me',
            backup_url: ['//backup.example/video/main.m4s?deadline=9&sig=keep-me'],
        },
    }
    const replaced = replaceManualCdnHosts(protocolRelative, 'manual.example', '')
    assert.notStrictEqual(replaced, protocolRelative)
    assert.equal(protocolRelative.dash.base_url, '//legacy.example/video/main.m4s?deadline=9&sig=keep-me')
    assert.equal(replaced.dash.base_url, '//manual.example/video/main.m4s?deadline=9&sig=keep-me')
    assert.equal(replaced.dash.backup_url[0], '//manual.example/video/main.m4s?deadline=9&sig=keep-me')
    assert.deepEqual(replaceManualCdnHosts(replaced, 'manual.example', ''), replaced)

    const akamaiGated = {
        urls: [
            '//upos-hz-mirrorakam.akamaized.net/a.m4s?sig=akamai',
            '//other.example/b.m4s?sig=other',
        ],
    }
    assert.deepEqual(replaceManualCdnHosts(akamaiGated, 'manual.example', ''), akamaiGated)
    assert.deepEqual(replaceManualCdnHosts(akamaiGated, 'manual.example', 'Y').urls, [
        '//manual.example/a.m4s?sig=akamai',
        '//manual.example/b.m4s?sig=other',
    ])
}

{
    const playUrl = { urls: [signedUrl], obsolete: true }
    const nestedIdentity = playUrl.urls
    let replacements = 0
    const runtime = makeRuntime({
        getMode: () => 'manual',
        getManualHost: () => 'manual.example',
        replaceManual(value, host) {
            replacements += 1
            return {
                urls: value.urls.map(url => url.replace(new URL(url).host, host)),
                added: 'manual',
            }
        },
    })
    assert.strictEqual(runtime.applyCdnPolicy(playUrl), playUrl)
    assert.strictEqual(playUrl.urls, nestedIdentity)
    assert.equal(playUrl.urls[0], 'https://manual.example/video/segment.m4s?deadline=999&token=do-not-persist')
    assert.equal(playUrl.added, 'manual')
    assert.equal('obsolete' in playUrl, false)
    runtime.applyCdnPolicy(playUrl)
    assert.strictEqual(playUrl.urls, nestedIdentity)
    assert.equal(replacements, 2)

    let invalidReplacementCalled = false
    const invalidPlayUrl = { urls: [signedUrl] }
    const invalidRuntime = makeRuntime({
        getMode: () => 'manual',
        getManualHost: () => '',
        replaceManual() {
            invalidReplacementCalled = true
        },
    })
    invalidRuntime.applyCdnPolicy(invalidPlayUrl)
    assert.equal(invalidReplacementCalled, false)
    assert.equal(invalidPlayUrl.urls[0], signedUrl)
}

{
    const storage = new MemoryStorage()
    const requests = []
    const streamTracker = {}
    const logs = []
    const timers = new Map()
    const clearedTimers = []
    let timerId = 0
    const runtime = makeRuntime({
        storage,
        fetch: async (url, init) => {
            requests.push({ url, init })
            return streamResponse([new Uint8Array(32), new Uint8Array(32)], streamTracker)
        },
        setTimeout(callback) {
            const id = ++timerId
            timers.set(id, callback)
            return id
        },
        clearTimeout(id) {
            clearedTimers.push(id)
            timers.delete(id)
        },
        log(event, status) {
            logs.push({ event, status })
        },
        limits: {
            maxConcurrent: 1,
            maxStages: 1,
            maxBytesPerRequest: 8,
            maxTotalBytes: 8,
        },
    })
    runtime.applyCdnPolicy({ urls: [signedUrl] })
    const subscribed = []
    const unsubscribe = runtime.subscribeCdnProbeStatus(status => subscribed.push(status))
    const result = await runtime.probeCurrentPlayUrlCdn()
    assert.equal(result.state, 'ready')
    assert.equal(requests.length, 1)
    assert.equal(requests[0].url, signedUrl)
    assert.equal(requests[0].init.method, 'GET')
    assert.equal(requests[0].init.mode, 'cors')
    assert.equal(requests[0].init.credentials, 'omit')
    assert.equal(requests[0].init.cache, 'no-store')
    assert.equal(requests[0].init.redirect, 'error')
    assert.equal('headers' in requests[0].init, false)
    assert.ok(requests[0].init.signal instanceof AbortSignal)
    assert.equal(streamTracker.reads, 1)
    assert.equal(streamTracker.cancels, 1)
    assert.equal(streamTracker.releases, 1)
    assert.deepEqual([...clearedTimers].sort(), [1, 2])
    assert.deepEqual(result.candidateHosts, ['cdn-a.test.bilivideo.com:8443'])

    const cacheText = storage.getItem(CDN_HEALTH_CACHE_KEY)
    assert.ok(cacheText)
    assert.doesNotMatch(cacheText, /deadline|token|segment\.m4s/)
    const cache = JSON.parse(cacheText)
    assert.deepEqual(Object.keys(cache.hosts), ['cdn-a.test.bilivideo.com:8443'])
    assert.equal(cache.version, 1)
    assert.equal(cache.networkHint, 'wifi:test')
    assert.equal(typeof cache.candidateHostHash, 'string')
    assert.doesNotMatch(JSON.stringify(logs), /deadline|token|segment\.m4s/)
    assert.doesNotMatch(JSON.stringify(subscribed), /deadline|token|segment\.m4s/)

    const publicStatus = runtime.getCdnProbeStatus()
    publicStatus.candidateHosts.push('mutated.example')
    assert.deepEqual(runtime.getCdnProbeStatus().candidateHosts, ['cdn-a.test.bilivideo.com:8443'])
    const eventCount = subscribed.length
    unsubscribe()
    runtime.clearCdnHealthCache()
    assert.equal(subscribed.length, eventCount)
    assert.equal(storage.getItem(CDN_HEALTH_CACHE_KEY), null)
}

{
    const storage = new MemoryStorage()
    const logs = []
    let fetches = 0
    let now = 10_000
    const runtime = makeRuntime({
        storage,
        now: () => now,
        fetch: async () => {
            fetches += 1
            throw new TypeError(`Failed to fetch ${signedUrl}`)
        },
        log(event, status) {
            logs.push({ event, status })
        },
        limits: { maxConcurrent: 1, maxStages: 1 },
    })
    runtime.applyCdnPolicy({ urls: [signedUrl] })
    const result = await runtime.probeCurrentPlayUrlCdn()
    assert.equal(fetches, 1)
    assert.equal(result.state, 'unprobeable')
    assert.deepEqual(result.failedHosts, [])
    assert.deepEqual(result.unprobeableHosts, ['cdn-a.test.bilivideo.com:8443'])
    assert.equal(storage.getItem(CDN_HEALTH_CACHE_KEY), null)
    assert.doesNotMatch(JSON.stringify(logs), /deadline|token|segment\.m4s/)
    assert.deepEqual(await runtime.probeCurrentPlayUrlCdn(), result)
    assert.equal(fetches, 1)
    runtime.applyCdnPolicy({ urls: [`${signedUrl}&segment=second`] })
    assert.equal((await runtime.probeCurrentPlayUrlCdn()).state, 'unprobeable')
    assert.equal(fetches, 2)
    assert.equal((await runtime.probeCurrentPlayUrlCdn({ force: true })).state, 'unprobeable')
    assert.equal(fetches, 3)
    now += CDN_UNPROBEABLE_RETRY_SUPPRESSION_MS + 1
    assert.equal((await runtime.probeCurrentPlayUrlCdn()).state, 'unprobeable')
    assert.equal(fetches, 4)
    assert.equal(storage.setCalls, 0)
}

{
    const storage = new MemoryStorage()
    const runtime = makeRuntime({
        storage,
        fetch: async () => ({ ok: true, type: 'basic', body: null }),
        limits: { maxConcurrent: 1, maxStages: 1 },
    })
    runtime.applyCdnPolicy({ urls: [signedUrl] })
    const result = await runtime.probeCurrentPlayUrlCdn({ force: true })
    assert.equal(result.state, 'unprobeable')
    assert.equal(storage.getItem(CDN_HEALTH_CACHE_KEY), null)
}

{
    const storage = new MemoryStorage()
    const streamTracker = {}
    const runtime = makeRuntime({
        storage,
        fetch: async () => streamResponse([], streamTracker),
        limits: { maxConcurrent: 1, maxStages: 1 },
    })
    runtime.applyCdnPolicy({ urls: [signedUrl] })
    const result = await runtime.probeCurrentPlayUrlCdn({ force: true })
    assert.equal(result.state, 'unprobeable')
    assert.deepEqual(result.failedHosts, [])
    assert.equal(streamTracker.reads, 1)
    assert.equal(streamTracker.releases, 1)
    assert.equal(storage.getItem(CDN_HEALTH_CACHE_KEY), null)
}

{
    const timerCallbacks = new Map()
    const cleared = []
    let nextTimer = 0
    let aborted = 0
    let cancelled = 0
    let released = 0
    const runtime = makeRuntime({
        fetch: async (_url, init) => {
            init.signal.addEventListener('abort', () => { aborted += 1 }, { once: true })
            return {
                ok: true,
                type: 'basic',
                body: {
                    getReader() {
                        return {
                            read() { return new Promise(() => { }) },
                            cancel() {
                                cancelled += 1
                                return Promise.resolve()
                            },
                            releaseLock() {
                                released += 1
                            },
                        }
                    },
                },
            }
        },
        setTimeout(callback) {
            const id = ++nextTimer
            timerCallbacks.set(id, callback)
            return id
        },
        clearTimeout(id) {
            cleared.push(id)
            timerCallbacks.delete(id)
        },
        limits: { maxConcurrent: 1, maxStages: 1, requestTimeoutMs: 10, stageTimeoutMs: 10, totalTimeoutMs: 10 },
    })
    runtime.applyCdnPolicy({ urls: [signedUrl] })
    const pending = runtime.probeCurrentPlayUrlCdn({ force: true })
    await flushMicrotasks()
    assert.equal(timerCallbacks.size, 1)
    ;[...timerCallbacks.values()][0]()
    const result = await pending
    assert.equal(result.state, 'failed')
    assert.equal(aborted, 1)
    assert.equal(cancelled, 1)
    assert.equal(released, 1)
    assert.deepEqual([...cleared].sort(), [1, 2])
}

{
    const timerCallbacks = new Map()
    let nextTimer = 0
    let resolveFetch
    let lateBodyCancels = 0
    let lateGetReaders = 0
    let requestSignal
    const runtime = makeRuntime({
        fetch: (_url, init) => {
            requestSignal = init.signal
            return new Promise(resolve => { resolveFetch = resolve })
        },
        setTimeout(callback) {
            const id = ++nextTimer
            timerCallbacks.set(id, callback)
            return id
        },
        clearTimeout(id) {
            timerCallbacks.delete(id)
        },
        limits: { maxConcurrent: 1, maxStages: 1, requestTimeoutMs: 10, stageTimeoutMs: 10, totalTimeoutMs: 10 },
    })
    runtime.applyCdnPolicy({ urls: [signedUrl] })
    const pending = runtime.probeCurrentPlayUrlCdn({ force: true })
    await flushMicrotasks()
    ;[...timerCallbacks.values()][0]()
    assert.equal((await pending).state, 'failed')
    assert.equal(requestSignal.aborted, true)
    const settledStatus = JSON.stringify(runtime.getCdnProbeStatus())
    resolveFetch({
        ok: true,
        type: 'basic',
        body: {
            cancel() {
                lateBodyCancels += 1
                return new Promise(() => { })
            },
            getReader() {
                lateGetReaders += 1
                throw new Error('late response must not acquire a reader')
            },
        },
    })
    await flushMicrotasks()
    assert.equal(timerCallbacks.size, 1)
    ;[...timerCallbacks.values()][0]()
    await flushMicrotasks(10)
    assert.equal(lateBodyCancels, 1)
    assert.equal(lateGetReaders, 0)
    assert.equal(JSON.stringify(runtime.getCdnProbeStatus()), settledStatus)
}

{
    const timerCallbacks = new Map()
    let nextTimer = 0
    let resolveRead
    let reads = 0
    let cancels = 0
    const runtime = makeRuntime({
        fetch: async () => ({
            ok: true,
            type: 'basic',
            body: {
                getReader() {
                    return {
                        read() {
                            reads += 1
                            return new Promise(resolve => { resolveRead = resolve })
                        },
                        cancel() {
                            cancels += 1
                            return Promise.resolve()
                        },
                        releaseLock() { },
                    }
                },
            },
        }),
        setTimeout(callback) {
            const id = ++nextTimer
            timerCallbacks.set(id, callback)
            return id
        },
        clearTimeout(id) {
            timerCallbacks.delete(id)
        },
        limits: { maxConcurrent: 1, maxStages: 1, requestTimeoutMs: 10, stageTimeoutMs: 10, totalTimeoutMs: 10 },
    })
    runtime.applyCdnPolicy({ urls: [signedUrl] })
    const pending = runtime.probeCurrentPlayUrlCdn({ force: true })
    await flushMicrotasks()
    assert.equal(reads, 1)
    ;[...timerCallbacks.values()][0]()
    assert.equal((await pending).state, 'failed')
    assert.equal(cancels, 1)
    const settledStatus = JSON.stringify(runtime.getCdnProbeStatus())
    resolveRead({ done: false, value: new Uint8Array(2) })
    await flushMicrotasks(10)
    assert.equal(reads, 1)
    assert.equal(JSON.stringify(runtime.getCdnProbeStatus()), settledStatus)
}

{
    const timerCallbacks = new Map()
    const cleared = []
    let nextTimer = 0
    let resolveCancel
    let released = 0
    let settled = false
    const runtime = makeRuntime({
        fetch: async () => ({
            ok: true,
            type: 'basic',
            body: {
                getReader() {
                    let read = false
                    return {
                        async read() {
                            if (read) return { done: true, value: undefined }
                            read = true
                            return { done: false, value: new Uint8Array(16) }
                        },
                        cancel() {
                            return new Promise(resolve => { resolveCancel = resolve })
                        },
                        releaseLock() {
                            released += 1
                        },
                    }
                },
            },
        }),
        setTimeout(callback) {
            const id = ++nextTimer
            timerCallbacks.set(id, callback)
            return id
        },
        clearTimeout(id) {
            cleared.push(id)
            timerCallbacks.delete(id)
        },
        limits: { maxConcurrent: 1, maxStages: 1, maxBytesPerRequest: 4, maxTotalBytes: 4 },
    })
    runtime.applyCdnPolicy({ urls: [signedUrl] })
    const pending = runtime.probeCurrentPlayUrlCdn({ force: true }).then(result => {
        settled = true
        return result
    })
    await flushMicrotasks()
    assert.equal(settled, false)
    assert.equal(released, 0)
    assert.equal(typeof resolveCancel, 'function')
    resolveCancel()
    assert.equal((await pending).state, 'ready')
    assert.equal(released, 1)
    assert.deepEqual([...cleared].sort(), [1, 2])
}

{
    let readerCancelCalls = 0
    let readerReleaseCalls = 0
    let readerSignal
    const rejectingReaderRuntime = makeRuntime({
        fetch: async (_url, init) => {
            readerSignal = init.signal
            return {
                ok: true,
                type: 'basic',
                body: {
                    getReader() {
                        return {
                            async read() { return { done: false, value: new Uint8Array(16) } },
                            cancel() {
                                readerCancelCalls += 1
                                return Promise.reject(new Error('cancel rejected'))
                            },
                            releaseLock() {
                                readerReleaseCalls += 1
                            },
                        }
                    },
                },
            }
        },
        limits: { maxConcurrent: 1, maxStages: 1, maxBytesPerRequest: 4, maxTotalBytes: 4 },
    })
    rejectingReaderRuntime.applyCdnPolicy({ urls: [signedUrl] })
    assert.equal((await rejectingReaderRuntime.probeCurrentPlayUrlCdn({ force: true })).state, 'ready')
    assert.equal(readerCancelCalls, 1)
    assert.equal(readerReleaseCalls, 1)
    assert.equal(readerSignal.aborted, true)

    let responseCancelCalls = 0
    let responseSignal
    const nonOkRuntime = makeRuntime({
        fetch: async (_url, init) => {
            responseSignal = init.signal
            return {
                ok: false,
                type: 'basic',
                body: {
                    cancel() {
                        responseCancelCalls += 1
                        return Promise.reject(new Error('response cancel rejected'))
                    },
                },
            }
        },
        limits: { maxConcurrent: 1, maxStages: 1 },
    })
    nonOkRuntime.applyCdnPolicy({ urls: [signedUrl] })
    assert.equal((await nonOkRuntime.probeCurrentPlayUrlCdn({ force: true })).state, 'failed')
    assert.equal(responseCancelCalls, 1)
    assert.equal(responseSignal.aborted, true)
}

{
    const timerCallbacks = new Map()
    let nextTimer = 0
    let requestIndex = 0
    let secondStageReads = 0
    const storage = new MemoryStorage()
    const runtime = makeRuntime({
        storage,
        fetch: async () => {
            requestIndex += 1
            if (requestIndex === 1) {
                let reads = 0
                return {
                    ok: true,
                    type: 'basic',
                    body: {
                        getReader() {
                            return {
                                read() {
                                    reads += 1
                                    if (reads === 1) return Promise.resolve({ done: false, value: new Uint8Array(6) })
                                    return new Promise(() => { })
                                },
                                cancel() { return Promise.resolve() },
                                releaseLock() { },
                            }
                        },
                    },
                }
            }
            return {
                ok: true,
                type: 'basic',
                body: {
                    getReader() {
                        return {
                            async read() {
                                secondStageReads += 1
                                if (secondStageReads === 1) return { done: false, value: new Uint8Array(5) }
                                throw new Error('second stage exceeded its remaining byte budget')
                            },
                            cancel() { return Promise.resolve() },
                            releaseLock() { },
                        }
                    },
                },
            }
        },
        setTimeout(callback) {
            const id = ++nextTimer
            timerCallbacks.set(id, callback)
            return id
        },
        clearTimeout(id) {
            timerCallbacks.delete(id)
        },
        limits: {
            maxConcurrent: 1,
            maxStages: 2,
            maxBytesPerRequest: 8,
            maxTotalBytes: 10,
            requestTimeoutMs: 10,
            stageTimeoutMs: 10,
            totalTimeoutMs: 20,
        },
    })
    runtime.applyCdnPolicy({ urls: [signedUrl] })
    const pending = runtime.probeCurrentPlayUrlCdn({ force: true })
    await flushMicrotasks()
    assert.equal(requestIndex, 1)
    ;[...timerCallbacks.values()][0]()
    for (let index = 0; index < 20 && requestIndex < 2; index += 1) await flushMicrotasks()
    const result = await pending
    assert.equal(result.state, 'partial')
    assert.equal(requestIndex, 2)
    assert.equal(secondStageReads, 1)
    const health = JSON.parse(storage.getItem(CDN_HEALTH_CACHE_KEY)).hosts['cdn-a.test.bilivideo.com:8443']
    assert.equal(health.samples, 2)
    assert.equal(health.failures, 1)
    assert.equal(health.successes, 1)
}

{
    const storage = new MemoryStorage()
    let fetches = 0
    const runtime = makeRuntime({
        storage,
        now: () => 50_000,
        fetch: async () => {
            fetches += 1
            return streamResponse([new Uint8Array(16)])
        },
        limits: {
            maxConcurrent: 1,
            maxStages: 2,
            maxBytesPerRequest: 4,
            maxTotalBytes: 8,
        },
    })
    runtime.applyCdnPolicy({ urls: [signedUrl] })
    const result = await runtime.probeCurrentPlayUrlCdn({ force: true })
    assert.equal(result.state, 'partial')
    assert.equal(fetches, 1)
    const health = JSON.parse(storage.getItem(CDN_HEALTH_CACHE_KEY)).hosts['cdn-a.test.bilivideo.com:8443']
    assert.equal(health.samples, 1)
    assert.equal(health.throughputKbps, 32)
}

{
    const urls = [
        'https://one.test.bilivideo.com/a?sig=1',
        'https://two.test.bilivideo.com/a?sig=2',
        'https://three.test.bilivideo.com/a?sig=3',
        'https://four.test.bilivideo.com/a?sig=4',
    ]
    const storage = new MemoryStorage()
    const pendingFetches = []
    let active = 0
    let maxActive = 0
    const runtime = makeRuntime({
        storage,
        fetch(url) {
            active += 1
            maxActive = Math.max(maxActive, active)
            return new Promise(resolve => pendingFetches.push({
                url,
                resolve() {
                    active -= 1
                    resolve(streamResponse([new Uint8Array(4)]))
                },
            }))
        },
        limits: { maxConcurrent: 99, maxStages: 2, maxBytesPerRequest: 4, maxTotalBytes: 16 },
    })
    runtime.applyCdnPolicy({ urls })
    const pendingProbe = runtime.probeCurrentPlayUrlCdn({ force: true })
    await flushMicrotasks()
    assert.equal(active, 2)
    assert.equal(pendingFetches.length, 2)
    assert.equal(maxActive, 2)
    pendingFetches.splice(0).forEach(request => request.resolve())
    for (let index = 0; index < 20 && pendingFetches.length < 2; index += 1) await flushMicrotasks()
    assert.equal(active, 2)
    assert.equal(pendingFetches.length, 2)
    pendingFetches.splice(0).forEach(request => request.resolve())
    const result = await pendingProbe
    assert.equal(maxActive, 2)
    assert.equal(result.total, 4)
    const cache = JSON.parse(storage.getItem(CDN_HEALTH_CACHE_KEY))
    assert.equal(cache.hosts['one.test.bilivideo.com'].samples, 2)
    assert.equal(cache.hosts['two.test.bilivideo.com'].samples, 2)
    assert.equal(cache.hosts['three.test.bilivideo.com'], undefined)
}

{
    const now = 1_000_000
    const url = 'https://cache.test.bilivideo.com/media.m4s?secret=signed'
    const storage = new MemoryStorage()
    let seedFetches = 0
    const seedRuntime = makeRuntime({
        storage,
        now: () => now,
        fetch: async () => {
            seedFetches += 1
            return streamResponse([new Uint8Array(4)])
        },
        limits: { maxConcurrent: 1, maxStages: 2, maxBytesPerRequest: 4, maxTotalBytes: 8 },
    })
    seedRuntime.applyCdnPolicy({ urls: [url] })
    await seedRuntime.probeCurrentPlayUrlCdn({ force: true })
    assert.equal(seedFetches, 2)
    const freshCacheText = storage.getItem(CDN_HEALTH_CACHE_KEY)
    assert.ok(freshCacheText)

    let cachedFetches = 0
    let cachedOptions
    const freshRuntime = makeRuntime({
        storage,
        now: () => now + 1,
        getMode: () => 'auto',
        fetch: async () => {
            cachedFetches += 1
            throw new Error('fresh cache must avoid fetch')
        },
        optimize(_playUrl, options) {
            cachedOptions = options
            return { changed: false, groups: 1, diagnostics: [] }
        },
        scheduleBackground() { },
    })
    freshRuntime.applyCdnPolicy({ urls: [url] })
    assert.equal(cachedOptions.hostHealth['cache.test.bilivideo.com'].samples, 2)
    const cachedStatus = await freshRuntime.probeCurrentPlayUrlCdn()
    assert.equal(cachedStatus.source, 'cache')
    assert.equal(cachedFetches, 0)

    const mismatchStorage = new MemoryStorage({ [CDN_HEALTH_CACHE_KEY]: freshCacheText })
    let mismatchFetches = 0
    const mismatchRuntime = makeRuntime({
        storage: mismatchStorage,
        now: () => now + 1,
        getNetworkHint: () => 'cell:test',
        fetch: async () => {
            mismatchFetches += 1
            return streamResponse([new Uint8Array(1)])
        },
        limits: { maxConcurrent: 1, maxStages: 1 },
    })
    mismatchRuntime.applyCdnPolicy({ urls: [url] })
    await mismatchRuntime.probeCurrentPlayUrlCdn()
    assert.equal(mismatchFetches, 1)

    const expired = JSON.parse(freshCacheText)
    expired.savedAt = now - CDN_HEALTH_CACHE_TTL_MS - 1
    let expiredFetches = 0
    const expiredRuntime = makeRuntime({
        storage: new MemoryStorage({ [CDN_HEALTH_CACHE_KEY]: JSON.stringify(expired) }),
        now: () => now,
        fetch: async () => {
            expiredFetches += 1
            return streamResponse([new Uint8Array(1)])
        },
        limits: { maxConcurrent: 1, maxStages: 1 },
    })
    expiredRuntime.applyCdnPolicy({ urls: [url] })
    await expiredRuntime.probeCurrentPlayUrlCdn()
    assert.equal(expiredFetches, 1)

    let candidateMismatchFetches = 0
    const candidateMismatchRuntime = makeRuntime({
        storage: new MemoryStorage({ [CDN_HEALTH_CACHE_KEY]: freshCacheText }),
        now: () => now + 1,
        fetch: async () => {
            candidateMismatchFetches += 1
            return streamResponse([new Uint8Array(1)])
        },
        limits: { maxConcurrent: 1, maxStages: 1 },
    })
    candidateMismatchRuntime.applyCdnPolicy({ urls: ['https://different.test.bilivideo.com/media.m4s?secret=other'] })
    await candidateMismatchRuntime.probeCurrentPlayUrlCdn()
    assert.equal(candidateMismatchFetches, 1)

    const failedStorage = new MemoryStorage()
    const failedSeedRuntime = makeRuntime({
        storage: failedStorage,
        now: () => now,
        fetch: async () => ({
            ok: false,
            type: 'basic',
            body: { cancel: () => Promise.resolve() },
        }),
        limits: { maxConcurrent: 1, maxStages: 1 },
    })
    failedSeedRuntime.applyCdnPolicy({ urls: [url] })
    assert.equal((await failedSeedRuntime.probeCurrentPlayUrlCdn({ force: true })).state, 'failed')
    let failedCacheFetches = 0
    const failedCacheRuntime = makeRuntime({
        storage: failedStorage,
        now: () => now + 1,
        fetch: async () => {
            failedCacheFetches += 1
            return streamResponse([new Uint8Array(1)])
        },
    })
    failedCacheRuntime.applyCdnPolicy({ urls: [url] })
    const failedCacheStatus = await failedCacheRuntime.probeCurrentPlayUrlCdn()
    assert.equal(failedCacheStatus.state, 'failed')
    assert.equal(failedCacheStatus.source, 'cache')
    assert.deepEqual(failedCacheStatus.failedHosts, ['cache.test.bilivideo.com'])
    assert.equal(failedCacheFetches, 0)
}

{
    const now = 1_500_000
    const url = 'https://network.test.bilivideo.com/media.m4s?sig=network'
    const host = 'network.test.bilivideo.com'
    let networkHint = 'wifi:test'
    const cacheFor = (hint, health) => JSON.stringify({
        version: 1,
        savedAt: now,
        networkHint: hint,
        candidateHostHash: candidateHostHash([host]),
        hosts: { [host]: { host, ...health } },
    })
    const storage = new MemoryStorage({
        [CDN_HEALTH_CACHE_KEY]: cacheFor('wifi:test', { successes: 2, failures: 0, samples: 2 }),
    })
    let fetches = 0
    const runtime = makeRuntime({
        storage,
        now: () => now + 1,
        getNetworkHint: () => networkHint,
        fetch: async () => {
            fetches += 1
            return streamResponse([new Uint8Array(1)])
        },
    })
    runtime.applyCdnPolicy({ urls: [url] })
    assert.equal(runtime.getCdnProbeStatus().state, 'ready')
    storage.setItem(CDN_HEALTH_CACHE_KEY, cacheFor('cell:test', { successes: 0, failures: 2, samples: 2 }))
    networkHint = 'cell:test'
    const cellStatus = await runtime.probeCurrentPlayUrlCdn()
    assert.equal(cellStatus.state, 'failed')
    assert.equal(cellStatus.source, 'cache')
    assert.deepEqual(cellStatus.failedHosts, [host])
    assert.equal(fetches, 0)
}

{
    const now = 1_600_000
    const oldUrl = 'https://old-context.test.bilivideo.com/media.m4s?sig=old'
    const newUrl = 'https://new-context.test.bilivideo.com/media.m4s?sig=new'
    let resolveOldFetch
    let oldSignal
    let lateCancels = 0
    const storage = new MemoryStorage()
    const runtime = makeRuntime({
        storage,
        now: () => now,
        fetch: (_url, init) => {
            oldSignal = init.signal
            return new Promise(resolve => { resolveOldFetch = resolve })
        },
        limits: { maxConcurrent: 1, maxStages: 1 },
    })
    runtime.applyCdnPolicy({ urls: [oldUrl] })
    const oldProbe = runtime.probeCurrentPlayUrlCdn({ force: true })
    await flushMicrotasks()
    assert.equal(runtime.getCdnProbeStatus().state, 'probing')
    storage.setItem(CDN_HEALTH_CACHE_KEY, JSON.stringify({
        version: 1,
        savedAt: now,
        networkHint: 'wifi:test',
        candidateHostHash: candidateHostHash(['new-context.test.bilivideo.com']),
        hosts: {
            'new-context.test.bilivideo.com': {
                host: 'new-context.test.bilivideo.com',
                successes: 2,
                failures: 0,
                samples: 2,
            },
        },
    }))
    runtime.applyCdnPolicy({ urls: [newUrl] })
    assert.equal(oldSignal.aborted, true)
    const newStatus = runtime.getCdnProbeStatus()
    assert.equal(newStatus.state, 'ready')
    assert.equal(newStatus.source, 'cache')
    assert.deepEqual(newStatus.candidateHosts, ['new-context.test.bilivideo.com'])
    assert.deepEqual(await runtime.probeCurrentPlayUrlCdn(), newStatus)
    await oldProbe
    assert.deepEqual(runtime.getCdnProbeStatus(), newStatus)
    resolveOldFetch({
        ok: true,
        type: 'basic',
        body: {
            cancel() {
                lateCancels += 1
                return Promise.resolve()
            },
            getReader() { throw new Error('stale response acquired a reader') },
        },
    })
    await flushMicrotasks(10)
    assert.equal(lateCancels, 1)
    assert.deepEqual(runtime.getCdnProbeStatus(), newStatus)
}

{
    const url = 'https://midflight-network.test.bilivideo.com/media.m4s?sig=old-network'
    let networkHint = 'wifi:test'
    let resolveFetch
    const storage = new MemoryStorage()
    const runtime = makeRuntime({
        storage,
        getNetworkHint: () => networkHint,
        fetch: () => new Promise(resolve => { resolveFetch = resolve }),
        limits: { maxConcurrent: 1, maxStages: 1 },
    })
    runtime.applyCdnPolicy({ urls: [url] })
    const pending = runtime.probeCurrentPlayUrlCdn({ force: true })
    await flushMicrotasks()
    networkHint = 'cell:test'
    resolveFetch(streamResponse([new Uint8Array(1)]))
    const result = await pending
    assert.equal(result.state, 'idle')
    assert.equal(storage.getItem(CDN_HEALTH_CACHE_KEY), null)
}

{
    let invalidJsonFetches = 0
    const invalidJsonRuntime = makeRuntime({
        storage: new MemoryStorage({ [CDN_HEALTH_CACHE_KEY]: '{not-json' }),
        fetch: async () => {
            invalidJsonFetches += 1
            return streamResponse([new Uint8Array(1)])
        },
        limits: { maxConcurrent: 1, maxStages: 1 },
    })
    invalidJsonRuntime.applyCdnPolicy({ urls: [signedUrl] })
    await invalidJsonRuntime.probeCurrentPlayUrlCdn()
    assert.equal(invalidJsonFetches, 1)

    const throwingStorage = {
        getItem() { throw new Error('read denied') },
        setItem() { throw new Error('write denied') },
        removeItem() { throw new Error('remove denied') },
    }
    const storageErrorRuntime = makeRuntime({
        storage: throwingStorage,
        fetch: async () => streamResponse([new Uint8Array(1)]),
        limits: { maxConcurrent: 1, maxStages: 1 },
    })
    storageErrorRuntime.applyCdnPolicy({ urls: [signedUrl] })
    assert.equal((await storageErrorRuntime.probeCurrentPlayUrlCdn()).state, 'ready')
    assert.doesNotThrow(() => storageErrorRuntime.clearCdnHealthCache())
}

{
    const now = 2_000_000
    const ipUrl = 'https://127.0.0.1:9443/media.m4s?secret=private'
    const ipHost = '127.0.0.1:9443'
    const storage = new MemoryStorage({
        [CDN_HEALTH_CACHE_KEY]: JSON.stringify({
            version: 1,
            savedAt: now,
            networkHint: 'wifi:test',
            candidateHostHash: candidateHostHash([ipHost]),
            hosts: {
                [ipHost]: { host: ipHost, successes: 99, failures: 0, samples: 99 },
            },
        }),
    })
    let ipFetches = 0
    const runtime = makeRuntime({
        storage,
        now: () => now,
        fetch: async () => {
            ipFetches += 1
            return streamResponse([new Uint8Array(1)])
        },
        limits: { maxConcurrent: 1, maxStages: 1 },
    })
    runtime.applyCdnPolicy({ urls: [ipUrl] })
    const result = await runtime.probeCurrentPlayUrlCdn()
    assert.equal(result.state, 'unprobeable')
    assert.equal(ipFetches, 0)
    assert.deepEqual(result.candidateHosts, [ipHost])
    assert.deepEqual(result.probedHosts, [])
    assert.deepEqual(result.unprobeableHosts, [ipHost])
    assert.equal(storage.setCalls, 0)
}

{
    const blockedUrls = [
        'https://127.0.0.1:9443/media.m4s?sig=ipv4-loopback',
        'https://10.0.0.1/media.m4s?sig=ipv4-private',
        'https://172.16.0.1/media.m4s?sig=ipv4-private',
        'https://169.254.169.254/latest/meta-data',
        'https://192.168.1.1/media.m4s?sig=ipv4-private',
        'https://8.8.8.8/media.m4s?sig=public-ip-literal',
        'https://127.1/media.m4s?sig=short-ipv4',
        'https://2130706433/media.m4s?sig=decimal-ipv4',
        'https://0x7f000001/media.m4s?sig=hex-ipv4',
        'https://0177.0.0.1/media.m4s?sig=octal-ipv4',
        'https://[::1]/media.m4s?sig=ipv6-loopback',
        'https://[fe80::1]/media.m4s?sig=ipv6-link-local',
        'https://[fc00::1]/media.m4s?sig=ipv6-private',
        'https://[2001:4860:4860::8888]/media.m4s?sig=public-ipv6-literal',
        'https://[::ffff:127.0.0.1]/media.m4s?sig=mapped-ipv4',
        'https://localhost/media.m4s?sig=localhost',
        'https://localhost.:9443/media.m4s?sig=localhost-dot',
        'https://media.localhost/media.m4s?sig=localhost-subdomain',
        'https://router.local/media.m4s?sig=local-network',
        'https://metadata.google.internal/computeMetadata/v1/',
        'https://edge-pcdn-1.biliapi.net/media.m4s?sig=biliapi-pcdn',
        'https://edge.szbdyd.com/media.m4s?sig=known-pcdn',
        'https://other.akamaized.net/media.m4s?sig=non-bilibili-akamai',
        'https://upos-sz-mirrorcos.bilivideo.com.evil.invalid/media.m4s?sig=suffix-confusion',
        'https://upos-hz-mirrorakam.akamaized.net.evil.invalid/media.m4s?sig=akamai-suffix-confusion',
        'https://upos-sz-mirrorcos.bilivideo.com@127.0.0.1/media.m4s?sig=userinfo-confusion',
        'https://user@upos-sz-mirrorcos.bilivideo.com/media.m4s?sig=userinfo',
        'https://cdn.example/media.m4s?sig=unknown-public-host',
    ]
    const originalPlayUrl = { urls: blockedUrls.slice() }
    let blockedFetches = 0
    const blockedRuntime = makeRuntime({
        fetch: async () => {
            blockedFetches += 1
            return streamResponse([new Uint8Array(1)])
        },
        limits: { maxConcurrent: 2, maxStages: 1 },
    })
    assert.strictEqual(blockedRuntime.applyCdnPolicy(originalPlayUrl), originalPlayUrl)
    assert.deepEqual(originalPlayUrl.urls, blockedUrls)
    const blockedResult = await blockedRuntime.probeCurrentPlayUrlCdn({ force: true })
    assert.equal(blockedResult.state, 'unprobeable')
    assert.equal(blockedFetches, 0)
    assert.deepEqual(blockedResult.probedHosts, [])
    assert.ok(blockedResult.candidateHosts.includes('127.0.0.1:9443'))
    assert.ok(blockedResult.candidateHosts.includes('[::1]'))
    assert.ok(blockedResult.candidateHosts.includes('localhost'))
    assert.ok(blockedResult.candidateHosts.includes('upos-sz-mirrorcos.bilivideo.com'))
    assert.deepEqual(blockedResult.unprobeableHosts, blockedResult.candidateHosts)

    let spoofedMetadataFetches = 0
    const spoofedMetadataRuntime = makeRuntime({
        collectGroups: () => [{
            key: 'spoofed',
            kind: 'dash-video',
            candidates: [{
                url: 'https://127.0.0.1/private.m4s?sig=spoofed-host',
                host: 'upos-sz-mirrorcos.bilivideo.com',
                hostname: 'upos-sz-mirrorcos.bilivideo.com',
                riskKinds: [],
            }],
        }],
        fetch: async () => {
            spoofedMetadataFetches += 1
            return streamResponse([new Uint8Array(1)])
        },
        limits: { maxConcurrent: 1, maxStages: 1 },
    })
    spoofedMetadataRuntime.applyCdnPolicy({})
    const spoofedMetadataResult = await spoofedMetadataRuntime.probeCurrentPlayUrlCdn({ force: true })
    assert.equal(spoofedMetadataResult.state, 'unprobeable')
    assert.equal(spoofedMetadataFetches, 0)
    assert.deepEqual(spoofedMetadataResult.candidateHosts, ['127.0.0.1'])
}

{
    const trustedUrls = [
        'https://upos-sz-mirrorcos.bilivideo.com:8443/media.m4s?sig=bilivideo-com',
        'https://cn-hk-eq-bcache-01.bilivideo.com/media.m4s?sig=bcache',
        'http://edge.mcdn.bilivideo.cn/media.m4s?sig=bilivideo-cn',
        'https://edge.mcdn.bilivideo.net/media.m4s?sig=bilivideo-net',
        'https://upos-hz-mirrorakam.akamaized.net/media.m4s?sig=akamai',
        'https://upos-sz-mirrorcos.bilivideo.com./media.m4s?sig=absolute-dns-name',
    ]
    for (const url of trustedUrls) {
        const storage = new MemoryStorage()
        const requests = []
        const trustedRuntime = makeRuntime({
            storage,
            fetch: async (requestUrl, init) => {
                requests.push({ requestUrl, init })
                return streamResponse([new Uint8Array(1)])
            },
            limits: { maxConcurrent: 1, maxStages: 1 },
        })
        trustedRuntime.applyCdnPolicy({ urls: [url] })
        const result = await trustedRuntime.probeCurrentPlayUrlCdn({ force: true })
        const host = new URL(url).host.toLowerCase()
        assert.equal(result.state, 'ready', url)
        assert.deepEqual(requests.map(request => request.requestUrl), [url], url)
        assert.equal(requests[0].init.redirect, 'error', url)
        assert.deepEqual(result.candidateHosts, [host], url)
        assert.deepEqual(Object.keys(JSON.parse(storage.getItem(CDN_HEALTH_CACHE_KEY)).hosts), [host], url)
    }

    let hostnameFetches = 0
    const hostnameRuntime = makeRuntime({
        fetch: async () => {
            hostnameFetches += 1
            return streamResponse([new Uint8Array(1)])
        },
        limits: { maxConcurrent: 1, maxStages: 1 },
    })
    hostnameRuntime.applyCdnPolicy({ urls: ['https://reusable.test.bilivideo.com/first.m4s?sig=first'] })
    assert.equal((await hostnameRuntime.probeCurrentPlayUrlCdn({ force: true })).state, 'ready')
    hostnameRuntime.applyCdnPolicy({ urls: ['https://reusable.test.bilivideo.com/second.m4s?sig=second'] })
    assert.equal((await hostnameRuntime.probeCurrentPlayUrlCdn()).state, 'ready')
    assert.equal(hostnameFetches, 1)
}

{
    const host = 'shared.test.bilivideo.com'
    const allowedUrl = `https://${host}/allowed.m4s?sig=allowed`
    const blockedUrl = `https://user@${host}/blocked.m4s?sig=userinfo`
    const storage = new MemoryStorage()
    const fetched = []
    const runtime = makeRuntime({
        storage,
        fetch: async url => {
            fetched.push(url)
            return streamResponse([new Uint8Array(1)])
        },
        limits: { maxConcurrent: 1, maxStages: 1 },
    })

    runtime.applyCdnPolicy({ urls: [blockedUrl, allowedUrl] })
    const result = await runtime.probeCurrentPlayUrlCdn({ force: true })
    assert.equal(result.state, 'ready')
    assert.deepEqual(fetched, [allowedUrl])
    assert.deepEqual(result.probedHosts, [host])
    assert.deepEqual(result.healthyHosts, [host])
    assert.deepEqual(result.unprobeableHosts, [])
    assert.deepEqual(Object.keys(JSON.parse(storage.getItem(CDN_HEALTH_CACHE_KEY)).hosts), [host])

    const nextAllowedUrl = `https://${host}/next-allowed.m4s?sig=allowed-next`
    const nextBlockedUrl = `https://other@${host}/next-blocked.m4s?sig=userinfo-next`
    runtime.applyCdnPolicy({ urls: [nextAllowedUrl, nextBlockedUrl] })
    const reusedStatus = await runtime.probeCurrentPlayUrlCdn()
    assert.equal(reusedStatus.state, 'ready')
    assert.deepEqual(reusedStatus.healthyHosts, [host])
    assert.deepEqual(reusedStatus.unprobeableHosts, [])
    assert.deepEqual(fetched, [allowedUrl])

    runtime.applyCdnPolicy({ urls: [nextBlockedUrl] })
    assert.equal(runtime.getCdnProbeStatus().state, 'idle')
    const blockedOnlyStatus = await runtime.probeCurrentPlayUrlCdn({ force: true })
    assert.equal(blockedOnlyStatus.state, 'unprobeable')
    assert.deepEqual(blockedOnlyStatus.unprobeableHosts, [host])
    assert.deepEqual(fetched, [allowedUrl])
}

{
    const logs = []
    const playUrl = { urls: ['https://fail-open.example/media.m4s?sig=keep'] }
    const original = structuredClone(playUrl)
    const runtime = makeRuntime({
        getMode: () => 'safe',
        optimize() {
            throw new Error('selector failed')
        },
        log(event) {
            logs.push(event)
        },
    })
    let returned
    assert.doesNotThrow(() => {
        returned = runtime.applyCdnPolicy(playUrl)
    })
    assert.strictEqual(returned, playUrl)
    assert.deepEqual(playUrl, original)
    assert.ok(logs.includes('cdn-selection-failed'))
}

{
    let mode = 'auto'
    const scheduled = []
    let fetches = 0
    const runtime = makeRuntime({
        getMode: () => mode,
        fetch: async () => {
            fetches += 1
            return streamResponse([new Uint8Array(1)])
        },
        scheduleBackground(callback) {
            scheduled.push(callback)
        },
        limits: { maxConcurrent: 1, maxStages: 1 },
    })
    runtime.applyCdnPolicy({ urls: ['https://mode.example/a?sig=1'] })
    assert.equal(scheduled.length, 1)
    mode = 'safe'
    scheduled[0]()
    await flushMicrotasks()
    assert.equal(fetches, 0)
}

{
    const scheduled = []
    const fetched = []
    let mode = 'auto'
    const runtime = makeRuntime({
        getMode: () => mode,
        fetch: async url => {
            fetched.push(url)
            return streamResponse([new Uint8Array(1)])
        },
        optimize(playUrl) {
            playUrl.urls.reverse()
            return { changed: true, groups: 1, diagnostics: [] }
        },
        scheduleBackground(callback) {
            scheduled.push(callback)
        },
        limits: { maxConcurrent: 1, maxStages: 1 },
    })
    const first = {
        urls: [
            'https://auto-a.test.bilivideo.com/a?sig=1',
            'https://auto-b.test.bilivideo.com/a?sig=2',
        ],
    }
    assert.strictEqual(runtime.applyCdnPolicy(first), first)
    assert.equal(fetched.length, 0)
    assert.equal(scheduled.length, 1)

    const second = { urls: ['https://auto-c.test.bilivideo.com/a?sig=3'] }
    runtime.applyCdnPolicy(second)
    assert.equal(scheduled.length, 2)
    scheduled[0]()
    await flushMicrotasks()
    assert.equal(fetched.length, 0)
    scheduled[1]()
    await runtime.probeCurrentPlayUrlCdn()
    assert.deepEqual(fetched, ['https://auto-c.test.bilivideo.com/a?sig=3'])

    mode = 'safe'
    let oldSignal
    let releaseOld
    const generationRuntime = makeRuntime({
        getMode: () => mode,
        fetch: (url, init) => {
            if (url.includes('old.test.bilivideo.com')) {
                oldSignal = init.signal
                return new Promise((_resolve, reject) => {
                    releaseOld = () => reject(new TypeError('aborted'))
                    init.signal.addEventListener('abort', releaseOld, { once: true })
                })
            }
            return Promise.resolve(streamResponse([new Uint8Array(1)]))
        },
        limits: { maxConcurrent: 1, maxStages: 1 },
    })
    generationRuntime.applyCdnPolicy({ urls: ['https://old.test.bilivideo.com/a?sig=old'] })
    const oldProbe = generationRuntime.probeCurrentPlayUrlCdn({ force: true })
    await flushMicrotasks()
    generationRuntime.applyCdnPolicy({ urls: ['https://new.test.bilivideo.com/a?sig=new'] })
    assert.equal(oldSignal.aborted, true)
    assert.equal((await generationRuntime.probeCurrentPlayUrlCdn({ force: true })).state, 'ready')
    await oldProbe
}

{
    const originalGlobalFetch = globalThis.fetch
    globalThis.fetch = async () => { throw new Error('BALH hook must not be used by the CDN probe') }
    const defaultPlayUrl = {
        dash: {
            video: [{ base_url: 'https://captured.test.bilivideo.com/media.m4s?sig=private', backup_url: [] }],
            audio: [],
        },
    }
    applyDefaultPolicy(defaultPlayUrl)
    await probeDefaultRuntime({ force: true })
    assert.equal(capturedFetchCalls.length, 2)
    assert.equal(capturedFetchCalls[0].url, 'https://captured.test.bilivideo.com/media.m4s?sig=private')
    globalThis.fetch = originalGlobalFetch
}

console.log('cdn runtime tests passed')
