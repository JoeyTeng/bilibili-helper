#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(rootDir, '.codex-tmp/tests')
const outFile = path.join(outDir, 'cdn-runtime.mjs')
const recoveryOutFile = path.join(outDir, 'cdn-recovery-runtime-integration.mjs')

await mkdir(outDir, { recursive: true })
await Promise.all([
    build({
        entryPoints: [path.join(rootDir, 'packages/unblock-area-limit/src/feature/bili/cdn_runtime.ts')],
        outfile: outFile,
        bundle: true,
        format: 'esm',
        platform: 'browser',
        target: 'es2020',
    }),
    build({
        entryPoints: [path.join(rootDir, 'packages/unblock-area-limit/src/feature/bili/cdn_recovery.ts')],
        outfile: recoveryOutFile,
        bundle: true,
        format: 'esm',
        platform: 'browser',
        target: 'es2020',
    }),
])

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
const recoveryModule = await import(`${pathToFileURL(recoveryOutFile).href}?t=${Date.now()}`)
const {
    CDN_HEALTH_CACHE_KEY,
    CDN_HEALTH_CACHE_VERSION,
    CDN_HEALTH_CACHE_TTL_MS,
    CDN_UNPROBEABLE_RETRY_SUPPRESSION_MS,
    createCdnRuntime,
    replaceManualCdnHosts,
    applyCdnPolicy: applyDefaultPolicy,
    probeCurrentPlayUrlCdn: probeDefaultRuntime,
} = runtimeModule
const { createCdnRecoveryCoordinator } = recoveryModule

function candidateGroups(playUrl) {
    return [makeCandidateGroup('test', playUrl.urls, {
        ...(playUrl.bandwidthBps === undefined ? {} : { bandwidthBps: playUrl.bandwidthBps }),
    })]
}

function makeCandidateGroup(key, urls, options = {}) {
    return {
        key,
        kind: options.kind ?? 'dash-video',
        ...(options.bandwidthBps === undefined ? {} : { bandwidthBps: options.bandwidthBps }),
        candidates: urls.map(url => {
            const parsed = new URL(url)
            const ipLiteral = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(parsed.hostname)
            return {
                url,
                host: parsed.host,
                hostname: parsed.hostname,
                riskKinds: ipLiteral ? ['ip-literal'] : [],
            }
        }),
    }
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
        publishRecoveryGroups() { },
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
    const recoveryPublications = []
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
        publishRecoveryGroups(groups, enabled) {
            recoveryPublications.push({ groups, enabled })
        },
    })
    assert.strictEqual(runtime.applyCdnPolicy(playUrl), playUrl)
    assert.strictEqual(playUrl.urls, nestedIdentity)
    assert.equal(playUrl.urls[0], 'https://manual.example/video/segment.m4s?deadline=999&token=do-not-persist')
    assert.equal(playUrl.added, 'manual')
    assert.equal('obsolete' in playUrl, false)
    assert.equal(recoveryPublications.length, 1)
    assert.equal(recoveryPublications[0].enabled, false)
    assert.equal(
        recoveryPublications[0].groups[0].candidates[0].url,
        'https://manual.example/video/segment.m4s?deadline=999&token=do-not-persist',
    )
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
    const prePolicyGroups = [makeCandidateGroup('pre-policy', [
        'https://pre-policy.test.bilivideo.com/video.m4s?sig=pre',
    ])]
    const postPolicyGroups = [makeCandidateGroup('post-policy', [
        'https://post-policy.test.bilivideo.com/video.m4s?sig=post',
    ])]
    const events = []
    let postPolicy = false
    let publication
    const runtime = makeRuntime({
        getMode: () => 'auto',
        collectGroups() {
            events.push(postPolicy ? 'collect:post' : 'collect:pre')
            return postPolicy ? postPolicyGroups : prePolicyGroups
        },
        optimize(playUrl) {
            events.push('optimize')
            postPolicy = true
            playUrl.urls = postPolicyGroups[0].candidates.map(candidate => candidate.url)
            return { changed: true, groups: 1, diagnostics: [] }
        },
        publishRecoveryGroups(groups, enabled) {
            events.push('publish')
            publication = { groups, enabled }
        },
        scheduleBackground() {
            events.push('schedule')
        },
    })

    runtime.applyCdnPolicy({ urls: prePolicyGroups[0].candidates.map(candidate => candidate.url) })
    assert.deepEqual(events, ['collect:pre', 'optimize', 'collect:post', 'publish', 'schedule'])
    assert.strictEqual(publication.groups, postPolicyGroups)
    assert.equal(publication.enabled, true)
}

{
    for (const mode of ['manual', 'original', 'safe', 'auto']) {
        const groups = [makeCandidateGroup(`mode:${mode}`, [
            `https://${mode}.test.bilivideo.com/video.m4s?sig=${mode}`,
        ])]
        const publications = []
        let collections = 0
        const runtime = makeRuntime({
            getMode: () => mode,
            getManualHost: () => undefined,
            collectGroups() {
                collections += 1
                return groups
            },
            optimize() {
                return { changed: false, groups: 1, diagnostics: [] }
            },
            publishRecoveryGroups(publishedGroups, enabled) {
                publications.push({ groups: publishedGroups, enabled })
            },
            scheduleBackground() { },
        })

        runtime.applyCdnPolicy({ urls: groups[0].candidates.map(candidate => candidate.url) })
        assert.equal(collections, mode === 'safe' || mode === 'auto' ? 2 : 1, mode)
        assert.equal(publications.length, 1, mode)
        assert.strictEqual(publications[0].groups, groups, mode)
        assert.equal(publications[0].enabled, mode === 'auto', mode)
    }
}

{
    const policyUrl = 'https://policy-stage.test.bilivideo.com/video.m4s?sig=policy'
    const finalUrl = 'https://final-delivery.test.bilivideo.com/video.m4s?sig=final'
    const policyGroups = [makeCandidateGroup('policy-stage', [policyUrl])]
    const finalGroups = [makeCandidateGroup('final-delivery', [finalUrl])]
    const policyPayload = { groups: policyGroups }
    const finalPayload = { groups: finalGroups, downstreamMarker: { preserved: true } }
    const finalNestedIdentity = finalPayload.downstreamMarker
    const publications = []
    const scheduled = []
    const fetched = []
    const collectedPayloads = []
    let optimizeCalls = 0
    let manualRewriteCalls = 0
    const runtime = makeRuntime({
        getMode: () => 'auto',
        collectGroups(playUrl) {
            collectedPayloads.push(playUrl)
            return playUrl.groups
        },
        optimize() {
            optimizeCalls += 1
            return { changed: false, groups: 1, diagnostics: [] }
        },
        replaceManual(playUrl) {
            manualRewriteCalls += 1
            return playUrl
        },
        publishRecoveryGroups(groups, enabled) {
            publications.push({ groups, enabled })
        },
        scheduleBackground(callback) {
            scheduled.push(callback)
        },
        fetch: async url => {
            fetched.push(String(url))
            return streamResponse([new Uint8Array(1)])
        },
        limits: { maxConcurrent: 1, maxStages: 1 },
    })

    runtime.applyCdnPolicy(policyPayload)
    assert.equal(optimizeCalls, 1)
    assert.equal(scheduled.length, 1)
    collectedPayloads.length = 0
    const optimizeCallsBeforeObservation = optimizeCalls

    assert.strictEqual(runtime.observeFinalCdnDelivery(finalPayload), finalPayload)
    assert.strictEqual(finalPayload.groups, finalGroups)
    assert.strictEqual(finalPayload.downstreamMarker, finalNestedIdentity)
    assert.deepEqual(finalPayload.downstreamMarker, { preserved: true })
    assert.deepEqual(collectedPayloads, [finalPayload])
    assert.equal(optimizeCalls, optimizeCallsBeforeObservation)
    assert.equal(manualRewriteCalls, 0)
    assert.equal(publications.length, 2)
    assert.strictEqual(publications[1].groups, finalGroups)
    assert.equal(publications[1].enabled, true)
    assert.deepEqual(runtime.getCdnProbeStatus().candidateHosts, [new URL(finalUrl).host])
    assert.equal(scheduled.length, 2)

    scheduled[0]()
    await flushMicrotasks()
    assert.deepEqual(fetched, [])
    scheduled[1]()
    const probeStatus = await runtime.probeCurrentPlayUrlCdn()
    assert.deepEqual(fetched, [finalUrl])
    assert.deepEqual(probeStatus.candidateHosts, [new URL(finalUrl).host])
}

{
    const oldUrl = 'https://ordering-old.test.bilivideo.com/video.m4s?sig=old'
    const newPolicyUrl = 'https://ordering-new-policy.test.bilivideo.com/video.m4s?sig=policy'
    const newFinalUrl = 'https://ordering-new-final.test.bilivideo.com/video.m4s?sig=final'
    const newFinalAlternateUrl = 'https://ordering-new-alternate.test.bilivideo.com/video.m4s?sig=alternate'
    const oldGroups = [makeCandidateGroup('ordering-old', [oldUrl])]
    const newPolicyGroups = [makeCandidateGroup('ordering-new-policy', [newPolicyUrl])]
    const newFinalGroups = [makeCandidateGroup('ordering-new-final', [
        newFinalUrl,
        newFinalAlternateUrl,
    ])]
    const oldPayload = { groups: oldGroups }
    const newPolicyPayload = { groups: newPolicyGroups }
    const newFinalPayload = { groups: newFinalGroups }
    const recoveryTimers = new Map()
    let recoveryTimerId = 0
    let now = 0
    const recovery = createCdnRecoveryCoordinator({
        now: () => now,
        setTimeout(callback) {
            const id = ++recoveryTimerId
            recoveryTimers.set(id, () => {
                recoveryTimers.delete(id)
                callback()
            })
            return id
        },
        clearTimeout(id) {
            recoveryTimers.delete(id)
        },
    })
    const publications = []
    const scheduled = []
    let collections = 0
    let optimizeCalls = 0
    const runtime = makeRuntime({
        getMode: () => 'auto',
        collectGroups(playUrl) {
            collections += 1
            return playUrl.groups
        },
        optimize() {
            optimizeCalls += 1
            return { changed: false, groups: 1, diagnostics: [] }
        },
        publishRecoveryGroups(groups, enabled) {
            publications.push({
                groups,
                enabled,
                status: recovery.publishGroups(groups, enabled),
            })
        },
        scheduleBackground(callback) {
            scheduled.push(callback)
        },
    })

    const oldToken = runtime.beginFinalCdnDelivery()
    const newToken = runtime.beginFinalCdnDelivery()
    assert.equal(oldToken, 1)
    assert.equal(newToken, oldToken + 1)

    runtime.transformCdnPolicyForFinalDelivery(newPolicyPayload)
    assert.equal(publications.length, 0)
    assert.equal(scheduled.length, 0)
    assert.deepEqual(runtime.getCdnProbeStatus().candidateHosts, [])
    assert.strictEqual(runtime.observeFinalCdnDelivery(newFinalPayload, newToken), newFinalPayload)
    assert.equal(optimizeCalls, 1)
    assert.deepEqual(runtime.getCdnProbeStatus().candidateHosts, [
        new URL(newFinalAlternateUrl).host,
        new URL(newFinalUrl).host,
    ].sort())

    const initialRoute = recovery.routeExactUrl(newFinalUrl)
    assert.equal(initialRoute.routed, false)
    assert.equal(initialRoute.activation?.candidateIndex, 0)
    const stalledPlayback = {
        visible: true,
        paused: false,
        seeking: false,
        ended: false,
        currentTimeSeconds: 10,
        durationSeconds: 120,
        bufferedAheadSeconds: 0.1,
    }
    recovery.samplePlayback(stalledPlayback)
    assert.equal(recovery.getStatus().groups[0].state, 'confirming')
    assert.equal(recoveryTimers.size, 1)
    now = 3_000
    ;[...recoveryTimers.values()][0]()
    const routeIntentStatus = recovery.getStatus()
    assert.deepEqual(routeIntentStatus.groups[0], {
        groupId: 1,
        key: 'ordering-new-final',
        kind: 'dash-video',
        generation: 1,
        candidateCount: 2,
        candidateIndex: 0,
        pendingCandidateIndex: 1,
        attemptedCount: 1,
        routeRevision: 1,
        state: 'waiting-retry',
        switchAttempts: 1,
        routeCommittedAt: null,
        retryAt: 18_000,
        timerPending: false,
    })
    assert.equal(recoveryTimers.size, 0)
    now = 18_000
    recovery.samplePlayback(stalledPlayback)
    assert.deepEqual(recovery.getStatus(), routeIntentStatus)
    assert.equal(recoveryTimers.size, 0)
    const overriddenRoute = recovery.routeExactUrl(newFinalUrl)
    assert.equal(overriddenRoute.routed, true)
    assert.equal(overriddenRoute.url, newFinalAlternateUrl)
    const recoveryBeforeStaleResponse = recovery.getStatus()
    assert.equal(recoveryBeforeStaleResponse.generation, 1)
    assert.equal(recoveryBeforeStaleResponse.activeGroupCount, 1)
    assert.deepEqual(recoveryBeforeStaleResponse.groups[0], {
        groupId: 1,
        key: 'ordering-new-final',
        kind: 'dash-video',
        generation: 1,
        candidateCount: 2,
        candidateIndex: 1,
        pendingCandidateIndex: null,
        attemptedCount: 2,
        routeRevision: 1,
        state: 'waiting-retry',
        switchAttempts: 1,
        routeCommittedAt: 18_000,
        retryAt: 33_000,
        timerPending: false,
    })
    const publicationsBeforeStaleResponse = publications.length
    const schedulesBeforeStaleResponse = scheduled.length
    const timersBeforeStaleResponse = [...recoveryTimers.keys()]
    const probeStatusBeforeStaleResponse = runtime.getCdnProbeStatus()

    runtime.transformCdnPolicyForFinalDelivery(oldPayload)
    assert.equal(optimizeCalls, 2)
    assert.deepEqual(runtime.getCdnProbeStatus(), probeStatusBeforeStaleResponse)
    assert.deepEqual(recovery.getStatus(), recoveryBeforeStaleResponse)
    assert.equal(publications.length, publicationsBeforeStaleResponse)
    const collectionsBeforeStaleCompletion = collections

    assert.strictEqual(runtime.observeFinalCdnDelivery(oldPayload, oldToken), oldPayload)
    assert.equal(collections, collectionsBeforeStaleCompletion)
    assert.equal(optimizeCalls, 2)
    assert.deepEqual(runtime.getCdnProbeStatus(), probeStatusBeforeStaleResponse)
    assert.deepEqual(recovery.getStatus(), recoveryBeforeStaleResponse)
    assert.equal(publications.length, publicationsBeforeStaleResponse)
    assert.equal(scheduled.length, schedulesBeforeStaleResponse)
    assert.deepEqual([...recoveryTimers.keys()], timersBeforeStaleResponse)
    assert.deepEqual(publications.map(publication => publication.status.groups[0].key), [
        'ordering-new-final',
    ])
    assert.deepEqual(publications.map(publication => publication.status.generation), [1])
    assert.equal(recovery.routeExactUrl(oldUrl).routed, false)
    const retainedOverride = recovery.routeExactUrl(newFinalUrl)
    assert.equal(retainedOverride.routed, true)
    assert.equal(retainedOverride.url, newFinalAlternateUrl)
}

{
    const oldUrl = 'https://reentrant-old.test.bilivideo.com/video.m4s?sig=old'
    const newUrl = 'https://reentrant-new.test.bilivideo.com/video.m4s?sig=new'
    const oldPayload = { groups: [makeCandidateGroup('reentrant-old', [oldUrl])] }
    const newPayload = { groups: [makeCandidateGroup('reentrant-new', [newUrl])] }
    const publications = []
    const scheduled = []
    let reentered = false
    const runtime = makeRuntime({
        getMode: () => 'auto',
        collectGroups: playUrl => playUrl.groups,
        optimize() {
            return { changed: false, groups: 1, diagnostics: [] }
        },
        publishRecoveryGroups(groups, enabled) {
            publications.push({ groups, enabled })
        },
        scheduleBackground(callback) {
            scheduled.push(callback)
        },
    })
    const oldToken = runtime.beginFinalCdnDelivery()
    const newToken = runtime.beginFinalCdnDelivery()
    const unsubscribe = runtime.subscribeCdnProbeStatus(status => {
        if (reentered || !status.candidateHosts.includes(new URL(oldUrl).host)) return
        reentered = true
        runtime.observeFinalCdnDelivery(newPayload, newToken)
    })

    runtime.observeFinalCdnDelivery(oldPayload, oldToken)
    unsubscribe()

    assert.equal(reentered, true, 'status publication must exercise synchronous final-delivery reentry')
    assert.deepEqual(runtime.getCdnProbeStatus().candidateHosts, [new URL(newUrl).host])
    assert.deepEqual(publications.map(publication => publication.groups[0].key), [
        'reentrant-new',
    ])
    assert.equal(publications[0].enabled, true)
    assert.equal(scheduled.length, 1)

    const publicationsBeforeStaleReplay = publications.length
    runtime.observeFinalCdnDelivery(oldPayload, oldToken)
    assert.equal(publications.length, publicationsBeforeStaleReplay)
    assert.deepEqual(runtime.getCdnProbeStatus().candidateHosts, [new URL(newUrl).host])
}

{
    const oldUrl = 'https://mode-reentrant-old.test.bilivideo.com/video.m4s?sig=old'
    const newUrl = 'https://mode-reentrant-new.test.bilivideo.com/video.m4s?sig=new'
    const oldPayload = { groups: [makeCandidateGroup('mode-reentrant-old', [oldUrl])] }
    const newPayload = { groups: [makeCandidateGroup('mode-reentrant-new', [newUrl])] }
    const publications = []
    const scheduled = []
    let runtime
    let reentered = false
    runtime = makeRuntime({
        getMode() {
            if (!reentered) {
                reentered = true
                runtime.observeFinalCdnDelivery(newPayload, newToken)
            }
            return 'auto'
        },
        collectGroups: playUrl => playUrl.groups,
        optimize() {
            return { changed: false, groups: 1, diagnostics: [] }
        },
        publishRecoveryGroups(groups, enabled) {
            publications.push({ groups, enabled })
        },
        scheduleBackground(callback) {
            scheduled.push(callback)
        },
    })
    const oldToken = runtime.beginFinalCdnDelivery()
    const newToken = runtime.beginFinalCdnDelivery()

    runtime.observeFinalCdnDelivery(oldPayload, oldToken)

    assert.equal(reentered, true, 'mode lookup must exercise synchronous final-delivery reentry')
    assert.deepEqual(runtime.getCdnProbeStatus().candidateHosts, [new URL(newUrl).host])
    assert.deepEqual(publications.map(publication => publication.groups[0].key), [
        'mode-reentrant-new',
    ])
    assert.equal(publications[0].enabled, true)
    assert.equal(scheduled.length, 1)
}

{
    const innerUrl = 'https://same-token-inner.test.bilivideo.com/video.m4s?sig=inner'
    const outerUrl = 'https://same-token-outer.test.bilivideo.com/video.m4s?sig=outer'
    const innerGroups = [makeCandidateGroup('same-token-inner', [innerUrl])]
    const outerGroups = [makeCandidateGroup('same-token-outer', [outerUrl])]
    const innerPayload = { groups: innerGroups }
    const outerPayload = { groups: outerGroups }
    const publications = []
    const scheduled = []
    let optimizeCalls = 0
    const runtime = makeRuntime({
        getMode: () => 'auto',
        collectGroups: playUrl => playUrl.groups,
        optimize() {
            optimizeCalls += 1
            return { changed: false, groups: 1, diagnostics: [] }
        },
        publishRecoveryGroups(groups, enabled) {
            publications.push({ groups, enabled })
        },
        scheduleBackground(callback) {
            scheduled.push(callback)
        },
    })

    const token = runtime.beginFinalCdnDelivery()
    assert.strictEqual(runtime.observeFinalCdnDelivery(innerPayload, token), innerPayload)
    assert.strictEqual(runtime.observeFinalCdnDelivery(outerPayload, token), outerPayload)
    assert.equal(optimizeCalls, 0)
    assert.equal(publications.length, 2)
    assert.strictEqual(publications[1].groups, outerGroups)
    assert.equal(publications[1].enabled, true)
    assert.deepEqual(runtime.getCdnProbeStatus().candidateHosts, [new URL(outerUrl).host])
    assert.equal(scheduled.length, 2)
}

{
    const pendingUrl = 'https://pending-request.test.bilivideo.com/video.m4s?sig=pending'
    const synchronousPolicyUrl = 'https://vue-sync-policy.test.bilivideo.com/video.m4s?sig=policy'
    const synchronousFinalUrl = 'https://vue-sync-final.test.bilivideo.com/video.m4s?sig=final'
    const pendingGroups = [makeCandidateGroup('pending-request', [pendingUrl])]
    const synchronousPolicyGroups = [makeCandidateGroup('vue-sync-policy', [synchronousPolicyUrl])]
    const synchronousFinalGroups = [makeCandidateGroup('vue-sync-final', [synchronousFinalUrl])]
    const pendingPayload = { groups: pendingGroups }
    const synchronousPolicyPayload = { groups: synchronousPolicyGroups }
    const synchronousFinalPayload = { groups: synchronousFinalGroups }
    const recovery = createCdnRecoveryCoordinator()
    const publications = []
    const scheduled = []
    const fetched = []
    let collections = 0
    let optimizeCalls = 0
    const runtime = makeRuntime({
        getMode: () => 'auto',
        collectGroups(playUrl) {
            collections += 1
            return playUrl.groups
        },
        optimize() {
            optimizeCalls += 1
            return { changed: false, groups: 1, diagnostics: [] }
        },
        publishRecoveryGroups(groups, enabled) {
            publications.push({
                groups,
                enabled,
                status: recovery.publishGroups(groups, enabled),
            })
        },
        scheduleBackground(callback) {
            scheduled.push(callback)
        },
        fetch: async url => {
            fetched.push(String(url))
            return streamResponse([new Uint8Array(1)])
        },
        limits: { maxConcurrent: 1, maxStages: 1 },
    })

    const pendingToken = runtime.beginFinalCdnDelivery()
    runtime.transformCdnPolicyForFinalDelivery(synchronousPolicyPayload)
    assert.equal(optimizeCalls, 1)
    assert.equal(publications.length, 0)
    assert.strictEqual(runtime.observeFinalCdnDelivery(synchronousFinalPayload), synchronousFinalPayload)
    assert.equal(optimizeCalls, 1)
    assert.deepEqual(runtime.getCdnProbeStatus().candidateHosts, [new URL(synchronousFinalUrl).host])
    const collectionsBeforePendingCompletion = collections

    assert.strictEqual(runtime.observeFinalCdnDelivery(pendingPayload, pendingToken), pendingPayload)
    assert.equal(collections, collectionsBeforePendingCompletion)
    assert.equal(optimizeCalls, 1)
    assert.deepEqual(runtime.getCdnProbeStatus().candidateHosts, [new URL(synchronousFinalUrl).host])
    const acceptedPublication = publications[publications.length - 1]
    assert.equal(acceptedPublication.enabled, true)
    assert.deepEqual(
        acceptedPublication.groups.flatMap(group => group.candidates.map(candidate => candidate.url)),
        [synchronousFinalUrl],
    )
    assert.equal(acceptedPublication.status.groups[0].key, 'vue-sync-final')
    assert.deepEqual(
        publications.map(publication => publication.status.groups[0].key),
        ['vue-sync-final'],
    )
    assert.equal(runtime.beginFinalCdnDelivery(), pendingToken + 2)
    assert.equal(scheduled.length, 1)

    scheduled[0]()
    const probeStatus = await runtime.probeCurrentPlayUrlCdn()
    assert.deepEqual(fetched, [synchronousFinalUrl])
    assert.deepEqual(probeStatus.candidateHosts, [new URL(synchronousFinalUrl).host])
}

{
    for (const mode of ['manual', 'original', 'safe']) {
        const groups = [makeCandidateGroup(`final-delivery:${mode}`, [
            `https://final-${mode}.test.bilivideo.com/video.m4s?sig=${mode}`,
        ])]
        const payload = { groups, nested: { mode } }
        const nestedIdentity = payload.nested
        const publications = []
        const scheduled = []
        let collections = 0
        let optimizeCalls = 0
        let manualRewriteCalls = 0
        const runtime = makeRuntime({
            getMode: () => mode,
            getManualHost: () => 'manual.example',
            collectGroups(playUrl) {
                collections += 1
                assert.strictEqual(playUrl, payload)
                return playUrl.groups
            },
            optimize() {
                optimizeCalls += 1
                return { changed: false, groups: 1, diagnostics: [] }
            },
            replaceManual(playUrl) {
                manualRewriteCalls += 1
                return playUrl
            },
            publishRecoveryGroups(publishedGroups, enabled) {
                publications.push({ groups: publishedGroups, enabled })
            },
            scheduleBackground(callback) {
                scheduled.push(callback)
            },
        })

        assert.strictEqual(runtime.observeFinalCdnDelivery(payload), payload, mode)
        assert.strictEqual(payload.groups, groups, mode)
        assert.strictEqual(payload.nested, nestedIdentity, mode)
        assert.equal(collections, 1, mode)
        assert.equal(optimizeCalls, 0, mode)
        assert.equal(manualRewriteCalls, 0, mode)
        assert.equal(publications.length, 1, mode)
        assert.strictEqual(publications[0].groups, groups, mode)
        assert.equal(publications[0].enabled, false, mode)
        assert.deepEqual(scheduled, [], mode)
    }
}

{
    const calls = {
        collect: 0,
        optimize: 0,
        rewrite: 0,
        publish: 0,
        schedule: 0,
    }
    const runtime = makeRuntime({
        getMode: () => 'auto',
        collectGroups() {
            calls.collect += 1
            return []
        },
        optimize() {
            calls.optimize += 1
            return { changed: false, groups: 0, diagnostics: [] }
        },
        replaceManual(playUrl) {
            calls.rewrite += 1
            return playUrl
        },
        publishRecoveryGroups() {
            calls.publish += 1
        },
        scheduleBackground() {
            calls.schedule += 1
        },
    })

    for (const invalidPayload of [null, undefined, false, 0, '']) {
        assert.strictEqual(runtime.observeFinalCdnDelivery(invalidPayload), invalidPayload)
    }
    assert.deepEqual(calls, {
        collect: 0,
        optimize: 0,
        rewrite: 0,
        publish: 0,
        schedule: 0,
    })
}

{
    const recovery = createCdnRecoveryCoordinator()
    const groups = [makeCandidateGroup('collection-success', [
        'https://collection-success.test.bilivideo.com/video.m4s?sig=success',
    ])]
    const publications = []
    const logs = []
    let collectionFails = false
    const runtime = makeRuntime({
        getMode: () => 'auto',
        collectGroups() {
            if (collectionFails) throw new Error('collection failed')
            return groups
        },
        optimize() {
            return { changed: false, groups: 1, diagnostics: [] }
        },
        publishRecoveryGroups(publishedGroups, enabled) {
            publications.push({
                groups: publishedGroups,
                enabled,
                status: recovery.publishGroups(publishedGroups, enabled),
            })
        },
        scheduleBackground() { },
        log(event) {
            logs.push(event)
        },
    })

    runtime.applyCdnPolicy({ urls: groups[0].candidates.map(candidate => candidate.url) })
    collectionFails = true
    runtime.applyCdnPolicy({ urls: groups[0].candidates.map(candidate => candidate.url) })
    assert.equal(publications.length, 2)
    assert.equal(publications[0].status.groupCount, 1)
    assert.deepEqual(publications[1].groups, [])
    assert.equal(publications[1].enabled, true)
    assert.equal(publications[1].status.groupCount, 0)
    assert.equal(publications[1].status.generation, publications[0].status.generation + 1)
    assert.equal(logs.filter(event => event === 'cdn-candidate-collection-failed').length, 2)
}

{
    const recovery = createCdnRecoveryCoordinator()
    const groups = [makeCandidateGroup('invalid-payload-clear', [
        'https://invalid-payload.test.bilivideo.com/video.m4s?sig=valid',
    ])]
    const publications = []
    const runtime = makeRuntime({
        getMode: () => 'auto',
        collectGroups: playUrl => playUrl.groups,
        optimize() {
            return { changed: false, groups: 1, diagnostics: [] }
        },
        publishRecoveryGroups(publishedGroups, enabled) {
            publications.push({
                groups: publishedGroups,
                enabled,
                status: recovery.publishGroups(publishedGroups, enabled),
            })
        },
        scheduleBackground() { },
    })

    runtime.applyCdnPolicy({ groups })
    assert.equal(publications[0].status.groupCount, 1)
    assert.strictEqual(runtime.applyCdnPolicy(null), null)
    assert.deepEqual(publications[1].groups, [])
    assert.equal(publications[1].enabled, true)
    assert.equal(publications[1].status.groupCount, 0)
}

{
    const urls = [
        'https://group-a.test.bilivideo.com/video.m4s?sig=a',
        'https://group-b.test.bilivideo.com/video.m4s?sig=b',
        'https://group-c.test.bilivideo.com/video.m4s?sig=c',
    ]
    const firstGroups = [
        makeCandidateGroup('dash.video[0]', urls.slice(0, 2)),
        makeCandidateGroup('dash.video[1]', urls.slice(2)),
    ]
    const secondGroups = [
        makeCandidateGroup('dash.video[0]', urls.slice(0, 1)),
        makeCandidateGroup('dash.video[1]', urls.slice(1)),
    ]
    const recovery = createCdnRecoveryCoordinator()
    const publications = []
    let stage2Schedules = 0
    const runtime = makeRuntime({
        getMode: () => 'auto',
        collectGroups(playUrl) {
            return playUrl.groups
        },
        optimize() {
            return { changed: false, groups: 2, diagnostics: [] }
        },
        publishRecoveryGroups(groups, enabled) {
            publications.push({
                flattenedUrls: groups.flatMap(group => group.candidates.map(candidate => candidate.url)).sort(),
                status: recovery.publishGroups(groups, enabled),
            })
        },
        scheduleBackground() {
            stage2Schedules += 1
        },
    })

    runtime.applyCdnPolicy({ groups: firstGroups })
    runtime.applyCdnPolicy({ groups: secondGroups })
    assert.equal(publications.length, 2)
    assert.deepEqual(publications[0].flattenedUrls, publications[1].flattenedUrls)
    assert.equal(publications[0].status.groupCount, 2)
    assert.equal(publications[1].status.groupCount, 2)
    assert.equal(publications[1].status.generation, publications[0].status.generation + 1)
    assert.equal(stage2Schedules, 1, 'cross-group reassignment changed the Stage 2 flattened generation')
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
    assert.equal(cache.version, CDN_HEALTH_CACHE_VERSION)
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
    assert.equal(result.state, 'partial')
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
    assert.equal((await pending).state, 'partial')
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
    let fetches = 0
    let resolveOldRead
    let oldSignal
    const runtime = makeRuntime({
        fetch: async (_url, init) => {
            fetches += 1
            if (fetches > 1) return streamResponse([new Uint8Array(4)])
            oldSignal = init.signal
            return {
                ok: true,
                type: 'basic',
                body: {
                    getReader() {
                        return {
                            read() { return new Promise(resolve => { resolveOldRead = resolve }) },
                            cancel() { return Promise.resolve() },
                            releaseLock() { },
                        }
                    },
                },
            }
        },
        limits: { maxConcurrent: 1, maxStages: 1, maxBytesPerRequest: 4, maxTotalBytes: 4 },
    })
    runtime.applyCdnPolicy({ urls: [signedUrl] })
    const oldProbe = runtime.probeCurrentPlayUrlCdn({ force: true })
    await flushMicrotasks()
    assert.equal(fetches, 1)

    runtime.clearCdnHealthCache()
    assert.equal(oldSignal.aborted, true)
    let forcedSettled = false
    const forcedA = runtime.probeCurrentPlayUrlCdn({ force: true })
    const forcedB = runtime.probeCurrentPlayUrlCdn({ force: true })
    assert.strictEqual(forcedA, forcedB)
    void forcedA.then(() => { forcedSettled = true })
    await flushMicrotasks(10)
    assert.equal(forcedSettled, false)
    assert.equal(fetches, 1)

    resolveOldRead({ done: true, value: undefined })
    for (let index = 0; index < 20 && fetches < 2; index += 1) await flushMicrotasks()
    assert.equal(fetches, 2)
    const result = await forcedA
    assert.equal(result.state, 'ready')
    assert.equal(forcedSettled, true)
    await oldProbe
}

{
    const timerCallbacks = new Map()
    let nextTimer = 0
    let resolveRead
    let reads = 0
    let cancels = 0
    let fetches = 0
    const runtime = makeRuntime({
        fetch: async () => {
            fetches += 1
            return ({
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
            })
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
    runtime.applyCdnPolicy({ urls: [
        signedUrl,
        'https://late-next.test.bilivideo.com/media.m4s?sig=must-not-start',
    ] })
    const pending = runtime.probeCurrentPlayUrlCdn({ force: true })
    await flushMicrotasks()
    assert.equal(reads, 1)
    ;[...timerCallbacks.values()][0]()
    const result = await pending
    assert.equal(result.state, 'partial')
    assert.equal(result.completed, 1)
    assert.equal(result.total, 2)
    assert.equal(fetches, 1)
    assert.equal(cancels, 1)
    const settledStatus = JSON.stringify(runtime.getCdnProbeStatus())
    resolveRead({ done: false, value: new Uint8Array(2) })
    await flushMicrotasks(10)
    assert.equal(reads, 1)
    assert.equal(fetches, 1)
    assert.equal(JSON.stringify(runtime.getCdnProbeStatus()), settledStatus)
}

{
    const timerCallbacks = new Map()
    const cleared = []
    let nextTimer = 0
    let resolveCancel
    let released = 0
    let settled = false
    let requestSignal
    const runtime = makeRuntime({
        fetch: async (_url, init) => {
            requestSignal = init.signal
            return ({
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
            })
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
    assert.equal(timerCallbacks.size, 2)
    timerCallbacks.get(Math.max(...timerCallbacks.keys()))()
    assert.equal((await pending).state, 'partial')
    assert.equal(settled, true)
    assert.equal(released, 1)
    assert.equal(requestSignal.aborted, true)
    assert.deepEqual([...cleared].sort(), [1, 2])
}

{
    const timerCallbacks = new Map()
    let nextTimer = 0
    let resolveCancel
    let fetches = 0
    const runtime = makeRuntime({
        fetch: async () => {
            fetches += 1
            if (fetches > 1) return streamResponse([new Uint8Array(4)])
            return {
                ok: true,
                type: 'basic',
                body: {
                    getReader() {
                        return {
                            async read() { return { done: false, value: new Uint8Array(16) } },
                            cancel() {
                                return new Promise(resolve => { resolveCancel = resolve })
                            },
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
        limits: { maxConcurrent: 1, maxStages: 1, maxBytesPerRequest: 4, maxTotalBytes: 4 },
    })
    runtime.applyCdnPolicy({ urls: [signedUrl] })
    const firstProbe = runtime.probeCurrentPlayUrlCdn({ force: true })
    await flushMicrotasks()
    assert.equal(typeof resolveCancel, 'function')
    timerCallbacks.get(Math.max(...timerCallbacks.keys()))()
    assert.equal((await firstProbe).state, 'partial')
    assert.equal(fetches, 1)

    let forcedSettled = false
    const forcedA = runtime.probeCurrentPlayUrlCdn({ force: true })
    const forcedB = runtime.probeCurrentPlayUrlCdn({ force: true })
    assert.strictEqual(forcedA, forcedB)
    void forcedA.then(() => { forcedSettled = true })
    await flushMicrotasks(10)
    assert.equal(forcedSettled, false)
    assert.equal(fetches, 1)

    resolveCancel()
    for (let index = 0; index < 20 && fetches < 2; index += 1) await flushMicrotasks()
    assert.equal(fetches, 2)
    assert.equal((await forcedA).state, 'ready')
    assert.equal(forcedSettled, true)
}

{
    let readerCancelCalls = 0
    let readerReleaseCalls = 0
    let readerSignal
    let readerFetches = 0
    const readerStorage = new MemoryStorage()
    readerStorage.values.set(CDN_HEALTH_CACHE_KEY, '{"stale":true}')
    const rejectingReaderRuntime = makeRuntime({
        storage: readerStorage,
        fetch: async (_url, init) => {
            readerFetches += 1
            if (readerFetches > 1) return streamResponse([new Uint8Array(4)])
            readerSignal = init.signal
            return {
                ok: true,
                type: 'basic',
                body: {
                    getReader() {
                        return {
                            async read() { return { done: false, value: new Uint8Array(4) } },
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
        limits: {
            maxConcurrent: 1,
            maxStages: 2,
            initialBytesPerRequest: 4,
            maxBytesPerRequest: 4,
            maxTotalBytes: 8,
        },
    })
    rejectingReaderRuntime.applyCdnPolicy({ urls: [signedUrl] })
    assert.equal((await rejectingReaderRuntime.probeCurrentPlayUrlCdn({ force: true })).state, 'partial')
    assert.equal(readerFetches, 1, 'cleanup-unsafe successful sample started Stage 2')
    assert.equal(readerStorage.getItem(CDN_HEALTH_CACHE_KEY), null, 'cleanup-unsafe successful sample retained cache')
    assert.equal(readerCancelCalls, 1)
    assert.equal(readerReleaseCalls, 1)
    assert.equal(readerSignal.aborted, true)
    assert.equal((await rejectingReaderRuntime.probeCurrentPlayUrlCdn({ force: true })).state, 'ready')
    assert.equal(readerFetches, 3)

    let responseCancelCalls = 0
    let responseSignal
    let responseFetches = 0
    const nonOkRuntime = makeRuntime({
        fetch: async (_url, init) => {
            responseFetches += 1
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
    assert.equal((await nonOkRuntime.probeCurrentPlayUrlCdn({ force: true })).state, 'partial')
    assert.equal(responseCancelCalls, 1)
    assert.equal(responseSignal.aborted, true)
    assert.equal((await nonOkRuntime.probeCurrentPlayUrlCdn({ force: true })).state, 'partial')
    assert.equal(responseFetches, 2)
}

{
    const timerCallbacks = new Map()
    const storage = new MemoryStorage()
    storage.values.set(CDN_HEALTH_CACHE_KEY, '{"stale":true}')
    let nextTimer = 0
    let resolveRead
    let rejectCancel
    let releases = 0
    let fetches = 0
    const runtime = makeRuntime({
        storage,
        fetch: async () => {
            fetches += 1
            if (fetches > 1) return streamResponse([new Uint8Array(4)])
            return {
                ok: true,
                type: 'basic',
                body: {
                    getReader() {
                        return {
                            read() { return new Promise(resolve => { resolveRead = resolve }) },
                            cancel() {
                                return new Promise((_resolve, reject) => { rejectCancel = reject })
                            },
                            releaseLock() { releases += 1 },
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
            initialBytesPerRequest: 4,
            maxBytesPerRequest: 4,
            maxTotalBytes: 8,
            requestTimeoutMs: 10,
            stageTimeoutMs: 20,
            totalTimeoutMs: 30,
        },
    })
    runtime.applyCdnPolicy({ urls: [signedUrl] })
    const firstProbe = runtime.probeCurrentPlayUrlCdn({ force: true })
    await flushMicrotasks()
    assert.equal(typeof resolveRead, 'function')
    assert.equal(timerCallbacks.size, 1)
    ;[...timerCallbacks.values()][0]()
    for (let index = 0; index < 20 && typeof rejectCancel !== 'function'; index += 1) await flushMicrotasks()
    assert.equal(typeof rejectCancel, 'function')
    rejectCancel(new Error('delayed cancel rejection'))
    assert.equal((await firstProbe).state, 'partial')
    assert.equal(fetches, 1, 'cleanup-unsafe round started Stage 2')
    assert.equal(storage.getItem(CDN_HEALTH_CACHE_KEY), null, 'cleanup-unsafe round retained a cache envelope')

    let forcedSettled = false
    const forcedProbe = runtime.probeCurrentPlayUrlCdn({ force: true })
    void forcedProbe.then(() => { forcedSettled = true })
    await flushMicrotasks(10)
    assert.equal(forcedSettled, false, 'cancel rejection released the fence before the request settled')
    assert.equal(fetches, 1)

    resolveRead({ done: true, value: undefined })
    for (let index = 0; index < 20 && fetches < 2; index += 1) await flushMicrotasks()
    assert.equal(fetches, 2, 'settled request did not release the forced-probe fence')
    assert.equal((await forcedProbe).state, 'ready')
    assert.equal(fetches, 3, 'forced retry did not complete both probe stages')
    assert.equal(releases, 1)
}

{
    const timerCallbacks = new Map()
    let nextTimer = 0
    let requestIndex = 0
    const storage = new MemoryStorage()
    const runtime = makeRuntime({
        storage,
        fetch: async () => {
            requestIndex += 1
            if (requestIndex === 1) {
                return streamResponse([new Uint8Array(8)])
            }
            return {
                ok: true,
                type: 'basic',
                body: {
                    getReader() {
                        return {
                            read() { return new Promise(() => { }) },
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
            maxTotalBytes: 16,
            requestTimeoutMs: 10,
            stageTimeoutMs: 10,
            totalTimeoutMs: 20,
        },
    })
    runtime.applyCdnPolicy({ urls: [signedUrl] })
    const pending = runtime.probeCurrentPlayUrlCdn({ force: true })
    for (let index = 0; index < 20 && requestIndex < 2; index += 1) await flushMicrotasks()
    assert.equal(requestIndex, 2)
    ;[...timerCallbacks.values()][0]()
    const result = await pending
    assert.equal(result.state, 'partial')
    assert.equal(requestIndex, 2)
    assert.deepEqual(result.healthyHosts, ['cdn-a.test.bilivideo.com:8443'])
    assert.deepEqual(result.failedHosts, [])
    assert.deepEqual(result.unprobeableHosts, [])
    assert.equal(result.completed, 2)
    assert.equal(result.total, 2)
    assert.equal(result.hostDiagnostics[0].classification, 'healthy')
    assert.equal(result.hostDiagnostics[0].stagesCompleted, 2)
    assert.equal(storage.getItem(CDN_HEALTH_CACHE_KEY), null)
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
    assert.equal(result.hostDiagnostics[0].accountedBytes, 4)
    assert.equal(result.hostDiagnostics[0].observedBytes, 16)
    assert.equal(result.hostDiagnostics[0].throughputKbps, 32)
    assert.equal(storage.getItem(CDN_HEALTH_CACHE_KEY), null)
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
    const requestedHosts = []
    const callsByHost = new Map()
    const firstStageSizes = new Map([
        ['one.test.bilivideo.com', 4],
        ['two.test.bilivideo.com', 3],
        ['three.test.bilivideo.com', 2],
        ['four.test.bilivideo.com', 1],
    ])
    let active = 0
    let maxActive = 0
    const runtime = makeRuntime({
        storage,
        now: () => 50_000,
        fetch(url) {
            const host = new URL(url).host
            const call = (callsByHost.get(host) ?? 0) + 1
            callsByHost.set(host, call)
            requestedHosts.push(host)
            active += 1
            maxActive = Math.max(maxActive, active)
            return new Promise(resolve => pendingFetches.push({
                url,
                resolve() {
                    active -= 1
                    const bytes = call === 1 ? firstStageSizes.get(host) : 4
                    resolve(streamResponse([new Uint8Array(bytes)]))
                },
            }))
        },
        limits: { maxConcurrent: 99, maxStages: 2, maxBytesPerRequest: 4, maxTotalBytes: 24 },
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
    for (let index = 0; index < 20 && pendingFetches.length < 2; index += 1) await flushMicrotasks()
    assert.equal(active, 2)
    assert.equal(pendingFetches.length, 2)
    pendingFetches.splice(0).forEach(request => request.resolve())
    const result = await pendingProbe
    assert.equal(maxActive, 2)
    assert.equal(result.total, 6)
    assert.equal(result.completed, 6)
    assert.deepEqual(requestedHosts.slice(0, 4), [
        'one.test.bilivideo.com',
        'two.test.bilivideo.com',
        'three.test.bilivideo.com',
        'four.test.bilivideo.com',
    ])
    assert.deepEqual(requestedHosts.slice(4), [
        'one.test.bilivideo.com',
        'two.test.bilivideo.com',
    ])
    const cache = JSON.parse(storage.getItem(CDN_HEALTH_CACHE_KEY))
    assert.equal(cache.hosts['one.test.bilivideo.com'].samples, 2)
    assert.equal(cache.hosts['two.test.bilivideo.com'].samples, 2)
    assert.equal(cache.hosts['three.test.bilivideo.com'].samples, 1)
    assert.equal(cache.hosts['four.test.bilivideo.com'].samples, 1)
}

{
    const rankedUrls = [
        'https://rank-known-high.test.bilivideo.com/a?sig=known-high',
        'https://rank-unknown.test.bilivideo.com/a?sig=unknown',
        'https://rank-known-low.test.bilivideo.com/a?sig=known-low',
    ]
    const storage = new MemoryStorage()
    const requestedHosts = []
    const runtime = makeRuntime({
        storage,
        now: () => 50_000,
        collectGroups: () => rankedUrls.map((url, index) => ({
            ...candidateGroups({
                urls: [url],
                ...(index === 0 ? { bandwidthBps: 1_000_000 } : {}),
                ...(index === 2 ? { bandwidthBps: 2_000_000 } : {}),
            })[0],
            key: `rank[${index}]`,
        })),
        fetch: async url => {
            requestedHosts.push(new URL(url).host)
            return streamResponse([new Uint8Array(4)])
        },
        limits: { maxConcurrent: 2, maxStages: 2, maxBytesPerRequest: 4, maxTotalBytes: 20 },
    })
    runtime.applyCdnPolicy({})
    const result = await runtime.probeCurrentPlayUrlCdn({ force: true })
    assert.equal(result.state, 'ready')
    assert.deepEqual(requestedHosts.slice(3), [
        'rank-known-high.test.bilivideo.com',
        'rank-known-low.test.bilivideo.com',
    ])
}

{
    const urls = [
        'https://stage-timeout-a.test.bilivideo.com/a?sig=a',
        'https://stage-timeout-b.test.bilivideo.com/a?sig=b',
        'https://stage-timeout-c.test.bilivideo.com/a?sig=c',
    ]
    const storage = new MemoryStorage()
    const requestedHosts = []
    let now = 0
    const runtime = makeRuntime({
        storage,
        now: () => now,
        fetch: async url => {
            requestedHosts.push(new URL(url).host)
            let delivered = false
            return {
                ok: true,
                type: 'basic',
                body: {
                    getReader() {
                        return {
                            async read() {
                                if (delivered) return { done: true, value: undefined }
                                delivered = true
                                now += 6
                                return { done: false, value: new Uint8Array(4) }
                            },
                            cancel() { return Promise.resolve() },
                            releaseLock() { },
                        }
                    },
                },
            }
        },
        limits: {
            maxConcurrent: 1,
            maxStages: 2,
            maxBytesPerRequest: 4,
            maxTotalBytes: 20,
            stageTimeoutMs: 5,
            totalTimeoutMs: 100,
        },
    })
    runtime.applyCdnPolicy({ urls })
    const result = await runtime.probeCurrentPlayUrlCdn({ force: true })
    assert.equal(result.state, 'partial')
    assert.equal(result.completed, 1)
    assert.equal(result.total, 3)
    assert.deepEqual(requestedHosts, ['stage-timeout-a.test.bilivideo.com'])
    assert.equal(storage.getItem(CDN_HEALTH_CACHE_KEY), null)
}

{
    const urls = [
        'https://cache-incomplete-a.test.bilivideo.com/a?sig=a',
        'https://cache-incomplete-b.test.bilivideo.com/a?sig=b',
        'https://cache-incomplete-c.test.bilivideo.com/a?sig=c',
    ]
    const storage = new MemoryStorage()
    const incompleteRuntime = makeRuntime({
        storage,
        fetch: async () => streamResponse([new Uint8Array(4)]),
        limits: { maxConcurrent: 1, maxStages: 1, maxBytesPerRequest: 4, maxTotalBytes: 4 },
    })
    incompleteRuntime.applyCdnPolicy({ urls })
    const incomplete = await incompleteRuntime.probeCurrentPlayUrlCdn({ force: true })
    assert.equal(incomplete.state, 'partial')
    assert.equal(incomplete.completed, 1)
    assert.equal(incomplete.total, 3)
    assert.deepEqual(incomplete.budgetLimitedHosts, [
        'cache-incomplete-b.test.bilivideo.com',
        'cache-incomplete-c.test.bilivideo.com',
    ])
    assert.equal(storage.getItem(CDN_HEALTH_CACHE_KEY), null)

    let reloadFetches = 0
    const reloadRuntime = makeRuntime({
        storage,
        fetch: async () => {
            reloadFetches += 1
            return streamResponse([new Uint8Array(4)])
        },
        limits: { maxConcurrent: 1, maxStages: 1, maxBytesPerRequest: 4, maxTotalBytes: 12 },
    })
    reloadRuntime.applyCdnPolicy({ urls })
    const reloaded = await reloadRuntime.probeCurrentPlayUrlCdn()
    assert.equal(reloaded.state, 'ready')
    assert.equal(reloadFetches, 3)
    assert.deepEqual(reloaded.budgetLimitedHosts, [])
}

{
    const host = 'bandwidth.test.bilivideo.com'
    const url = `https://${host}/media.m4s?sig=bandwidth-private`
    const storage = new MemoryStorage()
    const trackers = []
    let fetches = 0
    const runtime = makeRuntime({
        storage,
        now: () => 75_000,
        fetch: async () => {
            fetches += 1
            const tracker = {}
            trackers.push(tracker)
            return fetches === 1
                ? streamResponse([new Uint8Array(64 * 1024)], tracker)
                : streamResponse(Array.from({ length: 4 }, () => new Uint8Array(128 * 1024)), tracker)
        },
    })
    runtime.applyCdnPolicy({ urls: [url], bandwidthBps: 1_000_000 })
    const result = await runtime.probeCurrentPlayUrlCdn({ force: true })
    assert.equal(fetches, 2)
    assert.equal(trackers[0].reads, 1)
    assert.equal(trackers[1].reads, 4)
    assert.equal(result.state, 'ready')
    assert.equal(result.hostDiagnostics[0].accountedBytes, 576 * 1024)
    assert.equal(result.hostDiagnostics[0].observedBytes, 576 * 1024)
    assert.equal(result.hostDiagnostics[0].bandwidthBps, 1_000_000)
    assert.equal(
        result.hostDiagnostics[0].bitrateMargin,
        result.hostDiagnostics[0].throughputKbps / 1_000,
    )
    const health = JSON.parse(storage.getItem(CDN_HEALTH_CACHE_KEY)).hosts[host]
    assert.equal(health.measuredBytes, 576 * 1024)
}

{
    const urls = Array.from({ length: 17 }, (_, index) => (
        `https://h${String(index + 1).padStart(2, '0')}.test.bilivideo.com/media.m4s?sig=budget-${index + 1}`
    ))
    const storage = new MemoryStorage()
    const callsByHost = new Map()
    let fetches = 0
    const runtime = makeRuntime({
        storage,
        now: () => 80_000,
        fetch: async url => {
            fetches += 1
            const host = new URL(url).host
            const call = (callsByHost.get(host) ?? 0) + 1
            callsByHost.set(host, call)
            if (host === 'h01.test.bilivideo.com' && call === 1) {
                return { ok: false, type: 'basic', body: { cancel: () => Promise.resolve() } }
            }
            return streamResponse([new Uint8Array(call === 1 ? 64 * 1024 : 512 * 1024)])
        },
    })
    runtime.applyCdnPolicy({ urls })
    const result = await runtime.probeCurrentPlayUrlCdn({ force: true })
    assert.equal(result.state, 'partial')
    assert.equal(fetches, 19)
    assert.equal(result.completed, 19)
    assert.equal(result.total, 19)
    assert.deepEqual(result.budgetLimitedHosts, [])
    assert.equal(result.probedHosts.includes('h17.test.bilivideo.com'), true)
    assert.equal(result.healthyHosts.includes('h17.test.bilivideo.com'), true)
    assert.deepEqual(result.failedHosts, ['h01.test.bilivideo.com'])
    assert.equal(result.unprobeableHosts.includes('h17.test.bilivideo.com'), false)
    assert.equal(
        result.hostDiagnostics.reduce((sum, diagnostic) => sum + diagnostic.accountedBytes, 0),
        2 * 1024 * 1024,
    )
    assert.equal(
        result.hostDiagnostics.reduce((sum, diagnostic) => sum + diagnostic.observedBytes, 0),
        2 * 1024 * 1024,
    )
    assert.equal(
        result.hostDiagnostics.find(diagnostic => diagnostic.host === 'h17.test.bilivideo.com').classification,
        'healthy',
    )
    const cacheText = storage.getItem(CDN_HEALTH_CACHE_KEY)
    assert.doesNotMatch(cacheText, /media\.m4s|sig=budget/)
    assert.equal(Object.keys(JSON.parse(cacheText).hosts).length, 17)
}

{
    const urls = [
        'https://good-fast.test.bilivideo.com/a?sig=good-fast',
        'https://failed.test.bilivideo.com/a?sig=failed',
        'https://unprobeable.test.bilivideo.com/a?sig=unprobeable',
        'https://good-slow.test.bilivideo.com/a?sig=good-slow',
    ]
    const storage = new MemoryStorage()
    const requestedHosts = []
    const callsByHost = new Map()
    const runtime = makeRuntime({
        storage,
        fetch: async url => {
            const host = new URL(url).host
            requestedHosts.push(host)
            callsByHost.set(host, (callsByHost.get(host) ?? 0) + 1)
            if (host.startsWith('failed.')) {
                return { ok: false, type: 'basic', body: { cancel: () => Promise.resolve() } }
            }
            if (host.startsWith('unprobeable.')) throw new TypeError('CORS blocked')
            return streamResponse([new Uint8Array(host.startsWith('good-fast.') ? 4 : 2)])
        },
        limits: { maxConcurrent: 2, maxStages: 2, maxBytesPerRequest: 4, maxTotalBytes: 24 },
    })
    runtime.applyCdnPolicy({ urls })
    const result = await runtime.probeCurrentPlayUrlCdn({ force: true })
    assert.equal(result.state, 'partial')
    assert.deepEqual(result.healthyHosts, [
        'good-fast.test.bilivideo.com',
        'good-slow.test.bilivideo.com',
    ])
    assert.deepEqual(result.failedHosts, ['failed.test.bilivideo.com'])
    assert.deepEqual(result.unprobeableHosts, ['unprobeable.test.bilivideo.com'])
    assert.equal(callsByHost.get('failed.test.bilivideo.com'), 1)
    assert.equal(callsByHost.get('unprobeable.test.bilivideo.com'), 1)
    assert.deepEqual(requestedHosts.slice(4).sort(), [
        'good-fast.test.bilivideo.com',
        'good-slow.test.bilivideo.com',
    ])
    const classifiedHosts = [
        ...result.healthyHosts,
        ...result.failedHosts,
        ...result.unprobeableHosts,
        ...result.budgetLimitedHosts,
    ]
    assert.equal(new Set(classifiedHosts).size, classifiedHosts.length)
    assert.equal(storage.getItem(CDN_HEALTH_CACHE_KEY), null)
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

    let deferredOptions
    let deferredPublications = 0
    let deferredSchedules = 0
    const deferredRuntime = makeRuntime({
        storage: new MemoryStorage({ [CDN_HEALTH_CACHE_KEY]: freshCacheText }),
        now: () => now + 1,
        getMode: () => 'auto',
        optimize(_playUrl, options) {
            deferredOptions = options
            return { changed: false, groups: 1, diagnostics: [] }
        },
        publishRecoveryGroups() {
            deferredPublications += 1
        },
        scheduleBackground() {
            deferredSchedules += 1
        },
    })
    const deferredPayload = { urls: [url] }
    const deferredToken = deferredRuntime.beginFinalCdnDelivery()
    deferredRuntime.transformCdnPolicyForFinalDelivery(deferredPayload)
    assert.equal(deferredOptions.hostHealth['cache.test.bilivideo.com'].samples, 2)
    assert.deepEqual(deferredRuntime.getCdnProbeStatus().candidateHosts, [])
    assert.equal(deferredRuntime.getCdnProbeStatus().state, 'idle')
    assert.equal(deferredPublications, 0)
    assert.equal(deferredSchedules, 0)
    deferredRuntime.observeFinalCdnDelivery(deferredPayload, deferredToken)
    assert.equal(deferredRuntime.getCdnProbeStatus().source, 'cache')
    assert.equal(deferredPublications, 1)
    assert.equal(deferredSchedules, 1)

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
        version: CDN_HEALTH_CACHE_VERSION,
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
        version: CDN_HEALTH_CACHE_VERSION,
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
            version: CDN_HEALTH_CACHE_VERSION,
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
    const storage = new MemoryStorage()
    const allowedUrl = 'https://mixed-allowed.test.bilivideo.com/media.m4s?sig=allowed'
    const blockedUrl = 'https://unknown-public.example/media.m4s?sig=blocked'
    const fetched = []
    const runtime = makeRuntime({
        storage,
        fetch: async url => {
            fetched.push(url)
            return streamResponse([new Uint8Array(1)])
        },
        limits: { maxConcurrent: 1, maxStages: 1 },
    })
    runtime.applyCdnPolicy({ urls: [allowedUrl, blockedUrl] })
    const result = await runtime.probeCurrentPlayUrlCdn({ force: true })
    assert.equal(result.state, 'partial')
    assert.deepEqual(fetched, [allowedUrl])
    assert.deepEqual(result.healthyHosts, ['mixed-allowed.test.bilivideo.com'])
    assert.deepEqual(result.unprobeableHosts, ['unknown-public.example'])
    assert.equal(storage.getItem(CDN_HEALTH_CACHE_KEY), null)
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
    await flushMicrotasks()
    assert.equal((await generationRuntime.probeCurrentPlayUrlCdn({ force: true })).state, 'ready')
    await oldProbe
}

{
    const scheduled = []
    const fetched = []
    const finishOldCancels = []
    const runtime = makeRuntime({
        getMode: () => 'auto',
        fetch: async (url, init) => {
            fetched.push(url)
            if (!url.includes('draining-old-')) {
                return streamResponse([new Uint8Array(1)])
            }
            let resolveOldRead
            return {
                ok: true,
                type: 'basic',
                body: {
                    getReader() {
                        return {
                            read() { return new Promise(resolve => { resolveOldRead = resolve }) },
                            cancel() {
                                return new Promise(resolve => {
                                    finishOldCancels.push(() => {
                                        resolveOldRead({ done: true, value: undefined })
                                        resolve()
                                    })
                                })
                            },
                            releaseLock() { },
                        }
                    },
                },
            }
        },
        scheduleBackground(callback) {
            scheduled.push(callback)
        },
        limits: { maxConcurrent: 2, maxStages: 1 },
    })
    const oldUrls = [
        'https://draining-old-a.test.bilivideo.com/a?sig=old-a',
        'https://draining-old-b.test.bilivideo.com/a?sig=old-b',
    ]
    const newUrl = 'https://draining-new.test.bilivideo.com/a?sig=new'
    const newestUrl = 'https://draining-new.test.bilivideo.com/b?sig=newest'
    runtime.applyCdnPolicy({ urls: oldUrls })
    const oldProbe = runtime.probeCurrentPlayUrlCdn({ force: true })
    await flushMicrotasks()
    assert.deepEqual(fetched, oldUrls)

    runtime.applyCdnPolicy({ urls: [newUrl] })
    assert.equal(scheduled.length, 2)
    scheduled[1]()
    await flushMicrotasks(10)
    assert.deepEqual(fetched, oldUrls, 'new generation probed before old cleanup drained')
    assert.equal(finishOldCancels.length, 2)

    runtime.applyCdnPolicy({ urls: [newestUrl] })
    assert.equal(scheduled.length, 3)
    scheduled[2]()
    await flushMicrotasks(10)
    assert.deepEqual(fetched, oldUrls, 'newest generation probed before old cleanup drained')

    finishOldCancels[0]()
    await flushMicrotasks(10)
    assert.equal(scheduled.length, 3, 'drain resolved before every old controller settled')
    finishOldCancels[1]()
    for (let index = 0; index < 20 && scheduled.length < 4; index += 1) await flushMicrotasks()
    assert.equal(scheduled.length, 4, 'newest auto probe was not rescheduled after cleanup drain')
    scheduled[3]()
    assert.deepEqual(fetched, [...oldUrls, newestUrl], 'drain callback did not start the newest auto probe')
    const result = await runtime.probeCurrentPlayUrlCdn()
    assert.equal(result.state, 'ready')
    assert.deepEqual(fetched, [...oldUrls, newestUrl])
    await oldProbe
}

{
    const scheduled = []
    const fetched = []
    let networkHint = 'wifi:a'
    let resolveOldRead
    let finishOldCancel
    const runtime = makeRuntime({
        getMode: () => 'auto',
        getNetworkHint: () => networkHint,
        fetch: async url => {
            fetched.push(url)
            if (!url.includes('network-old.test.bilivideo.com')) {
                return streamResponse([new Uint8Array(1)])
            }
            return {
                ok: true,
                type: 'basic',
                body: {
                    getReader() {
                        return {
                            read() { return new Promise(resolve => { resolveOldRead = resolve }) },
                            cancel() {
                                return new Promise(resolve => {
                                    finishOldCancel = () => {
                                        resolveOldRead({ done: true, value: undefined })
                                        resolve()
                                    }
                                })
                            },
                            releaseLock() { },
                        }
                    },
                },
            }
        },
        scheduleBackground(callback) {
            scheduled.push(callback)
        },
        limits: { maxConcurrent: 1, maxStages: 1 },
    })
    const oldUrl = 'https://network-old.test.bilivideo.com/a?sig=old'
    const newUrl = 'https://network-new.test.bilivideo.com/a?sig=new'
    runtime.applyCdnPolicy({ urls: [oldUrl] })
    const oldProbe = runtime.probeCurrentPlayUrlCdn({ force: true })
    await flushMicrotasks()
    runtime.applyCdnPolicy({ urls: [newUrl] })
    scheduled[1]()
    await flushMicrotasks(10)
    assert.deepEqual(fetched, [oldUrl])

    networkHint = 'wifi:b'
    finishOldCancel()
    await oldProbe
    await flushMicrotasks(20)
    const postDrainCallbacks = scheduled.slice(2)
    assert.ok(postDrainCallbacks.length > 0, 'network generation change lost the auto-probe continuation')
    for (const callback of postDrainCallbacks) callback()
    assert.deepEqual(fetched, [oldUrl, newUrl], 'latest network generation did not start an auto probe')
    assert.equal((await runtime.probeCurrentPlayUrlCdn()).state, 'ready')
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
