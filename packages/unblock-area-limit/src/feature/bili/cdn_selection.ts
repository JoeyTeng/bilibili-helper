export type CdnMode = 'original' | 'safe' | 'auto' | 'manual'

export type CdnRiskKind =
    | 'mcdn-host'
    | 'mcdn-query'
    | 'ip-literal'
    | 'non-default-port'
    | 'pcdn-domain'
    | 'mirror14b'
    | 'host-label-302'

export interface HostHealth {
    host?: string
    successes?: number
    failures?: number
    samples?: number
    throughputKbps?: number
    ttfbMs?: number
}

export type HostHealthCollection =
    | Readonly<Record<string, HostHealth>>
    | ReadonlyMap<string, HostHealth>
    | readonly HostHealth[]

export interface OptimizePlayUrlCdnOptions {
    mode: CdnMode
    hostHealth?: HostHealthCollection
    minHealthSamples?: number
}

export interface CdnCandidate {
    /** The exact response URL. It is never normalized or rebuilt. */
    readonly url: string
    /** Parsed URL host, including a non-default port when present. */
    readonly host: string
    readonly hostname: string
    readonly riskKinds: readonly CdnRiskKind[]
}

export type CdnCandidateGroupKind =
    | 'dash-video'
    | 'dash-audio'
    | 'dash-dolby-audio'
    | 'dash-flac-audio'
    | 'durl'

export interface CdnCandidateGroup {
    /** A structural key. It never contains a media URL or query string. */
    readonly key: string
    readonly kind: CdnCandidateGroupKind
    /** Ordered, exact response URLs for this stream or durl segment only. */
    readonly candidates: readonly CdnCandidate[]
}

export type CdnSelectionReason =
    | 'mode-bypass'
    | 'unchanged'
    | 'risk-demotion'
    | 'health-promotion'
    | 'skipped-capacity'

export interface CdnHostDiagnostic {
    readonly host: string
    readonly riskKinds: readonly CdnRiskKind[]
}

export interface CdnSelectionDiagnostic {
    readonly group: string
    readonly kind: CdnCandidateGroupKind
    readonly changed: boolean
    readonly reason: CdnSelectionReason
    readonly originalHost: string | null
    readonly selectedHost: string | null
    readonly candidates: readonly CdnHostDiagnostic[]
}

export interface OptimizePlayUrlCdnResult {
    readonly changed: boolean
    readonly groups: number
    /** Host-only diagnostics: no path, query, fragment, credentials, or full URL. */
    readonly diagnostics: readonly CdnSelectionDiagnostic[]
}

export const KNOWN_PCDN_DOMAINS: readonly string[] = Object.freeze([
    'bsccdn.net',
    'gjfzpt.cn',
    'jomodns.cn',
    'kuiniuca.com',
    'mountaintoys.cn',
    'nexusedgeio.com',
    'onethingpcs.com',
    'pcdn.biliapi.net',
    'pcdn.xmcdn.com',
    'pkoplink.com',
    'saxysec.com',
    'szbdyd.com',
    'uhabo.com',
    'xycdn.com',
    'ahdohpiechei.com',
])

const DEFAULT_MIN_HEALTH_SAMPLES = 2
const DASH_BASE_KEYS = ['base_url', 'baseUrl'] as const
const BACKUP_KEYS = ['backup_url', 'backupUrl'] as const

type LooseRecord = Record<string, unknown>

interface MutableCandidateGroup {
    group: CdnCandidateGroup
    apply(urls: readonly string[]): boolean
}

interface MutableUrlSlot {
    read(): string
    write(url: string): boolean
}

interface NormalizedHealth {
    samples: number
    successes: number | null
    failures: number | null
    successRate: number | null
    throughputKbps: number | null
    ttfbMs: number | null
}

export function isCdnMode(value: unknown): value is CdnMode {
    return value === 'original' || value === 'safe' || value === 'auto' || value === 'manual'
}

export function isCompleteCdnUrl(value: unknown): value is string {
    return parseCompleteUrl(value) !== null
}

export function classifyCdnUrl(url: string): CdnCandidate | null {
    const parsed = parseCompleteUrl(url)
    if (!parsed) return null

    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '')
    const firstLabel = hostname.split('.')[0] || ''
    const riskKinds: CdnRiskKind[] = []

    if (isDomainOrSubdomain(hostname, 'mcdn.bilivideo.cn')
        || isDomainOrSubdomain(hostname, 'mcdn.bilivideo.com')
        || isDomainOrSubdomain(hostname, 'mcdn.bilivideo.net')) {
        riskKinds.push('mcdn-host')
    }
    if (parsed.searchParams.getAll('os').some(value => value.toLowerCase() === 'mcdn')) {
        riskKinds.push('mcdn-query')
    }
    if (isIpLiteral(hostname)) {
        riskKinds.push('ip-literal')
    }
    if (parsed.port) {
        riskKinds.push('non-default-port')
    }
    if (isKnownPcdnHostname(hostname)) {
        riskKinds.push('pcdn-domain')
    }
    if (hostname.split('.').some(label => hasHyphenToken(label, 'mirror14b'))) {
        riskKinds.push('mirror14b')
    }
    if (has302HostToken(firstLabel)) {
        riskKinds.push('host-label-302')
    }

    return {
        url,
        host: parsed.host.toLowerCase(),
        hostname,
        riskKinds,
    }
}

export function getCdnRiskKinds(url: string): readonly CdnRiskKind[] {
    return classifyCdnUrl(url)?.riskKinds ?? []
}

/** Collect exact candidates without changing the supplied playurl object. */
export function collectPlayUrlCdnGroups(playUrl: unknown): CdnCandidateGroup[] {
    return collectMutableGroups(playUrl).map(binding => binding.group)
}

/**
 * Compare health records for candidate selection. A negative result means `left`
 * is preferred. Insufficient evidence is deliberately treated as a tie.
 */
export function compareHostHealth(
    left: HostHealth | undefined,
    right: HostHealth | undefined,
    minSamples = DEFAULT_MIN_HEALTH_SAMPLES,
): number {
    const minimum = normalizeMinSamples(minSamples)
    const leftHealth = normalizeHealth(left ?? {})
    const rightHealth = normalizeHealth(right ?? {})

    const leftSortable = hasSortableSuccessEvidence(leftHealth, minimum)
    const rightSortable = hasSortableSuccessEvidence(rightHealth, minimum)
    if (leftSortable !== rightSortable) return leftSortable ? -1 : 1
    // Failed, unprobeable, unknown, and weak records retain original order.
    if (!leftSortable) return 0

    return compareOptionalMetric(leftHealth.throughputKbps, rightHealth.throughputKbps, 'descending')
        || compareOptionalMetric(leftHealth.ttfbMs, rightHealth.ttfbMs, 'ascending')
        || compareOptionalMetric(leftHealth.successRate, rightHealth.successRate, 'descending')
}

/** Return a reordered copy; candidates and their exact URL strings are reused. */
export function selectCdnCandidates(
    candidates: readonly CdnCandidate[],
    options: OptimizePlayUrlCdnOptions,
): CdnCandidate[] {
    const ordered = candidates.slice()
    if (options.mode === 'original' || options.mode === 'manual' || ordered.length < 2) {
        return ordered
    }

    const safe = ordered.filter(candidate => candidate.riskKinds.length === 0)
    const risky = ordered.filter(candidate => candidate.riskKinds.length > 0)
    // Safe and auto both leave an all-risk response exactly as received.
    if (safe.length === 0) return ordered
    if (safe.length > 0 && risky.length > 0) {
        ordered.splice(0, ordered.length, ...safe, ...risky)
    }

    if (options.mode !== 'auto' || !options.hostHealth) return ordered

    const health = createHealthLookup(options.hostHealth)
    const minSamples = normalizeMinSamples(options.minHealthSamples)
    stableSortByHealth(ordered, 0, safe.length, health, minSamples)
    return ordered
}

/** Mutate an already-unwrapped playurl in place and return host-only diagnostics. */
export function optimizePlayUrlCdn(
    playUrl: unknown,
    options: OptimizePlayUrlCdnOptions,
): OptimizePlayUrlCdnResult {
    const bindings = collectMutableGroups(playUrl)
    const diagnostics: CdnSelectionDiagnostic[] = []
    let changed = false

    for (const binding of bindings) {
        const original = binding.group.candidates
        const selected = selectCdnCandidates(original, options)
        const bypassed = options.mode === 'original' || options.mode === 'manual'
        const orderChanged = !sameCandidateOrder(original, selected)
        const applied = bypassed || !orderChanged
            ? false
            : binding.apply(selected.map(candidate => candidate.url))
        changed ||= applied

        let reason: CdnSelectionReason = 'unchanged'
        if (bypassed) {
            reason = 'mode-bypass'
        } else if (orderChanged && applied) {
            reason = original[0]?.riskKinds.length && !selected[0]?.riskKinds.length
                ? 'risk-demotion'
                : 'health-promotion'
        } else if (orderChanged) {
            reason = 'skipped-capacity'
        }

        diagnostics.push({
            group: binding.group.key,
            kind: binding.group.kind,
            changed: applied,
            reason,
            originalHost: original[0]?.host ?? null,
            selectedHost: selected[0]?.host ?? null,
            candidates: original.map(candidate => ({
                host: candidate.host,
                riskKinds: candidate.riskKinds,
            })),
        })
    }

    return { changed, groups: bindings.length, diagnostics }
}

function collectMutableGroups(playUrl: unknown): MutableCandidateGroup[] {
    if (!isRecord(playUrl)) return []
    const bindings: MutableCandidateGroup[] = []
    const dash = isRecord(playUrl.dash) ? playUrl.dash : null
    if (dash) {
        collectStreamCollection(bindings, dash.video, 'dash.video', 'dash-video', DASH_BASE_KEYS)
        collectStreamCollection(bindings, dash.audio, 'dash.audio', 'dash-audio', DASH_BASE_KEYS)
        if (isRecord(dash.dolby)) {
            collectStreamCollection(bindings, dash.dolby.audio, 'dash.dolby.audio', 'dash-dolby-audio', DASH_BASE_KEYS)
        }
        if (isRecord(dash.flac)) {
            collectStreamCollection(bindings, dash.flac.audio, 'dash.flac.audio', 'dash-flac-audio', DASH_BASE_KEYS)
        }
    }
    collectStreamCollection(bindings, playUrl.durl, 'durl', 'durl', ['url'])
    return bindings
}

function collectStreamCollection(
    bindings: MutableCandidateGroup[],
    value: unknown,
    key: string,
    kind: CdnCandidateGroupKind,
    mainKeys: readonly string[],
) {
    if (Array.isArray(value)) {
        value.forEach((stream, index) => {
            if (!isRecord(stream)) return
            const binding = createMutableGroup(stream, `${key}[${index}]`, kind, mainKeys)
            if (binding) bindings.push(binding)
        })
        return
    }
    if (isRecord(value)) {
        const binding = createMutableGroup(value, key, kind, mainKeys)
        if (binding) bindings.push(binding)
    }
}

function createMutableGroup(
    stream: LooseRecord,
    key: string,
    kind: CdnCandidateGroupKind,
    mainKeys: readonly string[],
): MutableCandidateGroup | null {
    const mainSlots: MutableUrlSlot[] = []
    for (const field of mainKeys) {
        if (hasOwn(stream, field) && isCompleteCdnUrl(stream[field])) {
            mainSlots.push(createPropertyUrlSlot(stream, field))
        }
    }
    const backupSlotGroups: MutableUrlSlot[][] = []
    for (const field of BACKUP_KEYS) {
        if (!hasOwn(stream, field)) continue
        const slots: MutableUrlSlot[] = []
        collectUrlSlots(stream, field, slots)
        backupSlotGroups.push(slots)
    }
    const allSlots = [...mainSlots, ...backupSlotGroups.flat()]

    const seen = new Set<string>()
    const candidates = allSlots
        .map(slot => slot.read())
        .filter(url => {
            if (seen.has(url)) return false
            seen.add(url)
            return true
        })
        .map(classifyCdnUrl)
        .filter((candidate): candidate is CdnCandidate => candidate !== null)
    if (candidates.length === 0) return null

    return {
        group: { key, kind, candidates },
        apply(nextUrls) {
            if (mainSlots.length === 0 || nextUrls.length === 0) return false
            return applyCandidateOccurrences(mainSlots, backupSlotGroups, nextUrls)
        },
    }
}

function collectUrlSlots(container: LooseRecord | unknown[], key: string | number, slots: MutableUrlSlot[]) {
    const value = readContainerValue(container, key)
    if (Array.isArray(value)) {
        value.forEach((_, index) => collectUrlSlots(value, index, slots))
    } else if (isCompleteCdnUrl(value)) {
        slots.push(createPropertyUrlSlot(container, key))
    } else if (isRecord(value) && hasOwn(value, 'url') && isCompleteCdnUrl(value.url)) {
        slots.push(createPropertyUrlSlot(value, 'url'))
    }
}

function createPropertyUrlSlot(container: LooseRecord | unknown[], key: string | number): MutableUrlSlot {
    return {
        read: () => readContainerValue(container, key) as string,
        write(url) {
            if (readContainerValue(container, key) === url) return false
            writeContainerValue(container, key, url)
            return true
        },
    }
}

function readContainerValue(container: LooseRecord | unknown[], key: string | number): unknown {
    return Array.isArray(container)
        ? container[typeof key === 'number' ? key : -1]
        : container[typeof key === 'string' ? key : '']
}

function writeContainerValue(container: LooseRecord | unknown[], key: string | number, value: string) {
    if (Array.isArray(container)) {
        if (typeof key === 'number') container[key] = value
    } else if (typeof key === 'string') {
        container[key] = value
    }
}

function applyCandidateOccurrences(
    mainSlots: readonly MutableUrlSlot[],
    backupSlotGroups: readonly MutableUrlSlot[][],
    uniqueOrder: readonly string[],
): boolean {
    if (mainSlots.length === 0 || uniqueOrder.length === 0) return false
    if (new Set(uniqueOrder).size !== uniqueOrder.length) return false
    if (backupSlotGroups.length === 0) return false

    const primary = uniqueOrder[0]
    const plans: string[][] = []
    for (const backupSlots of backupSlotGroups) {
        let canonicalPlan: string[] | null = null
        for (const mainSlot of mainSlots) {
            const plan = planAliasOccurrences(mainSlot, backupSlots, uniqueOrder)
            if (!plan) return false
            if (canonicalPlan && !sameStringArray(canonicalPlan, plan)) return false
            canonicalPlan = plan
        }
        if (!canonicalPlan) return false
        plans.push(canonicalPlan)
    }

    let changed = false
    mainSlots.forEach(slot => { changed = slot.write(primary) || changed })
    backupSlotGroups.forEach((slots, groupIndex) => {
        slots.forEach((slot, slotIndex) => {
            changed = slot.write(plans[groupIndex][slotIndex]) || changed
        })
    })
    return changed
}

function planAliasOccurrences(
    mainSlot: MutableUrlSlot,
    backupSlots: readonly MutableUrlSlot[],
    uniqueOrder: readonly string[],
): string[] | null {
    const occurrenceCounts = new Map<string, number>()
    for (const slot of [mainSlot, ...backupSlots]) {
        const url = slot.read()
        occurrenceCounts.set(url, (occurrenceCounts.get(url) ?? 0) + 1)
    }
    if (uniqueOrder.length !== occurrenceCounts.size
        || uniqueOrder.some(url => !occurrenceCounts.has(url))) {
        return null
    }

    const primary = uniqueOrder[0]
    const primaryCount = occurrenceCounts.get(primary) ?? 0
    if (primaryCount < 1) return null
    occurrenceCounts.set(primary, primaryCount - 1)

    const plan: string[] = []
    for (const url of uniqueOrder) {
        const count = occurrenceCounts.get(url) ?? 0
        for (let occurrence = 0; occurrence < count; occurrence++) plan.push(url)
    }
    return plan.length === backupSlots.length ? plan : null
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index])
}

function stableSortByHealth(
    candidates: CdnCandidate[],
    start: number,
    end: number,
    health: ReadonlyMap<string, HostHealth>,
    minSamples: number,
) {
    if (end - start < 2) return
    const sorted = candidates.slice(start, end)
        .map((candidate, index) => ({ candidate, index }))
        .sort((left, right) => compareHostHealth(
            findHealth(health, left.candidate),
            findHealth(health, right.candidate),
            minSamples,
        ) || left.index - right.index)
        .map(entry => entry.candidate)
    candidates.splice(start, end - start, ...sorted)
}

function createHealthLookup(collection: HostHealthCollection): Map<string, HostHealth> {
    const lookup = new Map<string, HostHealth>()
    const add = (key: string | undefined, health: HostHealth) => {
        const normalized = normalizeHealthKey(key)
        if (normalized) lookup.set(normalized, health)
    }

    if (Array.isArray(collection)) {
        const healthList = collection as readonly HostHealth[]
        healthList.forEach(health => add(health.host, health))
    } else if (collection instanceof Map) {
        collection.forEach((health, host) => add(host, health))
    } else {
        const record = collection as Readonly<Record<string, HostHealth>>
        Object.keys(record).forEach(host => add(host, record[host]))
    }
    return lookup
}

function findHealth(lookup: ReadonlyMap<string, HostHealth>, candidate: CdnCandidate): HostHealth | undefined {
    return lookup.get(normalizeHealthKey(candidate.host) || '')
        ?? lookup.get(normalizeHealthKey(candidate.hostname) || '')
}

function normalizeHealthKey(value: string | undefined): string | null {
    if (!value) return null
    const trimmed = value.trim()
    if (!trimmed) return null
    const direct = parseCompleteUrl(trimmed)
    if (direct) return direct.host.toLowerCase()
    try {
        return new URL(`http://${trimmed}`).host.toLowerCase()
    } catch (_) {
        return trimmed.toLowerCase().replace(/\.$/, '')
    }
}

function normalizeHealth(health: HostHealth): NormalizedHealth {
    const successes = nonNegativeFinite(health.successes)
    const failures = nonNegativeFinite(health.failures)
    const observed = (successes ?? 0) + (failures ?? 0)
    const declaredSamples = nonNegativeFinite(health.samples)
    const samples = declaredSamples ?? observed
    const denominator = Math.max(samples, observed)
    return {
        samples,
        successes,
        failures,
        successRate: successes !== null && denominator > 0 ? successes / denominator : null,
        throughputKbps: nonNegativeFinite(health.throughputKbps),
        ttfbMs: nonNegativeFinite(health.ttfbMs),
    }
}

function hasSortableSuccessEvidence(health: NormalizedHealth, minSamples: number): boolean {
    return health.samples >= minSamples
        && health.successes !== null
        && health.successes >= minSamples
}

function compareOptionalMetric(
    left: number | null,
    right: number | null,
    direction: 'ascending' | 'descending',
): number {
    if (left === null || right === null) {
        if (left === right) return 0
        return left === null ? 1 : -1
    }
    return direction === 'ascending' ? left - right : right - left
}

function normalizeMinSamples(value: number | undefined): number {
    return Number.isFinite(value) && value !== undefined
        ? Math.max(0, Math.floor(value))
        : DEFAULT_MIN_HEALTH_SAMPLES
}

function nonNegativeFinite(value: number | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function parseCompleteUrl(value: unknown): URL | null {
    if (typeof value !== 'string' || !value) return null
    try {
        const protocolRelative = value.startsWith('//') && !value.startsWith('///')
        const parsed = new URL(protocolRelative ? `https:${value}` : value)
        return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname ? parsed : null
    } catch (_) {
        return null
    }
}

function isKnownPcdnHostname(hostname: string): boolean {
    return KNOWN_PCDN_DOMAINS.some(domain => isDomainOrSubdomain(hostname, domain))
        || (isDomainOrSubdomain(hostname, 'biliapi.net')
            && hostname.split('.').some(label => hasHyphenToken(label, 'pcdn')))
}

function hasHyphenToken(label: string, token: string): boolean {
    return label.split('-').includes(token)
}

function has302HostToken(firstLabel: string): boolean {
    return firstLabel.split('-').some(token => token === '302' || /^[a-z]+302$/.test(token))
}

function isDomainOrSubdomain(hostname: string, domain: string): boolean {
    return hostname === domain || hostname.endsWith(`.${domain}`)
}

function isIpv4Hostname(hostname: string): boolean {
    const parts = hostname.split('.')
    return parts.length === 4 && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function isIpLiteral(hostname: string): boolean {
    return isIpv4Hostname(hostname)
        || (hostname.startsWith('[') && hostname.endsWith(']'))
        || hostname.includes(':')
}

function sameCandidateOrder(left: readonly CdnCandidate[], right: readonly CdnCandidate[]): boolean {
    return left.length === right.length && left.every((candidate, index) => candidate.url === right[index]?.url)
}

function isRecord(value: unknown): value is LooseRecord {
    return typeof value === 'object' && value !== null
}

function hasOwn(value: LooseRecord, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(value, key)
}
