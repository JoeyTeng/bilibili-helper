#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

class FakeClock {
    constructor({ honorClear = true } = {}) {
        this.now = 0
        this.nextId = 1
        this.honorClear = honorClear
        this.tasks = new Map()
        this.firedCallbacks = []
    }

    dependencies() {
        return {
            now: () => this.now,
            setTimeout: (callback, delayMs) => {
                const id = this.nextId++
                this.tasks.set(id, { id, at: this.now + delayMs, callback })
                return id
            },
            clearTimeout: id => {
                if (this.honorClear) this.tasks.delete(id)
            },
        }
    }

    get pendingCount() {
        return this.tasks.size
    }

    get pendingCallbacks() {
        return [...this.tasks.values()]
            .sort((left, right) => left.at - right.at || left.id - right.id)
            .map(task => task.callback)
    }

    advance(deltaMs) {
        this.advanceTo(this.now + deltaMs)
    }

    advanceTo(targetTime) {
        assert.ok(targetTime >= this.now, 'Fake clock cannot move backwards')
        while (true) {
            const next = [...this.tasks.values()]
                .filter(task => task.at <= targetTime)
                .sort((left, right) => left.at - right.at || left.id - right.id)[0]
            if (!next) break
            this.tasks.delete(next.id)
            this.now = next.at
            this.firedCallbacks.push(next.callback)
            next.callback()
        }
        this.now = targetTime
    }
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(rootDir, '.codex-tmp/tests')
const outFile = path.join(outDir, 'cdn-recovery.mjs')

await mkdir(outDir, { recursive: true })
await build({
    entryPoints: [path.join(rootDir, 'packages/unblock-area-limit/src/feature/bili/cdn_recovery.ts')],
    outfile: outFile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
})

const {
    DEFAULT_CDN_RECOVERY_TIMING,
    createCdnRecoveryCoordinator,
} = await import(`${pathToFileURL(outFile).href}?t=${Date.now()}`)

assert.deepEqual(DEFAULT_CDN_RECOVERY_TIMING, {
    lowBufferThresholdSeconds: 0.5,
    progressRestartSeconds: 0.25,
    confirmationGraceMs: 3_000,
    minimumSwitchCooldownMs: 15_000,
    retryBackoffBaseMs: 5_000,
    retryBackoffCapMs: 60_000,
    stableBufferThresholdSeconds: 3,
    stablePlaybackResetMs: 5_000,
    activeSampleIntervalMs: 500,
})
assert.equal(Object.isFrozen(DEFAULT_CDN_RECOVERY_TIMING), true)

const videoUrls = urls('video', 8)
const audioUrls = urls('audio', 2)

{
    const { clock, recovery } = makeRecovery()
    const groups = [group('video', videoUrls.slice(0, 3)), group('audio', audioUrls)]
    let status = recovery.publishGroups(groups, false)
    assert.deepEqual(status.groups.map(item => item.state), ['disabled', 'disabled'])

    status = recovery.publishGroups(groups, true)
    assert.deepEqual(status.groups.map(item => item.state), ['unseen', 'unseen'])
    const currentRequest = recovery.routeExactUrl(videoUrls[0])
    assert.equal(currentRequest.url, videoUrls[0])
    assert.equal(currentRequest.routed, false)
    assert.deepEqual(recovery.getStatus().groups.map(item => item.state), ['monitoring', 'unseen'])

    recovery.samplePlayback(low())
    assert.equal(groupStatus(recovery, 'video').state, 'confirming')
    assert.equal(groupStatus(recovery, 'audio').state, 'unseen')
    assert.equal(clock.pendingCount, 1)

    clock.advance(2_999)
    assert.equal(groupStatus(recovery, 'video').state, 'confirming')
    assert.equal(groupStatus(recovery, 'video').attemptedCount, 1)
    clock.advance(1)
    assert.equal(groupStatus(recovery, 'video').state, 'waiting-retry')
    assert.equal(groupStatus(recovery, 'video').attemptedCount, 2)
    assert.equal(groupStatus(recovery, 'audio').attemptedCount, 0)

    const futureRequest = recovery.routeExactUrl(videoUrls[0])
    assert.equal(futureRequest.url, videoUrls[1])
    assert.equal(futureRequest.routed, true)
}

{
    const { recovery } = makeActiveRecovery([group('prepared-open', videoUrls.slice(0, 2))])
    const discarded = recovery.prepareExactUrl(videoUrls[0])
    assert.equal(groupStatus(recovery, 'prepared-open').state, 'unseen')
    discarded.discard()
    assert.equal(discarded.commit().activation, undefined)
    assert.equal(groupStatus(recovery, 'prepared-open').state, 'unseen')

    const committed = recovery.prepareExactUrl(videoUrls[0])
    assert.equal(groupStatus(recovery, 'prepared-open').state, 'unseen')
    assert.ok(committed.commit().activation)
    assert.equal(groupStatus(recovery, 'prepared-open').state, 'monitoring')
}

{
    const { clock, recovery } = makeActiveRecovery([group('progress', videoUrls.slice(0, 3))])
    recovery.routeExactUrl(videoUrls[0])
    recovery.samplePlayback(low(10))
    clock.advance(1_000)
    recovery.samplePlayback(low(10.25))
    assert.equal(groupStatus(recovery, 'progress').state, 'confirming')
    assert.equal(clock.pendingCount, 1)

    clock.advance(2_999)
    assert.equal(groupStatus(recovery, 'progress').state, 'confirming')
    assert.equal(groupStatus(recovery, 'progress').attemptedCount, 1)
    clock.advance(1)
    assert.equal(groupStatus(recovery, 'progress').state, 'waiting-retry')
    assert.equal(groupStatus(recovery, 'progress').attemptedCount, 2)
}

for (const scenario of [
    { name: 'hidden', change: { visible: false } },
    { name: 'paused', change: { paused: true } },
    { name: 'seeking', change: { seeking: true } },
    { name: 'ended', change: { ended: true } },
    { name: 'near-end', change: { currentTimeSeconds: 9.5, durationSeconds: 10 } },
    { name: 'unknown-buffer', change: { bufferedAheadSeconds: null } },
    { name: 'unknown-time', change: { currentTimeSeconds: Number.NaN } },
    { name: 'healthy', change: { bufferedAheadSeconds: 1 } },
]) {
    const { clock, recovery } = makeActiveRecovery([group(scenario.name, videoUrls.slice(0, 2))])
    recovery.routeExactUrl(videoUrls[0])
    recovery.samplePlayback(low())
    clock.advance(1_000)
    recovery.samplePlayback(low(0, scenario.change))
    assert.equal(groupStatus(recovery, scenario.name).state, 'monitoring', scenario.name)
    assert.equal(clock.pendingCount, 0, scenario.name)
    clock.advance(3_000)
    assert.equal(groupStatus(recovery, scenario.name).attemptedCount, 1, scenario.name)
}

{
    const { clock, recovery } = makeActiveRecovery([group('unavailable', videoUrls.slice(0, 2))])
    recovery.routeExactUrl(videoUrls[0])
    recovery.samplePlayback(low())
    clock.advance(1_000)
    recovery.samplePlayback(null)
    assert.equal(groupStatus(recovery, 'unavailable').state, 'monitoring')
    assert.equal(clock.pendingCount, 0)
    clock.advance(3_000)
    assert.equal(groupStatus(recovery, 'unavailable').attemptedCount, 1)
}

{
    const { clock, recovery } = makeActiveRecovery([group('healthy-restart', videoUrls.slice(0, 2))])
    recovery.routeExactUrl(videoUrls[0])
    recovery.samplePlayback(low())
    clock.advance(1_000)
    recovery.samplePlayback(low(0, { bufferedAheadSeconds: 1 }))
    recovery.samplePlayback(low())
    clock.advance(2_999)
    assert.equal(groupStatus(recovery, 'healthy-restart').state, 'confirming')
    clock.advance(1)
    assert.equal(groupStatus(recovery, 'healthy-restart').state, 'waiting-retry')
}

{
    const { clock, recovery } = makeActiveRecovery([group('backoff', videoUrls.slice(0, 7))])
    recovery.routeExactUrl(videoUrls[0])
    const expectedCooldowns = [15_000, 15_000, 20_000, 40_000, 60_000, 60_000]

    for (let index = 0; index < expectedCooldowns.length; index += 1) {
        if (index > 0) {
            const previous = groupStatus(recovery, 'backoff')
            clock.advanceTo(previous.retryAt - 1)
            recovery.samplePlayback(low())
            assert.equal(groupStatus(recovery, 'backoff').state, 'waiting-retry')
            assert.equal(clock.pendingCount, 0)
            clock.advance(1)
        }

        const confirmationStartedAt = clock.now
        recovery.samplePlayback(low())
        assert.equal(groupStatus(recovery, 'backoff').state, 'confirming')
        clock.advance(3_000)
        const switched = groupStatus(recovery, 'backoff')
        assert.equal(switched.state, 'waiting-retry')
        assert.equal(switched.switchAttempts, index + 1)
        assert.equal(switched.retryAt, confirmationStartedAt + 3_000 + expectedCooldowns[index])
        assert.equal(switched.candidateIndex, index + 1)
        recovery.routeExactUrl(videoUrls[0])
    }

    const lastRetryAt = groupStatus(recovery, 'backoff').retryAt
    clock.advanceTo(lastRetryAt)
    recovery.samplePlayback(low())
    clock.advance(3_000)
    const exhausted = groupStatus(recovery, 'backoff')
    assert.equal(exhausted.state, 'exhausted')
    assert.equal(exhausted.switchAttempts, 6)
    assert.equal(exhausted.candidateIndex, 6)
}

{
    const { clock, recovery } = makeActiveRecovery([group('stable', videoUrls.slice(0, 3))])
    recovery.routeExactUrl(videoUrls[0])
    recovery.samplePlayback(low())
    clock.advance(3_000)
    const cooldownDeadline = groupStatus(recovery, 'stable').retryAt
    assert.equal(cooldownDeadline, 18_000)

    recovery.samplePlayback(healthy(1))
    for (let second = 1; second <= 5; second += 1) {
        clock.advance(1_000)
        recovery.samplePlayback(healthy(1 + second))
    }
    const reset = groupStatus(recovery, 'stable')
    assert.equal(reset.state, 'waiting-retry')
    assert.equal(reset.switchAttempts, 0)
    assert.equal(reset.attemptedCount, 1)
    assert.equal(reset.retryAt, cooldownDeadline)

    clock.advanceTo(cooldownDeadline)
    recovery.samplePlayback(low(7))
    clock.advance(3_000)
    assert.equal(groupStatus(recovery, 'stable').candidateIndex, 0)
    assert.equal(recovery.routeExactUrl(videoUrls[1]).url, videoUrls[0])
}

{
    const { clock, recovery } = makeActiveRecovery([group('stable-exhausted', [videoUrls[0]])])
    recovery.routeExactUrl(videoUrls[0])
    recovery.samplePlayback(low())
    clock.advance(3_000)
    assert.equal(groupStatus(recovery, 'stable-exhausted').state, 'exhausted')

    recovery.samplePlayback(healthy(1))
    for (let second = 1; second <= 5; second += 1) {
        clock.advance(1_000)
        recovery.samplePlayback(healthy(1 + second))
    }
    assert.equal(groupStatus(recovery, 'stable-exhausted').state, 'monitoring')
    assert.equal(groupStatus(recovery, 'stable-exhausted').attemptedCount, 1)
}

{
    const { clock, recovery } = makeActiveRecovery([group('stable-same-tick-rewind', [
        videoUrls[0],
        videoUrls[1],
    ])])
    recovery.routeExactUrl(videoUrls[0])
    recovery.samplePlayback(low())
    clock.advance(3_000)

    recovery.samplePlayback(healthy(10))
    clock.advance(2_000)
    recovery.samplePlayback(healthy(12))
    recovery.samplePlayback(healthy(11))
    clock.advance(3_000)
    recovery.samplePlayback(healthy(14))
    assert.equal(groupStatus(recovery, 'stable-same-tick-rewind').switchAttempts, 1)
    clock.advance(2_000)
    recovery.samplePlayback(healthy(16))
    assert.equal(groupStatus(recovery, 'stable-same-tick-rewind').switchAttempts, 0)
}

{
    const clock = new FakeClock({ honorClear: false })
    const recovery = createCdnRecoveryCoordinator(clock.dependencies())
    recovery.publishGroups([group('stale', videoUrls.slice(0, 2))], true)
    recovery.routeExactUrl(videoUrls[0])
    recovery.samplePlayback(low())
    const generation = recovery.getStatus().generation

    recovery.publishGroups([group('stale', [videoUrls[0], `${videoUrls[1]}&generation=2`])], true)
    assert.equal(recovery.getStatus().generation, generation + 1)
    clock.advance(3_000)
    assert.equal(groupStatus(recovery, 'stale').state, 'unseen')
    assert.equal(groupStatus(recovery, 'stale').attemptedCount, 0)

    recovery.routeExactUrl(videoUrls[0])
    recovery.samplePlayback(low())
    recovery.beginContext()
    clock.advance(3_000)
    assert.equal(groupStatus(recovery, 'stale').state, 'unseen')
    assert.equal(groupStatus(recovery, 'stale').attemptedCount, 0)
}

{
    const { clock, recovery } = makeActiveRecovery([group('duplicate', videoUrls.slice(0, 2))])
    recovery.routeExactUrl(videoUrls[0])
    recovery.samplePlayback(low())
    recovery.samplePlayback(low())
    assert.equal(clock.pendingCount, 1)
    const timer = clock.pendingCallbacks[0]
    clock.advance(3_000)
    const afterFirstFire = groupStatus(recovery, 'duplicate')
    assert.equal(afterFirstFire.attemptedCount, 2)
    assert.equal(afterFirstFire.state, 'waiting-retry')
    timer()
    const afterDuplicateFire = groupStatus(recovery, 'duplicate')
    assert.equal(afterDuplicateFire.attemptedCount, 2)
    assert.equal(afterDuplicateFire.routeRevision, afterFirstFire.routeRevision)
}

{
    const { clock, recovery } = makeActiveRecovery([group('early-timer', videoUrls.slice(0, 2))])
    recovery.routeExactUrl(videoUrls[0])
    recovery.samplePlayback(low())
    const earlyTask = [...clock.tasks.values()][0]
    clock.tasks.delete(earlyTask.id)
    earlyTask.callback()
    assert.equal(groupStatus(recovery, 'early-timer').state, 'confirming')
    assert.equal(clock.pendingCount, 1)
    clock.advance(2_999)
    assert.equal(groupStatus(recovery, 'early-timer').attemptedCount, 1)
    clock.advance(1)
    assert.equal(groupStatus(recovery, 'early-timer').attemptedCount, 2)
}

{
    const clock = new FakeClock({ honorClear: false })
    let externallyEnabled = true
    const recovery = createCdnRecoveryCoordinator({
        ...clock.dependencies(),
        isEnabled: () => externallyEnabled,
    })
    recovery.publishGroups([group('mode-transition', videoUrls.slice(0, 2))], true)
    recovery.routeExactUrl(videoUrls[0])
    recovery.samplePlayback(low())
    externallyEnabled = false
    clock.advance(3_000)
    let status = groupStatus(recovery, 'mode-transition')
    assert.equal(recovery.getStatus().enabled, false)
    assert.equal(status.state, 'disabled')
    assert.equal(status.attemptedCount, 0)

    externallyEnabled = true
    recovery.setEnabled(true)
    recovery.routeExactUrl(videoUrls[0])
    recovery.samplePlayback(low())
    clock.advance(3_000)
    assert.equal(groupStatus(recovery, 'mode-transition').state, 'waiting-retry')
    recovery.setEnabled(false)
    recovery.setEnabled(true)
    status = groupStatus(recovery, 'mode-transition')
    assert.equal(status.state, 'unseen')
    assert.equal(status.attemptedCount, 0)
    assert.equal(status.switchAttempts, 0)
    assert.equal(status.retryAt, null)
    assert.equal(recovery.routeExactUrl(videoUrls[0]).url, videoUrls[0])
}

for (const scenario of [
    {
        name: 'synchronous-timer',
        timer(callback) {
            callback()
            return 1
        },
    },
    {
        name: 'throw-after-register',
        timer(callback) {
            queueMicrotask(callback)
            throw new Error('synthetic timer registration failure')
        },
    },
]) {
    let cleared = 0
    const recovery = createCdnRecoveryCoordinator({
        now: () => 0,
        setTimeout: scenario.timer,
        clearTimeout: () => { cleared += 1 },
    })
    recovery.publishGroups([group(scenario.name, videoUrls.slice(0, 2))], true)
    recovery.routeExactUrl(videoUrls[0])
    assert.doesNotThrow(() => recovery.samplePlayback(low()), scenario.name)
    await Promise.resolve()
    const status = groupStatus(recovery, scenario.name)
    assert.equal(status.state, 'monitoring', scenario.name)
    assert.equal(status.timerPending, false, scenario.name)
    assert.equal(status.attemptedCount, 1, scenario.name)
    assert.equal(status.routeRevision, 0, scenario.name)
    assert.ok(cleared <= 1, scenario.name)
}

{
    const { recovery } = makeActiveRecovery([group('status', videoUrls.slice(0, 2))])
    recovery.routeExactUrl(videoUrls[0])
    const serialized = JSON.stringify(recovery.getStatus())
    assert.doesNotMatch(serialized, /token=|\/media\/|https?:|cdn-0\.example/)
    assert.match(serialized, /status/)
}

console.log('CDN recovery tests passed')

function makeRecovery() {
    const clock = new FakeClock()
    return {
        clock,
        recovery: createCdnRecoveryCoordinator(clock.dependencies()),
    }
}

function makeActiveRecovery(groups) {
    const result = makeRecovery()
    result.recovery.publishGroups(groups, true)
    return result
}

function group(key, candidates) {
    return {
        key,
        kind: key.includes('audio') ? 'dash-audio' : 'dash-video',
        candidates: candidates.map(url => {
            const parsed = new URL(url)
            return {
                url,
                host: parsed.host,
                hostname: parsed.hostname,
                riskKinds: [],
            }
        }),
    }
}

function urls(prefix, count) {
    return Array.from({ length: count }, (_, index) => (
        `https://cdn-${index}.example/media/${prefix}.m4s?token=${prefix}-${index}%2Fexact`
    ))
}

function low(currentTimeSeconds = 0, overrides = {}) {
    return {
        visible: true,
        paused: false,
        seeking: false,
        ended: false,
        currentTimeSeconds,
        durationSeconds: 120,
        bufferedAheadSeconds: 0.5,
        ...overrides,
    }
}

function healthy(currentTimeSeconds) {
    return low(currentTimeSeconds, { bufferedAheadSeconds: 3 })
}

function groupStatus(recovery, key) {
    const status = recovery.getStatus().groups.find(group => group.key === key)
    assert.ok(status, `Missing recovery group: ${key}`)
    return status
}
