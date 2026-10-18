export const PLAYER_STALL_MONITOR_INTERVAL_MS = 500
const MAX_SYNCHRONOUS_WAKE_CYCLES = 8

export interface PlaybackSignals {
    visible: boolean
    paused: boolean
    seeking: boolean
    ended: boolean
    currentTimeSeconds: number
    durationSeconds: number | null
    bufferedAheadSeconds: number | null
}

export interface PlayerStallMonitorDependencies {
    sample: (signals: PlaybackSignals | null) => void
    beginContext: () => void
    isActive: () => boolean
    isEnabled: () => boolean
    document?: Document | null
    queryVideos?: () => readonly HTMLVideoElement[]
    now?: () => number
    setTimeout?: (callback: () => void, delayMs: number) => number
    clearTimeout?: (handle: number) => void
}

export interface PlayerStallMonitor {
    start(): void
    stop(): void
    synchronizeContext(): void
    wake(): void
    dispose(): void
}

const MEDIA_WAKE_EVENTS = [
    'play',
    'pause',
    'seeking',
    'seeked',
    'progress',
    'timeupdate',
    'waiting',
    'stalled',
    'playing',
] as const

const WAKE_EVENTS = ['visibilitychange', ...MEDIA_WAKE_EVENTS] as const
const MAX_BUFFERED_RANGES = 10_000

/**
 * Adapts standard document/video state to the deterministic recovery core.
 * Media events only wake a sample; the callback remains the sole stall authority.
 */
export function createPlayerStallMonitor(
    dependencies: PlayerStallMonitorDependencies,
): PlayerStallMonitor {
    const documentValue = dependencies.document === undefined
        ? typeof document === 'undefined' ? null : document
        : dependencies.document
    const now = dependencies.now ?? Date.now
    const setTimer = dependencies.setTimeout
        ?? ((callback: () => void, delayMs: number) => globalThis.setTimeout(callback, delayMs))
    const clearTimer = dependencies.clearTimeout
        ?? ((handle: number) => globalThis.clearTimeout(handle))

    let running = false
    let disposed = false
    let stopping = false
    let processingWake = false
    let deferredWake = false
    let timerHandle: number | null = null
    let timerToken = 0
    let selectedVideo: HTMLVideoElement | null = null
    const installedWakeEvents: string[] = []

    const wakeListener = () => {
        wake()
    }

    function start() {
        if (running || disposed || stopping) return
        running = true
        installWakeListeners()
        if (running && !disposed) wake()
    }

    function stop() {
        if (stopping) {
            running = false
            deferredWake = false
            timerToken += 1
            return
        }
        const wasRunning = running
        running = false
        deferredWake = false
        stopping = true
        try {
            invalidateTimer()
            if (wasRunning || installedWakeEvents.length > 0) removeWakeListeners()
        } finally {
            stopping = false
        }
    }

    function dispose() {
        if (disposed) return
        disposed = true
        stop()
    }

    function wake() {
        if (!running || disposed) return
        if (processingWake) {
            deferredWake = true
            return
        }

        processingWake = true
        try {
            for (let cycle = 0;
                cycle < MAX_SYNCHRONOUS_WAKE_CYCLES && running && !disposed;
                cycle += 1) {
                deferredWake = false
                runWakeCycle()
                if (!deferredWake) break
            }
        } finally {
            processingWake = false
            deferredWake = false
        }
    }

    function synchronizeContext() {
        if (!running || disposed) return
        synchronizeSelectedVideo()
    }

    function runWakeCycle() {
        invalidateTimer()
        if (!running || disposed || !isEnabled()) return

        const cycleStartedAt = readNow()
        sampleSelectedVideo()
        if (shouldMonitor()) scheduleNextPoll(delayAfterCycle(cycleStartedAt))
    }

    function installWakeListeners() {
        if (!documentValue) return
        for (const eventName of WAKE_EVENTS) {
            if (!running || disposed || stopping) break
            try {
                documentValue.addEventListener(eventName, wakeListener, true)
                if (!running || disposed || stopping) {
                    try {
                        documentValue.removeEventListener(eventName, wakeListener, true)
                    } catch {
                        // A stopped monitor never relies on listener cleanup for safety.
                    }
                    break
                }
                installedWakeEvents.push(eventName)
            } catch {
                // Missing listener support must not affect page playback.
            }
        }
    }

    function removeWakeListeners() {
        if (!documentValue) {
            installedWakeEvents.length = 0
            return
        }
        for (const eventName of installedWakeEvents.splice(0)) {
            try {
                documentValue.removeEventListener(eventName, wakeListener, true)
            } catch {
                // Listener cleanup is best-effort; timer tokens still stop sampling.
            }
        }
    }

    function shouldMonitor() {
        if (!isEnabled()) return false
        try {
            return dependencies.isActive() === true
        } catch {
            return false
        }
    }

    function isEnabled() {
        try {
            return dependencies.isEnabled() === true
        } catch {
            return false
        }
    }

    function readNow() {
        try {
            const value = now()
            return Number.isFinite(value) ? value : null
        } catch {
            return null
        }
    }

    function delayAfterCycle(startedAt: number | null) {
        if (startedAt === null) return PLAYER_STALL_MONITOR_INTERVAL_MS
        const completedAt = readNow()
        if (completedAt === null || completedAt < startedAt) return PLAYER_STALL_MONITOR_INTERVAL_MS
        return Math.max(0, PLAYER_STALL_MONITOR_INTERVAL_MS - (completedAt - startedAt))
    }

    function invalidateTimer() {
        timerToken += 1
        if (timerHandle === null) return
        const handle = timerHandle
        timerHandle = null
        try {
            clearTimer(handle)
        } catch {
            // The token keeps a timer harmless even when host cleanup fails.
        }
    }

    function scheduleNextPoll(delayMs: number) {
        if (!running || disposed || !shouldMonitor()) return
        if (timerHandle !== null) invalidateTimer()
        const token = ++timerToken
        let timerReturned = false
        let firedSynchronously = false
        let handle: number
        try {
            handle = setTimer(() => {
                if (!timerReturned) {
                    firedSynchronously = true
                    return
                }
                poll(token)
            }, delayMs)
            timerReturned = true
        } catch {
            if (token === timerToken) timerToken += 1
            return
        }

        if (firedSynchronously || token !== timerToken || !running || disposed) {
            if (token === timerToken) timerToken += 1
            try {
                clearTimer(handle)
            } catch {
                // A stale handle is still guarded by its token.
            }
            return
        }
        timerHandle = handle
    }

    function poll(token: number) {
        if (token !== timerToken || !running || disposed) return
        timerHandle = null
        wake()
    }

    function sampleSelectedVideo() {
        const video = synchronizeSelectedVideo()
        if (!video) {
            submitSample(null)
            return
        }

        const signals = readPlaybackSignals(documentValue, video)
        submitSample(signals)
    }

    function synchronizeSelectedVideo() {
        const video = selectVideo(queryVideos())
        if (!video) return null
        if (selectedVideo === null) {
            selectedVideo = video
        } else if (selectedVideo !== video) {
            try {
                dependencies.beginContext()
            } catch {
                return null
            }
            selectedVideo = video
        }
        return video
    }

    function submitSample(signals: PlaybackSignals | null) {
        if (!running || disposed || !shouldMonitor()) return
        try {
            dependencies.sample(signals)
        } catch {
            // Recovery is optional; adapter failures must leave native playback alone.
        }
    }

    function queryVideos(): readonly HTMLVideoElement[] | null {
        try {
            if (dependencies.queryVideos) return dependencies.queryVideos()
            return documentValue ? Array.from(documentValue.querySelectorAll('video')) : null
        } catch {
            return null
        }
    }

    return { start, stop, synchronizeContext, wake, dispose }
}

function selectVideo(videos: readonly HTMLVideoElement[] | null) {
    if (!videos) return null

    const connected: HTMLVideoElement[] = []
    try {
        for (const video of videos) {
            if (video.isConnected) connected.push(video)
        }
    } catch {
        return null
    }

    const playing: HTMLVideoElement[] = []
    try {
        for (const video of connected) {
            const ended = video.ended
            const paused = video.paused
            if (typeof ended !== 'boolean' || typeof paused !== 'boolean') return null
            if (!ended && !paused) playing.push(video)
        }
    } catch {
        return null
    }
    if (playing.length === 1) return playing[0]
    if (playing.length > 1) return null

    const mediaBearing: HTMLVideoElement[] = []
    try {
        for (const video of connected) {
            if (video.currentSrc || video.src || video.srcObject != null) mediaBearing.push(video)
        }
    } catch {
        return null
    }
    return mediaBearing.length === 1 ? mediaBearing[0] : null
}

function readPlaybackSignals(
    documentValue: Document | null,
    video: HTMLVideoElement,
): PlaybackSignals | null {
    const visible = readVisibility(documentValue)
    if (visible === null) return null

    let paused: boolean
    let seeking: boolean
    let ended: boolean
    let currentTimeSeconds: number
    try {
        paused = video.paused
        seeking = video.seeking
        ended = video.ended
        currentTimeSeconds = video.currentTime
    } catch {
        return null
    }
    if (typeof paused !== 'boolean'
        || typeof seeking !== 'boolean'
        || typeof ended !== 'boolean'
        || !Number.isFinite(currentTimeSeconds)) {
        return null
    }

    let durationSeconds: number | null = null
    try {
        const duration = video.duration
        durationSeconds = Number.isFinite(duration) ? duration : null
    } catch {
        // Unknown duration is represented explicitly and remains fail-open in the core.
    }

    return {
        visible,
        paused,
        seeking,
        ended,
        currentTimeSeconds,
        durationSeconds,
        bufferedAheadSeconds: readBufferedAhead(video, currentTimeSeconds),
    }
}

function readVisibility(documentValue: Document | null) {
    if (!documentValue) return null
    try {
        if (documentValue.visibilityState === 'visible') return true
        if (documentValue.visibilityState === 'hidden') return false
        return null
    } catch {
        return null
    }
}

function readBufferedAhead(video: HTMLVideoElement, currentTimeSeconds: number) {
    try {
        const buffered = video.buffered
        const length = buffered.length
        if (!Number.isSafeInteger(length) || length < 0 || length > MAX_BUFFERED_RANGES) return null

        let greatestAhead: number | null = null
        for (let index = 0; index < length; index += 1) {
            const start = buffered.start(index)
            const end = buffered.end(index)
            if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return null
            if (start <= currentTimeSeconds && currentTimeSeconds <= end) {
                const ahead = end - currentTimeSeconds
                if (!Number.isFinite(ahead)) return null
                greatestAhead = greatestAhead === null ? ahead : Math.max(greatestAhead, ahead)
            }
        }
        return greatestAhead ?? 0
    } catch {
        return null
    }
}
