#!/usr/bin/env node

import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

globalThis.__testBalhConfig = { cdn_mode: 'auto' }
globalThis.location = { protocol: 'https:' }

class FakeDocument extends EventTarget {
    constructor() {
        super()
        this.visibilityState = 'visible'
        this.videos = []
    }

    querySelectorAll(selector) {
        assert.equal(selector, 'video')
        return this.videos
    }
}

function createRanges(ranges) {
    return {
        length: ranges.length,
        start(index) { return ranges[index][0] },
        end(index) { return ranges[index][1] },
    }
}

function createVideo(currentTime) {
    return {
        isConnected: true,
        paused: false,
        seeking: false,
        ended: false,
        currentTime,
        duration: 100,
        buffered: createRanges([[0, currentTime + 5]]),
        currentSrc: 'media',
        src: '',
        srcObject: null,
    }
}

const documentValue = new FakeDocument()
globalThis.document = documentValue

const bundle = await build({
    entryPoints: [path.join(
        rootDir,
        'packages/unblock-area-limit/src/feature/bili/cdn_recovery_browser.ts',
    )],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    write: false,
    plugins: [{
        name: 'cdn-recovery-config-stub',
        setup(buildContext) {
            buildContext.onResolve({ filter: /\/feature\/config$/ }, () => ({
                path: 'cdn-recovery-config-stub',
                namespace: 'cdn-recovery-test',
            }))
            buildContext.onLoad({
                filter: /^cdn-recovery-config-stub$/,
                namespace: 'cdn-recovery-test',
            }, () => ({
                contents: 'export const balh_config = globalThis.__testBalhConfig',
                loader: 'js',
            }))
        },
    }],
})
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
const recovery = await import(moduleUrl)

const primaryUrl = 'https://primary.example/video.m4s?token=primary'
const alternateUrl = 'https://alternate.example/video.m4s?token=alternate'
const group = {
    key: 'dash-video:0',
    kind: 'dash-video',
    candidates: [
        { url: primaryUrl, sourceFields: ['base_url'], riskKinds: [] },
        { url: alternateUrl, sourceFields: ['backup_url'], riskKinds: [] },
    ],
}

const firstVideo = createVideo(1)
const secondVideo = createVideo(2)
documentValue.videos = [firstVideo]
const monitor = recovery.installCdnRecoveryMonitor()
assert.ok(monitor, 'the browser composition monitor must install')

recovery.publishCdnRecoveryGroups([group], true)
const prepared = recovery.prepareCdnRecoveryRequestUrl(primaryUrl, 'GET')
assert.equal(prepared.decision.url, primaryUrl)

// Model synchronous page code inside native Fetch/XHR acceptance. The accepted
// request must be observed in the new video epoch rather than committed and
// immediately cleared by the post-acceptance monitor wake.
documentValue.videos = [secondVideo]
const committed = prepared.commit()
const afterReplacement = recovery.getCdnRecoveryStatus()
assert.ok(committed.activation, 'the accepted exact request must be re-observed after replacement')
assert.equal(afterReplacement.contextEpoch, 1)
assert.equal(afterReplacement.activeGroupCount, 1)
assert.equal(afterReplacement.groups[0].state, 'monitoring')
assert.equal(afterReplacement.groups[0].candidateIndex, 0)

globalThis.__testBalhConfig.cdn_mode = 'safe'
const disabled = recovery.getCdnRecoveryStatus()
assert.equal(disabled.enabled, false)
assert.equal(disabled.activeGroupCount, 0)
assert.equal(disabled.groups[0].state, 'disabled')

globalThis.__testBalhConfig.cdn_mode = 'auto'
const reenabled = recovery.getCdnRecoveryStatus()
assert.equal(reenabled.enabled, true)
assert.equal(reenabled.activeGroupCount, 0)
assert.equal(reenabled.groups[0].state, 'unseen')

monitor.dispose()
console.log('CDN recovery browser composition tests passed')
