#!/usr/bin/env node

import assert from 'node:assert/strict'
import { assessStage3InitialCooldown } from './cdn-live-e2e-cooldown.mjs'

const base = {
    minimumCooldownMs: 15_000,
    maxObservationWindowMs: 2_700,
}

assert.deepEqual(
    assess({ retryAt: 16_000, lastUnswitchedAt: null, firstSwitchedAt: 1_000 }).result,
    { status: 'INCONCLUSIVE', reason: 'cooldown-anchor-unavailable' },
)
assert.deepEqual(
    assess({ retryAt: 16_000, lastUnswitchedAt: 1_100, firstSwitchedAt: 1_000 }).result,
    { status: 'INCONCLUSIVE', reason: 'cooldown-observation-clock-invalid' },
)
assert.deepEqual(
    assess({ retryAt: 16_000, lastUnswitchedAt: 0, firstSwitchedAt: 2_701 }).result,
    { status: 'INCONCLUSIVE', reason: 'cooldown-observation-gap' },
)
assert.deepEqual(
    assess({ retryAt: null, lastUnswitchedAt: 0, firstSwitchedAt: 2_701 }).result,
    { status: 'FAIL', reason: 'cooldown-not-installed' },
)
assert.deepEqual(
    assess({ retryAt: 14_999, lastUnswitchedAt: 0, firstSwitchedAt: 2_701 }).result,
    { status: 'FAIL', reason: 'cooldown-not-installed' },
)

const detectedAfterSwitch = assess({
    retryAt: 16_000,
    lastUnswitchedAt: 1_000,
    firstSwitchedAt: 1_450,
})
assert.equal(detectedAfterSwitch.result, null)
assert.equal(detectedAfterSwitch.evidence.cooldownRemainingAtDetectionMs, 14_550)
assert.equal(detectedAfterSwitch.evidence.cooldownRequiredRemainingAtDetectionMs, 14_550)

assert.equal(assess({
    retryAt: 16_000,
    lastUnswitchedAt: 1_000,
    firstSwitchedAt: 3_700,
}).result, null)
assert.deepEqual(
    assess({ retryAt: 15_999, lastUnswitchedAt: 1_000, firstSwitchedAt: 3_700 }).result,
    { status: 'FAIL', reason: 'cooldown-not-installed' },
)

assert.deepEqual(
    assess({ retryAt: 15_999, lastUnswitchedAt: 1_000, firstSwitchedAt: 1_450 }).result,
    { status: 'FAIL', reason: 'cooldown-not-installed' },
)
assert.deepEqual(
    assess({ retryAt: null, lastUnswitchedAt: 1_000, firstSwitchedAt: 1_450 }).result,
    { status: 'FAIL', reason: 'cooldown-not-installed' },
)

console.log('CDN live E2E cooldown assessment tests passed')

function assess(values) {
    return assessStage3InitialCooldown({ ...base, ...values })
}
