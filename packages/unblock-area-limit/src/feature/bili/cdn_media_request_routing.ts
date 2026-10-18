import type { CdnCandidate, CdnCandidateGroup, CdnCandidateGroupKind } from './cdn_selection'

export interface RouteActivation {
    readonly contextEpoch: number
    readonly generation: number
    readonly groupId: number
    readonly routeRevision: number
    readonly candidateIndex: number
}

export interface CdnMediaRouteDecision {
    /** The original URL or one exact URL copied from the same published group. */
    readonly url: string
    readonly routed: boolean
    readonly activation?: RouteActivation
}

export interface PreparedCdnMediaRoute {
    /** True only when this exact GET uniquely matches the current registry. */
    readonly eligible: boolean
    readonly decision: CdnMediaRouteDecision
    commit(): CdnMediaRouteDecision
    discard(): void
}

export interface CdnRouteAdvanceResult {
    readonly accepted: boolean
    readonly advanced: boolean
    readonly exhausted: boolean
    readonly activation?: RouteActivation
}

export interface CdnStableRecoveryResetResult {
    readonly accepted: boolean
    readonly activation?: RouteActivation
}

export interface CdnRoutingGroupStatus {
    readonly groupId: number
    readonly key: string
    readonly kind: CdnCandidateGroupKind
    readonly generation: number
    readonly candidateCount: number
    readonly active: boolean
    readonly candidateIndex: number | null
    readonly pendingCandidateIndex: number | null
    readonly attemptedCount: number
    readonly routeRevision: number
    readonly exhausted: boolean
}

export interface CdnMediaRequestRoutingStatus {
    readonly enabled: boolean
    readonly contextEpoch: number
    readonly generation: number
    readonly groupCount: number
    readonly activeGroupCount: number
    readonly groups: readonly CdnRoutingGroupStatus[]
}

export interface CdnRoutingPublicationResult {
    readonly registryChanged: boolean
    readonly enabledChanged: boolean
    readonly status: CdnMediaRequestRoutingStatus
}

export interface CdnMediaRequestRouterDependencies {
    getLocationProtocol?: () => string
}

export interface CdnMediaRequestRouter {
    publishGroups(groups: readonly CdnCandidateGroup[], enabled: boolean): CdnRoutingPublicationResult
    setEnabled(enabled: boolean): CdnMediaRequestRoutingStatus
    beginContext(): CdnMediaRequestRoutingStatus
    prepareExactUrl(url: string, method?: string): PreparedCdnMediaRoute
    routeExactUrl(url: string, method?: string): CdnMediaRouteDecision
    advanceRoute(activation: RouteActivation): CdnRouteAdvanceResult
    resetAfterStableRecovery(activation: RouteActivation): CdnStableRecoveryResetResult
    getStatus(): CdnMediaRequestRoutingStatus
    getActiveActivations(): readonly RouteActivation[]
    getActiveActivation(groupId: number): RouteActivation | null
}

interface CandidateSnapshot {
    readonly url: string
    readonly risky: boolean
}

interface GroupSnapshot {
    readonly key: string
    readonly kind: CdnCandidateGroupKind
    readonly candidates: readonly CandidateSnapshot[]
}

interface GroupRuntime {
    readonly groupId: number
    readonly key: string
    readonly kind: CdnCandidateGroupKind
    readonly candidates: readonly CandidateSnapshot[]
    readonly fallbackOrder: readonly number[]
    attempted: Set<number>
    active: boolean
    candidateIndex: number | null
    overrideCandidateIndex: number | null
    pendingCandidateIndex: number | null
    routeRevision: number
    exhausted: boolean
}

interface ReverseMatch {
    readonly groupId: number
    readonly candidateIndex: number
}

function defaultLocationProtocol() {
    try {
        return typeof location === 'undefined' ? '' : location.protocol
    } catch {
        return ''
    }
}

/**
 * Create an in-memory exact request router. It deliberately has no storage or
 * logging dependencies so signed media URLs cannot escape through status data.
 */
export function createCdnMediaRequestRouter(
    overrides: CdnMediaRequestRouterDependencies = {},
): CdnMediaRequestRouter {
    const getLocationProtocol = overrides.getLocationProtocol ?? defaultLocationProtocol
    let enabled = false
    let contextEpoch = 0
    let generation = 0
    let canonicalRegistry = canonicalizeSnapshots([])
    let groups: GroupRuntime[] = []
    let groupsById = new Map<number, GroupRuntime>()
    let reverseIndex = new Map<string, ReverseMatch[]>()

    function publishGroups(
        candidateGroups: readonly CdnCandidateGroup[],
        nextEnabled: boolean,
    ): CdnRoutingPublicationResult {
        const snapshots = copyGroupsOrEmpty(candidateGroups)
        const nextCanonical = canonicalizeSnapshots(snapshots)
        const registryChanged = nextCanonical !== canonicalRegistry
        const enabledChanged = enabled !== nextEnabled

        if (registryChanged) {
            const nextGeneration = generation + 1
            const nextGroups = snapshots.map((snapshot, index) => createGroupRuntime(
                snapshot,
                index + 1,
            ))
            const nextGroupsById = new Map(nextGroups.map(group => [group.groupId, group]))
            const nextReverseIndex = createReverseIndex(nextGroups, readLocationProtocol())

            // Commit the complete replacement only after every derived view exists.
            generation = nextGeneration
            canonicalRegistry = nextCanonical
            groups = nextGroups
            groupsById = nextGroupsById
            reverseIndex = nextReverseIndex
        } else {
            // The page protocol can change without changing the signed delivery.
            reverseIndex = createReverseIndex(groups, readLocationProtocol())
        }

        enabled = nextEnabled
        if (enabledChanged && !registryChanged) {
            for (const group of groups) resetGroupRuntime(group)
        }

        return { registryChanged, enabledChanged, status: getStatus() }
    }

    function beginContext() {
        contextEpoch += 1
        for (const group of groups) resetGroupRuntime(group)
        return getStatus()
    }

    function setEnabled(nextEnabled: boolean) {
        if (enabled === nextEnabled) return getStatus()
        enabled = nextEnabled
        for (const group of groups) resetGroupRuntime(group)
        return getStatus()
    }

    function prepareExactUrl(url: string, method = 'GET'): PreparedCdnMediaRoute {
        const originalDecision: CdnMediaRouteDecision = { url, routed: false }
        if (!enabled || !isEffectiveGet(method)) return settledPreparation(originalDecision)
        const matches = reverseIndex.get(url)
        if (!matches || matches.length !== 1) return settledPreparation(originalDecision)

        const match = matches[0]
        const group = groupsById.get(match.groupId)
        if (!group || !group.candidates[match.candidateIndex]) {
            return settledPreparation(originalDecision)
        }
        const routeCandidateIndex = group.pendingCandidateIndex
            ?? group.overrideCandidateIndex
        const targetIndex = routeCandidateIndex ?? match.candidateIndex
        const target = group.candidates[targetIndex]
        if (!target) return settledPreparation(originalDecision)

        const targetUrl = routeCandidateIndex === null ? url : target.url
        const decision: CdnMediaRouteDecision = {
            url: targetUrl,
            routed: targetUrl !== url,
        }
        const preparedContextEpoch = contextEpoch
        const preparedGeneration = generation
        const preparedRouteRevision = group.routeRevision
        let finished = false
        let committedDecision = decision

        return {
            eligible: true,
            decision,
            commit() {
                if (finished) return committedDecision
                finished = true
                if (!enabled
                    || contextEpoch !== preparedContextEpoch
                    || generation !== preparedGeneration
                    || groupsById.get(group.groupId) !== group
                    || group.routeRevision !== preparedRouteRevision) return committedDecision

                const currentMatches = reverseIndex.get(url)
                if (!currentMatches || currentMatches.length !== 1
                    || currentMatches[0].groupId !== group.groupId
                    || currentMatches[0].candidateIndex !== match.candidateIndex
                    || (group.pendingCandidateIndex
                        ?? group.overrideCandidateIndex
                        ?? match.candidateIndex) !== targetIndex) {
                    return committedDecision
                }

                observeCommittedRoute(group, match.candidateIndex, targetIndex)
                committedDecision = {
                    ...decision,
                    activation: activationFor(group),
                }
                return committedDecision
            },
            discard() {
                finished = true
            },
        }
    }

    function routeExactUrl(url: string, method = 'GET'): CdnMediaRouteDecision {
        return prepareExactUrl(url, method).commit()
    }

    function advanceRoute(activation: RouteActivation): CdnRouteAdvanceResult {
        const group = validateActivation(activation)
        if (!group) return { accepted: false, advanced: false, exhausted: false }

        if (group.pendingCandidateIndex !== null) {
            return {
                accepted: true,
                advanced: false,
                exhausted: false,
                activation: activationFor(group),
            }
        }

        const nextCandidateIndex = group.fallbackOrder.find(index => !group.attempted.has(index))
        group.routeRevision += 1
        if (nextCandidateIndex === undefined) {
            group.exhausted = true
            return {
                accepted: true,
                advanced: false,
                exhausted: true,
                activation: activationFor(group),
            }
        }

        group.pendingCandidateIndex = nextCandidateIndex
        group.exhausted = false
        return {
            accepted: true,
            advanced: true,
            exhausted: false,
            activation: activationFor(group),
        }
    }

    function resetAfterStableRecovery(
        activation: RouteActivation,
    ): CdnStableRecoveryResetResult {
        const group = validateActivation(activation)
        if (!group || group.candidateIndex === null) return { accepted: false }
        group.pendingCandidateIndex = null
        group.attempted = new Set([group.candidateIndex])
        group.exhausted = false
        group.routeRevision += 1
        return { accepted: true, activation: activationFor(group) }
    }

    function getStatus(): CdnMediaRequestRoutingStatus {
        const groupStatuses = groups.map(group => ({
            groupId: group.groupId,
            key: group.key,
            kind: group.kind,
            generation,
            candidateCount: group.candidates.length,
            active: group.active,
            candidateIndex: group.candidateIndex,
            pendingCandidateIndex: group.pendingCandidateIndex,
            attemptedCount: group.attempted.size,
            routeRevision: group.routeRevision,
            exhausted: group.exhausted,
        }))
        return {
            enabled,
            contextEpoch,
            generation,
            groupCount: groupStatuses.length,
            activeGroupCount: groupStatuses.filter(group => group.active).length,
            groups: groupStatuses,
        }
    }

    function getActiveActivations() {
        return groups
            .filter((group): group is GroupRuntime & { candidateIndex: number } => (
                group.active && group.candidateIndex !== null
            ))
            .map(activationFor)
    }

    function getActiveActivation(groupId: number) {
        const group = groupsById.get(groupId)
        return group?.active && group.candidateIndex !== null ? activationFor(group) : null
    }

    function validateActivation(activation: RouteActivation) {
        if (!enabled || activation.contextEpoch !== contextEpoch || activation.generation !== generation) {
            return null
        }
        const group = groupsById.get(activation.groupId)
        if (!group || !group.active || group.candidateIndex === null) return null
        return activation.routeRevision === group.routeRevision
            && activation.candidateIndex === group.candidateIndex
            ? group
            : null
    }

    function activationFor(group: GroupRuntime & { candidateIndex: number }): RouteActivation
    function activationFor(group: GroupRuntime): RouteActivation
    function activationFor(group: GroupRuntime): RouteActivation {
        if (group.candidateIndex === null) {
            throw new Error('Cannot create an activation for an unseen CDN group.')
        }
        return {
            contextEpoch,
            generation,
            groupId: group.groupId,
            routeRevision: group.routeRevision,
            candidateIndex: group.candidateIndex,
        }
    }

    function readLocationProtocol() {
        try {
            const protocol = getLocationProtocol()
            return typeof protocol === 'string' && /^[A-Za-z][A-Za-z\d+.-]*:$/.test(protocol)
                ? protocol
                : null
        } catch {
            return null
        }
    }

    return {
        publishGroups,
        setEnabled,
        beginContext,
        prepareExactUrl,
        routeExactUrl,
        advanceRoute,
        resetAfterStableRecovery,
        getStatus,
        getActiveActivations,
        getActiveActivation,
    }
}

function settledPreparation(decision: CdnMediaRouteDecision): PreparedCdnMediaRoute {
    return {
        eligible: false,
        decision,
        commit: () => decision,
        discard() { },
    }
}

function observeCommittedRoute(
    group: GroupRuntime,
    matchedCandidateIndex: number,
    targetCandidateIndex: number,
) {
    if (!group.active) {
        group.active = true
        group.candidateIndex = matchedCandidateIndex
        group.overrideCandidateIndex = null
        group.pendingCandidateIndex = null
        group.attempted.add(matchedCandidateIndex)
        group.exhausted = false
    } else if (group.pendingCandidateIndex !== null) {
        group.overrideCandidateIndex = targetCandidateIndex
        group.pendingCandidateIndex = null
        group.exhausted = false
    } else if (group.overrideCandidateIndex === null
        && group.candidateIndex !== matchedCandidateIndex) {
        // Before recovery installs an override, follow a naturally changed exact request.
        group.candidateIndex = matchedCandidateIndex
        group.attempted.add(matchedCandidateIndex)
        group.routeRevision += 1
        group.exhausted = false
    }
    group.attempted.add(targetCandidateIndex)
    group.candidateIndex = targetCandidateIndex
}

function copyGroupsOrEmpty(candidateGroups: readonly CdnCandidateGroup[]): GroupSnapshot[] {
    try {
        if (!Array.isArray(candidateGroups)) return []
        return candidateGroups.map(group => {
            if (!group || typeof group !== 'object'
                || typeof group.key !== 'string' || typeof group.kind !== 'string'
                || !Array.isArray(group.candidates)) {
                throw new TypeError('Invalid CDN candidate group.')
            }
            const candidates = group.candidates.map((candidate: CdnCandidate) => {
                if (!candidate || typeof candidate !== 'object' || typeof candidate.url !== 'string') {
                    throw new TypeError('Invalid CDN candidate.')
                }
                return {
                    url: candidate.url,
                    risky: Array.isArray(candidate.riskKinds) && candidate.riskKinds.length > 0,
                }
            })
            if (candidates.length === 0) throw new TypeError('Empty CDN candidate group.')
            return { key: group.key, kind: group.kind, candidates }
        })
    } catch {
        // A failed collection must replace the complete registry with an empty view.
        return []
    }
}

function canonicalizeSnapshots(groups: readonly GroupSnapshot[]) {
    return JSON.stringify(groups.map(group => [
        group.kind,
        group.key,
        group.candidates.map(candidate => candidate.url),
    ]))
}

function createGroupRuntime(snapshot: GroupSnapshot, groupId: number): GroupRuntime {
    const originalOrder = snapshot.candidates.map((_, index) => index)
    const ordinary = originalOrder.filter(index => !snapshot.candidates[index].risky)
    const risky = originalOrder.filter(index => snapshot.candidates[index].risky)
    const fallbackOrder = ordinary.length === 0 ? originalOrder : [...ordinary, ...risky]
    return {
        groupId,
        key: snapshot.key,
        kind: snapshot.kind,
        candidates: snapshot.candidates,
        fallbackOrder,
        attempted: new Set(),
        active: false,
        candidateIndex: null,
        overrideCandidateIndex: null,
        pendingCandidateIndex: null,
        routeRevision: 0,
        exhausted: false,
    }
}

function createReverseIndex(groups: readonly GroupRuntime[], protocol: string | null) {
    const result = new Map<string, ReverseMatch[]>()
    for (const group of groups) {
        group.candidates.forEach((candidate, candidateIndex) => {
            addReverseMatch(result, candidate.url, group.groupId, candidateIndex)
            if (protocol && candidate.url.startsWith('//')) {
                addReverseMatch(result, `${protocol}${candidate.url}`, group.groupId, candidateIndex)
            }
        })
    }
    return result
}

function addReverseMatch(
    index: Map<string, ReverseMatch[]>,
    exactUrl: string,
    groupId: number,
    candidateIndex: number,
) {
    const matches = index.get(exactUrl)
    const match = { groupId, candidateIndex }
    if (matches) matches.push(match)
    else index.set(exactUrl, [match])
}

function resetGroupRuntime(group: GroupRuntime) {
    group.attempted = new Set()
    group.active = false
    group.candidateIndex = null
    group.overrideCandidateIndex = null
    group.pendingCandidateIndex = null
    group.routeRevision += 1
    group.exhausted = false
}

function isEffectiveGet(method: string) {
    return typeof method === 'string' && method.toUpperCase() === 'GET'
}

export const defaultCdnMediaRequestRouter = createCdnMediaRequestRouter()
export const publishCdnMediaRequestGroups = defaultCdnMediaRequestRouter.publishGroups
export const beginCdnMediaRequestContext = defaultCdnMediaRequestRouter.beginContext
export const routeCdnMediaRequestUrl = defaultCdnMediaRequestRouter.routeExactUrl
export const getCdnMediaRequestRoutingStatus = defaultCdnMediaRequestRouter.getStatus
