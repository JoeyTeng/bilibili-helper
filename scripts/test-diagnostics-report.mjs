#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(rootDir, '.codex-tmp/tests')
const outFile = path.join(outDir, 'diagnostics.mjs')

await mkdir(outDir, { recursive: true })
await build({
    entryPoints: [path.join(rootDir, 'packages/unblock-area-limit/src/feature/bili/diagnostics.ts')],
    outfile: outFile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
})

const secretAccessKey = 'ak_1234567890abcdef'
const secretAuthKey = 'auth_1234567890abcdef'
const secretRefreshToken = 'refresh_1234567890abcdef'
const secretSplitLineToken = 'splitline_abcdefghijklmnopqrstuvwxyz0123456789'
const secretSplitTextToken = 'splittext_abcdefghijklmnopqrstuvwxyz0123456789'
const secretMediaSignature = '11034ead12bc8b127425ae549ee8297e'
const signedMediaUrl = createSignedMediaUrl()
const protocolRelativeSignedMediaUrl = signedMediaUrl.replace(/^https:/, '')
const secretReplacementToken = 'replacement_1234567890abcdef'

const localStorageMock = createLocalStorage({
    access_key: secretAccessKey,
    refresh_token: secretRefreshToken,
    balh_migrate_to_2: 'Y',
})

globalThis.localStorage = localStorageMock
globalThis.location = new URL(`https://www.bilibili.com/bangumi/play/ep664928?access_key=${secretAccessKey}`)
Object.defineProperty(globalThis, 'navigator', {
    value: {
        userAgent: 'DiagnosticTest/1.0',
        language: 'zh-CN',
    },
    configurable: true,
})
globalThis.GM_info = {
    script: {
        name: '解除B站区域限制.test',
        version: '8.8.0-test',
    },
    scriptHandler: 'TestMonkey',
}

const video = {
    currentTime: 12.34567,
    duration: 1501,
    paused: false,
    readyState: 4,
    networkState: 2,
    error: null,
}
const playerStatus = {
    innerText: '解析成功，正在启动播放器\n香港服务器，用时300ms',
    dataset: { state: 'success' },
}
let appendedDownloadLink = null
let clickedDownloadLink = null
let removedDownloadLink = false
let revokedDownloadUrl = ''
const silentConsole = {
    log() { },
    info() { },
    debug() { },
    warn() { },
    error() { },
}

globalThis.document = {
    title: '死神 S2（僅限港澳台地區）',
    readyState: 'complete',
    referrer: `https://example.com/?refresh_token=${secretRefreshToken}`,
    cookie: [
        'balh_server_inner=__custom__',
        'balh_server_custom=https://user:pass@atri.ink',
        'balh_server_custom_hk=https://atri.ink',
        'balh_generate_sub=Y',
        `SESSDATA=${secretRefreshToken}`,
    ].join('; '),
    body: {
        innerText: '多语言字幕',
        appendChild(element) {
            appendedDownloadLink = element
        },
    },
    location: globalThis.location,
    addEventListener() { },
    createElement(tag) {
        assert.equal(tag, 'a')
        return {
            href: '',
            download: '',
            rel: '',
            style: {},
            click() {
                clickedDownloadLink = {
                    href: this.href,
                    download: this.download,
                    rel: this.rel,
                }
            },
            remove() {
                removedDownloadLink = true
            },
        }
    },
    querySelector(selector) {
        return selector === 'video' ? video : null
    },
    getElementById(id) {
        return id === 'balh-player-status' ? playerStatus : null
    },
}

globalThis.window = {
    location: globalThis.location,
    console: silentConsole,
    Promise,
    top: null,
    parent: null,
    addEventListener() { },
    postMessage() { },
    __PLAYURL_HYDRATE_DATA__: {
        result: {
            play_video_type: 'dash',
            arc: { aid: 471358748, cid: 785722097 },
            video_info: {
                dash: {
                    video: [{ id: 32 }, { id: 64 }],
                    audio: [{ id: 30232 }],
                },
            },
            supplement: {
                ogv_episode_info: { episode_id: 664928 },
                ogv_season_info: { season_id: 12345 },
            },
        },
    },
}
globalThis.window.top = globalThis.window
globalThis.window.parent = globalThis.window
globalThis.window.document = globalThis.document

globalThis.URL.createObjectURL = (blob) => {
    assert.equal(blob.type, 'text/plain;charset=utf-8')
    return 'blob:diagnostic-test'
}
globalThis.URL.revokeObjectURL = (url) => {
    revokedDownloadUrl = url
}

const {
    createDiagnosticArtifacts,
    createDiagnosticFileName,
    createDiagnosticReport,
    createDiagnosticSummary,
    downloadDiagnosticReport,
    sanitizeDiagnosticText,
} = await import(`${pathToFileURL(outFile).href}?t=${Date.now()}`)

const rawText = [
    `access_key=${secretAccessKey}`,
    `https://subtitle.bilibili.com/example?auth_key=${secretAuthKey}&token=token_1234567890abcdef`,
    `{"refresh_token":"${secretRefreshToken}"}`,
    `https://user:pass@example.com/path?access_token=${secretAccessKey}`,
    'https://tokenonly@example.com/path',
    'proxy user:pass@bare.example.com/path',
    signedMediaUrl,
    protocolRelativeSignedMediaUrl,
    secretReplacementToken,
    secretAccessKey,
    secretAccessKey,
].join('\n')
const sanitized = sanitizeDiagnosticText(rawText, { 'token$&': secretReplacementToken })
assert.doesNotMatch(sanitized, new RegExp(secretAccessKey))
assert.doesNotMatch(sanitized, new RegExp(secretAuthKey))
assert.doesNotMatch(sanitized, new RegExp(secretRefreshToken))
assert.doesNotMatch(sanitized, new RegExp(secretReplacementToken))
assert.doesNotMatch(sanitized, /token=token_1234567890abcdef/)
assert.doesNotMatch(sanitized, /user:pass@example\.com/)
assert.doesNotMatch(sanitized, /tokenonly@example\.com/)
assert.doesNotMatch(sanitized, /user:pass@bare\.example\.com/)
assert.doesNotMatch(sanitized, new RegExp(secretMediaSignature))
assert.doesNotMatch(sanitized, /deadline=1780305934/)
assert.doesNotMatch(sanitized, /trid=5e64a66ca7d949f6b831f7cdcd6a2f7p/)
assert.doesNotMatch(sanitized, /mid=1335764/)
assert.match(sanitized, /https:\/\/redacted@example\.com\/path/)
assert.match(sanitized, /redacted@bare\.example\.com\/path/)
assert.match(sanitized, /access_key=<redacted>/)
assert.match(sanitized, /https:\/\/upos-sz-mirrorcosov\.bilivideo\.com\/upgcxcode\/97\/20\/785722097\/785722097-1-30232\.m4s\?<media-query:redacted>/)
assert.match(sanitized, /<token_:redacted>/)

const report = createDiagnosticReport({
    buildVersion: 'test-build',
    invokeBy: 'test.invoke',
    now: new Date('2026-06-05T00:00:00.000Z'),
    logText: [
        `debug: playurl ${'x'.repeat(50000)}`,
        `debug: playurl ${'x'.repeat(3000)}access_key=${secretSplitLineToken}${'y'.repeat(1470 - secretSplitLineToken.length)}`,
        `${makeBoundedFiller(5000, 'p')}access_key=${secretSplitTextToken}${makeBoundedFiller(59010 - secretSplitTextToken.length, 'q')}`,
        `debug: fetch pgc playurl proxy success access_key=${secretAccessKey}`,
        `debug: subtitle fixed https://subtitle.bilibili.com/example?auth_key=${secretAuthKey}&token=token_1234567890abcdef`,
        'debug: proxy https://tokenonly@atri.ink/pgc/player/web/playurl',
        `debug: playurl data {"baseUrl":"${signedMediaUrl}","backupUrl":["${signedMediaUrl}"]}`,
        `debug: protocol relative playurl ${protocolRelativeSignedMediaUrl}`,
        `debug: extra secret ${secretReplacementToken}`,
        'warn: replace playinfo by proxy candidate failed {"code":403,"message":"地区限制"}',
    ].join('\n'),
    extraSecrets: { 'token$&': secretReplacementToken },
})

assert.match(report, /# BALH Diagnostic Report/)
assert.match(report, /script_version: 8\.8\.0-test/)
assert.match(report, /build_version: test-build/)
assert.match(report, /current_ep_id: 664928/)
assert.match(report, /aid: 471358748/)
assert.match(report, /cid: 785722097/)
assert.match(report, /video_streams: 2/)
assert.match(report, /subtitle_ui_present: true/)
assert.match(report, /Runtime Log/)
assert.match(report, /Recent Relevant Log Lines/)
assert.doesNotMatch(report, new RegExp(secretAccessKey))
assert.doesNotMatch(report, new RegExp(secretAuthKey))
assert.doesNotMatch(report, new RegExp(secretRefreshToken))
assert.doesNotMatch(report, new RegExp(secretReplacementToken))
assert.doesNotMatch(report, new RegExp(secretSplitLineToken.slice(-8)))
assert.doesNotMatch(report, new RegExp(secretSplitTextToken.slice(-8)))
assert.doesNotMatch(report, /token=token_1234567890abcdef/)
assert.doesNotMatch(report, /user:pass@atri\.ink/)
assert.doesNotMatch(report, /tokenonly@atri\.ink/)
assert.doesNotMatch(report, new RegExp(secretMediaSignature))
assert.doesNotMatch(report, /deadline=1780305934/)
assert.doesNotMatch(report, /trid=5e64a66ca7d949f6b831f7cdcd6a2f7p/)
assert.doesNotMatch(report, /mid=1335764/)
assert.match(report, /785722097-1-30232\.m4s\?<media-query:redacted>/)
assert.match(report, /<token_:redacted>/)
assert.match(report, /server_custom: https:\/\/redacted@atri\.ink\//)
assert.match(report, /line omitted/)

const diagnosticOptions = {
    buildVersion: 'test-build',
    invokeBy: 'test.invoke',
    now: new Date('2026-06-05T00:00:00.000Z'),
    logText: `debug: playurl ${'x'.repeat(50000)}`,
}
const expectedFileName = 'balh-diagnostic-v8.8.0-test-test-build-ep664928-20260605T000000000Z.txt'
assert.equal(createDiagnosticFileName(diagnosticOptions), expectedFileName)

const summary = createDiagnosticSummary({ ...diagnosticOptions, fileName: expectedFileName })
assert.match(summary, /# BALH Issue Summary/)
assert.match(summary, /diagnostic_file: balh-diagnostic-v8\.8\.0-test-test-build-ep664928-20260605T000000000Z\.txt/)
assert.match(summary, /Please attach the downloaded diagnostic file/)
assert.doesNotMatch(summary, /Runtime Log/)
assert.doesNotMatch(summary, /x{1000}/)
assert.doesNotMatch(summary, new RegExp(secretAccessKey))

const artifacts = createDiagnosticArtifacts(diagnosticOptions)
assert.equal(artifacts.fileName, expectedFileName)
assert.match(artifacts.report, /Runtime Log/)
assert.match(artifacts.summary, /BALH Issue Summary/)

assert.equal(downloadDiagnosticReport(artifacts.report, artifacts.fileName), true)
assert.equal(appendedDownloadLink.download, expectedFileName)
assert.deepEqual(clickedDownloadLink, {
    href: 'blob:diagnostic-test',
    download: expectedFileName,
    rel: 'noopener',
})
await new Promise(resolve => setTimeout(resolve, 0))
assert.equal(revokedDownloadUrl, 'blob:diagnostic-test')
assert.equal(removedDownloadLink, true)

console.log('diagnostics-report tests passed')

function createLocalStorage(initialValues) {
    const store = new Map(Object.entries(initialValues))
    const target = {
        get length() {
            return store.size
        },
        key(index) {
            return Array.from(store.keys())[index] ?? null
        },
        getItem(key) {
            return store.has(key) ? store.get(key) : null
        },
        setItem(key, value) {
            store.set(key, String(value))
            target[key] = String(value)
        },
        removeItem(key) {
            store.delete(key)
            delete target[key]
        },
    }
    for (const [key, value] of store.entries()) {
        target[key] = value
    }
    return target
}

function makeBoundedFiller(length, char) {
    let output = ''
    while (output.length < length) {
        const chunkLength = Math.min(80, length - output.length)
        output += char.repeat(chunkLength)
        if (output.length < length) {
            output += '\n'
        }
    }
    return output
}

function createSignedMediaUrl() {
    const params = new URLSearchParams({
        e: 'ig8euxZM2rNcNbdlhoNvNC8BqJIzNbfqXBvEqxTEto8BTrNvN0GvT90W5JZMkX_YN0MvXg8gNEV4NC8xNEV4N03eN0B599M=',
        deadline: '1780305934',
        uipk: '5',
        os: 'cosovbv',
        platform: 'pc',
        nbs: '1',
        oi: '729916908',
        gen: 'playurlv3',
        og: 'cos',
        trid: '5e64a66ca7d949f6b831f7cdcd6a2f7p',
        mid: '1335764',
        upsig: secretMediaSignature,
        uparams: 'e,deadline,uipk,os,platform,nbs,oi,gen,og,trid,mid',
        bvc: 'vod',
        nettype: '0',
        bw: '132795',
        lrs: '0',
        dl: '0',
        f: 'p_0_0',
        allo_id: '',
        qn_dyeid: '',
        agrr: '1',
        buvid: '',
        build: '0',
        orderid: '0,2',
    })
    return `https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/97/20/785722097/785722097-1-30232.m4s?${params}`
}
