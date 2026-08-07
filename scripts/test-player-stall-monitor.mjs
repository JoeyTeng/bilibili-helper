#!/usr/bin/env node
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bundle = await build({
    entryPoints: [path.join(
        rootDir,
        'packages/unblock-area-limit/src/feature/bili/player_stall_monitor.ts',
    )],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    write: false,
})
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
const {
    PLAYER_STALL_MONITOR_INTERVAL_MS,
    createPlayerStallMonitor,
} = await import(moduleUrl)

const wakeEvents = [
    'visibilitychange',
    'play',
    'pause',
    'seeking',
    'seeked',
    'progress',
    'timeupdate',
    'waiting',
    'stalled',
    'playing',
]

class FakeDocument extends EventTarget {
    constructor() {
        super()
        this.visibilityState = 'visible'
        this.videos = []
        this.addCalls = []
        this.removeCalls = []
    }

    addEventListener(type, listener, options) {
        this.addCalls.push({ type, listener, options })
        super.addEventListener(type, listener, options)
    }

    removeEventListener(type, listener, options) {
        this.removeCalls.push({ type, listener, options })
        super.removeEventListener(type, listener, options)
    }

    querySelectorAll(selector) {
        assert.equal(selector, 'video')
        return this.videos
    }
}

class FakeClock {
    constructor() {
        this.now = 0
        this.nextId = 0
        this.timers = new Map()
        this.cleared = []
    }

    setTimeout(callback, delayMs) {
        const id = ++this.nextId
        this.timers.set(id, {
            callback,
            dueAt: this.now + delayMs,
            delayMs,
        })
        return id
    }

    clearTimeout(id) {
        this.cleared.push(id)
        this.timers.delete(id)
    }

    advance(milliseconds) {
        const target = this.now + milliseconds
        while (true) {
            const next = [...this.timers.entries()]
                .filter(([, timer]) => timer.dueAt <= target)
                .sort((left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0])[0]
            if (!next) break
            const [id, timer] = next
            this.timers.delete(id)
            this.now = timer.dueAt
            timer.callback()
        }
        this.now = target
    }

    onlyTimer() {
        assert.equal(this.timers.size, 1)
        return [...this.timers.entries()][0]
    }
}

function createRanges(ranges) {
    return {
        length: ranges.length,
        start(index) {
            return ranges[index][0]
        },
        end(index) {
            return ranges[index][1]
        },
    }
}

function createVideo(overrides = {}) {
    return {
        isConnected: true,
        paused: false,
        seeking: false,
        ended: false,
        currentTime: 10,
        duration: 100,
        buffered: createRanges([[0, 12]]),
        currentSrc: 'media',
        src: '',
        srcObject: null,
        ...overrides,
    }
}

function createHarness(options = {}) {
    const document = options.document ?? new FakeDocument()
    const clock = options.clock ?? new FakeClock()
    const state = {
        active: options.active ?? true,
        enabled: options.enabled ?? true,
    }
    const samples = []
    let contextCalls = 0
    let beginContextError = null
    document.videos = options.videos ?? [createVideo()]

    const monitor = createPlayerStallMonitor({
        document,
        now: () => clock.now,
        setTimeout: (callback, delayMs) => clock.setTimeout(callback, delayMs),
        clearTimeout: handle => clock.clearTimeout(handle),
        isActive: () => state.active,
        isEnabled: () => state.enabled,
        beginContext() {
            contextCalls += 1
            if (beginContextError) throw beginContextError
        },
        sample(signals) {
            samples.push(signals)
        },
        ...options.dependencies,
    })

    return {
        clock,
        document,
        monitor,
        samples,
        state,
        contextCalls: () => contextCalls,
        failBeginContext(error) {
            beginContextError = error
        },
    }
}

function sampleOnce(video, options = {}) {
    const harness = createHarness({ videos: [video], ...options })
    harness.monitor.start()
    const sample = harness.samples[0]
    harness.monitor.dispose()
    return sample
}

assert.equal(PLAYER_STALL_MONITOR_INTERVAL_MS, 500)

{
    const pausedMedia = createVideo({ paused: true, currentTime: 11 })
    const playingWithoutSource = createVideo({
        currentSrc: '',
        src: '',
        currentTime: 22,
    })
    const harness = createHarness({ videos: [pausedMedia, playingWithoutSource] })
    harness.monitor.start()
    assert.equal(harness.samples.length, 1)
    assert.equal(harness.samples[0].currentTimeSeconds, 22, 'the unique playing video must win')
    harness.monitor.dispose()
}

{
    const first = createVideo({ currentTime: 1 })
    const second = createVideo({ currentTime: 2, currentSrc: '' })
    const harness = createHarness({ videos: [first, second] })
    harness.monitor.start()
    assert.deepEqual(harness.samples, [null], 'multiple playing videos must report unavailable')
    harness.monitor.dispose()
}

{
    const disconnected = createVideo({ isConnected: false, currentTime: 1 })
    const uniqueMedia = createVideo({ paused: true, currentTime: 2 })
    const empty = createVideo({ paused: true, currentSrc: '', src: '', currentTime: 3 })
    const harness = createHarness({ videos: [disconnected, uniqueMedia, empty] })
    harness.monitor.start()
    assert.equal(harness.samples.length, 1)
    assert.equal(harness.samples[0].currentTimeSeconds, 2)
    harness.monitor.dispose()

    const ambiguous = createHarness({
        videos: [createVideo({ paused: true }), createVideo({ paused: true })],
    })
    ambiguous.monitor.start()
    assert.deepEqual(ambiguous.samples, [null], 'multiple media-bearing videos must report unavailable')
    ambiguous.monitor.dispose()

    const missing = createHarness({ videos: [] })
    missing.monitor.start()
    assert.deepEqual(missing.samples, [null])
    missing.monitor.dispose()

    const queried = createVideo({ currentTime: 7 })
    const querySeam = createHarness({
        videos: [],
        dependencies: { queryVideos: () => [queried] },
    })
    querySeam.monitor.start()
    assert.equal(querySeam.samples[0].currentTimeSeconds, 7)
    querySeam.monitor.dispose()
}

{
    const first = createVideo({ currentTime: 1 })
    const second = createVideo({ currentTime: 2 })
    const third = createVideo({ currentTime: 3 })
    const harness = createHarness({ videos: [first] })
    harness.monitor.start()
    assert.equal(harness.contextCalls(), 0)

    harness.document.videos = [second]
    harness.failBeginContext(new Error('context unavailable'))
    assert.doesNotThrow(() => harness.monitor.wake())
    assert.equal(harness.contextCalls(), 1)
    assert.equal(harness.samples.length, 2)
    assert.equal(harness.samples.at(-1), null, 'a failed context reset must report unavailable')

    harness.failBeginContext(null)
    harness.monitor.wake()
    assert.equal(harness.contextCalls(), 2)
    assert.equal(harness.samples.at(-1).currentTimeSeconds, 2)
    harness.monitor.wake()
    assert.equal(harness.contextCalls(), 2, 'the same replacement must not reset twice')

    harness.document.videos = []
    harness.monitor.wake()
    assert.equal(harness.samples.at(-1), null)
    harness.document.videos = [second]
    harness.monitor.wake()
    assert.equal(harness.contextCalls(), 2, 'temporary absence must not fabricate a replacement')

    harness.document.videos = [third]
    harness.monitor.wake()
    assert.equal(harness.contextCalls(), 3)
    assert.equal(harness.samples.at(-1).currentTimeSeconds, 3)
    harness.monitor.dispose()
}

{
    const video = createVideo({ buffered: createRanges([[0, 10.25]]) })
    const harness = createHarness({ videos: [video] })
    harness.monitor.start()
    assert.equal(harness.samples[0].bufferedAheadSeconds, 0.25)

    harness.document.videos = []
    harness.monitor.wake()
    assert.equal(harness.samples.at(-1), null, 'missing video must invalidate prior low-buffer evidence')

    harness.document.videos = [video, createVideo()]
    harness.monitor.wake()
    assert.equal(harness.samples.at(-1), null, 'ambiguous video must invalidate prior low-buffer evidence')

    Object.defineProperty(video, 'currentTime', {
        configurable: true,
        get() {
            throw new Error('unreadable current time')
        },
    })
    harness.document.videos = [video]
    harness.monitor.wake()
    assert.equal(harness.samples.at(-1), null, 'critical getter failure must report unavailable')
    harness.monitor.dispose()
}

{
    const sample = sampleOnce(createVideo({
        currentTime: 10,
        buffered: createRanges([[0, 11], [9, 15], [20, 30]]),
    }))
    assert.equal(sample.bufferedAheadSeconds, 5, 'the greatest containing range must win')

    assert.equal(sampleOnce(createVideo({
        currentTime: 10,
        buffered: createRanges([[0, 9.9], [10.1, 20]]),
    })).bufferedAheadSeconds, 0)
    assert.equal(sampleOnce(createVideo({ buffered: createRanges([]) })).bufferedAheadSeconds, 0)

    const throwingRanges = {
        length: 1,
        start() {
            throw new Error('unreadable range')
        },
        end() {
            return 20
        },
    }
    assert.equal(sampleOnce(createVideo({ buffered: throwingRanges })).bufferedAheadSeconds, null)
    assert.equal(sampleOnce(createVideo({
        buffered: createRanges([[0, Number.POSITIVE_INFINITY]]),
    })).bufferedAheadSeconds, null)
    assert.equal(sampleOnce(createVideo({
        duration: Number.POSITIVE_INFINITY,
    })).durationSeconds, null)
    assert.equal(sampleOnce(createVideo({ currentTime: Number.NaN })), null)
}

{
    const video = createVideo({ currentTime: 9.6, duration: 10 })
    const harness = createHarness({ videos: [video] })
    harness.monitor.start()
    assert.deepEqual(
        {
            visible: harness.samples[0].visible,
            paused: harness.samples[0].paused,
            seeking: harness.samples[0].seeking,
            ended: harness.samples[0].ended,
            currentTimeSeconds: harness.samples[0].currentTimeSeconds,
            durationSeconds: harness.samples[0].durationSeconds,
        },
        {
            visible: true,
            paused: false,
            seeking: false,
            ended: false,
            currentTimeSeconds: 9.6,
            durationSeconds: 10,
        },
        'near-end state must remain explicit for the core to classify',
    )

    harness.document.visibilityState = 'hidden'
    harness.monitor.wake()
    assert.equal(harness.samples.at(-1).visible, false)

    video.paused = true
    harness.monitor.wake()
    assert.equal(harness.samples.at(-1).paused, true)

    video.paused = false
    video.seeking = true
    harness.monitor.wake()
    assert.equal(harness.samples.at(-1).seeking, true)

    video.seeking = false
    video.ended = true
    video.paused = true
    harness.monitor.wake()
    assert.equal(harness.samples.at(-1).ended, true)
    harness.monitor.dispose()
}

{
    const harness = createHarness()
    harness.monitor.start()
    let expectedSamples = 1
    for (const eventName of wakeEvents) {
        harness.document.dispatchEvent(new Event(eventName))
        expectedSamples += 1
        assert.equal(harness.samples.length, expectedSamples, `${eventName} must wake one sample`)
        assert.equal(harness.clock.timers.size, 1, `${eventName} must preserve one timer`)
    }
    assert.ok(harness.document.addCalls.every(call => call.options === true))
    harness.monitor.dispose()
}

{
    const document = new FakeDocument()
    const clock = new FakeClock()
    document.videos = [createVideo()]
    let monitor
    let samples = 0
    monitor = createPlayerStallMonitor({
        document,
        now: () => clock.now,
        setTimeout: (callback, delayMs) => clock.setTimeout(callback, delayMs),
        clearTimeout: handle => clock.clearTimeout(handle),
        isEnabled: () => true,
        isActive: () => true,
        beginContext() { },
        sample() {
            samples += 1
            if (samples < 3) monitor.wake()
        },
    })
    monitor.start()
    assert.equal(samples, 3, 'nested reentrant wakes must drain before returning')
    assert.equal(clock.timers.size, 1, 'nested reentrant wakes must leave only one live timer')
    monitor.dispose()
}

{
    const document = new FakeDocument()
    const clock = new FakeClock()
    const first = createVideo({ currentTime: 1 })
    const second = createVideo({ currentTime: 2 })
    document.videos = [first]
    const samples = []
    let contextCalls = 0
    let monitor
    monitor = createPlayerStallMonitor({
        document,
        now: () => clock.now,
        setTimeout: (callback, delayMs) => clock.setTimeout(callback, delayMs),
        clearTimeout: handle => clock.clearTimeout(handle),
        isEnabled: () => true,
        isActive: () => true,
        beginContext() {
            contextCalls += 1
            monitor.wake()
        },
        sample: signals => samples.push(signals),
    })
    monitor.start()
    document.videos = [second]
    monitor.wake()
    assert.equal(contextCalls, 1, 'a reentrant context callback must not reset twice')
    assert.equal(samples.filter(sample => sample?.currentTimeSeconds === 2).length, 2)
    assert.equal(clock.timers.size, 1)
    monitor.dispose()
}

{
    const harness = createHarness()
    harness.monitor.start()
    assert.equal(harness.samples.length, 1)
    const [, firstTimer] = harness.clock.onlyTimer()
    assert.equal(firstTimer.delayMs, 500)

    harness.clock.advance(499)
    assert.equal(harness.samples.length, 1)
    harness.clock.advance(1)
    assert.equal(harness.samples.length, 2)
    assert.equal(harness.clock.onlyTimer()[1].delayMs, 500)
    harness.clock.advance(500)
    assert.equal(harness.samples.length, 3)
    assert.equal(harness.clock.timers.size, 1)
    harness.monitor.dispose()
}

{
    for (const options of [{ enabled: false }, { active: false }]) {
        const harness = createHarness(options)
        harness.monitor.start()
        assert.equal(harness.samples.length, 0)
        assert.equal(harness.clock.timers.size, 0)
        harness.clock.advance(5_000)
        assert.equal(harness.samples.length, 0)
        harness.monitor.dispose()
    }

    const harness = createHarness({ active: false })
    harness.monitor.start()
    harness.state.active = true
    harness.monitor.wake()
    assert.equal(harness.samples.length, 1)
    assert.equal(harness.clock.timers.size, 1)
    harness.state.active = false
    harness.clock.advance(500)
    assert.equal(harness.samples.length, 1)
    assert.equal(harness.clock.timers.size, 0)

    harness.state.active = true
    harness.monitor.wake()
    harness.state.enabled = false
    harness.monitor.wake()
    assert.equal(harness.clock.timers.size, 0)
    harness.monitor.dispose()
}

{
    const first = createVideo({ currentTime: 1 })
    const second = createVideo({ currentTime: 2 })
    const harness = createHarness({ active: false, videos: [first] })
    harness.monitor.start()
    assert.equal(harness.samples.length, 0)
    assert.equal(harness.contextCalls(), 0)
    assert.equal(harness.clock.timers.size, 0)

    harness.document.videos = [second]
    harness.monitor.wake()
    assert.equal(
        harness.contextCalls(),
        1,
        'an inactive wake must synchronize a replaced player before a future route activates',
    )
    assert.equal(harness.samples.length, 0, 'inactive identity tracking must not sample the core')
    assert.equal(harness.clock.timers.size, 0, 'inactive identity tracking must not poll')

    harness.state.active = true
    harness.monitor.wake()
    assert.equal(harness.contextCalls(), 1, 'activation must not reset the already-synchronized context')
    assert.equal(harness.samples.at(-1).currentTimeSeconds, 2)
    assert.equal(harness.clock.timers.size, 1)
    harness.monitor.dispose()
}

{
    const harness = createHarness()
    harness.monitor.start()
    const [staleId, staleTimer] = harness.clock.onlyTimer()
    const addCount = harness.document.addCalls.length
    assert.equal(addCount, wakeEvents.length)

    harness.monitor.start()
    assert.equal(harness.samples.length, 1, 'duplicate start must be inert')
    assert.equal(harness.document.addCalls.length, addCount)
    assert.equal(harness.clock.timers.size, 1)

    harness.monitor.wake()
    assert.ok(harness.clock.cleared.includes(staleId))
    const samplesBeforeStaleTimer = harness.samples.length
    staleTimer.callback()
    assert.equal(harness.samples.length, samplesBeforeStaleTimer, 'a stale timer must not sample')
    assert.equal(harness.clock.timers.size, 1)

    const [, stopStaleTimer] = harness.clock.onlyTimer()
    harness.monitor.stop()
    assert.equal(harness.document.removeCalls.length, wakeEvents.length)
    assert.equal(harness.clock.timers.size, 0)
    stopStaleTimer.callback()
    harness.document.dispatchEvent(new Event('waiting'))
    assert.equal(harness.samples.length, samplesBeforeStaleTimer)

    harness.monitor.stop()
    assert.equal(harness.document.removeCalls.length, wakeEvents.length)

    harness.monitor.start()
    assert.equal(harness.samples.length, samplesBeforeStaleTimer + 1)
    assert.equal(harness.document.addCalls.length, wakeEvents.length * 2)
    const [, disposeStaleTimer] = harness.clock.onlyTimer()
    harness.monitor.dispose()
    harness.monitor.dispose()
    assert.equal(harness.document.removeCalls.length, wakeEvents.length * 2)
    disposeStaleTimer.callback()
    harness.monitor.start()
    harness.monitor.wake()
    harness.document.dispatchEvent(new Event('playing'))
    assert.equal(harness.samples.length, samplesBeforeStaleTimer + 1)
    assert.equal(harness.clock.timers.size, 0)
}

{
    const document = new FakeDocument()
    document.videos = [createVideo()]
    let samples = 0
    const monitor = createPlayerStallMonitor({
        document,
        isEnabled: () => true,
        isActive: () => true,
        beginContext() {
            throw new Error('unused for the initial video')
        },
        sample() {
            samples += 1
            throw new Error('optional recovery failure')
        },
        setTimeout() {
            throw new Error('timer unavailable')
        },
        clearTimeout() {
            throw new Error('timer cleanup unavailable')
        },
    })
    assert.doesNotThrow(() => monitor.start())
    assert.equal(samples, 1)
    assert.doesNotThrow(() => document.dispatchEvent(new Event('waiting')))
    assert.equal(samples, 2)
    assert.doesNotThrow(() => monitor.stop())
    monitor.dispose()

    const inactive = createPlayerStallMonitor({
        document,
        isEnabled: () => true,
        isActive() {
            throw new Error('activity unavailable')
        },
        beginContext() { },
        sample() {
            throw new Error('must not run')
        },
    })
    assert.doesNotThrow(() => inactive.start())
    inactive.dispose()

    const queryFailure = createHarness({
        dependencies: {
            queryVideos() {
                throw new Error('DOM unavailable')
            },
        },
    })
    assert.doesNotThrow(() => queryFailure.monitor.start())
    assert.deepEqual(queryFailure.samples, [null])
    assert.equal(queryFailure.clock.timers.size, 1)
    assert.doesNotThrow(() => queryFailure.document.dispatchEvent(new Event('progress')))
    assert.deepEqual(queryFailure.samples, [null, null])
    queryFailure.monitor.dispose()

    let staleCallback
    let clearFailureSamples = 0
    const clearFailure = createPlayerStallMonitor({
        document,
        isEnabled: () => true,
        isActive: () => true,
        beginContext() { },
        sample() {
            clearFailureSamples += 1
        },
        setTimeout(callback) {
            staleCallback = callback
            return 1
        },
        clearTimeout() {
            throw new Error('host cleanup failed')
        },
    })
    clearFailure.start()
    assert.equal(clearFailureSamples, 1)
    assert.doesNotThrow(() => clearFailure.stop())
    staleCallback()
    assert.equal(clearFailureSamples, 1, 'timer tokens must survive clearTimeout failure')
    clearFailure.dispose()
}

{
    const document = new FakeDocument()
    document.videos = [createVideo()]
    let registeredTimer
    let samples = 0
    let monitor
    monitor = createPlayerStallMonitor({
        document,
        isEnabled: () => true,
        isActive: () => true,
        beginContext() { },
        sample() {
            samples += 1
        },
        setTimeout(callback) {
            registeredTimer = callback
            return 1
        },
        clearTimeout() {
            monitor.start()
            monitor.wake()
            registeredTimer()
        },
    })
    monitor.start()
    assert.equal(samples, 1)
    monitor.stop()
    assert.equal(samples, 1, 'stop must commit inactive state before hostile cleanup callbacks')
    document.dispatchEvent(new Event('waiting'))
    assert.equal(samples, 1)
    monitor.dispose()
}

{
    const document = new FakeDocument()
    const clock = new FakeClock()
    document.videos = [createVideo()]
    let firstSchedule = true
    let samples = 0
    let monitor
    monitor = createPlayerStallMonitor({
        document,
        now: () => clock.now,
        isEnabled: () => true,
        isActive: () => true,
        beginContext() { },
        sample() {
            samples += 1
        },
        setTimeout(callback, delayMs) {
            if (firstSchedule) {
                firstSchedule = false
                monitor.wake()
            }
            return clock.setTimeout(callback, delayMs)
        },
        clearTimeout: handle => clock.clearTimeout(handle),
    })
    monitor.start()
    assert.equal(samples, 2, 'timer-setup reentrancy must merge into one deferred sample')
    assert.equal(clock.timers.size, 1)
    monitor.dispose()
}

for (const timerMode of ['synchronous', 'throw-after-register']) {
    const document = new FakeDocument()
    document.videos = [createVideo()]
    let retainedTimer
    let samples = 0
    const monitor = createPlayerStallMonitor({
        document,
        isEnabled: () => true,
        isActive: () => true,
        beginContext() { },
        sample() {
            samples += 1
        },
        setTimeout(callback) {
            retainedTimer = callback
            if (timerMode === 'synchronous') {
                callback()
                return 1
            }
            throw new Error('registered then failed')
        },
        clearTimeout() {
            throw new Error('cleanup failed')
        },
    })
    assert.doesNotThrow(() => monitor.start())
    assert.equal(samples, 1)
    retainedTimer()
    assert.equal(samples, 1, `${timerMode} abandoned callback must stay stale`)
    monitor.dispose()
}

console.log('player stall monitor tests passed')
