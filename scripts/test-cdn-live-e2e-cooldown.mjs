#!/usr/bin/env node

import assert from 'node:assert/strict'
import { assessStage3InitialCooldown } from './cdn-live-e2e-cooldown.mjs'
import {
    assessStage3AcceptedRouteWindow,
    assessStage3CommitCausality,
    assessStage3CommittedCooldown,
    assessStage3CommittedRouteBoundary,
    assessStage3FutureRouteObservation,
    assessStage3RouteBoundary,
    advanceStage3StableObservation,
    classifyStage3FutureRouteTimeout,
    classifyStage3ObservedIntentBoundary,
    installStage3CapabilityHooks,
    restartStage3StableObservation,
} from './test-cdn-live-e2e.mjs'

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

// This only proves the provisional intent cooldown. The exact commit-boundary
// assertion below is the separate authority for the post-commit deadline.
assert.equal(assess({
    retryAt: 20_000,
    lastUnswitchedAt: 5_000,
    firstSwitchedAt: 5_450,
}).result, null)
assert.deepEqual(
    assess({ retryAt: 19_999, lastUnswitchedAt: 5_000, firstSwitchedAt: 5_450 }).result,
    { status: 'FAIL', reason: 'cooldown-not-installed' },
)

const selected = {
    groupIndex: 0,
    initialCandidateIndex: 0,
    initialAttemptedCount: 1,
    initialRouteRevision: 4,
    initialSwitchAttempts: 2,
}
const pendingIntent = {
    candidateIndex: 0,
    pendingCandidateIndex: 1,
    attemptedCount: 1,
    routeRevision: 5,
    switchAttempts: 3,
    routeCommittedAt: null,
    retryAt: 20_000,
}
const committedRoute = {
    ...pendingIntent,
    candidateIndex: 1,
    pendingCandidateIndex: null,
    attemptedCount: 2,
    routeCommittedAt: 5_450,
    retryAt: 25_000,
}

assert.equal(assessStage3CommittedCooldown({
    retryAt: 20_450,
    routeCommittedAt: 5_450,
    minimumCooldownMs: 15_000,
}).result, null)
assert.deepEqual(assessStage3CommittedCooldown({
    retryAt: 20_000,
    routeCommittedAt: 5_450,
    minimumCooldownMs: 15_000,
}).result, {
    status: 'FAIL',
    reason: 'cooldown-not-installed',
    evidence: {},
})
assert.deepEqual(assessStage3CommittedCooldown({
    retryAt: 20_450,
    routeCommittedAt: null,
    minimumCooldownMs: 15_000,
}).result, {
    status: 'INCONCLUSIVE',
    reason: 'commit-cooldown-anchor-unavailable',
    evidence: {},
})

assert.deepEqual(assessStage3RouteBoundary(selected, pendingIntent), {
    phase: 'pending-intent',
    pendingCandidateIndex: 1,
    committedCandidateIndex: null,
})
assert.deepEqual(assessStage3RouteBoundary(selected, committedRoute), {
    phase: 'committed-route',
    pendingCandidateIndex: null,
    committedCandidateIndex: 1,
})
assert.deepEqual(classifyStage3ObservedIntentBoundary(
    assessStage3RouteBoundary(selected, committedRoute),
), {
    status: 'INCONCLUSIVE',
    reason: 'route-commit-causality-unproven',
    evidence: {},
})
assert.deepEqual(assessStage3RouteBoundary(selected, {
    ...pendingIntent,
    routeRevision: 6,
    switchAttempts: 4,
}), {
    phase: 'invalid',
    reason: 'route-changed-before-fault-window',
})

const stableReset = {
    ...committedRoute,
    attemptedCount: 1,
    routeRevision: 6,
    switchAttempts: 0,
}
assert.deepEqual(assessStage3CommittedRouteBoundary(
    selected,
    stableReset,
    committedRoute,
), {
    phase: 'committed-route',
    pendingCandidateIndex: null,
    committedCandidateIndex: 1,
    stableReset: true,
})
assert.equal(assessStage3CommittedRouteBoundary(selected, {
    ...stableReset,
    routeRevision: 7,
}, committedRoute).phase, 'invalid')
assert.deepEqual(assessStage3CommittedRouteBoundary(selected, {
    ...stableReset,
    retryAt: 40_000,
}, committedRoute), {
    phase: 'invalid',
    reason: 'cooldown-not-held',
})
assert.deepEqual(assessStage3CommittedRouteBoundary(selected, {
    ...stableReset,
    retryAt: 24_999,
}, committedRoute), {
    phase: 'invalid',
    reason: 'cooldown-not-held',
})
assert.deepEqual(assessStage3CommittedRouteBoundary(selected, {
    ...stableReset,
    routeCommittedAt: 5_451,
}, committedRoute), {
    phase: 'invalid',
    reason: 'cooldown-not-held',
})

const emptyStableObservation = {
    startedAt: null,
    lastAt: null,
    lastCurrentTimeSeconds: null,
    proved: false,
}
const stableSignals = {
    visible: true,
    paused: false,
    seeking: false,
    ended: false,
    currentTimeSeconds: 10,
    durationSeconds: 100,
    bufferedAheadSeconds: 3,
}
const stableStarted = advanceStage3StableObservation(emptyStableObservation, {
    now: 1_000,
    signals: stableSignals,
})
let stableProved = stableStarted
for (let now = 1_500; now <= 6_000; now += 500) {
    stableProved = advanceStage3StableObservation(stableProved, {
        now,
        signals: {
            ...stableSignals,
            currentTimeSeconds: 10 + ((now - 1_000) / 1_000),
        },
    })
    if (now < 6_000) assert.equal(stableProved.proved, false)
}
assert.equal(stableProved.proved, true)
const gappedStable = advanceStage3StableObservation(stableStarted, {
    now: 2_000,
    signals: { ...stableSignals, currentTimeSeconds: 11 },
})
assert.equal(gappedStable.startedAt, 2_000)
assert.equal(gappedStable.proved, false)
const restartedAtCommit = restartStage3StableObservation({
    now: 6_000,
    signals: { ...stableSignals, currentTimeSeconds: 11 },
})
assert.equal(restartedAtCommit.proved, false)
let postCommitStable = restartedAtCommit
for (let now = 6_500; now <= 11_000; now += 500) {
    postCommitStable = advanceStage3StableObservation(postCommitStable, {
        now,
        signals: {
            ...stableSignals,
            currentTimeSeconds: 11 + ((now - 6_000) / 1_000),
        },
    })
    if (now < 11_000) assert.equal(postCommitStable.proved, false)
}
assert.equal(postCommitStable.proved, true)
assert.equal(advanceStage3StableObservation(stableProved, {
    now: 6_100,
    signals: { ...stableSignals, paused: true },
}).proved, false)

const pendingOnly = assessFuture(pendingIntent, [])
assert.equal(pendingOnly.result, null)
assert.equal(pendingOnly.alternateCandidateIndex, null)
assert.equal(pendingOnly.alternateStarted, false)
assert.equal(pendingOnly.routeCommitted, false)
assert.deepEqual(classifyStage3FutureRouteTimeout({
    alternateStarted: pendingOnly.alternateStarted,
    routeCommitted: pendingOnly.routeCommitted,
    alternateResponded: pendingOnly.alternateResponded,
    signalsUnavailable: false,
    resumeAnchor: null,
}), {
    status: 'INCONCLUSIVE',
    reason: 'no-interceptable-future-request',
    evidence: {},
})

const committedWithoutRequest = assessFuture(committedRoute, [])
assert.equal(committedWithoutRequest.routeCommitted, true)
assert.equal(committedWithoutRequest.alternateStarted, false)
assert.equal(committedWithoutRequest.alternateCandidateIndex, 1)
assert.equal(classifyStage3FutureRouteTimeout({
    alternateStarted: false,
    routeCommitted: true,
    alternateResponded: false,
    signalsUnavailable: false,
    resumeAnchor: null,
}).status, 'INCONCLUSIVE')

const acceptedAlternate = {
    groupIndex: 0,
    candidateIndex: 1,
    transport: 'xhr',
    sequence: 21,
    acceptedAt: 5_450,
}
const causalCommit = assessStage3CommitCausality({
    acceptedCalls: [acceptedAlternate],
    selected,
    committedCandidateIndex: 1,
    afterAcceptedSequence: 20,
    acceptedSequenceAtStatus: 21,
    routeCommittedAt: 5_450,
    observedAt: 5_600,
})
assert.equal(causalCommit.result, null)
assert.deepEqual(causalCommit.acceptedCall, acceptedAlternate)
assert.deepEqual(assessStage3CommitCausality({
    acceptedCalls: [],
    selected,
    committedCandidateIndex: 1,
    afterAcceptedSequence: 20,
    acceptedSequenceAtStatus: 21,
    routeCommittedAt: 5_450,
    observedAt: 5_600,
}).result, {
    status: 'INCONCLUSIVE',
    reason: 'route-commit-causality-unproven',
    evidence: {},
})
assert.deepEqual(assessStage3CommitCausality({
    acceptedCalls: [{ ...acceptedAlternate, acceptedAt: 5_500 }],
    selected,
    committedCandidateIndex: 1,
    afterAcceptedSequence: 20,
    acceptedSequenceAtStatus: 21,
    routeCommittedAt: 5_450,
    observedAt: 5_600,
}).result, {
    status: 'INCONCLUSIVE',
    reason: 'route-commit-causality-unproven',
    evidence: {},
})
assert.deepEqual(assessStage3CommitCausality({
    acceptedCalls: [acceptedAlternate],
    selected,
    committedCandidateIndex: 1,
    afterAcceptedSequence: 20,
    acceptedSequenceAtStatus: 20,
    routeCommittedAt: 5_450,
    observedAt: 5_600,
}).result, {
    status: 'INCONCLUSIVE',
    reason: 'route-commit-causality-unproven',
    evidence: {},
})
assert.deepEqual(assessStage3CommitCausality({
    acceptedCalls: [{ ...acceptedAlternate, candidateIndex: 0 }],
    selected,
    committedCandidateIndex: 1,
    afterAcceptedSequence: 20,
    acceptedSequenceAtStatus: 21,
    routeCommittedAt: 5_450,
    observedAt: 5_600,
}).result, {
    status: 'FAIL',
    reason: 'future-route-unchanged',
    evidence: {},
})
assert.equal(assessStage3AcceptedRouteWindow({
    acceptedCalls: [acceptedAlternate],
    selected,
    committedCandidateIndex: 1,
    afterAcceptedSequence: acceptedAlternate.sequence,
    observedAt: 10_000,
}), null)
assert.deepEqual(assessStage3AcceptedRouteWindow({
    acceptedCalls: [
        acceptedAlternate,
        { ...acceptedAlternate, candidateIndex: 0, sequence: 22, acceptedAt: 9_995 },
    ],
    selected,
    committedCandidateIndex: 1,
    afterAcceptedSequence: acceptedAlternate.sequence,
    observedAt: 10_000,
}), {
    status: 'FAIL',
    reason: 'cooldown-route-changed',
    evidence: {},
})

const alternateRequest = {
    sequence: 11,
    startedAt: 5_450,
    match: { groupIndex: 0, candidateIndex: 1 },
    responded: true,
    responseOk: true,
    failed: false,
}
const committedWithRequest = assessFuture(committedRoute, [alternateRequest], {
    recordStartedAfter: 5_000,
    recordStartedBy: 7_700,
})
assert.equal(committedWithRequest.result, null)
assert.equal(committedWithRequest.alternateStarted, true)
assert.equal(committedWithRequest.alternateResponded, true)
assert.equal(committedWithRequest.routeCommitted, true)
assert.equal(committedWithRequest.alternateCandidateIndex, 1)
assert.equal(committedWithRequest.alternateRequestStartedAt, 5_450)

const stableResetWithRequest = assessFuture(stableReset, [alternateRequest], {
    recordStartedAfter: 5_000,
    recordStartedBy: 7_700,
    committedStatus: committedRoute,
})
assert.equal(stableResetWithRequest.result, null)
assert.equal(stableResetWithRequest.boundary.stableReset, true)

const lateUnrelatedRequest = assessFuture(committedRoute, [{
    ...alternateRequest,
    startedAt: 7_701,
}], {
    recordStartedAfter: 5_000,
    recordStartedBy: 7_700,
})
assert.equal(lateUnrelatedRequest.routeCommitted, true)
assert.equal(lateUnrelatedRequest.alternateStarted, false)

const requestBeforeCommit = assessFuture(pendingIntent, [alternateRequest])
assert.equal(requestBeforeCommit.alternateStarted, true)
assert.equal(requestBeforeCommit.routeCommitted, false)
assert.deepEqual(classifyStage3FutureRouteTimeout({
    alternateStarted: true,
    routeCommitted: false,
    alternateResponded: true,
    signalsUnavailable: false,
    resumeAnchor: 1,
}), {
    status: 'FAIL',
    reason: 'alternate-route-not-committed',
    evidence: {},
})

const wrongAlternate = assessFuture(pendingIntent, [{
    ...alternateRequest,
    match: { groupIndex: 0, candidateIndex: 2 },
}])
assert.deepEqual(wrongAlternate.result, {
    status: 'FAIL',
    reason: 'future-route-intent-mismatch',
    evidence: {},
})

testCapabilityHookFailOpen()

console.log('CDN live E2E cooldown and route classifier tests passed')

function testCapabilityHookFailOpen() {
    const originalWindow = globalThis.window
    const originalDateNow = Date.now
    const targetUrl = 'https://candidate.example/video.m4s?token=private'
    let hookNumber = 0

    const install = ({ fetchImpl, openImpl }) => {
        class FakeXMLHttpRequest { }
        Object.defineProperty(FakeXMLHttpRequest.prototype, 'open', {
            configurable: true,
            enumerable: false,
            writable: true,
            value: openImpl,
        })
        const fakeWindow = {
            fetch: fetchImpl,
            XMLHttpRequest: FakeXMLHttpRequest,
            location: { protocol: 'https:' },
        }
        const symbolName = `balh.stage3.test.${++hookNumber}`
        globalThis.window = fakeWindow
        installStage3CapabilityHooks(symbolName, 16)
        const hook = fakeWindow[Symbol.for(symbolName)]
        hook.configure([[targetUrl]])
        return { fakeWindow, hook, FakeXMLHttpRequest }
    }

    try {
        const rejected = Promise.reject(new Error('synthetic rejection'))
        rejected.catch(() => { })
        const fetchAccepted = install({
            fetchImpl: () => rejected,
            openImpl() { return undefined },
        })
        assert.strictEqual(fetchAccepted.fakeWindow.fetch(targetUrl), rejected)
        assert.equal(fetchAccepted.hook.snapshot().acceptedCalls.length, 1)
        assert.equal(fetchAccepted.hook.snapshot().observationFailed, false)

        const fetchError = new Error('synthetic fetch throw')
        const fetchRejectedSynchronously = install({
            fetchImpl: () => { throw fetchError },
            openImpl() { return undefined },
        })
        assert.throws(
            () => fetchRejectedSynchronously.fakeWindow.fetch(targetUrl),
            error => error === fetchError,
        )
        assert.equal(fetchRejectedSynchronously.hook.snapshot().acceptedCalls.length, 0)

        const fetchMarker = {}
        const fetchObservationFailure = install({
            fetchImpl: () => fetchMarker,
            openImpl() { return undefined },
        })
        Date.now = () => { throw new Error('synthetic clock failure') }
        assert.strictEqual(fetchObservationFailure.fakeWindow.fetch(targetUrl), fetchMarker)
        assert.equal(fetchObservationFailure.hook.snapshot().observationFailed, true)
        Date.now = originalDateNow

        const xhrMarker = {}
        const xhrObservationFailure = install({
            fetchImpl: () => Promise.resolve(),
            openImpl() { return xhrMarker },
        })
        Date.now = () => { throw new Error('synthetic clock failure') }
        const xhr = new xhrObservationFailure.FakeXMLHttpRequest()
        assert.strictEqual(xhr.open('GET', targetUrl), xhrMarker)
        assert.equal(xhrObservationFailure.hook.snapshot().observationFailed, true)
        Date.now = originalDateNow

        const xhrError = new Error('synthetic XHR open throw')
        const xhrRejectedSynchronously = install({
            fetchImpl: () => Promise.resolve(),
            openImpl() { throw xhrError },
        })
        const rejectedXhr = new xhrRejectedSynchronously.FakeXMLHttpRequest()
        assert.throws(() => rejectedXhr.open('GET', targetUrl), error => error === xhrError)
        assert.equal(xhrRejectedSynchronously.hook.snapshot().acceptedCalls.length, 0)
    } finally {
        Date.now = originalDateNow
        if (originalWindow === undefined) delete globalThis.window
        else globalThis.window = originalWindow
    }
}

function assess(values) {
    return assessStage3InitialCooldown({ ...base, ...values })
}

function assessFuture(recovery, supportedRecords, overrides = {}) {
    return assessStage3FutureRouteObservation({
        supportedRecords,
        selected,
        recovery,
        intentStatus: pendingIntent,
        afterSequence: 10,
        ...overrides,
    })
}
