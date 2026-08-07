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
import { publishCdnRecoveryGroups } from './cdn_recovery_browser'

// Capture fetch before BALH installs its own interception hook.
const capturedFetch = typeof globalThis.fetch === 'function'
    ? globalThis.fetch.bind(globalThis)
    : undefined

export const CDN_HEALTH_CACHE_KEY = 'balh_cdn_health_v1'
export const CDN_HEALTH_CACHE_VERSION = 2
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
    /** Eligible hosts omitted because their full two-stage reservation would exceed the round budget. */
    budgetLimitedHosts: readonly string[]
    /** Host-only measurements. No media URL components are exposed. */
    hostDiagnostics: readonly CdnProbeHostDiagnostic[]
    completed: number
    total: number
    updatedAt?: number
}

export interface CdnProbeHostDiagnostic {
    readonly host: string
    readonly classification: 'healthy' | 'failed' | 'unprobeable' | 'budget-limited'
    readonly stagesCompleted: number
    readonly accountedBytes: number
    readonly observedBytes: number
    readonly throughputKbps?: number
    readonly ttfbMs?: number
    readonly bandwidthBps?: number
    readonly bitrateMargin?: number
}

export interface CdnProbeLimits {
    maxConcurrent: number
    maxStages: number
    /** First-stage scored prefix. */
    initialBytesPerRequest: number
    /** Second-stage and absolute per-request scored-prefix cap. */
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
    probeAllowed: boolean
    bandwidthBps?: number
}

interface ProbeOutcome {
    host: string
    kind: 'success' | 'failure' | 'unprobeable'
    /** Bytes admitted to health scoring, capped by the requested prefix. */
    bytes: number
    /** Whole chunks actually delivered to the reader before settlement. */
    observedBytes: number
    /** Conservative budget charge; equals the reservation when cleanup cannot be proven. */
    budgetBytes: number
    /** False stops later batches when bounded successful cleanup was not proven. */
    safeToContinue: boolean
    stage: 1 | 2
    bandwidthBps?: number
    bitrateMargin?: number
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
    publishRecoveryGroups?: (groups: readonly CdnCandidateGroup[], enabled: boolean) => unknown
    optimize?: typeof optimizePlayUrlCdn
    log?: (event: string, status?: CdnProbeStatus) => void
    limits?: Partial<CdnProbeLimits>
}

export interface CdnRuntime {
    applyCdnPolicy<T>(playUrl: T): T
    transformCdnPolicyForFinalDelivery<T>(playUrl: T): T
    beginFinalCdnDelivery(): number
    observeFinalCdnDelivery<T>(playUrl: T, deliveryOrder?: number): T
    probeCurrentPlayUrlCdn(options?: { force?: boolean }): Promise<CdnProbeStatus>
    clearCdnHealthCache(): void
    getCdnProbeStatus(): CdnProbeStatus
    subscribeCdnProbeStatus(listener: (status: CdnProbeStatus) => void): () => void
}

const DEFAULT_LIMITS: CdnProbeLimits = {
    maxConcurrent: 2,
    maxStages: 2,
    initialBytesPerRequest: 64 * 1024,
    maxBytesPerRequest: 512 * 1024,
    maxTotalBytes: 2 * 1024 * 1024,
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
    const maxBytesPerRequest = positiveInteger(overrides?.maxBytesPerRequest, DEFAULT_LIMITS.maxBytesPerRequest)
    return {
        maxConcurrent: Math.min(2, positiveInteger(overrides?.maxConcurrent, DEFAULT_LIMITS.maxConcurrent)),
        maxStages: Math.min(2, positiveInteger(overrides?.maxStages, DEFAULT_LIMITS.maxStages)),
        initialBytesPerRequest: Math.min(
            maxBytesPerRequest,
            positiveInteger(overrides?.initialBytesPerRequest, DEFAULT_LIMITS.initialBytesPerRequest),
        ),
        maxBytesPerRequest,
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

const TRUSTED_BILIBILI_MEDIA_DOMAINS = [
    'bilivideo.com',
    'bilivideo.cn',
    'bilivideo.net',
] as const

const TRUSTED_BILIBILI_MEDIA_HOSTS = new Set([
    'upos-hz-mirrorakam.akamaized.net',
])

function isTrustedBilibiliMediaHostname(hostname: string) {
    const canonical = hostname.toLowerCase().replace(/\.$/, '')
    if (TRUSTED_BILIBILI_MEDIA_HOSTS.has(canonical)) return true
    return TRUSTED_BILIBILI_MEDIA_DOMAINS.some(domain => (
        canonical === domain || canonical.endsWith(`.${domain}`)
    ))
}

function parseRuntimeCandidate(url: unknown): RuntimeCandidate | undefined {
    if (typeof url !== 'string' || !url) return undefined
    try {
        const parsed = new URL(url, 'https://www.bilibili.com/')
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
        const host = normalizeHost(parsed.host)
        if (!host) return undefined
        const probeAllowed = !parsed.username && !parsed.password
            && isTrustedBilibiliMediaHostname(parsed.hostname)
        return { url, host, probeAllowed }
    } catch {
        return undefined
    }
}

function extractCandidates(groups: readonly CdnCandidateGroup[]) {
    const result: RuntimeCandidate[] = []
    const indexesByUrl = new Map<string, number>()
    for (const group of groups) {
        for (const candidate of group.candidates) {
            const existingIndex = indexesByUrl.get(candidate.url)
            if (existingIndex !== undefined) {
                if (group.bandwidthBps !== undefined) {
                    result[existingIndex].bandwidthBps = Math.max(
                        result[existingIndex].bandwidthBps ?? 0,
                        group.bandwidthBps,
                    )
                }
                continue
            }
            const parsed = parseRuntimeCandidate(candidate.url)
            if (!parsed) continue
            indexesByUrl.set(parsed.url, result.length)
            result.push({
                ...parsed,
                ...(group.bandwidthBps === undefined ? {} : { bandwidthBps: group.bandwidthBps }),
            })
        }
    }
    return result
}

function uniqueSorted(values: readonly string[]) {
    return [...new Set(values)].sort()
}

function probeAllowedHosts(candidates: readonly RuntimeCandidate[]) {
    return new Set(candidates.filter(candidate => candidate.probeAllowed).map(candidate => candidate.host))
}

function policyBlockedHosts(candidates: readonly RuntimeCandidate[]) {
    const allowedHosts = probeAllowedHosts(candidates)
    return uniqueSorted(candidates
        .filter(candidate => !candidate.probeAllowed && !allowedHosts.has(candidate.host))
        .map(candidate => candidate.host))
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
        budgetLimitedHosts: [...status.budgetLimitedHosts],
        hostDiagnostics: status.hostDiagnostics.map(diagnostic => ({ ...diagnostic })),
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
    const measuredBytes = finiteMetric(input.measuredBytes)
    if (successes === undefined && failures === undefined && samples === undefined
        && throughputKbps === undefined && ttfbMs === undefined && measuredBytes === undefined) return undefined
    return { host, successes, failures, samples, throughputKbps, ttfbMs, measuredBytes }
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
        getMode: overrides.getMode ?? (() => (
            balh_config.is_closed ? 'original' : balh_config.cdn_mode
        )),
        getManualHost: overrides.getManualHost ?? defaultManualHost,
        getManualReplaceAkamai: overrides.getManualReplaceAkamai ?? (() => balh_config.upos_replace_akamai),
        replaceManual: overrides.replaceManual ?? replaceManualCdnHosts,
        collectGroups: overrides.collectGroups ?? collectPlayUrlCdnGroups,
        publishRecoveryGroups: overrides.publishRecoveryGroups ?? publishCdnRecoveryGroups,
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
    let fencedProbe: Promise<CdnProbeStatus> | undefined
    let backgroundScheduled = false
    let backgroundScheduleId = 0
    let unprobeableGeneration = -1
    let unprobeableUntil = 0
    let suppressedUnprobeableStatus: CdnProbeStatus | undefined
    let finalDeliveryOrder = 0
    let latestAcceptedFinalDeliveryOrder = 0
    let processingFinalDeliveries = false
    const pendingFinalDeliveries: Array<{ playUrl: unknown, deliveryOrder: number }> = []
    const activeControllers = new Set<AbortController>()
    let activeControllerDrain: Promise<void> = Promise.resolve()
    let resolveActiveControllerDrain: (() => void) | undefined
    let pendingAutoProbeDrain: Promise<void> | undefined
    let pendingAutoProbeDrainGeneration = -1
    let pendingAutoProbeDrainHostHash = ''
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
            budgetLimitedHosts: [],
            hostDiagnostics: [],
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
    ): Promise<{ completedWithinBudget: boolean; settled: Promise<boolean> }> {
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
        return { completedWithinBudget: completed, settled: cancellation }
    }

    function readMatchingCache(
        candidateHostHash: string,
        networkHint: string,
        candidates: readonly RuntimeCandidate[] = currentCandidates,
    ) {
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
        const allowedHosts = probeAllowedHosts(candidates)
        for (const [rawHost, rawHealth] of Object.entries(cache.hosts)) {
            const host = normalizeHost(rawHost)
            if (!host || !allowedHosts.has(host)) continue
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
        const allowedHosts = probeAllowedHosts(currentCandidates)
        for (const host of uniqueSorted([...allowedHosts])) {
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
        const measuredHosts = new Set(healthEntries.map(([host]) => host))
        const unprobeableHosts = candidateHosts.filter(host => !measuredHosts.has(host))
        const healthState: CdnProbeState = healthyHosts.length
            ? (failedHosts.length || unprobeableHosts.length ? 'partial' : 'ready')
            : (failedHosts.length && !unprobeableHosts.length ? 'failed' : 'unprobeable')
        const prefix = source === 'cache' ? 'Cached CDN health' : 'CDN health'
        const bandwidthByHost = new Map<string, number>()
        for (const candidate of currentCandidates) {
            if (candidate.bandwidthBps === undefined) continue
            bandwidthByHost.set(candidate.host, Math.max(
                bandwidthByHost.get(candidate.host) ?? 0,
                candidate.bandwidthBps,
            ))
        }
        const hostDiagnostics: CdnProbeHostDiagnostic[] = candidateHosts.map(host => {
            const health = healthByHost[host]
            const bandwidthBps = bandwidthByHost.get(host)
            const throughputKbps = finiteMetric(health?.throughputKbps)
            const ttfbMs = finiteMetric(health?.ttfbMs)
            const classification = healthyHosts.includes(host)
                ? 'healthy'
                : failedHosts.includes(host)
                    ? 'failed'
                    : 'unprobeable'
            return {
                host,
                classification,
                stagesCompleted: Math.floor(finiteMetric(health?.samples) ?? 0),
                accountedBytes: Math.floor(finiteMetric(health?.measuredBytes) ?? 0),
                observedBytes: Math.floor(finiteMetric(health?.measuredBytes) ?? 0),
                ...(throughputKbps === undefined ? {} : { throughputKbps }),
                ...(ttfbMs === undefined ? {} : { ttfbMs }),
                ...(bandwidthBps === undefined ? {} : { bandwidthBps }),
                ...(throughputKbps === undefined || bandwidthBps === undefined
                    ? {}
                    : { bitrateMargin: throughputKbps / (bandwidthBps / 1000) }),
            }
        })
        const cachedAttempts = healthEntries.reduce((sum, [, health]) => (
            sum + Math.floor(finiteMetric(health.samples) ?? 0)
        ), 0)
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
            unprobeableHosts,
            budgetLimitedHosts: [],
            hostDiagnostics,
            completed: cachedAttempts,
            total: cachedAttempts,
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
    }

    function trackActiveController(controller: AbortController) {
        if (activeControllers.size === 0) {
            activeControllerDrain = new Promise<void>(resolve => {
                resolveActiveControllerDrain = resolve
            })
        }
        activeControllers.add(controller)
    }

    function releaseActiveController(controller: AbortController) {
        if (!activeControllers.delete(controller) || activeControllers.size > 0) return
        const resolve = resolveActiveControllerDrain
        resolveActiveControllerDrain = undefined
        resolve?.()
    }

    function updateCurrentCandidates(next: RuntimeCandidate[]) {
        const canonical = (candidates: RuntimeCandidate[]) => candidates
            .map(candidate => `${candidate.host}\0${candidate.url}\0${candidate.bandwidthBps ?? ''}`)
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
        clearUnprobeableSuppression()
        currentCandidates = next
        currentHostHash = hashCandidateHosts(next.map(candidate => candidate.host))
        ensureHealthForCurrentHosts()
        const allowedHosts = probeAllowedHosts(next)
        for (const host of uniqueSorted(next.map(candidate => candidate.host))) {
            if (!allowedHosts.has(host)) delete healthByHost[host]
        }
        const hasValidHealth = healthHostHash === currentHostHash
            && dependencies.now() < healthValidUntil
            && Object.keys(healthByHost).length > 0
        if (hasValidHealth) publishHealthSnapshot(status.source === 'cache' ? 'cache' : 'network')
        else publish(emptyStatus())
    }

    function collectCurrent(playUrl: unknown) {
        let groups: readonly CdnCandidateGroup[] = []
        try {
            groups = dependencies.collectGroups(playUrl)
        } catch {
            dependencies.log('cdn-candidate-collection-failed')
        }
        return groups
    }

    function commitCurrent(groups: readonly CdnCandidateGroup[]) {
        updateCurrentCandidates(extractCandidates(groups))
        ensureHealthForCurrentHosts()
        return groups
    }

    function captureCurrent(playUrl: unknown) {
        return commitCurrent(collectCurrent(playUrl))
    }

    function prospectiveHealth(groups: readonly CdnCandidateGroup[]) {
        const candidates = extractCandidates(groups)
        const candidateHostHash = hashCandidateHosts(candidates.map(candidate => candidate.host))
        const networkHint = currentNetworkHint()
        if (healthHostHash === candidateHostHash
            && healthNetworkHint === networkHint
            && dependencies.now() < healthValidUntil) return healthByHost
        return readMatchingCache(candidateHostHash, networkHint, candidates)?.hosts
            ?? Object.create(null) as Record<string, HostHealth>
    }

    function publishRecoveryGroups(groups: readonly CdnCandidateGroup[], enabled: boolean) {
        try {
            dependencies.publishRecoveryGroups(groups, enabled)
        } catch {
            dependencies.log('cdn-recovery-publication-failed')
        }
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

    function scheduleAutoProbeAfterActiveDrain() {
        const drain = activeControllerDrain
        const runGeneration = generation
        const runHostHash = currentHostHash
        if (pendingAutoProbeDrain === drain) {
            pendingAutoProbeDrainGeneration = runGeneration
            pendingAutoProbeDrainHostHash = runHostHash
            return
        }
        pendingAutoProbeDrain = drain
        pendingAutoProbeDrainGeneration = runGeneration
        pendingAutoProbeDrainHostHash = runHostHash
        void drain.then(() => {
            if (pendingAutoProbeDrain !== drain) return
            const latestGeneration = pendingAutoProbeDrainGeneration
            const latestHostHash = pendingAutoProbeDrainHostHash
            pendingAutoProbeDrain = undefined
            pendingAutoProbeDrainGeneration = -1
            pendingAutoProbeDrainHostHash = ''
            if (latestGeneration !== generation || latestHostHash !== currentHostHash
                || normalizeMode(dependencies.getMode()) !== 'auto') return
            scheduleAutoProbe()
        })
    }

    function applyCdnPolicy<T>(playUrl: T): T {
        const mode = normalizeMode(dependencies.getMode())
        if (!playUrl || typeof playUrl !== 'object') {
            publishRecoveryGroups([], mode === 'auto')
            return playUrl
        }
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
            publishRecoveryGroups(captureCurrent(playUrl), false)
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
            const finalGroups = captureCurrent(playUrl)
            publishRecoveryGroups(finalGroups, mode === 'auto')
            if (mode === 'auto') scheduleAutoProbe()
            return playUrl
        }
        publishRecoveryGroups(captureCurrent(playUrl), false)
        return playUrl
    }

    /**
     * Apply the payload mutation part of CDN policy inside a final-delivery
     * transaction. The token-aware observer is the sole committer of registry,
     * probe, status, and recovery state after downstream transforms finish.
     */
    function transformCdnPolicyForFinalDelivery<T>(playUrl: T): T {
        const mode = normalizeMode(dependencies.getMode())
        if (!playUrl || typeof playUrl !== 'object') return playUrl
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
            return playUrl
        }
        if (mode === 'safe' || mode === 'auto') {
            const initialGroups = collectCurrent(playUrl)
            try {
                dependencies.optimize(playUrl, {
                    mode,
                    hostHealth: prospectiveHealth(initialGroups),
                })
            } catch {
                dependencies.log('cdn-selection-failed')
            }
        }
        return playUrl
    }

    /**
     * Re-publish a playurl payload after every downstream response transformer
     * has run. This observes exact delivered groups without applying policy a
     * second time or changing the payload returned by the predecessor chain.
     */
    function beginFinalCdnDelivery() {
        finalDeliveryOrder += 1
        return finalDeliveryOrder
    }

    function hasSupersedingFinalDelivery(deliveryOrder: number) {
        return pendingFinalDeliveries.some(pending => pending.deliveryOrder > deliveryOrder)
    }

    function commitFinalCdnDelivery(playUrl: unknown, deliveryOrder: number) {
        if (deliveryOrder < latestAcceptedFinalDeliveryOrder) return

        // Reserve the order before any injected collector, status listener,
        // logger, recovery publisher, or scheduler can synchronously re-enter.
        latestAcceptedFinalDeliveryOrder = deliveryOrder
        const finalGroups = collectCurrent(playUrl)
        if (hasSupersedingFinalDelivery(deliveryOrder)) return

        commitCurrent(finalGroups)
        if (hasSupersedingFinalDelivery(deliveryOrder)) return

        const mode = normalizeMode(dependencies.getMode())
        if (hasSupersedingFinalDelivery(deliveryOrder)) return
        publishRecoveryGroups(finalGroups, mode === 'auto')
        if (hasSupersedingFinalDelivery(deliveryOrder)) return
        if (mode === 'auto') scheduleAutoProbe()
    }

    function observeFinalCdnDelivery<T>(playUrl: T, deliveryOrder?: number): T {
        if (!playUrl || typeof playUrl !== 'object') return playUrl
        const acceptedOrder = Number.isSafeInteger(deliveryOrder) && deliveryOrder! > 0
            ? deliveryOrder!
            : beginFinalCdnDelivery()
        finalDeliveryOrder = Math.max(finalDeliveryOrder, acceptedOrder)

        // A stale predecessor may already have applied selection to its private
        // response object. It must not publish that response, nor re-publish the
        // latest registry: either action would reset active recovery state.
        if (acceptedOrder < latestAcceptedFinalDeliveryOrder) return playUrl

        pendingFinalDeliveries.push({ playUrl, deliveryOrder: acceptedOrder })
        if (processingFinalDeliveries) return playUrl

        processingFinalDeliveries = true
        try {
            while (pendingFinalDeliveries.length > 0) {
                const pending = pendingFinalDeliveries.shift()!
                try {
                    commitFinalCdnDelivery(pending.playUrl, pending.deliveryOrder)
                } catch {
                    try {
                        dependencies.log('cdn-final-delivery-publication-failed')
                    } catch {
                        // Final observation must remain transparent on logger failure.
                    }
                }
            }
        } finally {
            processingFinalDeliveries = false
        }
        return playUrl
    }

    function selectProbeTargets() {
        const indexesByHost = new Map<string, number>()
        const targets: RuntimeCandidate[] = []
        for (const candidate of currentCandidates) {
            if (!candidate.probeAllowed) continue
            const existingIndex = indexesByHost.get(candidate.host)
            if (existingIndex === undefined) {
                indexesByHost.set(candidate.host, targets.length)
                targets.push({ ...candidate })
                continue
            }
            if (candidate.bandwidthBps !== undefined) {
                targets[existingIndex].bandwidthBps = Math.max(
                    targets[existingIndex].bandwidthBps ?? 0,
                    candidate.bandwidthBps,
                )
            }
        }
        return targets
    }

    async function probeCandidate(
        candidate: RuntimeCandidate,
        byteCap: number,
        timeoutMs: number,
        stage: 1 | 2,
    ): Promise<ProbeOutcome> {
        const fetchImpl = dependencies.fetch
        if (!candidate.probeAllowed || !fetchImpl || byteCap <= 0) {
            return {
                host: candidate.host,
                kind: 'unprobeable',
                bytes: 0,
                observedBytes: 0,
                budgetBytes: 0,
                safeToContinue: true,
                stage,
                ...(candidate.bandwidthBps === undefined ? {} : { bandwidthBps: candidate.bandwidthBps }),
            }
        }
        const controller = dependencies.createAbortController()
        trackActiveController(controller)
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
        let readerCleanup: Promise<boolean> | undefined
        let bodyCleanup: Promise<boolean> | undefined
        let readerLockReleased = false
        let cleanupProven = true
        let lateCleanupSettled = false
        let requestSettled = false

        const observeCleanup = (
            cleanup: { completedWithinBudget: boolean; settled: Promise<boolean> },
        ) => {
            cleanupProven &&= cleanup.completedWithinBudget
            if (!cleanup.completedWithinBudget) {
                void cleanup.settled.then(() => {
                    lateCleanupSettled = true
                    if (requestSettled) releaseActiveController(controller)
                })
            }
            return cleanup.completedWithinBudget
        }

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
            if (!reader) return Promise.resolve(true)
            if (!readerCleanup) {
                readerCleanup = (async () => {
                    let completed = true
                    try {
                        if (!streamDone) {
                            completed = observeCleanup(
                                await cancelWithBudget(() => reader!.cancel(), controller, timeoutMs),
                            )
                        }
                    } finally {
                        releaseReaderLock()
                    }
                    return completed
                })()
            }
            return readerCleanup
        }
        const cleanupAvailableResource = () => {
            if (reader) return cleanupReader()
            if (!responseBody) return Promise.resolve(true)
            if (!bodyCleanup) {
                bodyCleanup = cancelWithBudget(() => responseBody!.cancel(), controller, timeoutMs)
                    .then(observeCleanup)
            }
            return bodyCleanup
        }
        const snapshot = (kind: ProbeOutcome['kind']): ProbeOutcome => ({
            host: candidate.host,
            kind,
            bytes: accountedBytes,
            observedBytes,
            budgetBytes: Math.max(accountedBytes, observedBytes),
            safeToContinue: true,
            stage,
            ...(candidate.bandwidthBps === undefined ? {} : { bandwidthBps: candidate.bandwidthBps }),
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
                    redirect: 'error',
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
                const throughputKbps = accountedBytes > 0 ? accountedBytes * 8 / elapsedMs : undefined
                return {
                    ...snapshot('success'),
                    ttfbMs: Math.max(0, (firstByteAt ?? endedAt) - startedAt),
                    throughputKbps,
                    ...(throughputKbps === undefined || candidate.bandwidthBps === undefined
                        ? {}
                        : { bitrateMargin: throughputKbps / (candidate.bandwidthBps / 1000) }),
                }
            } finally {
                if (reader) {
                    await cleanupReader()
                    // Retry after a canceled pending read has had a chance to settle.
                    releaseReaderLock()
                }
            }
        })().finally(() => {
            requestSettled = true
            if (cleanupProven || lateCleanupSettled) releaseActiveController(controller)
        })
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
                // Let a standards-compliant canceled read settle before deciding whether another batch is safe.
                await Promise.resolve()
                await Promise.resolve()
            }
            controller.signal.removeEventListener('abort', onAbort)
        }
        const finalOutcome = timedOut ? snapshot('failure') : outcome
        const safeToContinue = requestSettled && cleanupProven
        return {
            ...finalOutcome,
            budgetBytes: safeToContinue
                ? Math.max(finalOutcome.bytes, finalOutcome.observedBytes)
                : Math.max(byteCap, finalOutcome.observedBytes),
            safeToContinue,
        }
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
        const previousMeasuredBytes = previous.measuredBytes ?? 0
        const sampleBytes = outcome.bytes
        const measuredBytes = previousMeasuredBytes + sampleBytes
        healthByHost[outcome.host] = {
            ...previous,
            successes: nextSuccesses,
            failures: previousFailures,
            samples: previousSamples + 1,
            throughputKbps: outcome.throughputKbps === undefined
                ? previous.throughputKbps
                : previous.throughputKbps === undefined || previousMeasuredBytes === 0
                    ? outcome.throughputKbps
                    : (previous.throughputKbps * previousMeasuredBytes + outcome.throughputKbps * sampleBytes)
                        / Math.max(1, measuredBytes),
            ttfbMs: outcome.ttfbMs === undefined
                ? previous.ttfbMs
                : ((previous.ttfbMs ?? outcome.ttfbMs) * previousSuccesses + outcome.ttfbMs) / nextSuccesses,
            measuredBytes,
        }
    }

    function statusFromOutcomes(
        outcomes: readonly ProbeOutcome[],
        total: number,
        budgetLimitedHosts: readonly string[],
        incomplete = false,
    ): CdnProbeStatus {
        const byHost = new Map<string, ProbeOutcome[]>()
        for (const outcome of outcomes) {
            const hostOutcomes = byHost.get(outcome.host) ?? []
            hostOutcomes.push(outcome)
            byHost.set(outcome.host, hostOutcomes)
        }
        const healthyHosts: string[] = []
        const failedHosts: string[] = []
        const unprobeableHosts = policyBlockedHosts(currentCandidates)
        for (const [host, hostOutcomes] of byHost) {
            if (hostOutcomes.some(outcome => outcome.kind === 'success')) healthyHosts.push(host)
            else if (hostOutcomes.some(outcome => outcome.kind === 'failure')) failedHosts.push(host)
            else unprobeableHosts.push(host)
        }
        healthyHosts.sort()
        failedHosts.sort()
        const sortedUnprobeableHosts = uniqueSorted(unprobeableHosts)
        const sortedBudgetLimitedHosts = uniqueSorted(budgetLimitedHosts)
        const hostDiagnostics: CdnProbeHostDiagnostic[] = []
        for (const [host, hostOutcomes] of byHost) {
            const successful = hostOutcomes.filter(outcome => outcome.kind === 'success')
            const representative = successful[successful.length - 1] ?? hostOutcomes[hostOutcomes.length - 1]
            const classification = successful.length
                ? 'healthy'
                : hostOutcomes.some(outcome => outcome.kind === 'failure')
                    ? 'failed'
                    : 'unprobeable'
            hostDiagnostics.push({
                host,
                classification,
                stagesCompleted: hostOutcomes.length,
                accountedBytes: hostOutcomes.reduce((sum, outcome) => sum + outcome.bytes, 0),
                observedBytes: hostOutcomes.reduce((sum, outcome) => sum + outcome.observedBytes, 0),
                ...(representative.throughputKbps === undefined ? {} : { throughputKbps: representative.throughputKbps }),
                ...(representative.ttfbMs === undefined ? {} : { ttfbMs: representative.ttfbMs }),
                ...(representative.bandwidthBps === undefined ? {} : { bandwidthBps: representative.bandwidthBps }),
                ...(representative.bitrateMargin === undefined ? {} : { bitrateMargin: representative.bitrateMargin }),
            })
        }
        for (const host of policyBlockedHosts(currentCandidates)) {
            if (byHost.has(host)) continue
            hostDiagnostics.push({
                host,
                classification: 'unprobeable',
                stagesCompleted: 0,
                accountedBytes: 0,
                observedBytes: 0,
            })
        }
        for (const host of sortedBudgetLimitedHosts) {
            hostDiagnostics.push({
                host,
                classification: 'budget-limited',
                stagesCompleted: 0,
                accountedBytes: 0,
                observedBytes: 0,
            })
        }
        hostDiagnostics.sort((left, right) => left.host.localeCompare(right.host))
        let state: CdnProbeState
        let message: string
        const complete = outcomes.length === total && !incomplete
        if (healthyHosts.length && complete && !failedHosts.length
            && !sortedUnprobeableHosts.length && !sortedBudgetLimitedHosts.length) {
            state = 'ready'
            message = 'CDN health probe completed.'
        } else if (!complete || sortedBudgetLimitedHosts.length
            || [healthyHosts.length, failedHosts.length, sortedUnprobeableHosts.length].filter(Boolean).length > 1) {
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
            unprobeableHosts: sortedUnprobeableHosts,
            budgetLimitedHosts: sortedBudgetLimitedHosts,
            hostDiagnostics,
            completed: outcomes.length,
            total,
            updatedAt: dependencies.now(),
        }
    }

    function compareProbeRank(left: ProbeOutcome, right: ProbeOutcome) {
        const leftThroughputKnown = left.throughputKbps !== undefined
        const rightThroughputKnown = right.throughputKbps !== undefined
        if (leftThroughputKnown !== rightThroughputKnown) return leftThroughputKnown ? -1 : 1
        if (left.throughputKbps !== right.throughputKbps) {
            return (right.throughputKbps ?? 0) - (left.throughputKbps ?? 0)
        }

        const leftMarginKnown = left.bitrateMargin !== undefined
        const rightMarginKnown = right.bitrateMargin !== undefined
        if (leftMarginKnown !== rightMarginKnown) return leftMarginKnown ? -1 : 1
        if (left.bitrateMargin !== right.bitrateMargin) {
            return (right.bitrateMargin ?? 0) - (left.bitrateMargin ?? 0)
        }

        const leftTtfbKnown = left.ttfbMs !== undefined
        const rightTtfbKnown = right.ttfbMs !== undefined
        if (leftTtfbKnown !== rightTtfbKnown) return leftTtfbKnown ? -1 : 1
        return (left.ttfbMs ?? Number.MAX_SAFE_INTEGER) - (right.ttfbMs ?? Number.MAX_SAFE_INTEGER)
    }

    async function runProbe(runGeneration: number) {
        const runNetworkHint = currentNetworkHint()
        const allTargets = selectProbeTargets()
        if (!allTargets.length) {
            const candidateHosts = uniqueSorted(currentCandidates.map(candidate => candidate.host))
            const next: CdnProbeStatus = candidateHosts.length
                ? {
                    state: 'unprobeable',
                    message: 'No current CDN candidates are eligible for active probing.',
                    candidateHosts,
                    probedHosts: [],
                    healthyHosts: [],
                    failedHosts: [],
                    unprobeableHosts: candidateHosts,
                    budgetLimitedHosts: [],
                    hostDiagnostics: candidateHosts.map(host => ({
                        host,
                        classification: 'unprobeable',
                        stagesCompleted: 0,
                        accountedBytes: 0,
                        observedBytes: 0,
                    })),
                    completed: 0,
                    total: 0,
                    updatedAt: dependencies.now(),
                }
                : emptyStatus('No CDN candidates are available for probing.')
            publish(next)
            if (next.state === 'unprobeable') rememberUnprobeable(next, runGeneration)
            return cloneStatus(next)
        }
        const budgetLimitedHosts = new Set<string>()
        const candidateHosts = uniqueSorted(currentCandidates.map(candidate => candidate.host))
        publish({
            state: 'probing',
            message: 'Testing current CDN hosts.',
            source: 'network',
            candidateHosts,
            probedHosts: [],
            healthyHosts: [],
            failedHosts: [],
            unprobeableHosts: policyBlockedHosts(currentCandidates),
            budgetLimitedHosts: [],
            hostDiagnostics: policyBlockedHosts(currentCandidates).map(host => ({
                host,
                classification: 'unprobeable' as const,
                stagesCompleted: 0,
                accountedBytes: 0,
                observedBytes: 0,
            })),
            completed: 0,
            total: allTargets.length,
            updatedAt: dependencies.now(),
        })
        const outcomes: ProbeOutcome[] = []
        const totalStartedAt = dependencies.now()
        let accountedRemaining = limits.maxTotalBytes
        let observedRemaining = limits.maxTotalBytes
        let totalAttempts = allTargets.length
        let contextValid = true
        let cleanupSafe = true

        const probeStage = async (
            targets: readonly RuntimeCandidate[],
            requestedCap: number,
            stage: 1 | 2,
        ) => {
            const stageOutcomes: ProbeOutcome[] = []
            const stageStartedAt = dependencies.now()
            let offset = 0
            while (offset < targets.length) {
                if (currentNetworkHint() !== runNetworkHint || runGeneration !== generation) {
                    contextValid = false
                    break
                }
                const totalRemainingMs = limits.totalTimeoutMs
                    - Math.max(0, dependencies.now() - totalStartedAt)
                const stageRemainingMs = limits.stageTimeoutMs
                    - Math.max(0, dependencies.now() - stageStartedAt)
                if (totalRemainingMs <= 0 || stageRemainingMs <= 0 || !cleanupSafe) break
                const batch = targets.slice(offset, offset + limits.maxConcurrent)
                const availableBytes = Math.min(accountedRemaining, Math.max(0, observedRemaining))
                let caps: number[]
                if (stage === 1) {
                    const runnableCount = Math.min(batch.length, Math.floor(availableBytes / requestedCap))
                    if (runnableCount === 0) {
                        targets.slice(offset).forEach(target => budgetLimitedHosts.add(target.host))
                        break
                    }
                    caps = Array.from({ length: runnableCount }, () => requestedCap)
                } else {
                    const batchBudget = Math.min(availableBytes, requestedCap * batch.length)
                    const baseCap = Math.floor(batchBudget / batch.length)
                    const extraBytes = batchBudget % batch.length
                    caps = batch.map((_, index) => Math.min(
                        requestedCap,
                        baseCap + (index < extraBytes ? 1 : 0),
                    ))
                }
                const runnable = batch
                    .slice(0, caps.length)
                    .map((candidate, index) => ({ candidate, cap: caps[index] }))
                    .filter(entry => entry.cap > 0)
                if (!runnable.length) break
                const reservedBytes = runnable.reduce((sum, entry) => sum + entry.cap, 0)
                accountedRemaining -= reservedBytes
                const timeoutMs = Math.max(1, Math.min(
                    limits.requestTimeoutMs,
                    stageRemainingMs,
                    totalRemainingMs,
                ))
                const batchOutcomes = await Promise.all(runnable.map(entry => (
                    probeCandidate(entry.candidate, entry.cap, timeoutMs, stage)
                )))
                if (currentNetworkHint() !== runNetworkHint || runGeneration !== generation) {
                    contextValid = false
                    break
                }
                let accountedCharge = 0
                let observedCharge = 0
                for (let index = 0; index < batchOutcomes.length; index += 1) {
                    const outcome = batchOutcomes[index]
                    accountedCharge += outcome.safeToContinue ? outcome.bytes : runnable[index].cap
                    observedCharge += outcome.budgetBytes
                    cleanupSafe &&= outcome.safeToContinue
                    outcomes.push(outcome)
                    stageOutcomes.push(outcome)
                    updateHealth(outcome)
                }
                accountedRemaining += Math.max(0, reservedBytes - accountedCharge)
                observedRemaining -= observedCharge
                offset += runnable.length
                publish({
                    ...statusFromOutcomes(outcomes, totalAttempts, [...budgetLimitedHosts], !cleanupSafe),
                    state: 'probing',
                    message: 'Testing current CDN hosts.',
                })
            }
            return stageOutcomes
        }

        const initialOutcomes = await probeStage(allTargets, limits.initialBytesPerRequest, 1)
        const targetOrder = new Map(allTargets.map((target, index) => [target.host, index]))
        const initialStageComplete = contextValid && cleanupSafe
            && initialOutcomes.length === allTargets.length
        const followupTargets = limits.maxStages < 2 || !initialStageComplete
            ? []
            : initialOutcomes
                .map(outcome => ({ outcome, index: targetOrder.get(outcome.host) ?? Number.MAX_SAFE_INTEGER }))
                .filter(entry => entry.outcome.kind === 'success')
                .sort((left, right) => (
                    compareProbeRank(left.outcome, right.outcome) || left.index - right.index
                ))
                .slice(0, 2)
                .map(entry => allTargets[entry.index])
        totalAttempts += followupTargets.length
        if (followupTargets.length) {
            await probeStage(followupTargets, limits.maxBytesPerRequest, 2)
        }
        if (!contextValid || runGeneration !== generation) {
            ensureHealthForCurrentHosts()
            return cloneStatus(status)
        }
        const cacheableRound = cleanupSafe
            && budgetLimitedHosts.size === 0
            && policyBlockedHosts(currentCandidates).length === 0
            && initialOutcomes.length === allTargets.length
            && outcomes.length === totalAttempts
            && !outcomes.some(outcome => outcome.kind === 'unprobeable')
        healthNetworkHint = runNetworkHint
        if (cacheableRound) {
            healthHostHash = currentHostHash
            healthValidUntil = dependencies.now() + CDN_HEALTH_CACHE_TTL_MS
            writeCache()
        } else {
            healthHostHash = ''
            healthValidUntil = 0
            try {
                dependencies.storage?.removeItem(CDN_HEALTH_CACHE_KEY)
            } catch {
                dependencies.log('cdn-health-cache-discard-failed')
            }
        }
        const next = statusFromOutcomes(outcomes, totalAttempts, [...budgetLimitedHosts], !cleanupSafe)
        publish(next)
        if (next.state === 'unprobeable') rememberUnprobeable(next, runGeneration)
        else clearUnprobeableSuppression()
        return cloneStatus(next)
    }

    function startProbe(runGeneration: number) {
        const promise = runProbe(runGeneration).finally(() => {
            if (inFlight === promise) inFlight = undefined
            if (runGeneration !== generation && normalizeMode(dependencies.getMode()) === 'auto') {
                if (activeControllers.size > 0) scheduleAutoProbeAfterActiveDrain()
                else scheduleAutoProbe()
            }
        })
        inFlight = promise
        return promise
    }

    async function runForcedProbeAfterFence() {
        while (true) {
            if (activeControllers.size > 0) await activeControllerDrain
            ensureHealthForCurrentHosts()
            if (activeControllers.size > 0) continue
            const runGeneration = generation
            const result = await (inFlight ?? startProbe(runGeneration))
            const terminal = result.state !== 'probing'
                && (result.state !== 'idle' || result.candidateHosts.length === 0)
            if (runGeneration === generation && terminal) return cloneStatus(result)
        }
    }

    function probeCurrentPlayUrlCdn(options: { force?: boolean } = {}) {
        ensureHealthForCurrentHosts()
        if (options.force && fencedProbe) return fencedProbe
        if (inFlight) return inFlight
        if (activeControllers.size > 0) {
            if (!options.force) {
                if (normalizeMode(dependencies.getMode()) === 'auto') {
                    scheduleAutoProbeAfterActiveDrain()
                }
                return Promise.resolve(cloneStatus(status))
            }
            if (fencedProbe) return fencedProbe
            const promise = runForcedProbeAfterFence().finally(() => {
                if (fencedProbe === promise) fencedProbe = undefined
            })
            fencedProbe = promise
            return promise
        }
        if (!options.force && unprobeableGeneration === generation
            && dependencies.now() < unprobeableUntil && suppressedUnprobeableStatus) {
            return Promise.resolve(cloneStatus(suppressedUnprobeableStatus))
        }
        if (!options.force && healthHostHash === currentHostHash
            && dependencies.now() < healthValidUntil && Object.keys(healthByHost).length) {
            return Promise.resolve(cloneStatus(status))
        }
        return startProbe(generation)
    }

    function clearCdnHealthCache() {
        generation += 1
        abortActiveProbes()
        inFlight = undefined
        backgroundScheduled = false
        backgroundScheduleId += 1
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
        transformCdnPolicyForFinalDelivery,
        beginFinalCdnDelivery,
        observeFinalCdnDelivery,
        probeCurrentPlayUrlCdn,
        clearCdnHealthCache,
        getCdnProbeStatus,
        subscribeCdnProbeStatus,
    }
}

const defaultRuntime = createCdnRuntime()

export const applyCdnPolicy = defaultRuntime.applyCdnPolicy
export const transformCdnPolicyForFinalDelivery = defaultRuntime.transformCdnPolicyForFinalDelivery
export const beginFinalCdnDelivery = defaultRuntime.beginFinalCdnDelivery
export const observeFinalCdnDelivery = defaultRuntime.observeFinalCdnDelivery
export const probeCurrentPlayUrlCdn = defaultRuntime.probeCurrentPlayUrlCdn
export const clearCdnHealthCache = defaultRuntime.clearCdnHealthCache
export const getCdnProbeStatus = defaultRuntime.getCdnProbeStatus
export const subscribeCdnProbeStatus = defaultRuntime.subscribeCdnProbeStatus
