import { balh_config } from '../../feature/config'
import type { CdnCandidateGroup } from './cdn_selection'
import { createCdnRecoveryCoordinator } from './cdn_recovery'
import type {
    CdnRecoveryStatus,
    PlaybackSignals,
} from './cdn_recovery'
import type {
    CdnMediaRouteDecision,
    PreparedCdnMediaRoute,
} from './cdn_media_request_routing'
import { createPlayerStallMonitor } from './player_stall_monitor'
import type { PlayerStallMonitor } from './player_stall_monitor'

const EMPTY_RECOVERY_STATUS: Readonly<CdnRecoveryStatus> = Object.freeze({
    enabled: false,
    contextEpoch: 0,
    generation: 0,
    groupCount: 0,
    activeGroupCount: 0,
    groups: Object.freeze([]),
})

let defaultMonitor: PlayerStallMonitor | null = null
let installingMonitor = false
let publicationAllowsRecovery = false

function isAutoRecoveryEnabled() {
    try {
        return !balh_config.is_closed && balh_config.cdn_mode === 'auto'
    } catch {
        return false
    }
}

function isRecoveryEnabled() {
    return publicationAllowsRecovery && isAutoRecoveryEnabled()
}

const recoveryCoordinator = createCdnRecoveryCoordinator({
    isEnabled: isRecoveryEnabled,
})

function synchronizeRecoveryEnabled() {
    try {
        recoveryCoordinator.setEnabled(isRecoveryEnabled())
    } catch {
        // The browser adapter must not affect the predecessor request or playback.
    }
}

function isSynchronizedRecoveryEnabled() {
    synchronizeRecoveryEnabled()
    return isRecoveryEnabled()
}

function wakeDefaultMonitor() {
    try {
        defaultMonitor?.wake()
    } catch {
        // Recovery is optional; routing and playback must remain fail-open.
    }
}

function synchronizeDefaultMonitorContext() {
    try {
        defaultMonitor?.synchronizeContext()
    } catch {
        // Context synchronization is optional and must not affect native acceptance.
    }
}

/** Publish the final delivered candidate groups and wake the browser adapter. */
export function publishCdnRecoveryGroups(
    groups: readonly CdnCandidateGroup[],
    enabled: boolean,
): CdnRecoveryStatus {
    publicationAllowsRecovery = enabled === true
    try {
        return recoveryCoordinator.publishGroups(groups, isRecoveryEnabled())
    } catch {
        publicationAllowsRecovery = false
        synchronizeRecoveryEnabled()
        return getCdnRecoveryStatus()
    } finally {
        wakeDefaultMonitor()
    }
}

export function beginCdnRecoveryContext(): CdnRecoveryStatus {
    synchronizeRecoveryEnabled()
    try {
        return recoveryCoordinator.beginContext()
    } catch {
        return getCdnRecoveryStatus()
    }
}

/** Prepare a future exact GET without observing it until the predecessor accepts it. */
export function prepareCdnRecoveryRequestUrl(
    url: string,
    method = 'GET',
): PreparedCdnMediaRoute {
    synchronizeRecoveryEnabled()
    let eligibility: PreparedCdnMediaRoute
    try {
        // Eligibility comes from the router's authoritative reverse index and
        // is side-effect free until commit. Unrelated GETs never touch the DOM.
        eligibility = recoveryCoordinator.prepareExactUrl(url, method)
    } catch {
        return settledPreparation({ url, routed: false })
    }
    if (!eligibility.eligible) return eligibility
    eligibility.discard()

    // Synchronize a replaced player before this request can become the first
    // activation in its new playback context. Re-prepare after synchronization so a
    // cleared or newly installed override cannot leak across that boundary.
    synchronizeDefaultMonitorContext()
    let prepared: PreparedCdnMediaRoute
    try {
        prepared = recoveryCoordinator.prepareExactUrl(url, method)
    } catch {
        return settledPreparation({ url, routed: false })
    }
    if (!prepared.eligible) return prepared

    let state: 'pending' | 'committed' | 'discarded' = 'pending'
    let committedDecision = prepared.decision
    return {
        eligible: true,
        decision: prepared.decision,
        commit() {
            if (state !== 'pending') return committedDecision
            state = 'committed'
            try {
                // Native Fetch/XHR acceptance can synchronously run page code.
                // Linearize player identity before route commit without sampling
                // playback: a stable-window sample here could cancel the pending
                // route that the predecessor has already accepted.
                synchronizeDefaultMonitorContext()
                const acceptedDecision = prepared.decision
                let observation = prepared.commit()
                if (!observation.activation) {
                    const current = recoveryCoordinator.prepareExactUrl(
                        acceptedDecision.url,
                        method,
                    )
                    if (current.decision.url === acceptedDecision.url) {
                        observation = current.commit()
                    } else {
                        current.discard()
                    }
                }
                committedDecision = observation.activation
                    ? { ...acceptedDecision, activation: observation.activation }
                    : acceptedDecision
            } catch {
                committedDecision = prepared.decision
            } finally {
                wakeDefaultMonitor()
            }
            return committedDecision
        },
        discard() {
            if (state !== 'pending') return
            state = 'discarded'
            try {
                prepared.discard()
            } catch {
                // Discarding an optional prepared route must remain fail-open.
            }
        },
    }
}

/** Observe and, when recovery has advanced, route one future exact GET. */
export function routeCdnRecoveryRequestUrl(
    url: string,
    method = 'GET',
): CdnMediaRouteDecision {
    return prepareCdnRecoveryRequestUrl(url, method).commit()
}

export function sampleCdnRecoveryPlayback(
    signals: PlaybackSignals | null,
): CdnRecoveryStatus {
    synchronizeRecoveryEnabled()
    try {
        return recoveryCoordinator.samplePlayback(signals)
    } catch {
        return getCdnRecoveryStatus()
    }
}

/** Return structural recovery state only; exact signed URLs are never exposed. */
export function getCdnRecoveryStatus(): CdnRecoveryStatus {
    synchronizeRecoveryEnabled()
    try {
        return recoveryCoordinator.getStatus()
    } catch {
        return EMPTY_RECOVERY_STATUS
    }
}

/** Install the singleton DOM/video adapter without stacking listeners or timers. */
export function installCdnRecoveryMonitor(): PlayerStallMonitor | null {
    if (defaultMonitor || installingMonitor) return defaultMonitor

    installingMonitor = true
    let candidate: PlayerStallMonitor | null = null
    try {
        candidate = createPlayerStallMonitor({
            sample: sampleCdnRecoveryPlayback,
            beginContext: beginCdnRecoveryContext,
            isActive: () => getCdnRecoveryStatus().activeGroupCount > 0,
            isEnabled: isSynchronizedRecoveryEnabled,
        })
        defaultMonitor = candidate
        candidate.start()
        return candidate
    } catch {
        if (defaultMonitor === candidate) defaultMonitor = null
        try {
            candidate?.dispose()
        } catch {
            // A failed optional adapter must not affect page initialization.
        }
        return null
    } finally {
        installingMonitor = false
    }
}

function settledPreparation(decision: CdnMediaRouteDecision): PreparedCdnMediaRoute {
    return {
        eligible: false,
        decision,
        commit: () => decision,
        discard: () => undefined,
    }
}
