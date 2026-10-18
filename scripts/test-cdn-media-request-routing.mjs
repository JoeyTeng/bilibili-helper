#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(rootDir, '.codex-tmp/tests')
const outFile = path.join(outDir, 'cdn-media-request-routing.mjs')

await mkdir(outDir, { recursive: true })
await build({
    entryPoints: [path.join(
        rootDir,
        'packages/unblock-area-limit/src/feature/bili/cdn_media_request_routing.ts',
    )],
    outfile: outFile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
})

const {
    createCdnMediaRequestRouter,
} = await import(`${pathToFileURL(outFile).href}?t=${Date.now()}`)

const n1 = 'https://ordinary-a.example/media/video.m4s?token=N1%2Fexact&order=1'
const n2 = 'https://ordinary-b.example/media/video.m4s?token=N2%2Fexact&order=2'
const m1 = 'https://node-1.mcdn.bilivideo.cn/media/video.m4s?token=M1&os=mcdn'
const m2 = 'https://edge.szbdyd.com/media/video.m4s?token=M2'
const protocolRelative = '//ordinary-c.example/media/audio.m4s?token=P%2Fexact&order=3'
const protocolAlias = `https:${protocolRelative}`

{
    const router = makeRouter()
    const groups = [group('video', [n1, n2])]
    const firstPublication = router.publishGroups(groups, false)
    assert.equal(firstPublication.registryChanged, true)
    assert.equal(router.routeExactUrl(n1).url, n1)
    assert.equal(router.getStatus().activeGroupCount, 0)

    const generation = router.getStatus().generation
    const enabledPublication = router.publishGroups(groups, true)
    assert.equal(enabledPublication.registryChanged, false)
    assert.equal(enabledPublication.enabledChanged, true)
    assert.equal(router.getStatus().generation, generation)

    assert.deepEqual(router.routeExactUrl(n1, 'POST'), { url: n1, routed: false })
    assert.deepEqual(router.routeExactUrl(`${n1}&one-byte=1`), {
        url: `${n1}&one-byte=1`,
        routed: false,
    })
    assert.deepEqual(router.routeExactUrl(n1.replace('%2F', '%2f')), {
        url: n1.replace('%2F', '%2f'),
        routed: false,
    })
    assert.equal(router.getStatus().activeGroupCount, 0)

    const observed = router.routeExactUrl(n1, 'get')
    assert.equal(observed.url, n1)
    assert.equal(observed.routed, false)
    assert.ok(observed.activation)
    assert.equal(router.getStatus().groups[0].attemptedCount, 1)

    const repeated = router.publishGroups(groups, true)
    assert.equal(repeated.registryChanged, false)
    assert.equal(router.getStatus().groups[0].active, true)
    assert.equal(router.getStatus().groups[0].attemptedCount, 1)
}

{
    const router = makeRouter()
    router.publishGroups([group('protocol', [protocolRelative, n1])], true)

    const aliasDecision = router.routeExactUrl(protocolAlias)
    assert.equal(aliasDecision.url, protocolAlias)
    assert.equal(aliasDecision.routed, false)
    assert.equal(aliasDecision.activation.candidateIndex, 0)

    router.beginContext()
    const upstreamDecision = router.routeExactUrl(protocolRelative)
    assert.equal(upstreamDecision.url, protocolRelative)
    assert.equal(upstreamDecision.activation.candidateIndex, 0)

    router.beginContext()
    assert.deepEqual(router.routeExactUrl(`http:${protocolRelative}`), {
        url: `http:${protocolRelative}`,
        routed: false,
    })
}

{
    const crossGroup = makeRouter()
    crossGroup.publishGroups([
        group('video-a', [n1]),
        group('video-b', [n1]),
    ], true)
    assert.deepEqual(crossGroup.routeExactUrl(n1), { url: n1, routed: false })
    assert.equal(crossGroup.getStatus().activeGroupCount, 0)

    const withinGroup = makeRouter()
    withinGroup.publishGroups([group('duplicate', [n1, n1])], true)
    assert.deepEqual(withinGroup.routeExactUrl(n1), { url: n1, routed: false })

    const aliasCollision = makeRouter()
    aliasCollision.publishGroups([group('alias-collision', [protocolRelative, protocolAlias])], true)
    assert.deepEqual(aliasCollision.routeExactUrl(protocolAlias), {
        url: protocolAlias,
        routed: false,
    })
}

{
    const router = makeRouter()
    router.publishGroups([group('ordinary-before-risk', [n1, m1, n2])], true)
    const initial = router.routeExactUrl(n1)
    const initialRevision = initial.activation.routeRevision

    const toN2 = router.advanceRoute(initial.activation)
    assert.equal(toN2.accepted, true)
    assert.equal(toN2.advanced, true)
    assert.equal(toN2.activation.candidateIndex, 0)
    assert.equal(toN2.activation.routeRevision, initialRevision + 1)
    assert.deepEqual(
        committedRouteStatus(router),
        { candidateIndex: 0, pendingCandidateIndex: 2, attemptedCount: 1 },
    )
    assert.deepEqual(router.advanceRoute(initial.activation), {
        accepted: false,
        advanced: false,
        exhausted: false,
    })
    assert.deepEqual(router.advanceRoute(toN2.activation), {
        accepted: true,
        advanced: false,
        exhausted: false,
        activation: toN2.activation,
    })

    const discardedN2 = router.prepareExactUrl(n1)
    assert.equal(discardedN2.decision.url, n2)
    discardedN2.discard()
    assert.equal(discardedN2.commit().activation, undefined)
    assert.deepEqual(
        committedRouteStatus(router),
        { candidateIndex: 0, pendingCandidateIndex: 2, attemptedCount: 1 },
    )

    const n2Request = router.routeExactUrl(n1)
    assert.equal(n2Request.url, n2)
    assert.equal(n2Request.routed, true)
    assert.equal(n2Request.activation.routeRevision, toN2.activation.routeRevision)
    assert.deepEqual(
        committedRouteStatus(router),
        { candidateIndex: 2, pendingCandidateIndex: null, attemptedCount: 2 },
    )

    const toM1 = router.advanceRoute(n2Request.activation)
    assert.equal(toM1.activation.candidateIndex, 2)
    assert.deepEqual(
        committedRouteStatus(router),
        { candidateIndex: 2, pendingCandidateIndex: 1, attemptedCount: 2 },
    )
    assert.equal(router.advanceRoute(toM1.activation).exhausted, false)
    const m1Request = router.routeExactUrl(n1)
    assert.equal(m1Request.url, m1)
    assert.deepEqual(
        committedRouteStatus(router),
        { candidateIndex: 1, pendingCandidateIndex: null, attemptedCount: 3 },
    )

    const exhausted = router.advanceRoute(m1Request.activation)
    assert.equal(exhausted.accepted, true)
    assert.equal(exhausted.advanced, false)
    assert.equal(exhausted.exhausted, true)
    assert.equal(exhausted.activation.candidateIndex, 1)
    assert.equal(router.routeExactUrl(n1).url, m1)

    const reset = router.resetAfterStableRecovery(exhausted.activation)
    assert.equal(reset.accepted, true)
    assert.equal(router.getStatus().groups[0].attemptedCount, 1)
    const retainedM1 = router.routeExactUrl(n1)
    assert.equal(retainedM1.url, m1)
    const backToN1 = router.advanceRoute(retainedM1.activation)
    assert.equal(backToN1.activation.candidateIndex, 1)
    assert.equal(router.getStatus().groups[0].pendingCandidateIndex, 0)
    const preparedN1 = router.prepareExactUrl(n1)
    assert.equal(preparedN1.decision.url, n1)

    const preserveM1 = router.resetAfterStableRecovery(backToN1.activation)
    assert.equal(preserveM1.accepted, true)
    assert.deepEqual(
        committedRouteStatus(router),
        { candidateIndex: 1, pendingCandidateIndex: null, attemptedCount: 1 },
    )
    assert.equal(preparedN1.commit().activation, undefined)
    const stillM1 = router.routeExactUrl(n1)
    assert.equal(stillM1.url, m1)

    const retriedN1 = router.advanceRoute(stillM1.activation)
    assert.equal(router.getStatus().groups[0].pendingCandidateIndex, 0)
    assert.equal(router.routeExactUrl(n1).url, n1)
    assert.equal(retriedN1.activation.candidateIndex, 1)
}

{
    const allRiskRouter = makeRouter()
    allRiskRouter.publishGroups([group('all-risk', [m1, m2])], true)
    const first = allRiskRouter.routeExactUrl(m1)
    const pendingM2 = allRiskRouter.advanceRoute(first.activation)
    assert.equal(pendingM2.activation.candidateIndex, 0)
    assert.equal(allRiskRouter.getStatus().groups[0].pendingCandidateIndex, 1)
    assert.equal(allRiskRouter.routeExactUrl(m1).activation.candidateIndex, 1)

    const singleRouter = makeRouter()
    singleRouter.publishGroups([group('single', [n1])], true)
    const only = singleRouter.routeExactUrl(n1)
    const exhausted = singleRouter.advanceRoute(only.activation)
    assert.equal(exhausted.exhausted, true)
    assert.equal(exhausted.activation.candidateIndex, 0)
}

{
    const router = makeRouter()
    router.publishGroups([group('stable-before-commit', [n1, n2])], true)
    const initial = router.routeExactUrl(n1)
    const pending = router.advanceRoute(initial.activation)
    const preparedAlternate = router.prepareExactUrl(n1)
    assert.equal(preparedAlternate.decision.url, n2)

    const reset = router.resetAfterStableRecovery(pending.activation)
    assert.equal(reset.accepted, true)
    assert.deepEqual(
        committedRouteStatus(router),
        { candidateIndex: 0, pendingCandidateIndex: null, attemptedCount: 1 },
    )
    assert.equal(preparedAlternate.commit().activation, undefined)
    assert.equal(router.routeExactUrl(n1).url, n1)

    const retried = router.advanceRoute(reset.activation)
    assert.equal(retried.advanced, true)
    assert.equal(router.getStatus().groups[0].pendingCandidateIndex, 1)
    assert.equal(router.routeExactUrl(n1).activation.candidateIndex, 1)
}

{
    const router = makeRouter()
    router.publishGroups([group('stale-guard', [n1, n2])], true)
    const oldGenerationActivation = router.routeExactUrl(n1).activation
    const changedGroups = [group('stale-guard', [n1, `${n2}&generation=2`])]
    const oldGeneration = router.getStatus().generation
    router.publishGroups(changedGroups, true)
    assert.equal(router.getStatus().generation, oldGeneration + 1)
    assert.equal(router.advanceRoute(oldGenerationActivation).accepted, false)

    const oldContextActivation = router.routeExactUrl(n1).activation
    router.beginContext()
    assert.equal(router.advanceRoute(oldContextActivation).accepted, false)
    assert.equal(router.getStatus().activeGroupCount, 0)

    const beforeDisable = router.routeExactUrl(n1).activation
    router.publishGroups(changedGroups, false)
    router.publishGroups(changedGroups, true)
    assert.equal(router.advanceRoute(beforeDisable).accepted, false)
}

{
    const router = makeRouter()
    router.publishGroups([group('no-url-status', [n1, n2, m1])], true)
    router.routeExactUrl(n1)
    const serialized = JSON.stringify(router.getStatus())
    assert.doesNotMatch(serialized, /token=|\/media\/|https?:|ordinary-a\.example/)
    assert.match(serialized, /no-url-status/)
}

{
    const router = makeRouter()
    router.publishGroups([group('prepared-open', [n1, n2])], true)
    const discarded = router.prepareExactUrl(n1)
    assert.equal(discarded.decision.url, n1)
    assert.equal(router.getStatus().activeGroupCount, 0)
    discarded.discard()
    assert.equal(discarded.commit().activation, undefined)
    assert.equal(router.getStatus().activeGroupCount, 0)

    const committed = router.prepareExactUrl(n1)
    assert.equal(router.getStatus().activeGroupCount, 0)
    const activation = committed.commit().activation
    assert.ok(activation)
    assert.equal(router.getStatus().activeGroupCount, 1)
    assert.deepEqual(committed.commit().activation, activation)

    const stale = router.prepareExactUrl(n1)
    router.beginContext()
    assert.equal(stale.commit().activation, undefined)
    assert.equal(router.getStatus().activeGroupCount, 0)

    router.routeExactUrl(n1)
    router.setEnabled(false)
    assert.equal(router.getStatus().enabled, false)
    assert.equal(router.getStatus().activeGroupCount, 0)
    router.setEnabled(true)
    assert.equal(router.getStatus().enabled, true)
    assert.equal(router.getStatus().activeGroupCount, 0)
}

{
    const protocolUnknown = createCdnMediaRequestRouter({
        getLocationProtocol() {
            throw new Error('location unavailable')
        },
    })
    protocolUnknown.publishGroups([group('no-guessed-protocol', [protocolRelative])], true)
    assert.deepEqual(protocolUnknown.routeExactUrl(protocolAlias), {
        url: protocolAlias,
        routed: false,
    })
    assert.equal(protocolUnknown.getStatus().activeGroupCount, 0)
    assert.ok(protocolUnknown.routeExactUrl(protocolRelative).activation)
}

console.log('CDN media request routing tests passed')

function makeRouter() {
    return createCdnMediaRequestRouter({ getLocationProtocol: () => 'https:' })
}

function committedRouteStatus(router) {
    const status = router.getStatus().groups[0]
    return {
        candidateIndex: status.candidateIndex,
        pendingCandidateIndex: status.pendingCandidateIndex,
        attemptedCount: status.attemptedCount,
    }
}

function group(key, urls) {
    return {
        key,
        kind: 'dash-video',
        candidates: urls.map(url => {
            const parsed = new URL(url, 'https://www.bilibili.com/')
            const risky = parsed.hostname.includes('.mcdn.') || parsed.hostname.endsWith('.szbdyd.com')
            return {
                url,
                host: parsed.host,
                hostname: parsed.hostname,
                riskKinds: risky ? ['mcdn-host'] : [],
            }
        }),
    }
}
