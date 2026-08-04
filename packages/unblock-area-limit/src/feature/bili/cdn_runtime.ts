import { balh_config } from '../config'
import { FALSE } from '../r'
import { Converters, uposMap } from '../../util/converters'
import { util_debug } from '../../util/log'
import {
    CdnCandidateGroup,
    CdnMode,
    HostHealth,
    collectPlayUrlCdnGroups,
    optimizePlayUrlCdn,
} from './cdn_selection'

// Capture fetch before BALH installs its own interception hook.
const capturedFetch = typeof globalThis.fetch === 'function'
    ? globalThis.fetch.bind(globalThis)
    : undefined

export const CDN_HEALTH_CACHE_KEY = 'balh_cdn_health_v1'
export const CDN_HEALTH_CACHE_VERSION = 1
export const CDN_HEALTH_CACHE_TTL_MS = 20 * 60 * 1000
/** Avoid repeating browser-blocked probes immediately; this is memory-only and context-scoped. */
export const CDN_UNPROBEABLE_RETRY_SUPPRESSION_MS = 60 * 1000

export type CdnProbeState = 'idle' | 'probing' | 'ready' | 'partial' | 'unprobeable' | 'failed'

export interface CdnProbeStatus {
    state: CdnProbeState
    message?: string
    source?: 'cache' | 'network'
    candidateHosts: readonly string[]
    probedHosts: readonly string[]
    healthyHosts: readonly string[]
    failedHosts: readonly string[]
    unprobeableHosts: readonly string[]
    completed: number
    total: number
    updatedAt?: number
}

export interface CdnProbeLimits {
    maxConcurrent: number
    maxStages: number
    maxBytesPerRequest: number
    maxTotalBytes: number
    requestTimeoutMs: number
    stageTimeoutMs: number
    totalTimeoutMs: number
}

interface StorageLike {
    getItem(key: string): string | null
    setItem(key: string, value: string): void
    removeItem(key: string): void
}

interface RuntimeCandidate {
    url: string
    host: string
    persistable: boolean
}

interface ProbeOutcome {
    host: string
    kind: 'success' | 'failure' | 'unprobeable'
    /** Bytes admitted to health scoring, capped by the requested prefix. */
    bytes: number
    /** Whole chunks delivered by the stream, used for conservative global budgeting. */
    observedBytes: number
    ttfbMs?: number
    throughputKbps?: number
}

interface PersistedHealthCache {
    version: number
    savedAt: number
    networkHint: string
    candidateHostHash: string
    hosts: Record<string, HostHealth>
}

export interface CdnRuntimeDependencies {
    fetch?: ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) | null
    storage?: StorageLike | null
    now?: () => number
    setTimeout?: (callback: () => void, delayMs: number) => number
    clearTimeout?: (handle: number) => void
    createAbortController?: () => AbortController
    scheduleBackground?: (callback: () => void) => void
    getNetworkHint?: () => string
    getMode?: () => unknown
    getManualHost?: () => string | undefined
    getManualReplaceAkamai?: () => typeof FALSE | 'Y' | undefined
    replaceManual?: (playUrl: unknown, host: string, replaceAkamai: typeof FALSE | 'Y') => unknown
    collectGroups?: (playUrl: unknown) => readonly CdnCandidateGroup[]
    optimize?: typeof optimizePlayUrlCdn
    log?: (event: string, status?: CdnProbeStatus) => void
    limits?: Partial<CdnProbeLimits>
}

export interface CdnRuntime {
    applyCdnPolicy<T>(playUrl: T): T
    probeCurrentPlayUrlCdn(options?: { force?: boolean }): Promise<CdnProbeStatus>
    clearCdnHealthCache(): void
    getCdnProbeStatus(): CdnProbeStatus
    subscribeCdnProbeStatus(listener: (status: CdnProbeStatus) => void): () => void
}

const DEFAULT_LIMITS: CdnProbeLimits = {
    maxConcurrent: 2,
    maxStages: 2,
    maxBytesPerRequest: 64 * 1024,
    maxTotalBytes: 192 * 1024,
    requestTimeoutMs: 3_500,
    stageTimeoutMs: 4_000,
    totalTimeoutMs: 7_500,
}

function defaultStorage(): StorageLike | null {
    try {
        return typeof localStorage === 'undefined' ? null : localStorage
    } catch {
        return null
    }
}

function defaultNetworkHint() {
    try {
        const connection = (navigator as Navigator & {
            connection?: { effectiveType?: unknown, saveData?: unknown, type?: unknown }
        }).connection
        if (!connection) return 'unknown'
        const type = typeof connection.type === 'string' ? connection.type : 'unknown'
        const effectiveType = typeof connection.effectiveType === 'string' ? connection.effectiveType : 'unknown'
        return `${type}:${effectiveType}:${connection.saveData === true ? 'save-data' : 'normal'}`
    } catch {
        return 'unknown'
    }
}

function defaultManualHost() {
    if ((globalThis as any).window?.__balh_app_only__ === true) return undefined
    const key = balh_config.upos_server
    if (!key) return undefined
    const host = uposMap[key]
    return typeof host === 'string' && host.length > 0 ? host : undefined
}

function normalizeMode(value: unknown): CdnMode | 'original' | 'manual' {
    return value === 'original' || value === 'manual' || value === 'auto' || value === 'safe'
        ? value
        : 'safe'
}

function positiveInteger(value: unknown, fallback: number) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.max(1, Math.floor(value))
        : fallback
}

function normalizeLimits(overrides: Partial<CdnProbeLimits> | undefined): CdnProbeLimits {
    return {
        maxConcurrent: Math.min(2, positiveInteger(overrides?.maxConcurrent, DEFAULT_LIMITS.maxConcurrent)),
        maxStages: positiveInteger(overrides?.maxStages, DEFAULT_LIMITS.maxStages),
        maxBytesPerRequest: positiveInteger(overrides?.maxBytesPerRequest, DEFAULT_LIMITS.maxBytesPerRequest),
        maxTotalBytes: positiveInteger(overrides?.maxTotalBytes, DEFAULT_LIMITS.maxTotalBytes),
        requestTimeoutMs: positiveInteger(overrides?.requestTimeoutMs, DEFAULT_LIMITS.requestTimeoutMs),
        stageTimeoutMs: positiveInteger(overrides?.stageTimeoutMs, DEFAULT_LIMITS.stageTimeoutMs),
        totalTimeoutMs: positiveInteger(overrides?.totalTimeoutMs, DEFAULT_LIMITS.totalTimeoutMs),
    }
}

function normalizeHost(value: unknown) {
    if (typeof value !== 'string') return undefined
    const host = value.trim().toLowerCase()
    if (!host || host.length > 253 || /[\s\\/?#@]/.test(host)) return undefined
    return host
}

function parseRuntimeCandidate(url: unknown, fallbackHost?: unknown): RuntimeCandidate | undefined {
    if (typeof url !== 'string' || !url) return undefined
    try {
        const parsed = new URL(url, 'https://www.bilibili.com/')
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
        const host = normalizeHost(fallbackHost) ?? normalizeHost(parsed.host)
        return host ? { url, host, persistable: !isIpLiteralHost(host) } : undefined
    } catch {
        return undefined
    }
}

function extractCandidates(groups: readonly CdnCandidateGroup[]) {
    const result: RuntimeCandidate[] = []
    const seenUrls = new Set<string>()
    for (const group of groups) {
        for (const candidate of group.candidates) {
            if (seenUrls.has(candidate.url)) continue
            const parsed = parseRuntimeCandidate(candidate.url, candidate.host || candidate.hostname)
            if (!parsed) continue
            parsed.persistable = !candidate.riskKinds.includes('ip-literal') && parsed.persistable
            seenUrls.add(parsed.url)
            result.push(parsed)
        }
    }
    return result
}

function isIpLiteralHost(host: string) {
    try {
        const hostname = new URL(`https://${host}`).hostname
        return /^\[.*\]$/.test(hostname) || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)
    } catch {
        return true
    }
}

function uniqueSorted(values: readonly string[]) {
    return [...new Set(values)].sort()
}

function hashCandidateHosts(hosts: readonly string[]) {
    let hash = 0x811c9dc5
    for (const character of uniqueSorted(hosts).join('\n')) {
        hash ^= character.charCodeAt(0)
        hash = Math.imul(hash, 0x01000193)
    }
    return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`
}

function cloneStatus(status: CdnProbeStatus): CdnProbeStatus {
    return {
        ...status,
        candidateHosts: [...status.candidateHosts],
        probedHosts: [...status.probedHosts],
        healthyHosts: [...status.healthyHosts],
        failedHosts: [...status.failedHosts],
        unprobeableHosts: [...status.unprobeableHosts],
    }
}

function finiteMetric(value: unknown) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function normalizeHealth(value: unknown, host: string): HostHealth | undefined {
    if (!value || typeof value !== 'object') return undefined
    const input = value as HostHealth
    const successes = finiteMetric(input.successes)
    const failures = finiteMetric(input.failures)
    const samples = finiteMetric(input.samples)
    const throughputKbps = finiteMetric(input.throughputKbps)
    const ttfbMs = finiteMetric(input.ttfbMs)
    if (successes === undefined && failures === undefined && samples === undefined
        && throughputKbps === undefined && ttfbMs === undefined) return undefined
    return { host, successes, failures, samples, throughputKbps, ttfbMs }
}

function replaceProtocolRelativeHosts(value: unknown, host: string, seen = new WeakSet<object>()): unknown {
    if (typeof value === 'string') {
        if (!value.startsWith('//')) return value
        try {
            const parsed = new URL(`https:${value}`)
            if (parsed.protocol !== 'https:' || !parsed.host || parsed.host === host) return value
            const authorityEnd = value.slice(2).search(/[/?#]/)
            const suffixIndex = authorityEnd < 0 ? value.length : authorityEnd + 2
            return `//${host}${value.slice(suffixIndex)}`
        } catch {
            return value
        }
    }
    if (!value || typeof value !== 'object' || seen.has(value)) return value
    seen.add(value)
    if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
            value[index] = replaceProtocolRelativeHosts(value[index], host, seen)
        }
        return value
    }
    const record = value as Record<string, unknown>
    for (const key of Object.keys(record)) {
        record[key] = replaceProtocolRelativeHosts(record[key], host, seen)
    }
    return value
}

export function replaceManualCdnHosts<T>(
    playUrl: T,
    host: string,
    replaceAkamai: typeof FALSE | 'Y',
): T {
    const replacement = Converters.replaceUpos(playUrl, host, replaceAkamai)
    const serialized = JSON.stringify(playUrl)
    if (serialized.includes('akamaized.net') && replaceAkamai !== 'Y') return replacement
    return replaceProtocolRelativeHosts(replacement, host) as T
}

function replaceObjectContents<T>(target: T, replacement: unknown): T {
    if (!target || typeof target !== 'object' || !replacement || typeof replacement !== 'object') return target
    if (Array.isArray(target) && Array.isArray(replacement)) {
        const sharedLength = Math.min(target.length, replacement.length)
        for (let index = 0; index < sharedLength; index += 1) {
            const current = target[index]
            const next = replacement[index]
            if (current && next && typeof current === 'object' && typeof next === 'object'
                && Array.isArray(current) === Array.isArray(next)) {
                replaceObjectContents(current, next)
            } else if (!Object.is(current, next)) {
                target[index] = next
            }
        }
        if (target.length > replacement.length) target.splice(replacement.length)
        if (replacement.length > target.length) target.push(...replacement.slice(target.length))
        return target
    }
    if (Array.isArray(target) || Array.isArray(replacement)) return target
    const targetRecord = target as Record<string, unknown>
    const replacementRecord = replacement as Record<string, unknown>
    for (const key of Object.keys(targetRecord)) {
        if (!Object.prototype.hasOwnProperty.call(replacementRecord, key)) delete targetRecord[key]
    }
    for (const [key, next] of Object.entries(replacementRecord)) {
        const current = targetRecord[key]
        if (current && next && typeof current === 'object' && typeof next === 'object'
            && Array.isArray(current) === Array.isArray(next)) {
            replaceObjectContents(current, next)
        } else if (!Object.is(current, next)) {
            targetRecord[key] = next
        }
    }
    return target
}

export function createCdnRuntime(overrides: CdnRuntimeDependencies = {}): CdnRuntime {
    const limits = normalizeLimits(overrides.limits)
    const dependencies = {
        fetch: overrides.fetch === undefined ? capturedFetch : overrides.fetch,
        storage: overrides.storage === undefined ? defaultStorage() : overrides.storage,
        now: overrides.now ?? (() => Date.now()),
        setTimeout: overrides.setTimeout ?? ((callback: () => void, delayMs: number) => globalThis.setTimeout(callback, delayMs)),
        clearTimeout: overrides.clearTimeout ?? ((handle: number) => globalThis.clearTimeout(handle)),
        createAbortController: overrides.createAbortController ?? (() => new AbortController()),
        scheduleBackground: overrides.scheduleBackground ?? ((callback: () => void) => {
            globalThis.setTimeout(callback, 0)
        }),
        getNetworkHint: overrides.getNetworkHint ?? defaultNetworkHint,
        getMode: overrides.getMode ?? (() => balh_config.cdn_mode),
        getManualHost: overrides.getManualHost ?? defaultManualHost,
        getManualReplaceAkamai: overrides.getManualReplaceAkamai ?? (() => balh_config.upos_replace_akamai),
        replaceManual: overrides.replaceManual ?? replaceManualCdnHosts,
        collectGroups: overrides.collectGroups ?? collectPlayUrlCdnGroups,
        optimize: overrides.optimize ?? optimizePlayUrlCdn,
        log: overrides.log ?? ((event: string, probeStatus?: CdnProbeStatus) => util_debug(event, probeStatus)),
    }

    let currentCandidates: RuntimeCandidate[] = []
    let currentHostHash = hashCandidateHosts([])
    let healthHostHash = ''
    let healthNetworkHint = ''
    let healthValidUntil = 0
    let healthByHost: Record<string, HostHealth> = Object.create(null)
    let status: CdnProbeStatus = emptyStatus()
    let generation = 0
    let inFlight: Promise<CdnProbeStatus> | undefined
    let backgroundScheduled = false
    let backgroundScheduleId = 0
    let unprobeableGeneration = -1
    let unprobeableUntil = 0
    let suppressedUnprobeableStatus: CdnProbeStatus | undefined
    const activeControllers = new Set<AbortController>()
    const exactOutcomes = new Map<string, ProbeOutcome>()
    const listeners = new Set<(status: CdnProbeStatus) => void>()

    function emptyStatus(message?: string): CdnProbeStatus {
        return {
            state: 'idle',
            message,
            candidateHosts: uniqueSorted(currentCandidates.map(candidate => candidate.host)),
            probedHosts: [],
            healthyHosts: [],
            failedHosts: [],
            unprobeableHosts: [],
            completed: 0,
            total: 0,
        }
    }

    function publish(next: CdnProbeStatus) {
        status = cloneStatus(next)
        const publicStatus = cloneStatus(status)
        dependencies.log('cdn-probe-status', publicStatus)
        for (const listener of listeners) {
            try {
                listener(cloneStatus(publicStatus))
            } catch {
                dependencies.log('cdn-probe-listener-failed')
            }
        }
    }

    function currentNetworkHint() {
        try {
            return String(dependencies.getNetworkHint())
        } catch {
            dependencies.log('cdn-network-hint-read-failed')
            return 'unknown'
        }
    }

    function clearUnprobeableSuppression() {
        unprobeableGeneration = -1
        unprobeableUntil = 0
        suppressedUnprobeableStatus = undefined
    }

    function rememberUnprobeable(status: CdnProbeStatus, runGeneration: number) {
        unprobeableGeneration = runGeneration
        unprobeableUntil = dependencies.now() + CDN_UNPROBEABLE_RETRY_SUPPRESSION_MS
        suppressedUnprobeableStatus = cloneStatus(status)
    }

    async function cancelWithBudget(
        cancel: () => void | PromiseLike<void>,
        controller: AbortController,
        requestTimeoutMs: number,
    ) {
        const cleanupTimeoutMs = Math.max(1, Math.min(250, requestTimeoutMs))
        let cleanupTimer = 0
        const cancellation = Promise.resolve()
            .then(cancel)
            .then(() => true, () => false)
        const deadline = new Promise<boolean>(resolve => {
            cleanupTimer = dependencies.setTimeout(() => resolve(false), cleanupTimeoutMs)
        })
        let completed = false
        try {
            completed = await Promise.race([cancellation, deadline])
        } finally {
            dependencies.clearTimeout(cleanupTimer)
        }
        if (!completed) {
            try {
                controller.abort()
            } catch {
                // The cleanup path is best-effort after its strict wait budget.
            }
        }
    }

    function readMatchingCache(candidateHostHash: string, networkHint: string) {
        const storage = dependencies.storage
        if (!storage) return undefined
        let raw: string | null
        try {
            raw = storage.getItem(CDN_HEALTH_CACHE_KEY)
        } catch {
            dependencies.log('cdn-health-cache-read-failed')
            return undefined
        }
        if (!raw) return undefined
        let parsed: unknown
        try {
            parsed = JSON.parse(raw)
        } catch {
            dependencies.log('cdn-health-cache-invalid')
            return undefined
        }
        if (!parsed || typeof parsed !== 'object') return undefined
        const cache = parsed as Partial<PersistedHealthCache>
        const age = dependencies.now() - Number(cache.savedAt)
        if (cache.version !== CDN_HEALTH_CACHE_VERSION
            || !Number.isFinite(age) || age < 0 || age > CDN_HEALTH_CACHE_TTL_MS
            || cache.networkHint !== networkHint
            || cache.candidateHostHash !== candidateHostHash
            || !cache.hosts || typeof cache.hosts !== 'object') return undefined
        const hosts: Record<string, HostHealth> = Object.create(null)
        const allowedHosts = new Set(currentCandidates.map(candidate => candidate.host))
        for (const [rawHost, rawHealth] of Object.entries(cache.hosts)) {
            const host = normalizeHost(rawHost)
            if (!host || isIpLiteralHost(host) || !allowedHosts.has(host)) continue
            const health = normalizeHealth(rawHealth, host)
            if (health) hosts[host] = health
        }
        if (!Object.keys(hosts).length) return undefined
        return { hosts, validUntil: Number(cache.savedAt) + CDN_HEALTH_CACHE_TTL_MS }
    }

    function writeCache() {
        const storage = dependencies.storage
        if (!storage || !Object.keys(healthByHost).length || !currentCandidates.length) return
        const hosts: Record<string, HostHealth> = Object.create(null)
        const persistableHosts = new Set(
            currentCandidates.filter(candidate => candidate.persistable).map(candidate => candidate.host),
        )
        for (const host of uniqueSorted([...persistableHosts])) {
            const health = normalizeHealth(healthByHost[host], host)
            if (health) hosts[host] = health
        }
        if (!Object.keys(hosts).length) return
        const cache: PersistedHealthCache = {
            version: CDN_HEALTH_CACHE_VERSION,
            savedAt: dependencies.now(),
            networkHint: healthNetworkHint || currentNetworkHint(),
            candidateHostHash: currentHostHash,
            hosts,
        }
        try {
            storage.setItem(CDN_HEALTH_CACHE_KEY, JSON.stringify(cache))
        } catch {
            dependencies.log('cdn-health-cache-write-failed')
        }
    }

    function publishHealthSnapshot(source: 'cache' | 'network') {
        const candidateHosts = uniqueSorted(currentCandidates.map(candidate => candidate.host))
        const healthEntries = Object.entries(healthByHost)
        const healthyHosts = healthEntries
            .filter(([, health]) => (health.successes ?? 0) > 0)
            .map(([host]) => host)
            .sort()
        const failedHosts = healthEntries
            .filter(([, health]) => (health.successes ?? 0) === 0 && (health.failures ?? 0) > 0)
            .map(([host]) => host)
            .sort()
        const healthState: CdnProbeState = healthyHosts.length
            ? (failedHosts.length ? 'partial' : 'ready')
            : (failedHosts.length ? 'failed' : 'unprobeable')
        const prefix = source === 'cache' ? 'Cached CDN health' : 'CDN health'
        publish({
            state: healthState,
            message: healthState === 'ready'
                ? `${prefix} is ready.`
                : healthState === 'partial'
                    ? `${prefix} has partial results.`
                    : healthState === 'failed'
                        ? `${prefix} did not find a healthy host.`
                        : `${prefix} is not measurable.`,
            source,
            candidateHosts,
            probedHosts: healthEntries.map(([host]) => host).sort(),
            healthyHosts,
            failedHosts,
            unprobeableHosts: [],
            completed: healthEntries.length,
            total: candidateHosts.length,
            updatedAt: dependencies.now(),
        })
    }

    function ensureHealthForCurrentHosts() {
        const networkHint = currentNetworkHint()
        const networkChanged = healthNetworkHint !== '' && healthNetworkHint !== networkHint
        if (networkChanged) {
            generation += 1
            abortActiveProbes()
            inFlight = undefined
            backgroundScheduled = false
            backgroundScheduleId += 1
            exactOutcomes.clear()
            healthHostHash = ''
            healthValidUntil = 0
            healthByHost = Object.create(null)
            clearUnprobeableSuppression()
        }
        if (!networkChanged && healthHostHash === currentHostHash
            && healthNetworkHint === networkHint && dependencies.now() < healthValidUntil) return
        const cached = readMatchingCache(currentHostHash, networkHint)
        healthHostHash = currentHostHash
        healthNetworkHint = networkHint
        healthByHost = cached?.hosts ?? Object.create(null)
        healthValidUntil = cached?.validUntil ?? 0
        if (cached) publishHealthSnapshot('cache')
        else if (networkChanged) publish(emptyStatus('Network changed; CDN health was reset.'))
    }

    function abortActiveProbes() {
        for (const controller of activeControllers) controller.abort()
        activeControllers.clear()
    }

    function updateCurrentCandidates(next: RuntimeCandidate[]) {
        const canonical = (candidates: RuntimeCandidate[]) => candidates
            .map(candidate => `${candidate.host}\0${candidate.url}`)
            .sort()
        const previousCanonical = canonical(currentCandidates)
        const nextCanonical = canonical(next)
        const changed = nextCanonical.length !== previousCanonical.length
            || nextCanonical.some((value, index) => value !== previousCanonical[index])
        if (!changed) {
            currentCandidates = next
            return
        }
        generation += 1
        abortActiveProbes()
        inFlight = undefined
        backgroundScheduled = false
        backgroundScheduleId += 1
        exactOutcomes.clear()
        clearUnprobeableSuppression()
        currentCandidates = next
        currentHostHash = hashCandidateHosts(next.map(candidate => candidate.host))
        ensureHealthForCurrentHosts()
        for (const candidate of next) {
            if (!candidate.persistable) delete healthByHost[candidate.host]
        }
        const hasValidHealth = healthHostHash === currentHostHash
            && dependencies.now() < healthValidUntil
            && Object.keys(healthByHost).length > 0
        if (hasValidHealth) publishHealthSnapshot(status.source === 'cache' ? 'cache' : 'network')
        else publish(emptyStatus())
    }

    function captureCurrent(playUrl: unknown) {
        let groups: readonly CdnCandidateGroup[] = []
        try {
            groups = dependencies.collectGroups(playUrl)
        } catch {
            dependencies.log('cdn-candidate-collection-failed')
        }
        updateCurrentCandidates(extractCandidates(groups))
        ensureHealthForCurrentHosts()
    }

    function scheduleAutoProbe() {
        if (backgroundScheduled || inFlight || !currentCandidates.length) return
        backgroundScheduled = true
        const scheduleId = ++backgroundScheduleId
        dependencies.scheduleBackground(() => {
            if (scheduleId !== backgroundScheduleId) return
            backgroundScheduled = false
            if (normalizeMode(dependencies.getMode()) !== 'auto') return
            void probeCurrentPlayUrlCdn().catch(() => {
                dependencies.log('cdn-background-probe-failed')
            })
        })
    }

    function applyCdnPolicy<T>(playUrl: T): T {
        if (!playUrl || typeof playUrl !== 'object') return playUrl
        const mode = normalizeMode(dependencies.getMode())
        if (mode === 'manual') {
            const host = dependencies.getManualHost()
            if (normalizeHost(host)) {
                try {
                    const replacement = dependencies.replaceManual(
                        playUrl,
                        host!,
                        dependencies.getManualReplaceAkamai() === 'Y' ? 'Y' : FALSE,
                    )
                    replaceObjectContents(playUrl, replacement)
                } catch {
                    dependencies.log('cdn-manual-replacement-failed')
                }
            }
            captureCurrent(playUrl)
            return playUrl
        }
        if (mode === 'safe' || mode === 'auto') {
            captureCurrent(playUrl)
            ensureHealthForCurrentHosts()
            try {
                dependencies.optimize(playUrl, { mode, hostHealth: healthByHost })
            } catch {
                dependencies.log('cdn-selection-failed')
            }
            captureCurrent(playUrl)
            if (mode === 'auto') scheduleAutoProbe()
            return playUrl
        }
        captureCurrent(playUrl)
        return playUrl
    }

    function selectProbeTargets() {
        const seenHosts = new Set<string>()
        const targets: RuntimeCandidate[] = []
        // Keep the candidate set to two hosts, then sample each host once per stage.
        const limit = limits.maxConcurrent
        for (const candidate of currentCandidates) {
            if (seenHosts.has(candidate.host)) continue
            seenHosts.add(candidate.host)
            targets.push(candidate)
            if (targets.length >= limit) break
        }
        return targets
    }

    async function probeCandidate(candidate: RuntimeCandidate, byteCap: number, timeoutMs: number): Promise<ProbeOutcome> {
        const fetchImpl = dependencies.fetch
        if (!fetchImpl || byteCap <= 0) {
            return { host: candidate.host, kind: 'unprobeable', bytes: 0, observedBytes: 0 }
        }
        const controller = dependencies.createAbortController()
        activeControllers.add(controller)
        const startedAt = dependencies.now()
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
        let responseBody: ReadableStream<Uint8Array> | null | undefined
        let streamDone = false
        let timedOut = false
        let cleanupRequested = false
        let requestOutcomeChosen = false
        let accountedBytes = 0
        let observedBytes = 0
        let timerHandle = 0
        let readerCleanup: Promise<void> | undefined
        let bodyCleanup: Promise<void> | undefined
        let readerLockReleased = false

        const releaseReaderLock = () => {
            if (!reader || readerLockReleased) return
            try {
                reader.releaseLock()
                readerLockReleased = true
            } catch {
                // A late pending read may keep the lock until its continuation settles.
            }
        }
        const cleanupReader = () => {
            if (!reader) return Promise.resolve()
            if (!readerCleanup) {
                readerCleanup = (async () => {
                    try {
                        if (!streamDone) {
                            await cancelWithBudget(() => reader!.cancel(), controller, timeoutMs)
                        }
                    } finally {
                        releaseReaderLock()
                    }
                })()
            }
            return readerCleanup
        }
        const cleanupAvailableResource = () => {
            if (reader) return cleanupReader()
            if (!responseBody) return Promise.resolve()
            if (!bodyCleanup) {
                bodyCleanup = cancelWithBudget(() => responseBody!.cancel(), controller, timeoutMs)
            }
            return bodyCleanup
        }
        const snapshot = (kind: ProbeOutcome['kind']): ProbeOutcome => ({
            host: candidate.host,
            kind,
            bytes: accountedBytes,
            observedBytes,
        })

        const timeoutToken = Symbol('timeout')
        const abortToken = Symbol('abort')
        let resolveAbort!: (value: typeof abortToken) => void
        const abortResult = new Promise<typeof abortToken>(resolve => {
            resolveAbort = resolve
        })
        const onAbort = () => {
            cleanupRequested = true
            if (!requestOutcomeChosen) resolveAbort(abortToken)
        }
        controller.signal.addEventListener('abort', onAbort, { once: true })
        const timeoutResult = new Promise<typeof timeoutToken>(resolve => {
            timerHandle = dependencies.setTimeout(() => {
                timedOut = true
                cleanupRequested = true
                controller.abort()
                resolve(timeoutToken)
            }, timeoutMs)
        })
        const requestResult = (async (): Promise<ProbeOutcome> => {
            try {
                const response = await fetchImpl(candidate.url, {
                    method: 'GET',
                    mode: 'cors',
                    credentials: 'omit',
                    cache: 'no-store',
                    signal: controller.signal,
                })
                responseBody = response.body
                if (cleanupRequested) {
                    await cleanupAvailableResource()
                    return snapshot(timedOut ? 'failure' : 'unprobeable')
                }
                if (response.type === 'opaque' || response.ok === false) {
                    requestOutcomeChosen = true
                    await cleanupAvailableResource()
                    return snapshot(response.type === 'opaque' ? 'unprobeable' : 'failure')
                }
                reader = responseBody?.getReader()
                if (!reader) {
                    requestOutcomeChosen = true
                    return snapshot('unprobeable')
                }
                if (cleanupRequested) {
                    await cleanupReader()
                    return snapshot(timedOut ? 'failure' : 'unprobeable')
                }
                let firstByteAt: number | undefined
                while (accountedBytes < byteCap && !cleanupRequested) {
                    const chunk = await reader.read()
                    if (chunk.done) {
                        streamDone = true
                        break
                    }
                    const available = chunk.value?.byteLength ?? 0
                    observedBytes = Math.min(Number.MAX_SAFE_INTEGER, observedBytes + available)
                    if (cleanupRequested) return snapshot(timedOut ? 'failure' : 'unprobeable')
                    if (firstByteAt === undefined) firstByteAt = dependencies.now()
                    accountedBytes += Math.min(available, byteCap - accountedBytes)
                }
                if (cleanupRequested) return snapshot(timedOut ? 'failure' : 'unprobeable')
                const endedAt = dependencies.now()
                const elapsedMs = Math.max(1, endedAt - (firstByteAt ?? startedAt))
                requestOutcomeChosen = true
                if (accountedBytes === 0) return snapshot('unprobeable')
                return {
                    ...snapshot('success'),
                    ttfbMs: Math.max(0, (firstByteAt ?? endedAt) - startedAt),
                    throughputKbps: accountedBytes > 0 ? accountedBytes * 8 / elapsedMs : undefined,
                }
            } finally {
                if (reader) {
                    await cleanupReader()
                    // Retry after a canceled pending read has had a chance to settle.
                    releaseReaderLock()
                }
            }
        })()
        let outcome: ProbeOutcome
        try {
            const winner = await Promise.race([requestResult, timeoutResult, abortResult])
            outcome = winner === timeoutToken
                ? snapshot('failure')
                : winner === abortToken
                    ? snapshot(timedOut ? 'failure' : 'unprobeable')
                    : winner
        } catch {
            outcome = snapshot(timedOut ? 'failure' : 'unprobeable')
        } finally {
            dependencies.clearTimeout(timerHandle)
            if (cleanupRequested) {
                await cleanupAvailableResource()
                // Let a canceled read publish its final observed/accounted counters.
                await Promise.resolve()
            }
            activeControllers.delete(controller)
            controller.signal.removeEventListener('abort', onAbort)
        }
        return timedOut ? snapshot('failure') : outcome
    }

    function updateHealth(outcome: ProbeOutcome) {
        if (outcome.kind === 'unprobeable') return
        const previous = normalizeHealth(healthByHost[outcome.host], outcome.host) ?? { host: outcome.host }
        const previousSuccesses = previous.successes ?? 0
        const previousFailures = previous.failures ?? 0
        const previousSamples = previous.samples ?? 0
        if (outcome.kind === 'failure') {
            healthByHost[outcome.host] = {
                ...previous,
                failures: previousFailures + 1,
                samples: previousSamples + 1,
            }
            return
        }
        const nextSuccesses = previousSuccesses + 1
        healthByHost[outcome.host] = {
            ...previous,
            successes: nextSuccesses,
            failures: previousFailures,
            samples: previousSamples + 1,
            throughputKbps: outcome.throughputKbps === undefined
                ? previous.throughputKbps
                : ((previous.throughputKbps ?? outcome.throughputKbps) * previousSuccesses + outcome.throughputKbps) / nextSuccesses,
            ttfbMs: outcome.ttfbMs === undefined
                ? previous.ttfbMs
                : ((previous.ttfbMs ?? outcome.ttfbMs) * previousSuccesses + outcome.ttfbMs) / nextSuccesses,
        }
    }

    function statusFromOutcomes(outcomes: readonly ProbeOutcome[], total: number): CdnProbeStatus {
        const healthyHosts = uniqueSorted(outcomes.filter(outcome => outcome.kind === 'success').map(outcome => outcome.host))
        const failedHosts = uniqueSorted(outcomes.filter(outcome => outcome.kind === 'failure').map(outcome => outcome.host))
        const unprobeableHosts = uniqueSorted(outcomes.filter(outcome => outcome.kind === 'unprobeable').map(outcome => outcome.host))
        let state: CdnProbeState
        let message: string
        if (healthyHosts.length && outcomes.length === total && !failedHosts.length && !unprobeableHosts.length) {
            state = 'ready'
            message = 'CDN health probe completed.'
        } else if (healthyHosts.length) {
            state = 'partial'
            message = 'CDN health probe completed with partial results.'
        } else if (failedHosts.length) {
            state = 'failed'
            message = 'CDN health probe did not find a healthy host.'
        } else {
            state = 'unprobeable'
            message = 'CDN health could not be measured in this browser context.'
        }
        return {
            state,
            message,
            source: 'network',
            candidateHosts: uniqueSorted(currentCandidates.map(candidate => candidate.host)),
            probedHosts: uniqueSorted(outcomes.map(outcome => outcome.host)),
            healthyHosts,
            failedHosts,
            unprobeableHosts,
            completed: outcomes.length,
            total,
            updatedAt: dependencies.now(),
        }
    }

    async function runProbe(runGeneration: number) {
        const runNetworkHint = currentNetworkHint()
        const stageTargets = selectProbeTargets()
        if (!stageTargets.length) {
            const next = emptyStatus('No CDN candidates are available for probing.')
            publish(next)
            return cloneStatus(next)
        }
        const candidateHosts = uniqueSorted(currentCandidates.map(candidate => candidate.host))
        publish({
            state: 'probing',
            message: 'Testing current CDN hosts.',
            source: 'network',
            candidateHosts,
            probedHosts: [],
            healthyHosts: [],
            failedHosts: [],
            unprobeableHosts: [],
            completed: 0,
            total: stageTargets.length * limits.maxStages,
            updatedAt: dependencies.now(),
        })
        const outcomes: ProbeOutcome[] = []
        const totalStartedAt = dependencies.now()
        let remainingBytes = limits.maxTotalBytes
        const totalAttempts = stageTargets.length * limits.maxStages
        for (let stage = 0; stage < limits.maxStages; stage += 1) {
            if (currentNetworkHint() !== runNetworkHint) {
                ensureHealthForCurrentHosts()
                break
            }
            const elapsed = Math.max(0, dependencies.now() - totalStartedAt)
            const totalRemainingMs = limits.totalTimeoutMs - elapsed
            if (totalRemainingMs <= 0 || remainingBytes <= 0 || runGeneration !== generation) break
            const baseTargetCap = Math.floor(remainingBytes / stageTargets.length)
            const extraBytes = remainingBytes % stageTargets.length
            const targetCaps = stageTargets.map((_, index) => Math.min(
                limits.maxBytesPerRequest,
                baseTargetCap + (index < extraBytes ? 1 : 0),
            ))
            const timeoutMs = Math.max(1, Math.min(
                limits.requestTimeoutMs,
                limits.stageTimeoutMs,
                totalRemainingMs,
            ))
            const currentStageOutcomes = await Promise.all(
                stageTargets.map((candidate, index) => probeCandidate(candidate, targetCaps[index], timeoutMs)),
            )
            if (currentNetworkHint() !== runNetworkHint) {
                ensureHealthForCurrentHosts()
                break
            }
            if (runGeneration !== generation) break
            for (let index = 0; index < currentStageOutcomes.length; index += 1) {
                const outcome = currentStageOutcomes[index]
                outcomes.push(outcome)
                remainingBytes = Math.max(0, remainingBytes - Math.max(outcome.bytes, outcome.observedBytes))
                exactOutcomes.set(stageTargets[index].url, outcome)
                updateHealth(outcome)
            }
            publish({
                ...statusFromOutcomes(outcomes, totalAttempts),
                state: 'probing',
                message: 'Testing current CDN hosts.',
            })
        }
        if (runGeneration !== generation) return cloneStatus(status)
        healthHostHash = currentHostHash
        healthNetworkHint = runNetworkHint
        healthValidUntil = dependencies.now() + CDN_HEALTH_CACHE_TTL_MS
        writeCache()
        const next = statusFromOutcomes(outcomes, totalAttempts)
        publish(next)
        if (next.state === 'unprobeable') rememberUnprobeable(next, runGeneration)
        else clearUnprobeableSuppression()
        return cloneStatus(next)
    }

    function probeCurrentPlayUrlCdn(options: { force?: boolean } = {}) {
        ensureHealthForCurrentHosts()
        if (inFlight) return inFlight
        if (!options.force && unprobeableGeneration === generation
            && dependencies.now() < unprobeableUntil && suppressedUnprobeableStatus) {
            return Promise.resolve(cloneStatus(suppressedUnprobeableStatus))
        }
        if (!options.force && healthHostHash === currentHostHash
            && dependencies.now() < healthValidUntil && Object.keys(healthByHost).length) {
            return Promise.resolve(cloneStatus(status))
        }
        const runGeneration = generation
        const promise = runProbe(runGeneration).finally(() => {
            if (inFlight === promise) inFlight = undefined
        })
        inFlight = promise
        return promise
    }

    function clearCdnHealthCache() {
        generation += 1
        abortActiveProbes()
        inFlight = undefined
        backgroundScheduled = false
        backgroundScheduleId += 1
        exactOutcomes.clear()
        healthByHost = Object.create(null)
        healthHostHash = ''
        healthNetworkHint = ''
        healthValidUntil = 0
        clearUnprobeableSuppression()
        try {
            dependencies.storage?.removeItem(CDN_HEALTH_CACHE_KEY)
        } catch {
            dependencies.log('cdn-health-cache-clear-failed')
        }
        publish(emptyStatus('CDN health cache cleared.'))
    }

    function getCdnProbeStatus() {
        return cloneStatus(status)
    }

    function subscribeCdnProbeStatus(listener: (status: CdnProbeStatus) => void) {
        listeners.add(listener)
        try {
            listener(cloneStatus(status))
        } catch {
            dependencies.log('cdn-probe-listener-failed')
        }
        return () => listeners.delete(listener)
    }

    return {
        applyCdnPolicy,
        probeCurrentPlayUrlCdn,
        clearCdnHealthCache,
        getCdnProbeStatus,
        subscribeCdnProbeStatus,
    }
}

const defaultRuntime = createCdnRuntime()

export const applyCdnPolicy = defaultRuntime.applyCdnPolicy
export const probeCurrentPlayUrlCdn = defaultRuntime.probeCurrentPlayUrlCdn
export const clearCdnHealthCache = defaultRuntime.clearCdnHealthCache
export const getCdnProbeStatus = defaultRuntime.getCdnProbeStatus
export const subscribeCdnProbeStatus = defaultRuntime.subscribeCdnProbeStatus
