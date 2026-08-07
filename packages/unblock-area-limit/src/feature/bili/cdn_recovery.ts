import type { CdnCandidateGroup, CdnCandidateGroupKind } from './cdn_selection'
import {
    CdnMediaRequestRouter,
    CdnMediaRouteDecision,
    PreparedCdnMediaRoute,
    RouteActivation,
    createCdnMediaRequestRouter,
    defaultCdnMediaRequestRouter,
} from './cdn_media_request_routing'

export interface PlaybackSignals {
    readonly visible: boolean
    readonly paused: boolean
    readonly seeking: boolean
    readonly ended: boolean
    readonly currentTimeSeconds: number
    readonly durationSeconds: number | null
    readonly bufferedAheadSeconds: number | null
}

export type CdnRecoveryState =
    | 'disabled'
    | 'unseen'
    | 'monitoring'
    | 'confirming'
    | 'waiting-retry'
    | 'exhausted'

export interface CdnRecoveryTiming {
    readonly lowBufferThresholdSeconds: number
    readonly progressRestartSeconds: number
    readonly confirmationGraceMs: number
    readonly minimumSwitchCooldownMs: number
    readonly retryBackoffBaseMs: number
    readonly retryBackoffCapMs: number
    readonly stableBufferThresholdSeconds: number
    readonly stablePlaybackResetMs: number
    readonly activeSampleIntervalMs: number
}

export const DEFAULT_CDN_RECOVERY_TIMING: Readonly<CdnRecoveryTiming> = Object.freeze({
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

export interface CdnRecoveryGroupStatus {
    readonly groupId: number
    readonly key: string
    readonly kind: CdnCandidateGroupKind
    readonly generation: number
    readonly candidateCount: number
    readonly candidateIndex: number | null
    readonly attemptedCount: number
    readonly routeRevision: number
    readonly state: CdnRecoveryState
    readonly switchAttempts: number
    readonly retryAt: number | null
    readonly timerPending: boolean
}

export interface CdnRecoveryStatus {
    readonly enabled: boolean
    readonly contextEpoch: number
    readonly generation: number
    readonly groupCount: number
    readonly activeGroupCount: number
    readonly groups: readonly CdnRecoveryGroupStatus[]
}

export interface CdnRecoveryDependencies {
    router?: CdnMediaRequestRouter
    isEnabled?: () => boolean
    now?: () => number
    setTimeout?: (callback: () => void, delayMs: number) => number
    clearTimeout?: (handle: number) => void
    timing?: Partial<CdnRecoveryTiming>
}

export interface CdnRecoveryCoordinator {
    publishGroups(groups: readonly CdnCandidateGroup[], enabled: boolean): CdnRecoveryStatus
    setEnabled(enabled: boolean): CdnRecoveryStatus
    beginContext(): CdnRecoveryStatus
    prepareExactUrl(url: string, method?: string): PreparedCdnMediaRoute
    routeExactUrl(url: string, method?: string): CdnMediaRouteDecision
    samplePlayback(signals: PlaybackSignals | null): CdnRecoveryStatus
    getStatus(): CdnRecoveryStatus
    getActiveStates(): readonly CdnRecoveryGroupStatus[]
}

interface GroupRecoveryRuntime {
    readonly groupId: number
    readonly key: string
    readonly kind: CdnCandidateGroupKind
    readonly contextEpoch: number
    readonly generation: number
    readonly candidateCount: number
    state: CdnRecoveryState
    activation: RouteActivation | null
    switchAttempts: number
    retryAt: number
    retryAtSet: boolean
    timerRevision: number
    timerHandle: number | null
    confirmationAnchorSeconds: number | null
    confirmationDueAt: number | null
    latestSignals: PlaybackSignals | null
    latestSampleAt: number | null
    lastProcessedFingerprint: string | null
    lastProcessedRouteRevision: number | null
    stableStartAt: number | null
    stableLastAt: number | null
    stableLastCurrentTimeSeconds: number | null
}

interface GraceTimerToken {
    readonly contextEpoch: number
    readonly generation: number
    readonly groupId: number
    readonly timerRevision: number
}

/** Create a deterministic per-group recovery coordinator with an injected clock. */
export function createCdnRecoveryCoordinator(
    overrides: CdnRecoveryDependencies = {},
): CdnRecoveryCoordinator {
    const router = overrides.router ?? createCdnMediaRequestRouter()
    const isEnabled = overrides.isEnabled ?? (() => true)
    const now = overrides.now ?? (() => Date.now())
    const scheduleTimeout = overrides.setTimeout
        ?? ((callback: () => void, delayMs: number) => globalThis.setTimeout(callback, delayMs))
    const cancelTimeout = overrides.clearTimeout
        ?? ((handle: number) => globalThis.clearTimeout(handle))
    const timing = normalizeTiming(overrides.timing)
    let groupsById = new Map<number, GroupRecoveryRuntime>()

    function publishGroups(groups: readonly CdnCandidateGroup[], enabled: boolean) {
        const publication = router.publishGroups(groups, enabled && readEnabledGuard(isEnabled))
        if (publication.registryChanged || publication.enabledChanged) resetAllStates()
        synchronizeWithRouter()
        return getStatus()
    }

    function setEnabled(enabled: boolean) {
        const currentEnabled = router.getStatus().enabled
        const nextEnabled = enabled && readEnabledGuard(isEnabled)
        router.setEnabled(nextEnabled)
        if (currentEnabled !== nextEnabled) resetAllStates()
        synchronizeWithRouter()
        return getStatus()
    }

    function beginContext() {
        router.beginContext()
        resetAllStates()
        synchronizeWithRouter()
        return getStatus()
    }

    function prepareExactUrl(url: string, method = 'GET'): PreparedCdnMediaRoute {
        let prepared: PreparedCdnMediaRoute
        try {
            prepared = router.prepareExactUrl(url, method)
        } catch {
            return settledRecoveryPreparation({ url, routed: false })
        }
        return {
            eligible: prepared.eligible,
            decision: prepared.decision,
            commit() {
                let decision: CdnMediaRouteDecision
                try {
                    decision = prepared.commit()
                } catch {
                    decision = { url, routed: false }
                }
                synchronizeWithRouter()
                return decision
            },
            discard() {
                try {
                    prepared.discard()
                } catch {
                    // A discarded optional route must not affect the native request.
                }
            },
        }
    }

    function routeExactUrl(url: string, method = 'GET') {
        return prepareExactUrl(url, method).commit()
    }

    function samplePlayback(signals: PlaybackSignals | null) {
        synchronizeWithRouter()
        const sampledAt = safeNow(now)
        for (const group of groupsById.values()) {
            if (!group.activation || group.state === 'disabled' || group.state === 'unseen') continue
            if (signals) processSample(group, signals, sampledAt)
            else processUnavailableSample(group, sampledAt)
        }
        return getStatus()
    }

    function processUnavailableSample(group: GroupRecoveryRuntime, sampledAt: number) {
        group.latestSignals = null
        group.latestSampleAt = sampledAt
        group.lastProcessedFingerprint = 'unavailable'
        group.lastProcessedRouteRevision = group.activation?.routeRevision ?? null
        clearStableWindow(group)
        if (group.state !== 'confirming') return
        cancelConfirmation(group)
        group.state = 'monitoring'
    }

    function processSample(group: GroupRecoveryRuntime, signals: PlaybackSignals, sampledAt: number) {
        const fingerprint = sampleFingerprint(signals)
        if (group.latestSampleAt === sampledAt
            && group.lastProcessedFingerprint === fingerprint
            && group.lastProcessedRouteRevision === group.activation?.routeRevision) return

        group.latestSignals = copySignals(signals)
        group.latestSampleAt = sampledAt
        group.lastProcessedFingerprint = fingerprint
        group.lastProcessedRouteRevision = group.activation?.routeRevision ?? null

        if (group.state === 'waiting-retry' || group.state === 'exhausted') {
            if (processStableRecovery(group, signals, sampledAt)) return
            if (group.state === 'exhausted') return
            if (sampledAt < group.retryAt) return
            if (isEligibleLowBuffer(signals, timing)) startConfirmation(group, signals, sampledAt)
            else group.state = 'monitoring'
            return
        }

        clearStableWindow(group)
        if (group.state === 'monitoring') {
            if (sampledAt >= group.retryAt && isEligibleLowBuffer(signals, timing)) {
                startConfirmation(group, signals, sampledAt)
            }
            return
        }

        if (group.state !== 'confirming') return
        if (!isEligibleLowBuffer(signals, timing)) {
            cancelConfirmation(group)
            group.state = 'monitoring'
            return
        }

        const anchor = group.confirmationAnchorSeconds
        const currentTime = finiteNumber(signals.currentTimeSeconds)
        if (anchor === null || currentTime === null || currentTime < anchor) {
            cancelConfirmation(group)
            group.state = 'monitoring'
            return
        }
        if (currentTime - anchor >= timing.progressRestartSeconds) {
            startConfirmation(group, signals, sampledAt)
        }
    }

    function startConfirmation(
        group: GroupRecoveryRuntime,
        signals: PlaybackSignals,
        startedAt: number,
    ) {
        invalidateGraceTimer(group)
        group.state = 'confirming'
        group.confirmationAnchorSeconds = signals.currentTimeSeconds
        group.confirmationDueAt = startedAt + timing.confirmationGraceMs
        const token: GraceTimerToken = {
            contextEpoch: group.contextEpoch,
            generation: group.generation,
            groupId: group.groupId,
            timerRevision: group.timerRevision,
        }
        scheduleGraceTimer(group, token, timing.confirmationGraceMs)
    }

    function handleGraceTimer(token: GraceTimerToken) {
        const group = groupsById.get(token.groupId)
        if (!group || group.contextEpoch !== token.contextEpoch
            || group.generation !== token.generation
            || group.timerRevision !== token.timerRevision
            || group.state !== 'confirming') return
        if (!readEnabledGuard(isEnabled)) {
            setEnabled(false)
            return
        }

        const firedAt = safeNow(now)
        const dueAt = group.confirmationDueAt
        if (dueAt !== null && firedAt < dueAt) {
            rescheduleEarlyGraceTimer(group, token, dueAt - firedAt)
            return
        }

        group.timerHandle = null
        group.timerRevision += 1
        const activation = group.activation
        const currentActivation = router.getActiveActivation(group.groupId)
        if (!activation || !currentActivation || !sameActivation(activation, currentActivation)) {
            synchronizeWithRouter()
            return
        }

        const signals = group.latestSignals
        if (!signals || !isEligibleLowBuffer(signals, timing)) {
            group.confirmationAnchorSeconds = null
            group.confirmationDueAt = null
            group.state = 'monitoring'
            return
        }

        const currentTime = finiteNumber(signals.currentTimeSeconds)
        const anchor = group.confirmationAnchorSeconds
        if (currentTime === null || anchor === null || currentTime < anchor) {
            group.confirmationAnchorSeconds = null
            group.confirmationDueAt = null
            group.state = 'monitoring'
            return
        }
        if (currentTime - anchor >= timing.progressRestartSeconds) {
            startConfirmation(group, signals, firedAt)
            return
        }

        group.confirmationAnchorSeconds = null
        group.confirmationDueAt = null
        const result = router.advanceRoute(activation)
        if (!result.accepted || !result.activation) {
            synchronizeWithRouter()
            return
        }

        group.activation = result.activation
        group.lastProcessedRouteRevision = result.activation.routeRevision
        clearStableWindow(group)
        if (result.exhausted) {
            group.state = 'exhausted'
            return
        }

        group.switchAttempts += 1
        group.retryAt = firedAt + switchCooldownMs(group.switchAttempts, timing)
        group.retryAtSet = true
        group.state = 'waiting-retry'
    }

    function rescheduleEarlyGraceTimer(
        group: GroupRecoveryRuntime,
        previousToken: GraceTimerToken,
        remainingMs: number,
    ) {
        group.timerHandle = null
        group.timerRevision += 1
        const token: GraceTimerToken = {
            ...previousToken,
            timerRevision: group.timerRevision,
        }
        scheduleGraceTimer(group, token, remainingMs)
    }

    function scheduleGraceTimer(
        group: GroupRecoveryRuntime,
        token: GraceTimerToken,
        delayMs: number,
    ) {
        let timerReturned = false
        let firedSynchronously = false
        let handle: number
        try {
            handle = scheduleTimeout(() => {
                if (!timerReturned) {
                    firedSynchronously = true
                    return
                }
                handleGraceTimer(token)
            }, delayMs)
            timerReturned = true
        } catch {
            abandonGraceTimer(group, token)
            return
        }

        const currentGroup = groupsById.get(token.groupId)
        if (firedSynchronously
            || currentGroup !== group
            || group.contextEpoch !== token.contextEpoch
            || group.generation !== token.generation
            || group.timerRevision !== token.timerRevision
            || group.state !== 'confirming') {
            abandonGraceTimer(group, token)
            try {
                cancelTimeout(handle)
            } catch {
                // The revision fence keeps a retained host callback harmless.
            }
            return
        }
        group.timerHandle = handle
    }

    function abandonGraceTimer(group: GroupRecoveryRuntime, token: GraceTimerToken) {
        if (group.contextEpoch !== token.contextEpoch
            || group.generation !== token.generation
            || group.timerRevision !== token.timerRevision) return
        group.timerRevision += 1
        group.timerHandle = null
        group.confirmationAnchorSeconds = null
        group.confirmationDueAt = null
        if (group.state === 'confirming') group.state = 'monitoring'
    }

    function processStableRecovery(
        group: GroupRecoveryRuntime,
        signals: PlaybackSignals,
        sampledAt: number,
    ) {
        const currentTime = stablePlaybackTime(signals, timing)
        if (currentTime === null) {
            clearStableWindow(group)
            return false
        }

        if (group.stableStartAt === null || group.stableLastAt === null
            || group.stableLastCurrentTimeSeconds === null) {
            beginStableWindow(group, sampledAt, currentTime)
            return false
        }

        if (sampledAt < group.stableLastAt
            || (sampledAt > group.stableLastAt
                && currentTime <= group.stableLastCurrentTimeSeconds)
            || (sampledAt === group.stableLastAt
                && currentTime < group.stableLastCurrentTimeSeconds)) {
            beginStableWindow(group, sampledAt, currentTime)
            return false
        }
        if (sampledAt === group.stableLastAt
            && currentTime === group.stableLastCurrentTimeSeconds) return false

        group.stableLastAt = sampledAt
        group.stableLastCurrentTimeSeconds = currentTime
        if (sampledAt - group.stableStartAt < timing.stablePlaybackResetMs) return false

        const activation = group.activation
        if (!activation) return false
        const reset = router.resetAfterStableRecovery(activation)
        if (!reset.accepted || !reset.activation) {
            synchronizeWithRouter()
            return true
        }

        group.activation = reset.activation
        group.switchAttempts = 0
        group.lastProcessedRouteRevision = reset.activation.routeRevision
        clearStableWindow(group)
        group.state = group.retryAtSet && sampledAt < group.retryAt
            ? 'waiting-retry'
            : 'monitoring'
        return true
    }

    function synchronizeWithRouter() {
        const routingStatus = router.getStatus()
        const activeActivations = new Map(
            router.getActiveActivations().map(activation => [activation.groupId, activation]),
        )
        const nextGroups = new Map<number, GroupRecoveryRuntime>()

        for (const routingGroup of routingStatus.groups) {
            const activeActivation = activeActivations.get(routingGroup.groupId) ?? null
            const existing = groupsById.get(routingGroup.groupId)
            const reusable = existing
                && existing.contextEpoch === routingStatus.contextEpoch
                && existing.generation === routingStatus.generation
            const group = reusable
                ? existing
                : createGroupRecoveryRuntime(
                    routingGroup.groupId,
                    routingGroup.key,
                    routingGroup.kind,
                    routingStatus.contextEpoch,
                    routingStatus.generation,
                    routingGroup.candidateCount,
                    routingStatus.enabled,
                    activeActivation,
                )

            if (reusable) {
                synchronizeGroupActivation(group, routingStatus.enabled, activeActivation)
            }
            nextGroups.set(group.groupId, group)
        }

        for (const [groupId, group] of groupsById) {
            if (!nextGroups.has(groupId)) invalidateGraceTimer(group)
        }
        groupsById = nextGroups
    }

    function synchronizeGroupActivation(
        group: GroupRecoveryRuntime,
        routingEnabled: boolean,
        activeActivation: RouteActivation | null,
    ) {
        if (!routingEnabled) {
            invalidateGraceTimer(group)
            disableGroup(group)
            return
        }
        if (!activeActivation) {
            if (group.state !== 'unseen') {
                invalidateGraceTimer(group)
                resetGroupToUnseen(group)
            }
            return
        }
        if (!group.activation) {
            group.activation = activeActivation
            group.state = 'monitoring'
            return
        }
        if (sameActivation(group.activation, activeActivation)) return

        invalidateGraceTimer(group)
        group.activation = activeActivation
        clearStableWindow(group)
        group.state = safeNow(now) < group.retryAt ? 'waiting-retry' : 'monitoring'
    }

    function getStatus(): CdnRecoveryStatus {
        const routingStatus = router.getStatus()
        const groups = routingStatus.groups.map(routingGroup => {
            const recovery = groupsById.get(routingGroup.groupId)
            return {
                groupId: routingGroup.groupId,
                key: routingGroup.key,
                kind: routingGroup.kind,
                generation: routingGroup.generation,
                candidateCount: routingGroup.candidateCount,
                candidateIndex: routingGroup.candidateIndex,
                attemptedCount: routingGroup.attemptedCount,
                routeRevision: routingGroup.routeRevision,
                state: recovery?.state ?? (routingStatus.enabled ? 'unseen' : 'disabled'),
                switchAttempts: recovery?.switchAttempts ?? 0,
                retryAt: recovery?.retryAtSet ? recovery.retryAt : null,
                timerPending: recovery?.timerHandle !== null && recovery?.timerHandle !== undefined,
            } satisfies CdnRecoveryGroupStatus
        })
        return {
            enabled: routingStatus.enabled,
            contextEpoch: routingStatus.contextEpoch,
            generation: routingStatus.generation,
            groupCount: groups.length,
            activeGroupCount: groups.filter(group => (
                group.state !== 'disabled' && group.state !== 'unseen'
            )).length,
            groups,
        }
    }

    function getActiveStates() {
        return getStatus().groups.filter(group => (
            group.state !== 'disabled' && group.state !== 'unseen'
        ))
    }

    function resetAllStates() {
        for (const group of groupsById.values()) invalidateGraceTimer(group)
        groupsById = new Map()
    }

    function invalidateGraceTimer(group: GroupRecoveryRuntime) {
        const handle = group.timerHandle
        group.timerHandle = null
        group.timerRevision += 1
        group.confirmationAnchorSeconds = null
        group.confirmationDueAt = null
        if (handle === null) return
        try {
            cancelTimeout(handle)
        } catch {
            // The revision fence remains authoritative if the host timer cannot be cancelled.
        }
    }

    function cancelConfirmation(group: GroupRecoveryRuntime) {
        invalidateGraceTimer(group)
        group.confirmationAnchorSeconds = null
        group.confirmationDueAt = null
    }

    return {
        publishGroups,
        setEnabled,
        beginContext,
        prepareExactUrl,
        routeExactUrl,
        samplePlayback,
        getStatus,
        getActiveStates,
    }
}

function settledRecoveryPreparation(decision: CdnMediaRouteDecision): PreparedCdnMediaRoute {
    return {
        eligible: false,
        decision,
        commit: () => decision,
        discard() { },
    }
}

function createGroupRecoveryRuntime(
    groupId: number,
    key: string,
    kind: CdnCandidateGroupKind,
    contextEpoch: number,
    generation: number,
    candidateCount: number,
    enabled: boolean,
    activation: RouteActivation | null,
): GroupRecoveryRuntime {
    return {
        groupId,
        key,
        kind,
        contextEpoch,
        generation,
        candidateCount,
        state: !enabled ? 'disabled' : activation ? 'monitoring' : 'unseen',
        activation,
        switchAttempts: 0,
        retryAt: 0,
        retryAtSet: false,
        timerRevision: 0,
        timerHandle: null,
        confirmationAnchorSeconds: null,
        confirmationDueAt: null,
        latestSignals: null,
        latestSampleAt: null,
        lastProcessedFingerprint: null,
        lastProcessedRouteRevision: activation?.routeRevision ?? null,
        stableStartAt: null,
        stableLastAt: null,
        stableLastCurrentTimeSeconds: null,
    }
}

function disableGroup(group: GroupRecoveryRuntime) {
    resetGroupToUnseen(group)
    group.state = 'disabled'
}

function resetGroupToUnseen(group: GroupRecoveryRuntime) {
    group.activation = null
    group.state = 'unseen'
    group.switchAttempts = 0
    group.retryAt = 0
    group.retryAtSet = false
    group.latestSignals = null
    group.latestSampleAt = null
    group.lastProcessedFingerprint = null
    group.lastProcessedRouteRevision = null
    clearStableWindow(group)
}

function beginStableWindow(group: GroupRecoveryRuntime, sampledAt: number, currentTime: number) {
    group.stableStartAt = sampledAt
    group.stableLastAt = sampledAt
    group.stableLastCurrentTimeSeconds = currentTime
}

function clearStableWindow(group: GroupRecoveryRuntime) {
    group.stableStartAt = null
    group.stableLastAt = null
    group.stableLastCurrentTimeSeconds = null
}

function isEligibleLowBuffer(signals: PlaybackSignals, timing: CdnRecoveryTiming) {
    const currentTime = finiteNumber(signals.currentTimeSeconds)
    const bufferedAhead = finiteNumber(signals.bufferedAheadSeconds)
    if (currentTime === null || bufferedAhead === null || invalidDuration(signals.durationSeconds)) return false
    return signals.visible
        && !signals.paused
        && !signals.seeking
        && !signals.ended
        && !isNearEnd(currentTime, signals.durationSeconds)
        && bufferedAhead <= timing.lowBufferThresholdSeconds
}

function stablePlaybackTime(signals: PlaybackSignals, timing: CdnRecoveryTiming) {
    const currentTime = finiteNumber(signals.currentTimeSeconds)
    const bufferedAhead = finiteNumber(signals.bufferedAheadSeconds)
    if (currentTime === null || bufferedAhead === null || invalidDuration(signals.durationSeconds)) return null
    if (!signals.visible || signals.paused || signals.seeking || signals.ended
        || isNearEnd(currentTime, signals.durationSeconds)
        || bufferedAhead < timing.stableBufferThresholdSeconds) return null
    return currentTime
}

function invalidDuration(durationSeconds: number | null) {
    return durationSeconds !== null && finiteNumber(durationSeconds) === null
}

function isNearEnd(currentTimeSeconds: number, durationSeconds: number | null) {
    return durationSeconds !== null
        && durationSeconds - currentTimeSeconds <= 0.5
}

function switchCooldownMs(attempt: number, timing: CdnRecoveryTiming) {
    const exponent = Math.max(0, attempt - 1)
    const backoff = Math.min(
        timing.retryBackoffBaseMs * (2 ** exponent),
        timing.retryBackoffCapMs,
    )
    return Math.max(timing.minimumSwitchCooldownMs, backoff)
}

function normalizeTiming(overrides: Partial<CdnRecoveryTiming> | undefined): CdnRecoveryTiming {
    return {
        lowBufferThresholdSeconds: nonNegativeFinite(
            overrides?.lowBufferThresholdSeconds,
            DEFAULT_CDN_RECOVERY_TIMING.lowBufferThresholdSeconds,
        ),
        progressRestartSeconds: positiveFinite(
            overrides?.progressRestartSeconds,
            DEFAULT_CDN_RECOVERY_TIMING.progressRestartSeconds,
        ),
        confirmationGraceMs: nonNegativeFinite(
            overrides?.confirmationGraceMs,
            DEFAULT_CDN_RECOVERY_TIMING.confirmationGraceMs,
        ),
        minimumSwitchCooldownMs: nonNegativeFinite(
            overrides?.minimumSwitchCooldownMs,
            DEFAULT_CDN_RECOVERY_TIMING.minimumSwitchCooldownMs,
        ),
        retryBackoffBaseMs: nonNegativeFinite(
            overrides?.retryBackoffBaseMs,
            DEFAULT_CDN_RECOVERY_TIMING.retryBackoffBaseMs,
        ),
        retryBackoffCapMs: nonNegativeFinite(
            overrides?.retryBackoffCapMs,
            DEFAULT_CDN_RECOVERY_TIMING.retryBackoffCapMs,
        ),
        stableBufferThresholdSeconds: nonNegativeFinite(
            overrides?.stableBufferThresholdSeconds,
            DEFAULT_CDN_RECOVERY_TIMING.stableBufferThresholdSeconds,
        ),
        stablePlaybackResetMs: nonNegativeFinite(
            overrides?.stablePlaybackResetMs,
            DEFAULT_CDN_RECOVERY_TIMING.stablePlaybackResetMs,
        ),
        activeSampleIntervalMs: positiveFinite(
            overrides?.activeSampleIntervalMs,
            DEFAULT_CDN_RECOVERY_TIMING.activeSampleIntervalMs,
        ),
    }
}

function positiveFinite(value: number | undefined, fallback: number) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function nonNegativeFinite(value: number | undefined, fallback: number) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

function finiteNumber(value: number | null) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function safeNow(now: () => number) {
    try {
        const value = now()
        return Number.isFinite(value) ? value : 0
    } catch {
        return 0
    }
}

function readEnabledGuard(isEnabled: () => boolean) {
    try {
        return isEnabled() === true
    } catch {
        return false
    }
}

function copySignals(signals: PlaybackSignals): PlaybackSignals {
    return {
        visible: signals.visible,
        paused: signals.paused,
        seeking: signals.seeking,
        ended: signals.ended,
        currentTimeSeconds: signals.currentTimeSeconds,
        durationSeconds: signals.durationSeconds,
        bufferedAheadSeconds: signals.bufferedAheadSeconds,
    }
}

function sampleFingerprint(signals: PlaybackSignals) {
    return [
        signals.visible,
        signals.paused,
        signals.seeking,
        signals.ended,
        signals.currentTimeSeconds,
        signals.durationSeconds,
        signals.bufferedAheadSeconds,
    ].join('|')
}

function sameActivation(left: RouteActivation, right: RouteActivation) {
    return left.contextEpoch === right.contextEpoch
        && left.generation === right.generation
        && left.groupId === right.groupId
        && left.routeRevision === right.routeRevision
        && left.candidateIndex === right.candidateIndex
}

export const defaultCdnRecoveryCoordinator = createCdnRecoveryCoordinator({
    router: defaultCdnMediaRequestRouter,
})
export const publishCdnRecoveryGroups = defaultCdnRecoveryCoordinator.publishGroups
export const beginCdnRecoveryContext = defaultCdnRecoveryCoordinator.beginContext
export const routeCdnRecoveryRequestUrl = defaultCdnRecoveryCoordinator.routeExactUrl
export const sampleCdnRecoveryPlayback = defaultCdnRecoveryCoordinator.samplePlayback
export const getCdnRecoveryStatus = defaultCdnRecoveryCoordinator.getStatus
export const getActiveCdnRecoveryStates = defaultCdnRecoveryCoordinator.getActiveStates
