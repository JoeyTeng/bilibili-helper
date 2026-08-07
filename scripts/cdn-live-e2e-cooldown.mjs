/**
 * Assess a cooldown whose switch is observed only between two status samples.
 * The final deadline is authoritative; the exact switch instant is not.
 */
export function assessStage3InitialCooldown({
    retryAt,
    lastUnswitchedAt,
    firstSwitchedAt,
    minimumCooldownMs,
    maxObservationWindowMs,
}) {
    if (!Number.isFinite(lastUnswitchedAt) || !Number.isFinite(firstSwitchedAt)) {
        return {
            result: { status: 'INCONCLUSIVE', reason: 'cooldown-anchor-unavailable' },
            evidence: {},
        }
    }
    if (firstSwitchedAt < lastUnswitchedAt) {
        return {
            result: { status: 'INCONCLUSIVE', reason: 'cooldown-observation-clock-invalid' },
            evidence: {},
        }
    }

    // The switch happened in (lastUnswitchedAt, firstSwitchedAt]. Requiring a
    // fresh full cooldown from the right edge would reject every detected
    // switch. Bound the observation gap and use the authoritative pre-switch
    // sample as the conservative deadline anchor.
    const observationWindowMs = firstSwitchedAt - lastUnswitchedAt
    const cooldownRemainingAtDetectionMs = Number.isFinite(retryAt)
        ? retryAt - firstSwitchedAt
        : null
    const requiredRemainingAtDetectionMs = minimumCooldownMs - observationWindowMs
    const evidence = {
        cooldownLastUnswitchedAt: lastUnswitchedAt,
        cooldownFirstSwitchedAt: firstSwitchedAt,
        cooldownObservationWindowMs: observationWindowMs,
        cooldownRetryAt: retryAt,
        cooldownRemainingAtDetectionMs,
        cooldownRequiredRemainingAtDetectionMs: requiredRemainingAtDetectionMs,
    }
    if (!Number.isFinite(retryAt)
        || retryAt < lastUnswitchedAt + minimumCooldownMs) {
        return {
            result: { status: 'FAIL', reason: 'cooldown-not-installed' },
            evidence,
        }
    }
    if (observationWindowMs > maxObservationWindowMs) {
        return {
            result: { status: 'INCONCLUSIVE', reason: 'cooldown-observation-gap' },
            evidence,
        }
    }
    return { result: null, evidence }
}
