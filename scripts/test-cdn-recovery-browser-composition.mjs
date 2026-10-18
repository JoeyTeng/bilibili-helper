#!/usr/bin/env node

import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

globalThis.__testBalhConfig = { cdn_mode: 'auto' }
globalThis.location = { protocol: 'https:' }

let timerScheduleCount = 0
let timerClearCount = 0
let nextTimerHandle = 1
const scheduledTimers = new Map()
let now = 0
Date.now = () => now
globalThis.setTimeout = (callback, delayMs) => {
    timerScheduleCount += 1
    const handle = nextTimerHandle++
    scheduledTimers.set(handle, { callback, delayMs })
    return handle
}
globalThis.clearTimeout = handle => {
    timerClearCount += 1
    scheduledTimers.delete(handle)
}

class FakeDocument extends EventTarget {
    constructor() {
        super()
        this.visibilityState = 'visible'
        this.videos = []
        this.queryCount = 0
    }

    querySelectorAll(selector) {
        assert.equal(selector, 'video')
        this.queryCount += 1
        return this.videos
    }
}

function createRanges(ranges) {
    return {
        length: ranges.length,
        start(index) { return ranges[index][0] },
        end(index) { return ranges[index][1] },
    }
}

function createVideo(currentTime, counters) {
    const state = { currentTime }
    return {
        isConnected: true,
        paused: false,
        seeking: false,
        ended: false,
        get currentTime() {
            counters.mediaReadCount += 1
            return state.currentTime
        },
        duration: 100,
        get buffered() {
            return createRanges([[0, state.currentTime + 5]])
        },
        currentSrc: 'media',
        src: '',
        srcObject: null,
        setCurrentTime(value) {
            state.currentTime = value
        },
    }
}

const documentValue = new FakeDocument()
globalThis.document = documentValue

const bundle = await build({
    entryPoints: [path.join(
        rootDir,
        'packages/unblock-area-limit/src/feature/bili/cdn_recovery_browser.ts',
    )],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    write: false,
    plugins: [{
        name: 'cdn-recovery-config-stub',
        setup(buildContext) {
            buildContext.onResolve({ filter: /\/feature\/config$/ }, () => ({
                path: 'cdn-recovery-config-stub',
                namespace: 'cdn-recovery-test',
            }))
            buildContext.onLoad({
                filter: /^cdn-recovery-config-stub$/,
                namespace: 'cdn-recovery-test',
            }, () => ({
                contents: 'export const balh_config = globalThis.__testBalhConfig',
                loader: 'js',
            }))
        },
    }],
})
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
const recovery = await import(moduleUrl)

const primaryUrl = 'https://primary.example/video.m4s?token=primary'
const alternateUrl = 'https://alternate.example/video.m4s?token=alternate'
const group = {
    key: 'dash-video:0',
    kind: 'dash-video',
    candidates: [
        { url: primaryUrl, sourceFields: ['base_url'], riskKinds: [] },
        { url: alternateUrl, sourceFields: ['backup_url'], riskKinds: [] },
    ],
}

const counters = { mediaReadCount: 0 }
const firstVideo = createVideo(1, counters)
const secondVideo = createVideo(2, counters)
const thirdVideo = createVideo(3, counters)
documentValue.videos = [firstVideo]
const monitor = recovery.installCdnRecoveryMonitor()
assert.ok(monitor, 'the browser composition monitor must install')

recovery.publishCdnRecoveryGroups([group], true)
const prepared = recovery.prepareCdnRecoveryRequestUrl(primaryUrl, 'GET')
assert.equal(prepared.decision.url, primaryUrl)

// Model synchronous page code inside native Fetch/XHR acceptance. The accepted
// request must be observed in the new video epoch rather than committed and
// immediately cleared by the post-acceptance monitor wake.
documentValue.videos = [secondVideo]
const committed = prepared.commit()
const afterReplacement = recovery.getCdnRecoveryStatus()
assert.ok(committed.activation, 'the accepted exact request must be re-observed after replacement')
assert.equal(afterReplacement.contextEpoch, 1)
assert.equal(afterReplacement.activeGroupCount, 1)
assert.equal(afterReplacement.groups[0].state, 'monitoring')
assert.equal(afterReplacement.groups[0].candidateIndex, 0)
assert.equal(afterReplacement.groups[0].pendingCandidateIndex, null)

recovery.sampleCdnRecoveryPlayback({
    visible: true,
    paused: false,
    seeking: false,
    ended: false,
    currentTimeSeconds: 2,
    durationSeconds: 100,
    bufferedAheadSeconds: 0.1,
})
const graceTimer = [...scheduledTimers.entries()]
    .find(([, timer]) => timer.delayMs === 3_000)
assert.ok(graceTimer, 'low buffer must install the recovery grace timer')
now = 3_000
scheduledTimers.delete(graceTimer[0])
graceTimer[1].callback()
const afterGrace = recovery.getCdnRecoveryStatus()
assert.equal(afterGrace.groups[0].state, 'waiting-retry')
assert.equal(afterGrace.groups[0].candidateIndex, 0)
assert.equal(afterGrace.groups[0].pendingCandidateIndex, 1)
assert.equal(afterGrace.groups[0].attemptedCount, 1)
assert.equal(afterGrace.groups[0].routeRevision, afterReplacement.groups[0].routeRevision + 1)
assert.equal(afterGrace.groups[0].switchAttempts, 1)
assert.equal(afterGrace.groups[0].timerPending, false)

// The grace callback installs only a future route intent. The committed route
// remains primary until a later exact request is accepted by its predecessor.
recovery.sampleCdnRecoveryPlayback({
    visible: true,
    paused: false,
    seeking: false,
    ended: false,
    currentTimeSeconds: 10,
    durationSeconds: 100,
    bufferedAheadSeconds: 5,
})
now = 7_999
recovery.sampleCdnRecoveryPlayback({
    visible: true,
    paused: false,
    seeking: false,
    ended: false,
    currentTimeSeconds: 14.999,
    durationSeconds: 100,
    bufferedAheadSeconds: 5,
})
secondVideo.setCurrentTime(15)
const futurePrepared = recovery.prepareCdnRecoveryRequestUrl(primaryUrl, 'GET')
assert.equal(futurePrepared.decision.url, alternateUrl)
const beforeFutureCommit = recovery.getCdnRecoveryStatus()
assert.equal(beforeFutureCommit.groups[0].candidateIndex, 0)
assert.equal(beforeFutureCommit.groups[0].pendingCandidateIndex, 1)
assert.equal(beforeFutureCommit.groups[0].attemptedCount, 1)
assert.equal(beforeFutureCommit.groups[0].routeCommittedAt, null)
now = 8_000
secondVideo.setCurrentTime(16)
const futureCommitted = futurePrepared.commit()
assert.equal(futureCommitted.url, alternateUrl)
assert.equal(futureCommitted.activation?.candidateIndex, 1)
const afterFutureCommit = recovery.getCdnRecoveryStatus()
assert.equal(afterFutureCommit.groups[0].candidateIndex, 1)
assert.equal(afterFutureCommit.groups[0].pendingCandidateIndex, null)
assert.equal(afterFutureCommit.groups[0].attemptedCount, 2)
assert.equal(afterFutureCommit.groups[0].routeRevision, afterGrace.groups[0].routeRevision)
assert.equal(afterFutureCommit.groups[0].switchAttempts, 1)
assert.equal(afterFutureCommit.groups[0].routeCommittedAt, 8_000)
assert.equal(afterFutureCommit.groups[0].retryAt, 23_000)

// Eligibility may be checked before DOM synchronization, but the routed
// decision must be prepared again afterwards. A replaced player clears the
// previous context's alternate override before the native request starts.
documentValue.videos = [thirdVideo]
const replacementPrepared = recovery.prepareCdnRecoveryRequestUrl(primaryUrl, 'GET')
assert.equal(recovery.getCdnRecoveryStatus().contextEpoch, 2)
assert.equal(replacementPrepared.decision.url, primaryUrl)
assert.ok(replacementPrepared.commit().activation)

const unrelatedBefore = {
    queryCount: documentValue.queryCount,
    mediaReadCount: counters.mediaReadCount,
    timerScheduleCount,
    timerClearCount,
}
const unrelatedUrl = 'https://unrelated.example/telemetry'
const unrelated = recovery.prepareCdnRecoveryRequestUrl(unrelatedUrl, 'GET')
assert.deepEqual(unrelated.decision, { url: unrelatedUrl, routed: false })
assert.deepEqual(unrelated.commit(), { url: unrelatedUrl, routed: false })
assert.deepEqual({
    queryCount: documentValue.queryCount,
    mediaReadCount: counters.mediaReadCount,
    timerScheduleCount,
    timerClearCount,
}, unrelatedBefore, 'an unrelated GET must not wake, sample, or reschedule the monitor')

const exactBefore = {
    queryCount: documentValue.queryCount,
    mediaReadCount: counters.mediaReadCount,
    timerScheduleCount,
    timerClearCount,
}
const exact = recovery.prepareCdnRecoveryRequestUrl(alternateUrl, 'GET')
assert.equal(exact.decision.url, alternateUrl)
assert.ok(exact.commit().activation)
assert.ok(documentValue.queryCount > exactBefore.queryCount, 'an exact GET must wake the monitor')
assert.ok(counters.mediaReadCount > exactBefore.mediaReadCount, 'an exact GET must sample media')
assert.ok(timerScheduleCount > exactBefore.timerScheduleCount, 'an exact GET must reschedule polling')
assert.ok(timerClearCount > exactBefore.timerClearCount, 'an exact GET must invalidate prior polling')

globalThis.__testBalhConfig.cdn_mode = 'safe'
const disabled = recovery.getCdnRecoveryStatus()
assert.equal(disabled.enabled, false)
assert.equal(disabled.activeGroupCount, 0)
assert.equal(disabled.groups[0].state, 'disabled')

globalThis.__testBalhConfig.cdn_mode = 'auto'
const reenabled = recovery.getCdnRecoveryStatus()
assert.equal(reenabled.enabled, true)
assert.equal(reenabled.activeGroupCount, 0)
assert.equal(reenabled.groups[0].state, 'unseen')

const protocolRelativeUrl = '//protocol-relative.example/video.m4s?token=alias'
recovery.publishCdnRecoveryGroups([{
    ...group,
    candidates: [{
        url: protocolRelativeUrl,
        sourceFields: ['base_url'],
        riskKinds: [],
    }],
}], true)
const aliasQueryCount = documentValue.queryCount
const alias = recovery.prepareCdnRecoveryRequestUrl(`https:${protocolRelativeUrl}`, 'get')
assert.ok(alias.commit().activation, 'the publication-time protocol alias must remain eligible')
assert.ok(documentValue.queryCount > aliasQueryCount, 'an exact protocol alias must wake the monitor')

monitor.dispose()
console.log('CDN recovery browser composition tests passed')
