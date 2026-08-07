#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(rootDir, '.codex-tmp/tests')
const outFile = path.join(outDir, 'cdn-selection.mjs')

await mkdir(outDir, { recursive: true })
await build({
    entryPoints: [path.join(rootDir, 'packages/unblock-area-limit/src/feature/bili/cdn_selection.ts')],
    outfile: outFile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
})

const {
    classifyCdnUrl,
    compareHostHealth,
    collectPlayUrlCdnGroups,
    getCdnRiskKinds,
    isCompleteCdnUrl,
    optimizePlayUrlCdn,
    selectCdnCandidates,
} = await import(`${pathToFileURL(outFile).href}?t=${Date.now()}`)

const safeOv = 'https://upos-sz-mirrorov.bilivideo.com/media/video.m4s?token=ov%2FA%2Bb&order=1'
const safeAkamai = 'https://upos-hz-mirrorakam.akamaized.net/media/video.m4s?token=akamai%2Fexact'
const safeBcache = 'https://cn-hk-eq-bcache-01.bilivideo.com/media/audio.m4s?token=bcache'
const safePlain = 'https://upos-sz-mirrorcos.bilivideo.com/media/plain.m4s?token=plain&x=%2f'
const riskyMcdn = 'https://node-1.mcdn.bilivideo.cn:8082/media/video.m4s?token=mcdn&os=mcdn'
const riskyPcdn = 'https://edge.szbdyd.com/media/video.m4s?token=pcdn'
const riskyIp = 'https://192.0.2.44:8080/media/segment.flv?token=ip'
const risky302 = 'https://upos302-edge.bilivideo.com/media/segment.flv?token=302'
const riskyMirror14b = 'https://upos-sz-mirror14b.bilivideo.com/media/audio.m4s?token=14b'
const protocolSafeOv = '//upos-sz-mirrorov.bilivideo.com/media/protocol.m4s?token=protocol%2Fexact'
const protocolRiskyMcdn = '//node-2.mcdn.bilivideo.net:8082/media/protocol.m4s?os=mcdn&token=protocol-risk'

assert.equal(isCompleteCdnUrl(safeOv), true)
assert.equal(isCompleteCdnUrl(protocolSafeOv), true)
assert.equal(isCompleteCdnUrl('/media/video.m4s'), false)
assert.equal(isCompleteCdnUrl('///missing-host/media/video.m4s'), false)
assert.equal(isCompleteCdnUrl('ftp://example.com/media/video.m4s'), false)
assert.equal(classifyCdnUrl(safeOv).url, safeOv)
assert.equal(classifyCdnUrl(protocolSafeOv).url, protocolSafeOv)
assert.equal(classifyCdnUrl(protocolSafeOv).host, 'upos-sz-mirrorov.bilivideo.com')
assert.deepEqual(getCdnRiskKinds(protocolRiskyMcdn), ['mcdn-host', 'mcdn-query', 'non-default-port'])
assert.deepEqual(getCdnRiskKinds('//upos-hz-mirrorakam.akamaized.net/media/video.m4s'), [])

assert.deepEqual(getCdnRiskKinds('https://edge.mcdn.bilivideo.net/media'), ['mcdn-host'])
assert.deepEqual(getCdnRiskKinds('https://safe.example/media?x=1&os=mcdn'), ['mcdn-query'])
assert.deepEqual(getCdnRiskKinds('https://192.0.2.1:443/media'), ['ip-literal'])
assert.deepEqual(getCdnRiskKinds('http://192.0.2.1:80/media'), ['ip-literal'])
assert.deepEqual(getCdnRiskKinds('https://192.0.2.1:8443/media'), ['ip-literal', 'non-default-port'])
assert.deepEqual(getCdnRiskKinds('https://[2001:db8::1]:443/media'), ['ip-literal'])
assert.deepEqual(getCdnRiskKinds('https://[2001:db8::1]:444/media'), ['ip-literal', 'non-default-port'])
assert.deepEqual(getCdnRiskKinds('https://cdn.example.com:444/media'), ['non-default-port'])
for (const domain of ['mountaintoys.cn', 'nexusedgeio.com', 'ahdohpiechei.com']) {
    assert.deepEqual(getCdnRiskKinds(`https://edge.${domain}/media`), ['pcdn-domain'])
}
assert.deepEqual(getCdnRiskKinds(riskyMirror14b), ['mirror14b'])
assert.deepEqual(getCdnRiskKinds(risky302), ['host-label-302'])
assert.deepEqual(getCdnRiskKinds('https://safe.302.example/media'), [])
assert.deepEqual(getCdnRiskKinds('https://notmirror14b.example/media'), [])
assert.deepEqual(getCdnRiskKinds('https://mirror14backup.example/media'), [])
assert.deepEqual(getCdnRiskKinds('https://safe302x.example/media'), [])
assert.deepEqual(getCdnRiskKinds('https://cdn3020.example/media'), [])
assert.deepEqual(getCdnRiskKinds('https://notpcdn.biliapi.net/media'), [])
assert.deepEqual(getCdnRiskKinds('https://edge-pcdn-1.biliapi.net/media'), ['pcdn-domain'])
assert.deepEqual(getCdnRiskKinds(safeAkamai), [])
assert.deepEqual(getCdnRiskKinds(safeOv), [])
assert.deepEqual(getCdnRiskKinds(safeBcache), [])

const protocolRelativeBackup = [protocolSafeOv]
const protocolRelativePlayUrl = {
    durl: [{ url: protocolRiskyMcdn, backup_url: protocolRelativeBackup }],
}
const protocolResult = optimizePlayUrlCdn(protocolRelativePlayUrl, { mode: 'safe' })
assert.equal(protocolResult.changed, true)
assert.equal(protocolRelativePlayUrl.durl[0].url, protocolSafeOv)
assert.deepEqual(protocolRelativeBackup, [protocolRiskyMcdn])
assert.equal(protocolRelativePlayUrl.durl[0].backup_url, protocolRelativeBackup)
assert.doesNotMatch(JSON.stringify(protocolResult), /\/media\/|token=|https?:/)
const protocolSnapshot = JSON.stringify(protocolRelativePlayUrl)
assert.equal(optimizePlayUrlCdn(protocolRelativePlayUrl, { mode: 'safe' }).changed, false)
assert.equal(JSON.stringify(protocolRelativePlayUrl), protocolSnapshot)

const videoBackupSnake = [safeOv, safeAkamai, riskyPcdn]
const videoBackupCamel = [safeOv, safeAkamai, riskyPcdn]
const camelBackup = [safeBcache]
const audioBackup = [safePlain]
const flacAudio = [{
    base_url: riskyPcdn,
    backup_url: [safeAkamai],
}]
const flacBackup = flacAudio[0].backup_url
const dolbyAudio = {
    baseUrl: riskyMirror14b,
    backupUrl: [safeOv],
}
const dolbyBackup = dolbyAudio.backupUrl
const mixedObject = { url: risky302, marker: 'preserve-object' }
const opaqueObject = { marker: 'preserve-unknown' }
const mixedDurlBackup = [37, safePlain, opaqueObject, mixedObject]
const scalarObjectBackup = { url: safeAkamai, marker: 'preserve-scalar-object' }
const playUrl = {
    dash: {
        video: [
            {
                base_url: riskyMcdn,
                baseUrl: riskyMcdn,
                backup_url: videoBackupSnake,
                backupUrl: videoBackupCamel,
            },
            {
                baseUrl: 'https://safe.example/media/camel.m4s?Case=%2FExact',
                backupUrl: camelBackup,
            },
        ],
        audio: [{
            base_url: 'https://audio.example/media/audio.m4s?os=mcdn&token=exact',
            backup_url: audioBackup,
        }],
        dolby: { audio: dolbyAudio },
        flac: { audio: flacAudio },
    },
    durl: [
        { url: riskyIp, backup_url: mixedDurlBackup },
        { url: riskyMirror14b, backupUrl: safeBcache },
        { url: riskyPcdn, backup_url: scalarObjectBackup },
    ],
}

const identities = {
    playUrl,
    dash: playUrl.dash,
    video: playUrl.dash.video,
    audio: playUrl.dash.audio,
    dolbyAudio,
    dolbyBackup,
    flacAudio,
    flacBackup,
    durl: playUrl.durl,
    mixedDurlBackup,
    mixedObject,
    opaqueObject,
    scalarObjectBackup,
}
const beforeGroups = collectPlayUrlCdnGroups(playUrl)
assert.deepEqual(beforeGroups.map(group => group.key), [
    'dash.video[0]',
    'dash.video[1]',
    'dash.audio[0]',
    'dash.dolby.audio',
    'dash.flac.audio[0]',
    'durl[0]',
    'durl[1]',
    'durl[2]',
])
assert.deepEqual(beforeGroups[0].candidates.map(candidate => candidate.url), [
    riskyMcdn,
    safeOv,
    safeAkamai,
    riskyPcdn,
])
assert.ok(beforeGroups.every(group => !group.key.includes('?')))

const firstResult = optimizePlayUrlCdn(playUrl, { mode: 'safe' })
assert.equal(firstResult.changed, true)
assert.equal(firstResult.groups, 8)
assert.equal(playUrl.dash.video[0].base_url, safeOv)
assert.equal(playUrl.dash.video[0].baseUrl, safeOv)
assert.deepEqual(playUrl.dash.video[0].backup_url, [safeAkamai, riskyMcdn, riskyPcdn])
assert.deepEqual(playUrl.dash.video[0].backupUrl, [safeAkamai, riskyMcdn, riskyPcdn])
assert.equal(playUrl.dash.audio[0].base_url, safePlain)
assert.equal(dolbyAudio.baseUrl, safeOv)
assert.equal(flacAudio[0].base_url, safeAkamai)
assert.equal(playUrl.durl[0].url, safePlain)
assert.deepEqual(mixedDurlBackup, [37, riskyIp, opaqueObject, mixedObject])
assert.equal(mixedObject.url, risky302)
assert.equal(playUrl.durl[1].url, safeBcache)
assert.equal(playUrl.durl[1].backupUrl, riskyMirror14b)
assert.equal(playUrl.durl[2].url, safeAkamai)
assert.equal(scalarObjectBackup.url, riskyPcdn)
assert.equal(scalarObjectBackup.marker, 'preserve-scalar-object')

assert.equal(playUrl, identities.playUrl)
assert.equal(playUrl.dash, identities.dash)
assert.equal(playUrl.dash.video, identities.video)
assert.equal(playUrl.dash.audio, identities.audio)
assert.equal(playUrl.dash.dolby.audio, identities.dolbyAudio)
assert.equal(dolbyAudio.backupUrl, identities.dolbyBackup)
assert.equal(playUrl.dash.flac.audio, identities.flacAudio)
assert.equal(flacAudio[0].backup_url, identities.flacBackup)
assert.equal(playUrl.durl, identities.durl)
assert.equal(playUrl.durl[0].backup_url, identities.mixedDurlBackup)
assert.equal(mixedDurlBackup[2], identities.opaqueObject)
assert.equal(mixedDurlBackup[3], identities.mixedObject)
assert.equal(playUrl.durl[2].backup_url, identities.scalarObjectBackup)
assert.equal(Object.hasOwn(playUrl.dash.video[1], 'base_url'), false)
assert.equal(Object.hasOwn(playUrl.dash.video[1], 'backup_url'), false)

const afterGroups = collectPlayUrlCdnGroups(playUrl)
assert.deepEqual(groupUrlMultisets(afterGroups), groupUrlMultisets(beforeGroups))
const exactUrls = afterGroups.flatMap(group => group.candidates.map(candidate => candidate.url))
for (const exactUrl of [safeOv, safeAkamai, safePlain, riskyMcdn, riskyPcdn, riskyIp, risky302]) {
    assert.ok(exactUrls.includes(exactUrl), `missing exact URL: ${exactUrl}`)
}

const afterFirstPass = JSON.stringify(playUrl)
const secondResult = optimizePlayUrlCdn(playUrl, { mode: 'safe' })
assert.equal(secondResult.changed, false)
assert.equal(JSON.stringify(playUrl), afterFirstPass)

const diagnosticText = JSON.stringify(firstResult)
assert.match(diagnosticText, /upos-sz-mirrorov\.bilivideo\.com/)
assert.match(diagnosticText, /node-1\.mcdn\.bilivideo\.cn:8082/)
assert.doesNotMatch(diagnosticText, /https?:/)
assert.doesNotMatch(diagnosticText, /\/media\//)
assert.doesNotMatch(diagnosticText, /token=/)
assert.doesNotMatch(diagnosticText, /%2F|%2f/)

const nullShapes = { dash: { dolby: { audio: null }, flac: { audio: null } }, durl: null }
assert.equal(optimizePlayUrlCdn(nullShapes, { mode: 'safe' }).changed, false)
assert.equal(nullShapes.dash.dolby.audio, null)
assert.equal(nullShapes.dash.flac.audio, null)
assert.equal(nullShapes.durl, null)

{
    const bandwidthPlayUrl = {
        dash: {
            video: [{
                bandwidth: 1_500_000,
                base_url: safeOv,
                backup_url: [safeAkamai],
            }],
            audio: [{ bandwidth: '192000', base_url: safePlain }],
            dolby: { audio: { bandwidth: 640_000, baseUrl: safeBcache } },
            flac: { audio: [{ bandwidth: Number.POSITIVE_INFINITY, base_url: safeAkamai }] },
        },
        durl: [{ url: safePlain, size: 1_000_000, length: 5_000 }],
    }
    const groups = collectPlayUrlCdnGroups(bandwidthPlayUrl)
    assert.equal(groups.find(group => group.key === 'dash.video[0]').bandwidthBps, 1_500_000)
    assert.equal(groups.find(group => group.key === 'dash.audio[0]').bandwidthBps, undefined)
    assert.equal(groups.find(group => group.key === 'dash.dolby.audio').bandwidthBps, 640_000)
    assert.equal(groups.find(group => group.key === 'dash.flac.audio[0]').bandwidthBps, undefined)
    assert.equal(groups.find(group => group.key === 'durl[0]').bandwidthBps, undefined)

    const result = optimizePlayUrlCdn(bandwidthPlayUrl, {
        mode: 'auto',
        hostHealth: {
            [classifyCdnUrl(safeOv).host]: {
                samples: 2,
                successes: 2,
                throughputKbps: 3_000,
            },
        },
    })
    const videoDiagnostic = result.diagnostics.find(item => item.group === 'dash.video[0]')
    assert.equal(videoDiagnostic.bandwidthBps, 1_500_000)
    assert.equal(videoDiagnostic.candidates[0].throughputKbps, 3_000)
    assert.equal(videoDiagnostic.candidates[0].bitrateMargin, 2)
    assert.equal(result.diagnostics.find(item => item.group === 'durl[0]').bandwidthBps, null)
    assert.doesNotMatch(JSON.stringify(result), /\/media\/|token=|https?:/)
}

for (const mode of ['original', 'manual']) {
    const untouched = {
        dash: { video: [{ base_url: riskyMcdn, backup_url: [safeOv] }] },
        durl: [{ url: riskyPcdn, backup_url: safeAkamai }],
    }
    const snapshot = JSON.stringify(untouched)
    const result = optimizePlayUrlCdn(untouched, { mode })
    assert.equal(result.changed, false)
    assert.equal(JSON.stringify(untouched), snapshot)
    assert.ok(result.diagnostics.every(item => item.reason === 'mode-bypass'))
}

const allRiskCandidates = [riskyMcdn, riskyPcdn, riskyMirror14b].map(classifyCdnUrl)
const allRiskHealth = {
    [classifyCdnUrl(riskyMcdn).host]: { samples: 4, successes: 1, failures: 3, throughputKbps: 10, ttfbMs: 900 },
    [classifyCdnUrl(riskyPcdn).host]: { samples: 4, successes: 4, failures: 0, throughputKbps: 9000, ttfbMs: 10 },
}
for (const mode of ['safe', 'auto']) {
    assert.deepEqual(
        selectCdnCandidates(allRiskCandidates, { mode, hostHealth: allRiskHealth }).map(candidate => candidate.url),
        [riskyMcdn, riskyPcdn, riskyMirror14b],
    )
}

const safeUnknown = 'https://unknown.example/media/auto.m4s?secret=unknown'
const safeFastHighTtfb = 'https://fast.example/media/auto.m4s?secret=fast'
const safeFastLowTtfb = 'https://fast-low.example/media/auto.m4s?secret=fast-low'
const safeSlow = 'https://slow.example/media/auto.m4s?secret=slow'
const autoPlayUrl = {
    dash: {
        video: [{
            base_url: safeUnknown,
            backup_url: [safeFastHighTtfb, safeSlow, safeFastLowTtfb, riskyPcdn],
        }],
    },
}
const autoHealth = {
    'fast.example': { samples: 5, successes: 5, failures: 0, throughputKbps: 800, ttfbMs: 180 },
    'fast-low.example': { samples: 5, successes: 5, failures: 0, throughputKbps: 800, ttfbMs: 60 },
    'slow.example': { samples: 5, successes: 5, failures: 0, throughputKbps: 200, ttfbMs: 20 },
}
assert.equal(optimizePlayUrlCdn(autoPlayUrl, { mode: 'auto', hostHealth: autoHealth }).changed, true)
assert.equal(autoPlayUrl.dash.video[0].base_url, safeFastLowTtfb)
assert.deepEqual(autoPlayUrl.dash.video[0].backup_url, [
    safeFastHighTtfb,
    safeSlow,
    safeUnknown,
    riskyPcdn,
])

const weakPlayUrl = {
    durl: [{ url: safeOv, backup_url: [safePlain] }],
}
const weakSnapshot = JSON.stringify(weakPlayUrl)
const weakHealth = {
    [classifyCdnUrl(safeOv).host]: { samples: 5, successes: 1, failures: 4, throughputKbps: 10 },
    [classifyCdnUrl(safePlain).host]: { samples: 5, successes: 1, failures: 4, throughputKbps: 9000 },
}
assert.equal(optimizePlayUrlCdn(weakPlayUrl, { mode: 'auto', hostHealth: weakHealth }).changed, false)
assert.equal(JSON.stringify(weakPlayUrl), weakSnapshot)

const failedUrl = 'https://failed.example/media/health.m4s'
const unknownUrl = 'https://unknown-health.example/media/health.m4s'
const failedHealth = {
    'failed.example': { samples: 2, successes: 0, failures: 2, throughputKbps: 0 },
}
for (const urls of [[failedUrl, unknownUrl], [unknownUrl, failedUrl]]) {
    const candidates = urls.map(classifyCdnUrl)
    assert.deepEqual(
        selectCdnCandidates(candidates, { mode: 'auto', hostHealth: failedHealth }).map(candidate => candidate.url),
        urls,
    )
}

const tupleA = { samples: 3, successes: 3, failures: 0, throughputKbps: 500, ttfbMs: 100 }
const tupleB = { samples: 3, successes: 3, failures: 0, throughputKbps: 500 }
const tupleC = { samples: 3, successes: 3, failures: 0, throughputKbps: 500, ttfbMs: 10 }
assert.ok(compareHostHealth(tupleC, tupleA) < 0)
assert.ok(compareHostHealth(tupleA, tupleB) < 0)
assert.ok(compareHostHealth(tupleC, tupleB) < 0)
const tupleUrls = [
    'https://tuple-a.example/media/health.m4s',
    'https://tuple-b.example/media/health.m4s',
    'https://tuple-c.example/media/health.m4s',
]
const tupleHealth = {
    'tuple-a.example': tupleA,
    'tuple-b.example': tupleB,
    'tuple-c.example': tupleC,
}
for (const permutation of permutations(tupleUrls)) {
    assert.deepEqual(
        selectCdnCandidates(permutation.map(classifyCdnUrl), {
            mode: 'auto',
            hostHealth: tupleHealth,
        }).map(candidate => candidate.url),
        [tupleUrls[2], tupleUrls[0], tupleUrls[1]],
    )
}

const aliasConflict = {
    dash: { video: [{ base_url: riskyMcdn, baseUrl: safeOv }] },
}
const aliasConflictSnapshot = JSON.stringify(aliasConflict)
const aliasConflictResult = optimizePlayUrlCdn(aliasConflict, { mode: 'safe' })
assert.equal(aliasConflictResult.changed, false)
assert.equal(aliasConflictResult.diagnostics[0].reason, 'skipped-capacity')
assert.equal(JSON.stringify(aliasConflict), aliasConflictSnapshot)

const scalarOverflow = {
    dash: {
        video: [{
            base_url: riskyMcdn,
            baseUrl: riskyPcdn,
            backup_url: safeOv,
        }],
    },
}
const scalarOverflowSnapshot = JSON.stringify(scalarOverflow)
assert.equal(optimizePlayUrlCdn(scalarOverflow, { mode: 'safe' }).changed, false)
assert.equal(JSON.stringify(scalarOverflow), scalarOverflowSnapshot)
assert.deepEqual(
    collectPlayUrlCdnGroups(scalarOverflow)[0].candidates.map(candidate => candidate.url).sort(),
    [riskyMcdn, riskyPcdn, safeOv].sort(),
)

const simpleDuplicateBackup = [riskyMcdn, safeOv]
const simpleDuplicate = {
    dash: { video: [{ base_url: riskyMcdn, backup_url: simpleDuplicateBackup }] },
}
const simpleDuplicateArray = simpleDuplicateBackup
const simpleOccurrencesBefore = [simpleDuplicate.dash.video[0].base_url, ...simpleDuplicateBackup].sort()
assert.deepEqual(
    collectPlayUrlCdnGroups(simpleDuplicate)[0].candidates.map(candidate => candidate.url),
    [riskyMcdn, safeOv],
)
assert.equal(optimizePlayUrlCdn(simpleDuplicate, { mode: 'safe' }).changed, true)
assert.equal(simpleDuplicate.dash.video[0].base_url, safeOv)
assert.deepEqual(simpleDuplicateBackup, [riskyMcdn, riskyMcdn])
assert.equal(simpleDuplicate.dash.video[0].backup_url, simpleDuplicateArray)
assert.deepEqual(
    [simpleDuplicate.dash.video[0].base_url, ...simpleDuplicateBackup].sort(),
    simpleOccurrencesBefore,
)
const simpleDuplicateSnapshot = JSON.stringify(simpleDuplicate)
assert.equal(optimizePlayUrlCdn(simpleDuplicate, { mode: 'safe' }).changed, false)
assert.equal(JSON.stringify(simpleDuplicate), simpleDuplicateSnapshot)

const unknownMarker = { preserve: 'same-position-and-identity' }
const mixedDuplicateBackup = [riskyMcdn, unknownMarker, riskyMcdn, safeOv]
const mixedDuplicate = {
    durl: [{ url: riskyMcdn, backup_url: mixedDuplicateBackup }],
}
const mixedDuplicateArray = mixedDuplicateBackup
const mixedOccurrencesBefore = [mixedDuplicate.durl[0].url, ...mixedDuplicateBackup]
    .filter(value => typeof value === 'string')
    .sort()
assert.equal(optimizePlayUrlCdn(mixedDuplicate, { mode: 'safe' }).changed, true)
assert.equal(mixedDuplicate.durl[0].url, safeOv)
assert.deepEqual(mixedDuplicateBackup, [riskyMcdn, unknownMarker, riskyMcdn, riskyMcdn])
assert.equal(mixedDuplicate.durl[0].backup_url, mixedDuplicateArray)
assert.equal(mixedDuplicateBackup.length, 4)
assert.equal(mixedDuplicateBackup[1], unknownMarker)
assert.deepEqual(
    [mixedDuplicate.durl[0].url, ...mixedDuplicateBackup]
        .filter(value => typeof value === 'string')
        .sort(),
    mixedOccurrencesBefore,
)

const duplicateSnakeBackup = [riskyMcdn, safeAkamai]
const duplicateCamelBackup = [riskyMcdn, safeAkamai]
const duplicateAliases = {
    dash: {
        video: [{
            base_url: riskyMcdn,
            baseUrl: riskyMcdn,
            backup_url: duplicateSnakeBackup,
            backupUrl: duplicateCamelBackup,
        }],
    },
}
assert.equal(optimizePlayUrlCdn(duplicateAliases, { mode: 'safe' }).changed, true)
assert.equal(duplicateAliases.dash.video[0].base_url, safeAkamai)
assert.equal(duplicateAliases.dash.video[0].baseUrl, safeAkamai)
assert.deepEqual(duplicateSnakeBackup, [riskyMcdn, riskyMcdn])
assert.deepEqual(duplicateCamelBackup, [riskyMcdn, riskyMcdn])
assert.equal(duplicateAliases.dash.video[0].backup_url, duplicateSnakeBackup)
assert.equal(duplicateAliases.dash.video[0].backupUrl, duplicateCamelBackup)

const consistentSnakeBackup = [safeOv, safeAkamai]
const consistentCamelBackup = [safeOv, safeAkamai]
const singleMainDualBackup = {
    dash: {
        video: [{
            base_url: riskyMcdn,
            backup_url: consistentSnakeBackup,
            backupUrl: consistentCamelBackup,
        }],
    },
}
const snakeViewBefore = [singleMainDualBackup.dash.video[0].base_url, ...consistentSnakeBackup].sort()
const camelViewBefore = [singleMainDualBackup.dash.video[0].base_url, ...consistentCamelBackup].sort()
assert.equal(optimizePlayUrlCdn(singleMainDualBackup, { mode: 'safe' }).changed, true)
assert.equal(singleMainDualBackup.dash.video[0].base_url, safeOv)
assert.deepEqual(consistentSnakeBackup, [safeAkamai, riskyMcdn])
assert.deepEqual(consistentCamelBackup, [safeAkamai, riskyMcdn])
assert.deepEqual([singleMainDualBackup.dash.video[0].base_url, ...consistentSnakeBackup].sort(), snakeViewBefore)
assert.deepEqual([singleMainDualBackup.dash.video[0].base_url, ...consistentCamelBackup].sort(), camelViewBefore)
const consistentAliasSnapshot = JSON.stringify(singleMainDualBackup)
assert.equal(optimizePlayUrlCdn(singleMainDualBackup, { mode: 'safe' }).changed, false)
assert.equal(JSON.stringify(singleMainDualBackup), consistentAliasSnapshot)

const divergentAliases = {
    dash: {
        video: [{
            base_url: riskyMcdn,
            backup_url: [safeOv, safeAkamai],
            backupUrl: [safeOv, safePlain],
        }],
    },
}
const divergentAliasSnapshot = JSON.stringify(divergentAliases)
const divergentAliasResult = optimizePlayUrlCdn(divergentAliases, { mode: 'safe' })
assert.equal(divergentAliasResult.changed, false)
assert.equal(divergentAliasResult.diagnostics[0].reason, 'skipped-capacity')
assert.equal(JSON.stringify(divergentAliases), divergentAliasSnapshot)

console.log('cdn-selection tests passed')

function groupUrlMultisets(groups) {
    return Object.fromEntries(groups.map(group => [
        group.key,
        group.candidates.map(candidate => candidate.url).sort(),
    ]))
}

function permutations(values) {
    if (values.length < 2) return [values]
    return values.flatMap((value, index) => permutations([
        ...values.slice(0, index),
        ...values.slice(index + 1),
    ]).map(rest => [value, ...rest]))
}
