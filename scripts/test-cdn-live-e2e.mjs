#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assessStage3InitialCooldown } from './cdn-live-e2e-cooldown.mjs'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const userscriptPath = path.join(rootDir, 'dist', 'unblock-area-limit.user.js')
const defaultUrl = 'https://www.bilibili.com/video/BV17x411w7KC/'
const defaultTimeoutMs = 120_000
const minTimeoutMs = 15_000
const maxTimeoutMs = 180_000
const cleanupTimeoutMs = 5_000
const stage3ObservationTimeoutMs = 8_000
const stage3FaultWindowTimeoutMs = 22_000
const stage3FutureRequestTimeoutMs = 12_000
const stage3CooldownObservationMs = 15_500
const stage3PollIntervalMs = 200
const stage3StatusSampleTimeoutMs = 2_000
const stage3SwitchObservationSlackMs = 500
const stage3MinimumCooldownMs = 15_000
const stage3HookSymbol = 'balh.stage3.live-capability'
const stage3MaxBrowserRequests = 10_000
const stage3MaxHeldRequests = 32
const cdnHealthCacheKey = 'balh_cdn_health_v1'
const cdnHealthCacheVersion = 2
const terminalProbeStates = new Set(['ready', 'partial', 'unprobeable', 'failed'])
const hostListNames = [
    'candidateHosts',
    'probedHosts',
    'healthyHosts',
    'failedHosts',
    'unprobeableHosts',
    'budgetLimitedHosts',
]

class HarnessFailure extends Error {
    constructor(stage, reason) {
        super(`${stage}:${reason}`)
        this.name = 'HarnessFailure'
        this.stage = stage
        this.reason = reason
    }
}

const stage3CapabilityRequested = process.argv.slice(2).includes('--stage3-capability')

run().catch(error => {
    const stage = error instanceof HarnessFailure ? error.stage : 'unexpected'
    const reason = error instanceof HarnessFailure ? error.reason : 'unexpected-error'
    if (stage3CapabilityRequested) {
        console.error(`[cdn-live-e2e] stage3Capability=FAIL reason=${stage}-${reason}`)
    } else {
        console.error(`[cdn-live-e2e] FAIL stage=${stage} reason=${reason}`)
    }
    process.exitCode = 1
})

async function run() {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) {
        printUsage()
        return
    }

    // Prevent opt-in Playwright protocol logging from exposing media request URLs.
    delete process.env.DEBUG
    delete process.env.PWDEBUG

    console.log(`[cdn-live-e2e] BVID=${options.bvid} pageHostname=${options.url.hostname}`)
    const capabilityResult = await main(options)
    if (options.stage3Capability) {
        if (!printStage3CapabilityResult(capabilityResult)) return
        if (capabilityResult.status === 'UNSUPPORTED') process.exitCode = 2
        if (capabilityResult.status === 'INCONCLUSIVE') process.exitCode = 3
        if (capabilityResult.status === 'FAIL') process.exitCode = 1
    }
}

async function main(options) {
    const deadline = createDeadline(options.timeoutMs)
    let browser
    let context
    let failure
    let capabilityResult
    let stage3Observer

    try {
        const userscript = await readUserscript()
        const { chromium } = await import('playwright')

        browser = await launchChrome(chromium, options, deadline)
        console.log(`[cdn-live-e2e] browserVersion=${JSON.stringify(browser.version())}`)

        context = await runStage('browser-context', deadline, 10_000, () => browser.newContext({
            acceptDownloads: false,
            locale: 'en-US',
            serviceWorkers: 'block',
        }))

        await runStage('cdn-mode-setup', deadline, 5_000, () => context.addCookies([{
            name: 'balh_cdn_mode',
            value: 'auto',
            domain: '.bilibili.com',
            path: '/',
            secure: true,
            sameSite: 'Lax',
        }]))
        await runStage('proxy-isolation', deadline, 5_000, () => assertNoCustomProxyCookies(context))

        await runStage('userscript-install', deadline, 10_000, () => context.addInitScript({
            content: createInitScript(userscript, options.stage3Capability),
        }))

        const page = await runStage('page-create', deadline, 5_000, () => context.newPage())
        if (options.stage3Capability) stage3Observer = createStage3BrowserObserver(page)
        page.setDefaultTimeout(Math.min(30_000, options.timeoutMs))
        page.setDefaultNavigationTimeout(Math.min(45_000, options.timeoutMs))

        await runStage('navigation', deadline, 45_000, timeoutMs => page.goto(options.url.href, {
            waitUntil: 'domcontentloaded',
            timeout: timeoutMs,
        }))
        await assertPageIdentity(page, options)
        await assertHarnessConfiguration(page, context, deadline)
        await waitForUserscriptApi(page, deadline)
        await waitForVideoMetadata(page, deadline)
        await assertPlaybackAdvances(page, deadline)
        await waitForCdnCandidates(page, deadline)

        if (options.stage3Capability) {
            capabilityResult = await runStage3Capability(page, deadline, stage3Observer)
        } else {
            const probe = await forceCdnProbe(page, deadline)
            assertProbeSummary(probe.status)
            const expectedCacheHosts = assertCacheSummary(probe.cache, probe.status)
            const cacheReuse = await verifyCacheReuse(page, context, options, deadline, expectedCacheHosts)
            printProbeSummary(probe.status, probe.cache, cacheReuse)

            if (probe.status.state === 'failed') {
                throw new HarnessFailure('cdn-probe', 'failed')
            }
        }

        await assertHarnessConfiguration(page, context, deadline)
        if (!options.stage3Capability) console.log('[cdn-live-e2e] PASS')
    } catch (error) {
        failure = error instanceof HarnessFailure
            ? error
            : new HarnessFailure('browser-operation', error?.name === 'TimeoutError' ? 'timeout' : 'failed')
    } finally {
        stage3Observer?.dispose()
        const closed = await closeWithDeadline(
            () => browser ? browser.close() : context?.close(),
            cleanupTimeoutMs,
        )
        if (!closed && !failure) {
            failure = new HarnessFailure('cleanup', 'failed')
        }
    }

    if (failure) throw failure
    return capabilityResult
}

function parseArgs(args) {
    let rawUrl = defaultUrl
    let timeoutMs = defaultTimeoutMs
    let headless = true
    let help = false
    let stage3Capability = false

    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index]
        if (arg === '--') {
            continue
        } else if (arg === '--help' || arg === '-h') {
            help = true
        } else if (arg === '--headless') {
            headless = true
        } else if (arg === '--headed') {
            headless = false
        } else if (arg === '--stage3-capability') {
            stage3Capability = true
        } else if (arg === '--url' || arg.startsWith('--url=')) {
            const value = readOptionValue(args, index, '--url')
            rawUrl = value.value
            index = value.index
        } else if (arg === '--timeout-ms' || arg.startsWith('--timeout-ms=')) {
            const value = readOptionValue(args, index, '--timeout-ms')
            timeoutMs = Number(value.value)
            index = value.index
        } else {
            throw new HarnessFailure('arguments', 'unknown-option')
        }
    }

    if (help) return { help: true }
    if (!Number.isInteger(timeoutMs) || timeoutMs < minTimeoutMs || timeoutMs > maxTimeoutMs) {
        throw new HarnessFailure('arguments', 'invalid-timeout')
    }

    let parsed
    try {
        parsed = new URL(rawUrl)
    } catch {
        throw new HarnessFailure('arguments', 'invalid-url')
    }
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'www.bilibili.com'
        || parsed.username || parsed.password) {
        throw new HarnessFailure('arguments', 'unsupported-url')
    }
    const bvid = parsed.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10})(?:\/|$)/)?.[1]
    if (!bvid) throw new HarnessFailure('arguments', 'missing-bvid')

    const normalizedUrl = new URL(`https://www.bilibili.com/video/${bvid}/`)
    const part = parsed.searchParams.get('p')
    if (part && /^\d+$/.test(part)) normalizedUrl.searchParams.set('p', part)

    return { bvid, headless, help: false, stage3Capability, timeoutMs, url: normalizedUrl }
}

function readOptionValue(args, index, name) {
    const arg = args[index]
    if (arg.startsWith(`${name}=`)) {
        const value = arg.slice(name.length + 1)
        if (!value) throw new HarnessFailure('arguments', 'missing-option-value')
        return { value, index }
    }
    const value = args[index + 1]
    if (!value || value.startsWith('--')) {
        throw new HarnessFailure('arguments', 'missing-option-value')
    }
    return { value, index: index + 1 }
}

function printUsage() {
    console.log(`Usage: node scripts/test-cdn-live-e2e.mjs [options]

Options:
  --url <url>          Public Bilibili BV video page. Default BVID: BV17x411w7KC.
  --timeout-ms <ms>    Operation deadline (${minTimeoutMs}-${maxTimeoutMs}). Default: ${defaultTimeoutMs}.
  --headless           Run installed Chrome headlessly (default).
  --headed             Run installed Chrome with a visible window.
  --stage3-capability  Run the optional Stage 3 live capability classifier only.
  --help, -h           Show this help.

This live gate uses a fresh, logged-out browser context and no BALH proxy.
Stage 3 PASS exits 0; FAIL, UNSUPPORTED, and INCONCLUSIVE are non-success results.`)
}

async function readUserscript() {
    try {
        const source = await readFile(userscriptPath, 'utf8')
        if (!source.includes('window.bangumi_area_limit_hack')) {
            throw new HarnessFailure('userscript-read', 'api-marker-missing')
        }
        return source
    } catch (error) {
        if (error instanceof HarnessFailure) throw error
        throw new HarnessFailure('userscript-read', 'missing-build-output')
    }
}

async function launchChrome(chromium, options, deadline) {
    const timeout = Math.min(20_000, deadline.remaining())
    try {
        return await chromium.launch({
            channel: 'chrome',
            headless: options.headless,
            timeout,
            args: ['--disk-cache-size=0', '--media-cache-size=0'],
        })
    } catch {
        throw new HarnessFailure('browser-launch', 'installed-chrome-unavailable')
    }
}

function createInitScript(userscript, stage3Capability = false) {
    const capabilityHook = stage3Capability ? createStage3CapabilityHookScript() : ''
    return `;(() => {
        const isBilibili = location.hostname === 'bilibili.com'
            || location.hostname.endsWith('.bilibili.com')
        if (!isBilibili) return
        localStorage.setItem('balh_migrate_to_2', 'Y')
        ${capabilityHook}
        const GM_info = Object.freeze({
            script: Object.freeze({ name: 'BALH CDN live E2E', version: 'local' }),
            scriptHandler: 'Playwright live E2E',
        })
        ${userscript}
    })();`
}

function createStage3CapabilityHookScript() {
    return `;(${installStage3CapabilityHooks.toString()})(${JSON.stringify(stage3HookSymbol)}, ${stage3MaxBrowserRequests});`
}

function installStage3CapabilityHooks(symbolName, maxHistory) {
    const history = []
    const documentId = (() => {
        try {
            return crypto.randomUUID()
        } catch {
            return `${Date.now()}:${Math.random()}`
        }
    })()
    let overflowed = false
    let exactIndex = new Map()
    let fetchInstalled = false
    let xhrInstalled = false

    const record = (transport, method, url) => {
        if (typeof method !== 'string' || method.toUpperCase() !== 'GET' || typeof url !== 'string') return
        if (history.length >= maxHistory) {
            overflowed = true
            history.shift()
        }
        history.push({ transport, url })
    }

    try {
        const predecessorFetch = window.fetch
        if (typeof predecessorFetch === 'function') {
            window.fetch = function (input, init) {
                const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
                const url = typeof input === 'string'
                    ? input
                    : input instanceof URL
                        ? input.href
                        : input instanceof Request
                            ? input.url
                            : null
                record('fetch', method, url)
                return predecessorFetch.apply(this, arguments)
            }
            fetchInstalled = true
        }
    } catch {
        fetchInstalled = false
    }

    try {
        const prototype = window.XMLHttpRequest?.prototype
        const predecessorOpen = prototype && Reflect.get(prototype, 'open')
        if (prototype && typeof predecessorOpen === 'function') {
            const descriptor = Object.getOwnPropertyDescriptor(prototype, 'open')
            Object.defineProperty(prototype, 'open', {
                configurable: descriptor?.configurable ?? true,
                enumerable: descriptor?.enumerable ?? false,
                writable: descriptor?.writable ?? true,
                value: function (method, url) {
                    record('xhr', method, typeof url === 'string' ? url : null)
                    return predecessorOpen.apply(this, arguments)
                },
            })
            xhrInstalled = true
        }
    } catch {
        xhrInstalled = false
    }

    const configure = candidateGroups => {
        const nextIndex = new Map()
        const add = (url, groupIndex, candidateIndex) => {
            const existing = nextIndex.get(url)
            const match = { groupIndex, candidateIndex }
            if (existing) existing.push(match)
            else nextIndex.set(url, [match])
        }
        if (Array.isArray(candidateGroups)) {
            candidateGroups.forEach((candidates, groupIndex) => {
                if (!Array.isArray(candidates)) return
                candidates.forEach((url, candidateIndex) => {
                    if (typeof url !== 'string' || !url) return
                    add(url, groupIndex, candidateIndex)
                    if (url.startsWith('//') && !url.startsWith('///')) {
                        add(`${location.protocol}${url}`, groupIndex, candidateIndex)
                    }
                })
            })
        }
        exactIndex = nextIndex
    }

    const snapshot = () => {
        const counts = new Map()
        let ambiguousCalls = 0
        for (const item of history) {
            const matches = exactIndex.get(item.url)
            if (!matches) continue
            if (matches.length !== 1) {
                ambiguousCalls += 1
                continue
            }
            const match = matches[0]
            const key = `${match.groupIndex}:${match.candidateIndex}`
            const current = counts.get(key) ?? {
                groupIndex: match.groupIndex,
                candidateIndex: match.candidateIndex,
                fetchCalls: 0,
                xhrCalls: 0,
            }
            if (item.transport === 'fetch') current.fetchCalls += 1
            if (item.transport === 'xhr') current.xhrCalls += 1
            counts.set(key, current)
        }
        return {
            installed: true,
            documentId,
            fetchInstalled,
            xhrInstalled,
            overflowed,
            ambiguousCalls,
            exactCalls: [...counts.values()],
        }
    }

    const hook = Object.freeze({ configure, snapshot })
    try {
        Object.defineProperty(window, Symbol.for(symbolName), {
            configurable: false,
            enumerable: false,
            writable: false,
            value: hook,
        })
    } catch {
        // The capability gate reports a missing hook without changing playback.
    }
}

function createStage3BrowserObserver(page) {
    const records = []
    const recordsByRequest = new WeakMap()
    let overflowed = false
    let sequence = 0

    const onRequest = request => {
        let record
        try {
            record = {
                request,
                sequence: ++sequence,
                startedAt: Date.now(),
                url: request.url(),
                method: request.method(),
                resourceType: request.resourceType(),
                responded: false,
                responseOk: false,
                finished: false,
                failed: false,
                aborted: false,
            }
        } catch {
            return
        }
        if (records.length >= stage3MaxBrowserRequests) {
            overflowed = true
            records.shift()
        }
        records.push(record)
        recordsByRequest.set(request, record)
    }
    const onRequestFinished = request => {
        const record = recordsByRequest.get(request)
        if (record) record.finished = true
    }
    const onResponse = response => {
        let record
        try {
            record = recordsByRequest.get(response.request())
        } catch {
            return
        }
        if (!record) return
        record.responded = true
        try {
            record.responseOk = response.ok()
        } catch {
            // An unreadable response is not success evidence.
        }
    }
    const onRequestFailed = request => {
        const record = recordsByRequest.get(request)
        if (!record) return
        record.failed = true
        try {
            const errorText = request.failure()?.errorText
            record.aborted = typeof errorText === 'string' && /abort|cancel/i.test(errorText)
        } catch {
            // Unknown request failure is not proof of an abort.
        }
    }

    page.on('request', onRequest)
    page.on('response', onResponse)
    page.on('requestfinished', onRequestFinished)
    page.on('requestfailed', onRequestFailed)

    return {
        snapshot() {
            return {
                records: records.slice(),
                overflowed,
                sequence,
            }
        },
        recordForRequest(request) {
            return recordsByRequest.get(request) ?? null
        },
        dispose() {
            page.off('request', onRequest)
            page.off('response', onResponse)
            page.off('requestfinished', onRequestFinished)
            page.off('requestfailed', onRequestFailed)
        },
    }
}

async function assertPageIdentity(page, options) {
    let actual
    try {
        actual = new URL(page.url())
    } catch {
        throw new HarnessFailure('page-identity', 'invalid-location')
    }
    if (actual.hostname !== options.url.hostname || !actual.pathname.includes(options.bvid)) {
        throw new HarnessFailure('page-identity', 'unexpected-location')
    }
    const expectedPart = options.url.searchParams.get('p')
    if (expectedPart && actual.searchParams.get('p') !== expectedPart) {
        throw new HarnessFailure('page-identity', 'unexpected-part')
    }
}

async function assertNoCustomProxyCookies(context) {
    const cookies = await context.cookies()
    if (cookies.some(cookie => cookie.name.startsWith('balh_server_custom'))) {
        throw new HarnessFailure('proxy-isolation', 'custom-proxy-cookie-present')
    }
}

async function assertHarnessConfiguration(page, context, deadline) {
    const state = await runStage('configuration', deadline, 5_000, () => page.evaluate(() => {
        const cookies = Object.fromEntries(document.cookie.split('; ')
            .filter(Boolean)
            .map(item => {
                const [name, ...value] = item.split('=')
                return [name, value.join('=')]
            }))
        return {
            cdnMode: cookies.balh_cdn_mode,
            migration: localStorage.getItem('balh_migrate_to_2'),
            localCustomProxyCount: Object.keys(localStorage)
                .filter(key => key.startsWith('balh_server_custom')).length,
            hasAccessKey: localStorage.getItem('access_key') !== null,
        }
    }))
    await runStage('proxy-isolation', deadline, 5_000, () => assertNoCustomProxyCookies(context))
    if (state.cdnMode !== 'auto' || state.migration !== 'Y') {
        throw new HarnessFailure('configuration', 'cdn-mode-or-migration-mismatch')
    }
    if (state.localCustomProxyCount !== 0) {
        throw new HarnessFailure('proxy-isolation', 'custom-proxy-storage-present')
    }
    if (state.hasAccessKey) {
        throw new HarnessFailure('authentication-isolation', 'access-key-present')
    }
}

async function waitForUserscriptApi(page, deadline) {
    await runStage('userscript-api', deadline, 20_000, timeout => page.waitForFunction(() => {
        const api = window.bangumi_area_limit_hack
        return typeof api === 'object'
            && typeof api.testCurrentVideoCdn === 'function'
            && typeof api.clearCdnHealthCache === 'function'
            && typeof api.getCdnProbeStatus === 'function'
    }, undefined, { timeout }))
}

async function waitForVideoMetadata(page, deadline) {
    await runStage('video-metadata', deadline, 35_000, timeout => page.waitForFunction(() => {
        return Array.from(document.querySelectorAll('video')).some(video => (
            video.readyState >= HTMLMediaElement.HAVE_METADATA
            && Number.isFinite(video.duration)
            && video.duration > 0
            && Boolean(video.currentSrc || video.src)
        ))
    }, undefined, { timeout }))
}

async function assertPlaybackAdvances(page, deadline) {
    const result = await runStage('video-playback', deadline, 15_000, timeout => page.evaluate(async innerTimeout => {
        const video = Array.from(document.querySelectorAll('video')).find(item => (
            item.readyState >= HTMLMediaElement.HAVE_METADATA
            && Number.isFinite(item.duration)
            && item.duration > 0
        ))
        if (!video) return { ok: false, reason: 'video-missing' }

        video.muted = true
        const startedAt = video.currentTime
        try {
            await video.play()
        } catch {
            return { ok: false, reason: 'play-rejected' }
        }

        return new Promise(resolve => {
            const began = performance.now()
            const timer = setInterval(() => {
                if (video.currentTime >= startedAt + 0.25) {
                    clearInterval(timer)
                    resolve({ ok: true })
                } else if (performance.now() - began >= innerTimeout) {
                    clearInterval(timer)
                    resolve({ ok: false, reason: 'time-did-not-advance' })
                }
            }, 100)
        })
    }, Math.max(1_000, timeout - 500)))

    if (!result?.ok) {
        throw new HarnessFailure('video-playback', result?.reason || 'failed')
    }
}

async function waitForCdnCandidates(page, deadline) {
    try {
        await runStage('cdn-candidates', deadline, 30_000, timeout => page.waitForFunction(() => {
            const status = window.bangumi_area_limit_hack?.getCdnProbeStatus?.()
            return Array.isArray(status?.candidateHosts) && status.candidateHosts.length > 0
        }, undefined, { timeout }))
    } catch (error) {
        const evidence = await collectCdnCandidateEvidence(page, deadline)
        console.log(`[cdn-live-e2e] candidateEvidence=${JSON.stringify(evidence)}`)
        throw error
    }
}

async function collectCdnCandidateEvidence(page, deadline) {
    try {
        return await runStage('cdn-candidate-evidence', deadline, 3_000, () => page.evaluate(() => {
            const classifyEndpoint = entry => {
                let parsed
                try {
                    parsed = new URL(entry.name)
                } catch {
                    return null
                }
                const key = `${parsed.hostname}${parsed.pathname}`
                if (key === 'api.bilibili.com/x/player/wbi/playurl') return 'x-player-wbi-playurl'
                if (key === 'api.bilibili.com/x/player/playurl') return 'x-player-playurl'
                if (key === 'api.bilibili.com/pgc/player/web/playurl') return 'pgc-web-playurl'
                if (key === 'api.bilibili.com/pgc/player/web/v2/playurl') return 'pgc-web-v2-playurl'
                if (parsed.pathname.includes('playurl')) return 'other-playurl'
                return null
            }
            const endpointCounts = Object.create(null)
            const initiatorTypes = new Set()
            for (const entry of performance.getEntriesByType('resource')) {
                const endpoint = classifyEndpoint(entry)
                if (!endpoint) continue
                endpointCounts[endpoint] = (endpointCounts[endpoint] ?? 0) + 1
                if (typeof entry.initiatorType === 'string' && entry.initiatorType) {
                    initiatorTypes.add(entry.initiatorType)
                }
            }
            const playInfo = window.__PLAYURL_HYDRATE_DATA__
                || window.__playinfo__ || window.__playinfo__origin
            const payload = playInfo?.data?.dash || playInfo?.data?.durl
                ? playInfo.data
                : playInfo?.result?.dash || playInfo?.result?.durl
                    ? playInfo.result
                    : playInfo
            const status = window.bangumi_area_limit_hack?.getCdnProbeStatus?.()
            return {
                apiState: typeof status?.state === 'string' ? status.state : 'missing',
                candidateHostCount: Array.isArray(status?.candidateHosts) ? status.candidateHosts.length : -1,
                endpointCounts,
                hasDash: Boolean(payload?.dash),
                hasDurl: Array.isArray(payload?.durl),
                initiatorTypes: [...initiatorTypes].sort(),
            }
        }))
    } catch {
        return { unavailable: true }
    }
}

async function runStage3Capability(page, deadline, observer) {
    if (!observer) throw new HarnessFailure('stage3-observer', 'missing')
    await waitForStage3RecoveryApi(page, deadline)

    const exactSnapshot = await readStage3ExactGroups(page, deadline)
    if (!exactSnapshot.matched || exactSnapshot.groups.length === 0) {
        return stage3CapabilityResult('INCONCLUSIVE', 'no-unique-exact-group')
    }
    const groups = exactSnapshot.groups
    const hookSnapshot = await configureStage3PageHooks(page, deadline, groups)
    if (!hookSnapshot?.installed || typeof hookSnapshot.documentId !== 'string') {
        return stage3CapabilityResult('UNSUPPORTED', 'page-hooks-unavailable')
    }
    if (hookSnapshot.overflowed || observer.snapshot().overflowed) {
        return stage3CapabilityResult('INCONCLUSIVE', 'observation-history-overflow')
    }
    if (!await waitForStage3BackgroundProbe(page, deadline)) {
        return stage3CapabilityResult('INCONCLUSIVE', 'background-probe-did-not-settle')
    }

    const observation = await observeStage3Transport(page, deadline, observer, groups)
    if (observation.result) return observation.result
    return runStage3FaultWindow(page, deadline, observer, groups, observation)
}

async function waitForStage3BackgroundProbe(page, deadline) {
    const end = boundedStageEnd(deadline, 10_000)
    let settledSince = null
    while (Date.now() < end) {
        const state = await runStage('stage3-probe-state', deadline, 2_000, () => page.evaluate(() => (
            window.bangumi_area_limit_hack?.getCdnProbeStatus?.()?.state
        )))
        if (state !== 'probing') {
            settledSince ??= Date.now()
            if (Date.now() - settledSince >= 500) return true
        } else {
            settledSince = null
        }
        await stage3Delay(deadline, stage3PollIntervalMs)
    }
    return false
}

async function waitForStage3RecoveryApi(page, deadline) {
    await runStage('stage3-api', deadline, 12_000, timeout => page.waitForFunction(() => {
        return typeof window.bangumi_area_limit_hack?.getCdnRecoveryStatus === 'function'
    }, undefined, { timeout }))
}

async function readStage3ExactGroups(page, deadline) {
    return runStage('stage3-exact-groups', deadline, 5_000, () => page.evaluate(() => {
        const isRecord = value => typeof value === 'object' && value !== null
        const isCompleteUrl = value => {
            if (typeof value !== 'string' || !value) return false
            try {
                const protocolRelative = value.startsWith('//') && !value.startsWith('///')
                const parsed = new URL(protocolRelative ? `https:${value}` : value)
                return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && Boolean(parsed.hostname)
            } catch {
                return false
            }
        }
        const collectBackupUrls = (value, urls, seen, depth = 0) => {
            if (depth > 32 || urls.length > 10_000) return
            if (isCompleteUrl(value)) {
                urls.push(value)
                return
            }
            if (!isRecord(value) || seen.has(value)) return
            seen.add(value)
            if (Array.isArray(value)) {
                for (const item of value) collectBackupUrls(item, urls, seen, depth + 1)
            } else if (Object.prototype.hasOwnProperty.call(value, 'url')) {
                collectBackupUrls(value.url, urls, seen, depth + 1)
            }
        }
        const collectGroup = (stream, key, kind, mainKeys) => {
            if (!isRecord(stream)) return null
            const urls = []
            for (const field of mainKeys) {
                if (Object.prototype.hasOwnProperty.call(stream, field) && isCompleteUrl(stream[field])) {
                    urls.push(stream[field])
                }
            }
            for (const field of ['backup_url', 'backupUrl']) {
                if (!Object.prototype.hasOwnProperty.call(stream, field)) continue
                collectBackupUrls(stream[field], urls, new Set())
            }
            const candidates = [...new Set(urls)]
            return candidates.length > 0 ? { key, kind, candidates } : null
        }
        const collectCollection = (groups, value, key, kind, mainKeys) => {
            if (Array.isArray(value)) {
                value.forEach((stream, index) => {
                    const group = collectGroup(stream, `${key}[${index}]`, kind, mainKeys)
                    if (group) groups.push(group)
                })
            } else {
                const group = collectGroup(value, key, kind, mainKeys)
                if (group) groups.push(group)
            }
        }
        const collectGroups = payload => {
            if (!isRecord(payload)) return []
            const groups = []
            const dash = isRecord(payload.dash) ? payload.dash : null
            if (dash) {
                collectCollection(groups, dash.video, 'dash.video', 'dash-video', ['base_url', 'baseUrl'])
                collectCollection(groups, dash.audio, 'dash.audio', 'dash-audio', ['base_url', 'baseUrl'])
                if (isRecord(dash.dolby)) {
                    collectCollection(groups, dash.dolby.audio, 'dash.dolby.audio', 'dash-dolby-audio', ['base_url', 'baseUrl'])
                }
                if (isRecord(dash.flac)) {
                    collectCollection(groups, dash.flac.audio, 'dash.flac.audio', 'dash-flac-audio', ['base_url', 'baseUrl'])
                }
            }
            collectCollection(groups, payload.durl, 'durl', 'durl', ['url'])
            return groups
        }
        const findPayloads = root => [
            root?.result?.video_info,
            root?.data?.video_info,
            root?.video_info,
            root?.result,
            root?.data,
            root,
        ].filter(value => isRecord(value)
            && (isRecord(value.dash) || Array.isArray(value.durl) || isRecord(value.durl)))
        const status = window.bangumi_area_limit_hack?.getCdnRecoveryStatus?.()
        const statusGroups = Array.isArray(status?.groups) ? status.groups : []
        const matchesStatus = groups => groups.length === statusGroups.length
            && groups.every((group, index) => {
                const expected = statusGroups[index]
                return expected?.key === group.key
                    && expected?.kind === group.kind
                    && expected?.candidateCount === group.candidates.length
            })

        const roots = []
        for (const name of ['__PLAYURL_HYDRATE_DATA__', '__playinfo__', '__playinfo__origin']) {
            try {
                if (isRecord(window[name])) roots.push(window[name])
            } catch {
                // A hostile getter cannot make a stale snapshot authoritative.
            }
        }
        for (const root of roots) {
            for (const payload of findPayloads(root)) {
                const groups = collectGroups(payload)
                if (groups.length > 0 && matchesStatus(groups)) return { matched: true, groups }
            }
        }
        return { matched: false, groups: [] }
    }))
}

async function configureStage3PageHooks(page, deadline, groups) {
    return runStage('stage3-page-hooks', deadline, 5_000, () => page.evaluate(
        ({ symbolName, candidateGroups }) => {
            const hook = window[Symbol.for(symbolName)]
            if (!hook || typeof hook.configure !== 'function' || typeof hook.snapshot !== 'function') {
                return { installed: false }
            }
            hook.configure(candidateGroups)
            return hook.snapshot()
        },
        {
            symbolName: stage3HookSymbol,
            candidateGroups: groups.map(group => group.candidates),
        },
    ))
}

async function readStage3CapabilitySample(page, deadline) {
    const sample = await runStage('stage3-sample', deadline, stage3StatusSampleTimeoutMs, () => page.evaluate(symbolName => {
        const rawStatus = window.bangumi_area_limit_hack?.getCdnRecoveryStatus?.()
        const status = rawStatus && typeof rawStatus === 'object' ? {
            enabled: rawStatus.enabled,
            contextEpoch: rawStatus.contextEpoch,
            generation: rawStatus.generation,
            groupCount: rawStatus.groupCount,
            activeGroupCount: rawStatus.activeGroupCount,
            groups: Array.isArray(rawStatus.groups) ? rawStatus.groups.map(group => ({
                groupId: group?.groupId,
                key: group?.key,
                kind: group?.kind,
                generation: group?.generation,
                candidateCount: group?.candidateCount,
                candidateIndex: group?.candidateIndex,
                attemptedCount: group?.attemptedCount,
                routeRevision: group?.routeRevision,
                state: group?.state,
                switchAttempts: group?.switchAttempts,
                retryAt: group?.retryAt,
                timerPending: group?.timerPending,
            })) : null,
        } : null

        const selectVideo = () => {
            let connected
            try {
                connected = Array.from(document.querySelectorAll('video')).filter(video => video.isConnected)
            } catch {
                return null
            }
            let playing
            try {
                playing = connected.filter(video => !video.ended && !video.paused)
            } catch {
                return null
            }
            if (playing.length === 1) return playing[0]
            if (playing.length > 1) return null
            let mediaBearing
            try {
                mediaBearing = connected.filter(video => video.currentSrc || video.src || video.srcObject != null)
            } catch {
                return null
            }
            return mediaBearing.length === 1 ? mediaBearing[0] : null
        }
        const readSignals = video => {
            if (!video) return null
            try {
                const visible = document.visibilityState === 'visible'
                    ? true
                    : document.visibilityState === 'hidden'
                        ? false
                        : null
                const currentTimeSeconds = video.currentTime
                if (visible === null || !Number.isFinite(currentTimeSeconds)) return null
                const buffered = video.buffered
                if (!Number.isSafeInteger(buffered.length) || buffered.length < 0 || buffered.length > 10_000) {
                    return null
                }
                let bufferedAheadSeconds = null
                for (let index = 0; index < buffered.length; index += 1) {
                    const start = buffered.start(index)
                    const end = buffered.end(index)
                    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return null
                    if (start <= currentTimeSeconds && currentTimeSeconds <= end) {
                        const ahead = end - currentTimeSeconds
                        bufferedAheadSeconds = bufferedAheadSeconds === null
                            ? ahead
                            : Math.max(bufferedAheadSeconds, ahead)
                    }
                }
                const duration = video.duration
                return {
                    visible,
                    paused: video.paused,
                    seeking: video.seeking,
                    ended: video.ended,
                    currentTimeSeconds,
                    durationSeconds: Number.isFinite(duration) ? duration : null,
                    bufferedAheadSeconds: bufferedAheadSeconds ?? 0,
                }
            } catch {
                return null
            }
        }

        const hook = window[Symbol.for(symbolName)]
        return {
            now: Date.now(),
            status,
            signals: readSignals(selectVideo()),
            hooks: typeof hook?.snapshot === 'function' ? hook.snapshot() : { installed: false },
        }
    }, stage3HookSymbol))
    validateStage3RecoveryStatus(sample?.status)
    return sample
}

function validateStage3RecoveryStatus(status) {
    const states = new Set(['disabled', 'unseen', 'monitoring', 'confirming', 'waiting-retry', 'exhausted'])
    if (!status || typeof status.enabled !== 'boolean'
        || !Number.isInteger(status.contextEpoch) || status.contextEpoch < 0
        || !Number.isInteger(status.generation) || status.generation < 0
        || !Number.isInteger(status.groupCount) || status.groupCount < 0
        || !Number.isInteger(status.activeGroupCount) || status.activeGroupCount < 0
        || !Array.isArray(status.groups) || status.groups.length !== status.groupCount) {
        throw new HarnessFailure('stage3-status', 'invalid')
    }
    for (const group of status.groups) {
        if (!Number.isInteger(group.groupId) || group.groupId < 0
            || typeof group.key !== 'string' || typeof group.kind !== 'string'
            || !Number.isInteger(group.generation) || group.generation < 0
            || !Number.isInteger(group.candidateCount) || group.candidateCount < 1
            || (group.candidateIndex !== null
                && (!Number.isInteger(group.candidateIndex)
                    || group.candidateIndex < 0 || group.candidateIndex >= group.candidateCount))
            || !Number.isInteger(group.attemptedCount) || group.attemptedCount < 0
            || !Number.isInteger(group.routeRevision) || group.routeRevision < 0
            || !states.has(group.state)
            || !Number.isInteger(group.switchAttempts) || group.switchAttempts < 0
            || (group.retryAt !== null && (!Number.isFinite(group.retryAt) || group.retryAt < 0))
            || typeof group.timerPending !== 'boolean') {
            throw new HarnessFailure('stage3-status', 'invalid-group')
        }
    }
}

async function observeStage3Transport(page, deadline, observer, groups) {
    const end = boundedStageEnd(deadline, stage3ObservationTimeoutMs)
    let lastAnalysis
    let lastSample
    while (Date.now() < end) {
        const sample = await readStage3CapabilitySample(page, deadline)
        const analysis = analyzeStage3Transport(groups, observer.snapshot(), sample.hooks)
        lastAnalysis = analysis
        lastSample = sample

        if (analysis.observationOverflowed) {
            return {
                result: stage3CapabilityResult('INCONCLUSIVE', 'observation-history-overflow', analysis.evidence),
            }
        }
        if (analysis.unsupportedReason) {
            return {
                result: stage3CapabilityResult('UNSUPPORTED', analysis.unsupportedReason, analysis.evidence),
            }
        }
        if (!sample.status.enabled) {
            return {
                result: stage3CapabilityResult('FAIL', 'recovery-disabled', analysis.evidence),
            }
        }

        const selected = selectStage3ObservedGroup(groups, sample.status, analysis)
        if (selected) return { analysis, sample, selected }
        await stage3Delay(deadline, stage3PollIntervalMs)
    }

    const evidence = lastAnalysis?.evidence
    if (!lastAnalysis || lastAnalysis.uniqueBrowserRecords.length === 0) {
        return { result: stage3CapabilityResult('INCONCLUSIVE', 'no-unique-exact-group', evidence) }
    }
    const hasAlternateGroup = lastAnalysis.supportedRecords.some(record => (
        groups[record.match.groupIndex]?.candidates.length > 1
    ))
    if (!hasAlternateGroup) {
        return { result: stage3CapabilityResult('INCONCLUSIVE', 'no-same-group-alternate', evidence) }
    }
    if (lastSample && lastSample.status.activeGroupCount === 0) {
        return { result: stage3CapabilityResult('INCONCLUSIVE', 'no-active-exact-group', evidence) }
    }
    return { result: stage3CapabilityResult('INCONCLUSIVE', 'no-interceptable-exact-group', evidence) }
}

function analyzeStage3Transport(groups, observerSnapshot, hookSnapshot) {
    const exactIndex = createStage3ExactIndex(groups)
    const uniqueBrowserRecords = []
    let ambiguousBrowserRequests = 0
    for (const record of observerSnapshot.records) {
        if (typeof record.method !== 'string' || record.method.toUpperCase() !== 'GET') continue
        const matches = exactIndex.get(record.url)
        if (!matches) continue
        if (matches.length !== 1) {
            ambiguousBrowserRequests += 1
            continue
        }
        uniqueBrowserRecords.push({ ...record, match: matches[0] })
    }

    const hookCounts = new Map()
    let pageFetchCalls = 0
    let pageXhrCalls = 0
    if (Array.isArray(hookSnapshot?.exactCalls)) {
        for (const item of hookSnapshot.exactCalls) {
            if (!Number.isInteger(item?.groupIndex) || !Number.isInteger(item?.candidateIndex)
                || !Number.isInteger(item?.fetchCalls) || item.fetchCalls < 0
                || !Number.isInteger(item?.xhrCalls) || item.xhrCalls < 0) continue
            hookCounts.set(stage3MatchKey(item), item)
            pageFetchCalls += item.fetchCalls
            pageXhrCalls += item.xhrCalls
        }
    }

    const browserCounts = new Map()
    for (const record of uniqueBrowserRecords) {
        const key = `${stage3MatchKey(record.match)}:${record.resourceType}`
        browserCounts.set(key, (browserCounts.get(key) ?? 0) + 1)
    }

    let unsupportedReason = null
    if (uniqueBrowserRecords.some(record => record.resourceType === 'media')) {
        unsupportedReason = 'native-media-loader'
    } else {
        for (const [key, count] of browserCounts) {
            const separator = key.lastIndexOf(':')
            const matchKey = key.slice(0, separator)
            const resourceType = key.slice(separator + 1)
            const pageCounts = hookCounts.get(matchKey)
            const matchingPageCalls = resourceType === 'fetch'
                ? pageCounts?.fetchCalls ?? 0
                : resourceType === 'xhr'
                    ? pageCounts?.xhrCalls ?? 0
                    : 0
            if (matchingPageCalls < count) {
                unsupportedReason = 'browser-request-without-page-hook'
                break
            }
        }
    }

    const supportedRecords = unsupportedReason ? [] : uniqueBrowserRecords.filter(record => (
        record.resourceType === 'fetch' || record.resourceType === 'xhr'
    ))
    return {
        exactIndex,
        uniqueBrowserRecords,
        supportedRecords,
        observationOverflowed: observerSnapshot.overflowed === true || hookSnapshot?.overflowed === true,
        unsupportedReason,
        evidence: {
            browserExactRequests: uniqueBrowserRecords.length,
            browserAmbiguousRequests: ambiguousBrowserRequests,
            browserFetchRequests: uniqueBrowserRecords.filter(record => record.resourceType === 'fetch').length,
            browserXhrRequests: uniqueBrowserRecords.filter(record => record.resourceType === 'xhr').length,
            browserMediaRequests: uniqueBrowserRecords.filter(record => record.resourceType === 'media').length,
            browserOtherRequests: uniqueBrowserRecords.filter(record => (
                record.resourceType !== 'fetch'
                    && record.resourceType !== 'xhr'
                    && record.resourceType !== 'media'
            )).length,
            pageFetchCalls,
            pageXhrCalls,
        },
    }
}

function selectStage3ObservedGroup(groups, status, analysis) {
    const candidates = []
    for (const record of analysis.supportedRecords) {
        const group = groups[record.match.groupIndex]
        const recovery = status.groups[record.match.groupIndex]
        if (!group || !recovery || group.key !== recovery.key || group.kind !== recovery.kind
            || group.candidates.length !== recovery.candidateCount || group.candidates.length < 2) continue
        // Background CDN probes use the captured predecessor directly and do not
        // activate recovery. A clean monitoring baseline also prevents an old
        // grace or cooldown from being counted as fault-injection evidence.
        if (recovery.state !== 'monitoring'
            || recovery.candidateIndex !== record.match.candidateIndex) continue
        const hasUniqueAlternate = group.candidates.some((_, candidateIndex) => (
            candidateIndex !== record.match.candidateIndex
                && isUniqueStage3Candidate(
                    groups,
                    analysis.exactIndex,
                    record.match.groupIndex,
                    candidateIndex,
                )
        ))
        if (!hasUniqueAlternate) continue
        candidates.push({
            groupIndex: record.match.groupIndex,
            initialCandidateIndex: record.match.candidateIndex,
            groupId: recovery.groupId,
            contextEpoch: status.contextEpoch,
            generation: recovery.generation,
            initialRouteRevision: recovery.routeRevision,
            initialSwitchAttempts: recovery.switchAttempts,
            kind: group.kind,
            resourceType: record.resourceType,
            sequence: record.sequence,
        })
    }
    candidates.sort((left, right) => (
        Number(right.kind === 'dash-video') - Number(left.kind === 'dash-video')
        || right.sequence - left.sequence
    ))
    return candidates[0] ?? null
}

function createStage3ExactIndex(groups) {
    const index = new Map()
    const add = (url, groupIndex, candidateIndex) => {
        const matches = index.get(url)
        const match = { groupIndex, candidateIndex }
        if (matches) matches.push(match)
        else index.set(url, [match])
    }
    groups.forEach((group, groupIndex) => {
        group.candidates.forEach((url, candidateIndex) => {
            add(url, groupIndex, candidateIndex)
            if (url.startsWith('//') && !url.startsWith('///')) {
                add(`https:${url}`, groupIndex, candidateIndex)
            }
        })
    })
    return index
}

function isUniqueStage3Candidate(groups, index, groupIndex, candidateIndex) {
    const url = groups[groupIndex]?.candidates[candidateIndex]
    if (typeof url !== 'string') return false
    const browserUrl = url.startsWith('//') && !url.startsWith('///') ? `https:${url}` : url
    const matches = index.get(browserUrl)
    return matches?.length === 1
        && matches[0].groupIndex === groupIndex
        && matches[0].candidateIndex === candidateIndex
}

function stage3MatchKey(match) {
    return `${match.groupIndex}:${match.candidateIndex}`
}

async function runStage3FaultWindow(page, deadline, observer, groups, observation) {
    const { selected } = observation
    const hold = await installStage3RequestHold(page, deadline, groups, selected)
    const documentId = observation.sample.hooks.documentId
    let preparation
    let result
    try {
        preparation = await prepareStage3FaultWindow(page, deadline)
        if (!preparation.ok) {
            result = stage3CapabilityResult('INCONCLUSIVE', preparation.reason, observation.analysis.evidence)
        } else {
            result = await waitForStage3RouteAdvance(
                page,
                deadline,
                observer,
                groups,
                selected,
                hold,
                documentId,
                observation.analysis.evidence,
            )
        }
    } finally {
        await hold.stop()
        if (preparation) await restoreStage3Playback(page, preparation)
    }
    if (hold.cleanupFailed) {
        return stage3CapabilityResult('FAIL', 'fault-route-cleanup-failed', result?.evidence)
    }
    if (hold.hasAbortedRequest(observer)) {
        return stage3CapabilityResult('INCONCLUSIVE', 'current-request-abort-unclassified', result?.evidence)
    }
    if (hold.hasFailedRequest(observer)) {
        return stage3CapabilityResult('INCONCLUSIVE', 'current-request-failure-unclassified', result?.evidence)
    }
    if (hold.hasReleaseFailure()) {
        return stage3CapabilityResult('INCONCLUSIVE', 'fault-route-continue-failed', result?.evidence)
    }
    if (hold.hasUnobservedRequest(observer)) {
        return stage3CapabilityResult('INCONCLUSIVE', 'held-request-not-observed', result?.evidence)
    }
    return result
}

async function installStage3RequestHold(page, deadline, groups, selected) {
    const exactIndex = createStage3ExactIndex(groups)
    const held = []
    const activeHandlers = new Set()
    let overflowed = false
    let stopped = false
    let holdingEnabled = true
    let exactContinueFailed = false
    let cleanupFailed = false

    const handler = route => {
        const task = (async () => {
            const request = route.request()
            let matches
            let method
            let resourceType
            try {
                matches = exactIndex.get(request.url())
                method = request.method()
                resourceType = request.resourceType()
            } catch {
                matches = null
            }
            const match = matches?.length === 1 ? matches[0] : null
            const interceptableGet = typeof method === 'string' && method.toUpperCase() === 'GET'
                && (resourceType === 'fetch' || resourceType === 'xhr')
            if (!stopped && holdingEnabled && interceptableGet
                && match?.groupIndex === selected.groupIndex
                && match.candidateIndex === selected.initialCandidateIndex) {
                if (held.length < stage3MaxHeldRequests) {
                    let release
                    let resolveSettled
                    const releasePromise = new Promise(resolve => {
                        release = resolve
                    })
                    const settled = new Promise(resolve => {
                        resolveSettled = resolve
                    })
                    const item = {
                        request,
                        release,
                        settled,
                        released: false,
                        continueFailed: false,
                    }
                    held.push(item)
                    try {
                        await releasePromise
                        await route.continue()
                    } catch {
                        item.continueFailed = true
                    } finally {
                        resolveSettled()
                    }
                    return
                }
                overflowed = true
            }
            try {
                await route.continue()
            } catch {
                if (interceptableGet && match?.groupIndex === selected.groupIndex) {
                    exactContinueFailed = true
                }
            }
        })().catch(() => {
            cleanupFailed = true
        })
        activeHandlers.add(task)
        void task.finally(() => activeHandlers.delete(task))
        return task
    }

    await runStage('stage3-fault-route', deadline, 5_000, () => page.route('**/*', handler))

    const releaseAll = async () => {
        holdingEnabled = false
        for (const item of held) {
            if (item.released) continue
            item.released = true
            item.release()
        }
        await Promise.all(held.map(item => item.settled))
    }
    const stop = async () => {
        if (stopped) return
        stopped = true
        await releaseAll()
        try {
            await page.unroute('**/*', handler)
        } catch {
            cleanupFailed = true
        }
        const handlersSettled = await closeWithDeadline(
            () => Promise.allSettled([...activeHandlers]),
            2_000,
        )
        if (!handlersSettled) cleanupFailed = true
    }

    return {
        held,
        releaseAll,
        stop,
        hasAbortedRequest(observer) {
            return held.some(item => observer.recordForRequest(item.request)?.aborted === true)
        },
        hasFailedRequest(observer) {
            return held.some(item => observer.recordForRequest(item.request)?.failed === true)
        },
        hasUnobservedRequest(observer) {
            return held.some(item => observer.recordForRequest(item.request) === null)
        },
        hasReleaseFailure() {
            return exactContinueFailed || held.some(item => item.continueFailed)
        },
        get overflowed() {
            return overflowed
        },
        get cleanupFailed() {
            return cleanupFailed
        },
    }
}

async function prepareStage3FaultWindow(page, deadline) {
    return runStage('stage3-fault-prepare', deadline, 5_000, () => page.evaluate(async () => {
        const selectVideo = () => {
            const connected = Array.from(document.querySelectorAll('video')).filter(video => video.isConnected)
            const playing = connected.filter(video => !video.ended && !video.paused)
            if (playing.length === 1) return playing[0]
            if (playing.length > 1) return null
            const mediaBearing = connected.filter(video => video.currentSrc || video.src || video.srcObject != null)
            return mediaBearing.length === 1 ? mediaBearing[0] : null
        }
        const video = selectVideo()
        if (!video) return { ok: false, reason: 'no-unique-video' }

        const originalPlaybackRate = video.playbackRate
        video.muted = true
        try {
            await video.play()
        } catch {
            return { ok: false, reason: 'playback-not-started' }
        }

        let strategy = 'accelerate'
        try {
            const currentTime = video.currentTime
            const duration = video.duration
            let target = null
            for (let index = 0; index < video.buffered.length; index += 1) {
                const start = video.buffered.start(index)
                const end = video.buffered.end(index)
                if (start <= currentTime && currentTime <= end && end - currentTime >= 0.75) {
                    const nearEdge = end - 0.2
                    const beforeNaturalEnd = Number.isFinite(duration) ? duration - 0.75 : nearEdge
                    const candidate = Math.min(nearEdge, beforeNaturalEnd)
                    if (candidate > currentTime + 0.25) target = candidate
                }
            }
            if (target !== null) {
                strategy = 'seek-buffer-edge'
                video.currentTime = target
                const waitEnd = performance.now() + 2_000
                while (video.seeking && performance.now() < waitEnd) {
                    await new Promise(resolve => setTimeout(resolve, 25))
                }
            }
            video.playbackRate = Math.max(1, Math.min(4, originalPlaybackRate * 4))
            await video.play()
        } catch {
            return { ok: false, reason: 'fault-window-unavailable', originalPlaybackRate }
        }
        return { ok: true, strategy, originalPlaybackRate }
    }))
}

async function restoreStage3Playback(page, preparation) {
    if (!Number.isFinite(preparation?.originalPlaybackRate)) return
    try {
        await page.evaluate(playbackRate => {
            const videos = Array.from(document.querySelectorAll('video'))
            const playing = videos.filter(video => video.isConnected && !video.ended && !video.paused)
            const video = playing.length === 1 ? playing[0] : videos.find(item => item.isConnected)
            if (video) video.playbackRate = playbackRate
        }, preparation.originalPlaybackRate)
    } catch {
        // Context shutdown remains authoritative cleanup.
    }
}

async function waitForStage3RouteAdvance(
    page,
    deadline,
    observer,
    groups,
    selected,
    hold,
    documentId,
    initialEvidence,
) {
    const end = boundedStageEnd(deadline, stage3FaultWindowTimeoutMs)
    let lowWindowStartedAt = null
    let lowWindowAnchor = null
    let validLowBufferWindow = false
    let sawLowBuffer = false
    let lastAnalysis
    let lastSample
    let lastUnswitchedNow = null

    while (Date.now() < end) {
        const sample = await readStage3CapabilitySample(page, deadline)
        const observerSnapshot = observer.snapshot()
        const analysis = analyzeStage3Transport(groups, observerSnapshot, sample.hooks)
        const evidence = stage3FaultEvidence(initialEvidence, analysis, hold, sawLowBuffer)
        lastAnalysis = analysis
        lastSample = sample

        if (sample.hooks.documentId !== documentId) {
            return stage3CapabilityResult('FAIL', 'page-reloaded', evidence)
        }
        if (analysis.observationOverflowed || hold.overflowed) {
            return stage3CapabilityResult('INCONCLUSIVE', 'fault-observation-overflow', evidence)
        }
        if (analysis.unsupportedReason) {
            return stage3CapabilityResult('UNSUPPORTED', analysis.unsupportedReason, evidence)
        }
        if (hold.hasAbortedRequest(observer)) {
            return stage3CapabilityResult('INCONCLUSIVE', 'current-request-abort-unclassified', evidence)
        }
        if (hold.hasFailedRequest(observer)) {
            return stage3CapabilityResult('INCONCLUSIVE', 'current-request-failure-unclassified', evidence)
        }
        if (hold.hasReleaseFailure()) {
            return stage3CapabilityResult('INCONCLUSIVE', 'fault-route-continue-failed', evidence)
        }

        const recovery = sample.status.groups.find(group => group.groupId === selected.groupId)
        if (!recovery || sample.status.contextEpoch !== selected.contextEpoch
            || recovery.generation !== selected.generation) {
            return stage3CapabilityResult('INCONCLUSIVE', 'media-context-changed', evidence)
        }
        if (recovery.switchAttempts < selected.initialSwitchAttempts
            || (recovery.switchAttempts === selected.initialSwitchAttempts
                && recovery.candidateIndex !== null
                && recovery.candidateIndex !== selected.initialCandidateIndex)) {
            return stage3CapabilityResult('INCONCLUSIVE', 'route-changed-before-fault-window', evidence)
        }

        const signals = sample.signals
        if (isEligibleStage3LowBuffer(signals)) {
            sawLowBuffer = true
            if (lowWindowStartedAt === null || lowWindowAnchor === null
                || signals.currentTimeSeconds - lowWindowAnchor >= 0.25) {
                lowWindowStartedAt = sample.now
                lowWindowAnchor = signals.currentTimeSeconds
            }
            if (sample.now - lowWindowStartedAt >= 3_000) validLowBufferWindow = true
        } else {
            lowWindowStartedAt = null
            lowWindowAnchor = null
        }

        const switched = recovery.switchAttempts > selected.initialSwitchAttempts
            && recovery.routeRevision > selected.initialRouteRevision
            && recovery.candidateIndex !== null
            && recovery.candidateIndex !== selected.initialCandidateIndex
        if (switched) {
            if (!validLowBufferWindow) {
                return stage3CapabilityResult('INCONCLUSIVE', 'no-valid-low-buffer-window', evidence)
            }
            if (hold.held.length === 0) {
                return stage3CapabilityResult('INCONCLUSIVE', 'current-request-not-held', evidence)
            }
            if (hold.hasUnobservedRequest(observer)) {
                return stage3CapabilityResult('INCONCLUSIVE', 'held-request-not-observed', evidence)
            }
            const switchedIndex = recovery.candidateIndex
            if (!isUniqueStage3Candidate(groups, analysis.exactIndex, selected.groupIndex, switchedIndex)) {
                return stage3CapabilityResult('INCONCLUSIVE', 'same-group-alternate-ambiguous', evidence)
            }
            const cooldown = assessStage3InitialCooldown(
                {
                    retryAt: recovery.retryAt,
                    lastUnswitchedAt: lastUnswitchedNow,
                    firstSwitchedAt: sample.now,
                    minimumCooldownMs: stage3MinimumCooldownMs,
                    maxObservationWindowMs: stage3PollIntervalMs
                        + stage3StatusSampleTimeoutMs
                        + stage3SwitchObservationSlackMs,
                },
            )
            const cooldownEvidence = { ...evidence, ...cooldown.evidence }
            if (cooldown.result) {
                return stage3CapabilityResult(
                    cooldown.result.status,
                    cooldown.result.reason,
                    cooldownEvidence,
                )
            }
            return waitForStage3FutureAlternate(
                page,
                deadline,
                observer,
                groups,
                selected,
                switchedIndex,
                recovery,
                hold,
                documentId,
                // Requests started before this first switched snapshot cannot be
                // attributed to the switch without a page-side causal marker.
                observerSnapshot.sequence,
                cooldownEvidence,
            )
        }
        lastUnswitchedNow = sample.now
        await stage3Delay(deadline, stage3PollIntervalMs)
    }

    const evidence = stage3FaultEvidence(initialEvidence, lastAnalysis, hold, sawLowBuffer)
    if (hold.held.length === 0) {
        return stage3CapabilityResult('INCONCLUSIVE', 'current-request-not-held', evidence)
    }
    if (!sawLowBuffer || !validLowBufferWindow) {
        return stage3CapabilityResult('INCONCLUSIVE', 'no-valid-low-buffer-window', evidence)
    }
    const recovery = lastSample?.status.groups.find(group => group.groupId === selected.groupId)
    if (recovery?.state === 'exhausted') {
        return stage3CapabilityResult('INCONCLUSIVE', 'same-group-alternate-exhausted', evidence)
    }
    return stage3CapabilityResult('FAIL', 'recovery-did-not-advance', evidence)
}

async function waitForStage3FutureAlternate(
    page,
    deadline,
    observer,
    groups,
    selected,
    switchedIndex,
    switchStatus,
    hold,
    documentId,
    switchDetectionSequence,
    initialEvidence,
) {
    const end = boundedStageEnd(deadline, stage3FutureRequestTimeoutMs)
    let resumeAnchor = null
    let alternateStarted = false
    let alternateResponded = false
    let currentReleased = false
    let playbackResumed = false
    let lastAnalysis
    let signalsUnavailable = false

    while (Date.now() < end) {
        const sample = await readStage3CapabilitySample(page, deadline)
        const observerSnapshot = observer.snapshot()
        const analysis = analyzeStage3Transport(groups, observerSnapshot, sample.hooks)
        lastAnalysis = analysis
        const evidence = {
            ...initialEvidence,
            ...analysis.evidence,
            alternateRequests: alternateStarted ? 1 : 0,
            alternateResponses: alternateResponded ? 1 : 0,
            playbackResumed,
        }

        if (sample.hooks.documentId !== documentId) {
            return stage3CapabilityResult('FAIL', 'page-reloaded', evidence)
        }
        if (analysis.observationOverflowed) {
            return stage3CapabilityResult('INCONCLUSIVE', 'future-observation-overflow', evidence)
        }
        if (analysis.unsupportedReason) {
            return stage3CapabilityResult('UNSUPPORTED', analysis.unsupportedReason, evidence)
        }
        if (hold.hasAbortedRequest(observer)) {
            return stage3CapabilityResult('INCONCLUSIVE', 'current-request-abort-unclassified', evidence)
        }
        if (hold.hasFailedRequest(observer)) {
            return stage3CapabilityResult('INCONCLUSIVE', 'current-request-failure-unclassified', evidence)
        }
        if (hold.hasReleaseFailure()) {
            return stage3CapabilityResult('INCONCLUSIVE', 'fault-route-continue-failed', evidence)
        }

        const recovery = sample.status.groups.find(group => group.groupId === selected.groupId)
        if (!recovery || sample.status.contextEpoch !== selected.contextEpoch
            || recovery.generation !== selected.generation) {
            return stage3CapabilityResult('INCONCLUSIVE', 'media-context-changed', evidence)
        }
        if (recovery.switchAttempts > switchStatus.switchAttempts
            || recovery.candidateIndex !== switchedIndex
            || typeof recovery.retryAt !== 'number'
            || recovery.retryAt < switchStatus.retryAt) {
            return stage3CapabilityResult('FAIL', 'cooldown-not-held', evidence)
        }

        const alternateRecords = analysis.supportedRecords.filter(record => (
            record.sequence > switchDetectionSequence
                && record.match.groupIndex === selected.groupIndex
                && record.match.candidateIndex === switchedIndex
        ))
        alternateStarted ||= alternateRecords.length > 0
        const hasHealthyAlternateResponse = alternateRecords.some(record => (
            record.responded && record.responseOk && !record.failed
        ))
        if (alternateResponded && !hasHealthyAlternateResponse) {
            return stage3CapabilityResult('INCONCLUSIVE', 'alternate-request-failure-unclassified', evidence)
        }
        alternateResponded ||= hasHealthyAlternateResponse
        const unchangedFutureRequest = analysis.supportedRecords.some(record => (
            record.sequence > switchDetectionSequence
                && record.match.groupIndex === selected.groupIndex
                && record.match.candidateIndex === selected.initialCandidateIndex
        ))
        if (unchangedFutureRequest) {
            return stage3CapabilityResult('FAIL', 'future-route-unchanged', evidence)
        }
        if (!sample.signals) {
            signalsUnavailable = true
        } else if (hasHealthyAlternateResponse && !currentReleased) {
            if (resumeAnchor === null) resumeAnchor = sample.signals.currentTimeSeconds
            else if (sample.signals.currentTimeSeconds >= resumeAnchor + 0.25) playbackResumed = true
        }
        if (alternateResponded && playbackResumed && !currentReleased) {
            await hold.releaseAll()
            currentReleased = true
            if (hold.hasReleaseFailure()) {
                return stage3CapabilityResult('INCONCLUSIVE', 'fault-route-continue-failed', evidence)
            }
            return verifyStage3Cooldown(
                page,
                deadline,
                observer,
                groups,
                selected,
                switchedIndex,
                switchStatus,
                hold,
                documentId,
                switchDetectionSequence,
                {
                    ...evidence,
                    alternateRequests: 1,
                    alternateResponses: 1,
                    playbackResumed: true,
                },
            )
        }
        await stage3Delay(deadline, stage3PollIntervalMs)
    }

    const evidence = {
        ...initialEvidence,
        ...(lastAnalysis?.evidence ?? {}),
        alternateRequests: alternateStarted ? 1 : 0,
        alternateResponses: alternateResponded ? 1 : 0,
        playbackResumed,
    }
    if (!alternateStarted) {
        return stage3CapabilityResult('INCONCLUSIVE', 'no-interceptable-future-request', evidence)
    }
    if (!alternateResponded) {
        return stage3CapabilityResult('INCONCLUSIVE', 'alternate-request-did-not-respond', evidence)
    }
    if (signalsUnavailable || resumeAnchor === null) {
        return stage3CapabilityResult('INCONCLUSIVE', 'playback-signals-unavailable', evidence)
    }
    return stage3CapabilityResult('FAIL', 'playback-did-not-resume', evidence)
}

async function verifyStage3Cooldown(
    page,
    deadline,
    observer,
    groups,
    selected,
    switchedIndex,
    switchStatus,
    hold,
    documentId,
    switchDetectionSequence,
    evidence,
) {
    const cooldownRemainingMs = Math.max(0, switchStatus.retryAt - Date.now())
    if (cooldownRemainingMs > stage3CooldownObservationMs
        || deadline.remaining() < cooldownRemainingMs + stage3PollIntervalMs) {
        return stage3CapabilityResult('INCONCLUSIVE', 'cooldown-observation-deadline', evidence)
    }
    const end = Date.now() + cooldownRemainingMs + stage3PollIntervalMs
    while (Date.now() < end) {
        const sample = await readStage3CapabilitySample(page, deadline)
        const analysis = analyzeStage3Transport(groups, observer.snapshot(), sample.hooks)
        if (sample.hooks.documentId !== documentId) {
            return stage3CapabilityResult('FAIL', 'page-reloaded', evidence)
        }
        if (analysis.observationOverflowed) {
            return stage3CapabilityResult('INCONCLUSIVE', 'cooldown-observation-overflow', evidence)
        }
        if (analysis.unsupportedReason) {
            return stage3CapabilityResult('UNSUPPORTED', analysis.unsupportedReason, evidence)
        }
        if (hold.hasAbortedRequest(observer)) {
            return stage3CapabilityResult('INCONCLUSIVE', 'current-request-abort-unclassified', evidence)
        }
        if (hold.hasFailedRequest(observer)) {
            return stage3CapabilityResult('INCONCLUSIVE', 'current-request-failure-unclassified', evidence)
        }
        if (hold.hasReleaseFailure()) {
            return stage3CapabilityResult('INCONCLUSIVE', 'fault-route-continue-failed', evidence)
        }
        const futureRecords = analysis.supportedRecords.filter(record => (
            record.sequence > switchDetectionSequence
                && record.match.groupIndex === selected.groupIndex
        ))
        if (futureRecords.some(record => (
            record.match.candidateIndex === selected.initialCandidateIndex
        ))) {
            return stage3CapabilityResult('FAIL', 'future-route-unchanged', evidence)
        }
        if (!futureRecords.some(record => (
            record.match.candidateIndex === switchedIndex
                && record.responded && record.responseOk && !record.failed
        ))) {
            return stage3CapabilityResult('INCONCLUSIVE', 'alternate-request-failure-unclassified', evidence)
        }
        const recovery = sample.status.groups.find(group => group.groupId === selected.groupId)
        if (!recovery || sample.status.contextEpoch !== selected.contextEpoch
            || recovery.generation !== selected.generation) {
            return stage3CapabilityResult('INCONCLUSIVE', 'media-context-changed', evidence)
        }
        if (recovery.switchAttempts > switchStatus.switchAttempts
            || recovery.routeRevision !== switchStatus.routeRevision
            || recovery.candidateIndex !== switchedIndex
            || typeof recovery.retryAt !== 'number'
            || recovery.retryAt < switchStatus.retryAt) {
            return stage3CapabilityResult('FAIL', 'cooldown-not-held', evidence)
        }
        if (sample.now >= switchStatus.retryAt) {
            return stage3CapabilityResult('PASS', 'exact-same-group-recovery', evidence)
        }
        await stage3Delay(deadline, stage3PollIntervalMs)
    }
    return stage3CapabilityResult('INCONCLUSIVE', 'cooldown-boundary-not-observed', evidence)
}

function isEligibleStage3LowBuffer(signals) {
    if (!signals || signals.visible !== true || signals.paused || signals.seeking || signals.ended
        || !Number.isFinite(signals.currentTimeSeconds)
        || (signals.durationSeconds !== null && !Number.isFinite(signals.durationSeconds))
        || !Number.isFinite(signals.bufferedAheadSeconds)) return false
    const nearEnd = signals.durationSeconds !== null
        && signals.durationSeconds - signals.currentTimeSeconds <= 0.5
    return !nearEnd && signals.bufferedAheadSeconds <= 0.5
}

function stage3FaultEvidence(initialEvidence, analysis, hold, sawLowBuffer) {
    return {
        ...initialEvidence,
        ...(analysis?.evidence ?? {}),
        heldRequests: hold.held.length,
        lowBufferObserved: sawLowBuffer,
    }
}

function stage3CapabilityResult(status, reason, evidence = {}) {
    return { status, reason, evidence }
}

function printStage3CapabilityResult(result) {
    const terminal = new Set(['PASS', 'FAIL', 'UNSUPPORTED', 'INCONCLUSIVE'])
    if (!result || !terminal.has(result.status)) {
        console.error('[cdn-live-e2e] stage3Capability=FAIL reason=invalid-terminal-result')
        process.exitCode = 1
        return false
    }
    console.log(`[cdn-live-e2e] stage3Capability=${result.status} reason=${result.reason} evidence=${JSON.stringify(result.evidence)}`)
    return true
}

function boundedStageEnd(deadline, capMs) {
    return Date.now() + Math.max(1, Math.min(capMs, deadline.remaining()))
}

async function stage3Delay(deadline, delayMs) {
    const boundedDelay = Math.max(1, Math.min(delayMs, deadline.remaining()))
    await new Promise(resolve => setTimeout(resolve, boundedDelay))
}

async function forceCdnProbe(page, deadline) {
    const result = await runStage('cdn-probe', deadline, 20_000, () => page.evaluate(async contract => {
        const { cacheKey, cacheVersion, hostListNames } = contract
        const isHostOnly = value => {
            if (typeof value !== 'string' || !value || value !== value.trim().toLowerCase()) return false
            if (value.length > 253 || /[\s\\/?#@]/.test(value) || value.includes('://')) return false
            try {
                const parsed = new URL(`https://${value}/`)
                return !parsed.username && !parsed.password && parsed.host === value
                    && parsed.pathname === '/' && !parsed.search && !parsed.hash
            } catch {
                return false
            }
        }
        const inspectCache = () => {
            const raw = localStorage.getItem(cacheKey)
            if (raw === null) {
                return {
                    valid: true,
                    exists: false,
                    hostCount: 0,
                    cacheHosts: [],
                    candidateHostHash: null,
                }
            }
            if (raw.length > 100_000) return { valid: false, exists: true, code: 'oversized' }

            let cache
            try {
                cache = JSON.parse(raw)
            } catch {
                return { valid: false, exists: true, code: 'invalid-json' }
            }
            if (!cache || typeof cache !== 'object' || Array.isArray(cache)) {
                return { valid: false, exists: true, code: 'invalid-root' }
            }
            const topLevelKeys = ['candidateHostHash', 'hosts', 'networkHint', 'savedAt', 'version']
            if (Object.keys(cache).sort().join('\n') !== topLevelKeys.join('\n')) {
                return { valid: false, exists: true, code: 'invalid-top-level-fields' }
            }
            const networkParts = typeof cache.networkHint === 'string'
                ? cache.networkHint.split(':')
                : []
            const validNetworkHint = cache.networkHint === 'unknown'
                || (networkParts.length === 3
                    && networkParts[0].length > 0 && networkParts[0].length <= 32
                    && networkParts[1].length > 0 && networkParts[1].length <= 32
                    && !networkParts.slice(0, 2).some(part => /[\s\\/?#@]/.test(part))
                    && (networkParts[2] === 'save-data' || networkParts[2] === 'normal'))
            if (cache.version !== cacheVersion || !Number.isFinite(cache.savedAt) || cache.savedAt < 0
                || !validNetworkHint
                || typeof cache.candidateHostHash !== 'string'
                || !/^fnv1a32:[0-9a-f]{8}$/.test(cache.candidateHostHash)
                || !cache.hosts || typeof cache.hosts !== 'object' || Array.isArray(cache.hosts)) {
                return { valid: false, exists: true, code: 'invalid-metadata' }
            }

            const allowedHealthKeys = new Set([
                'failures', 'host', 'measuredBytes', 'samples', 'successes', 'throughputKbps', 'ttfbMs',
            ])
            for (const [host, health] of Object.entries(cache.hosts)) {
                if (!isHostOnly(host) || !health || typeof health !== 'object' || Array.isArray(health)) {
                    return { valid: false, exists: true, code: 'invalid-host-entry' }
                }
                const keys = Object.keys(health)
                if (!keys.length || keys.some(key => !allowedHealthKeys.has(key)) || health.host !== host) {
                    return { valid: false, exists: true, code: 'invalid-health-fields' }
                }
                for (const [key, value] of Object.entries(health)) {
                    if (key === 'host') continue
                    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
                        return { valid: false, exists: true, code: 'invalid-health-metric' }
                    }
                }
            }
            const cacheHosts = Object.keys(cache.hosts).sort()
            return {
                valid: true,
                exists: true,
                hostCount: cacheHosts.length,
                cacheHosts,
                candidateHostHash: cache.candidateHostHash,
            }
        }

        const api = window.bangumi_area_limit_hack
        api.clearCdnHealthCache()
        let status
        try {
            status = await api.testCurrentVideoCdn({ force: true })
        } catch {
            return { ok: false, code: 'probe-rejected', cache: inspectCache() }
        }

        const summary = {
            state: status?.state,
            source: status?.source,
            completed: status?.completed,
            total: status?.total,
        }
        for (const name of hostListNames) {
            const hosts = status?.[name]
            if (!Array.isArray(hosts) || hosts.some(host => !isHostOnly(host))) {
                return { ok: false, code: 'unsafe-probe-host', cache: inspectCache() }
            }
            summary[name] = [...hosts]
        }
        const allowedDiagnosticKeys = new Set([
            'accountedBytes', 'bandwidthBps', 'bitrateMargin', 'classification', 'host',
            'observedBytes', 'stagesCompleted', 'throughputKbps', 'ttfbMs',
        ])
        const classifications = new Set(['healthy', 'failed', 'unprobeable', 'budget-limited'])
        const diagnostics = status?.hostDiagnostics
        if (!Array.isArray(diagnostics)) {
            return { ok: false, code: 'invalid-probe-diagnostics', cache: inspectCache() }
        }
        const diagnosticHosts = new Set()
        const diagnosticEntries = []
        for (const diagnostic of diagnostics) {
            if (!diagnostic || typeof diagnostic !== 'object' || Array.isArray(diagnostic)
                || Object.keys(diagnostic).some(key => !allowedDiagnosticKeys.has(key))
                || !isHostOnly(diagnostic.host) || !classifications.has(diagnostic.classification)
                || !Number.isInteger(diagnostic.stagesCompleted) || diagnostic.stagesCompleted < 0
                || !Number.isInteger(diagnostic.accountedBytes) || diagnostic.accountedBytes < 0
                || !Number.isInteger(diagnostic.observedBytes) || diagnostic.observedBytes < 0) {
                return { ok: false, code: 'invalid-probe-diagnostics', cache: inspectCache() }
            }
            for (const name of ['throughputKbps', 'ttfbMs', 'bitrateMargin']) {
                if (diagnostic[name] !== undefined
                    && (typeof diagnostic[name] !== 'number'
                        || !Number.isFinite(diagnostic[name]) || diagnostic[name] < 0)) {
                    return { ok: false, code: 'invalid-probe-diagnostics', cache: inspectCache() }
                }
            }
            if (diagnostic.bandwidthBps !== undefined
                && (typeof diagnostic.bandwidthBps !== 'number'
                    || !Number.isFinite(diagnostic.bandwidthBps) || diagnostic.bandwidthBps <= 0)) {
                return { ok: false, code: 'invalid-probe-diagnostics', cache: inspectCache() }
            }
            if (diagnosticHosts.has(diagnostic.host)) {
                return { ok: false, code: 'invalid-probe-diagnostics', cache: inspectCache() }
            }
            diagnosticHosts.add(diagnostic.host)
            diagnosticEntries.push([diagnostic.host, diagnostic.classification])
        }
        summary.diagnosticEntries = diagnosticEntries
        return { ok: true, status: summary, cache: inspectCache() }
    }, {
        cacheKey: cdnHealthCacheKey,
        cacheVersion: cdnHealthCacheVersion,
        hostListNames,
    }))

    if (!result?.ok) {
        if (result?.cache && !result.cache.valid) {
            throw new HarnessFailure('cdn-cache-privacy', result.cache.code || 'invalid')
        }
        throw new HarnessFailure('cdn-probe', result?.code || 'failed')
    }
    return result
}

function assertProbeSummary(status) {
    if (!status || !terminalProbeStates.has(status.state)) {
        throw new HarnessFailure('cdn-probe', 'non-terminal-state')
    }
    if (status.source !== 'network') {
        throw new HarnessFailure('cdn-probe', 'unexpected-source')
    }
    if (!Number.isInteger(status.completed) || status.completed < 0
        || !Number.isInteger(status.total) || status.total < 0
        || status.completed > status.total) {
        throw new HarnessFailure('cdn-probe', 'invalid-counts')
    }
    for (const name of hostListNames) {
        if (!Array.isArray(status[name]) || new Set(status[name]).size !== status[name].length) {
            throw new HarnessFailure('cdn-probe', 'invalid-host-list')
        }
    }
    if (status.candidateHosts.length === 0) {
        throw new HarnessFailure('cdn-candidates', 'empty')
    }
    if (status.completed === 0 || status.total === 0 || status.probedHosts.length === 0) {
        throw new HarnessFailure('cdn-probe', 'no-active-attempt')
    }
    const candidateSet = new Set(status.candidateHosts)
    const classifiedHosts = [
        ...status.healthyHosts,
        ...status.failedHosts,
        ...status.unprobeableHosts,
        ...status.budgetLimitedHosts,
    ]
    if (new Set(classifiedHosts).size !== classifiedHosts.length
        || classifiedHosts.some(host => !candidateSet.has(host))
        || status.probedHosts.some(host => !candidateSet.has(host))) {
        throw new HarnessFailure('cdn-probe', 'invalid-host-classification')
    }
    if (!Array.isArray(status.diagnosticEntries)
        || status.diagnosticEntries.some(entry => !Array.isArray(entry) || entry.length !== 2)) {
        throw new HarnessFailure('cdn-probe', 'invalid-diagnostics')
    }
    const expectedClassification = new Map([
        ...status.healthyHosts.map(host => [host, 'healthy']),
        ...status.failedHosts.map(host => [host, 'failed']),
        ...status.unprobeableHosts.map(host => [host, 'unprobeable']),
        ...status.budgetLimitedHosts.map(host => [host, 'budget-limited']),
    ])
    if (status.diagnosticEntries.length !== expectedClassification.size
        || status.diagnosticEntries.some(([host, classification]) => (
            expectedClassification.get(host) !== classification
        ))) {
        throw new HarnessFailure('cdn-probe', 'diagnostic-classification-mismatch')
    }
    const nonEmptyOutcomeClasses = [
        status.healthyHosts.length,
        status.failedHosts.length,
        status.unprobeableHosts.length,
    ].filter(Boolean).length
    if (status.state === 'ready'
        && (status.completed !== status.total || status.budgetLimitedHosts.length
            || status.healthyHosts.length === 0 || status.failedHosts.length
            || status.unprobeableHosts.length)) {
        throw new HarnessFailure('cdn-probe', 'invalid-ready-state')
    }
    if (status.state === 'failed'
        && (status.completed !== status.total || status.budgetLimitedHosts.length
            || status.failedHosts.length === 0 || status.healthyHosts.length
            || status.unprobeableHosts.length)) {
        throw new HarnessFailure('cdn-probe', 'invalid-failed-state')
    }
    if (status.state === 'unprobeable'
        && (status.completed !== status.total || status.budgetLimitedHosts.length
            || status.unprobeableHosts.length === 0 || status.healthyHosts.length
            || status.failedHosts.length)) {
        throw new HarnessFailure('cdn-probe', 'invalid-unprobeable-state')
    }
    if (status.state === 'partial'
        && status.completed === status.total && status.budgetLimitedHosts.length === 0
        && nonEmptyOutcomeClasses <= 1) {
        throw new HarnessFailure('cdn-probe', 'invalid-partial-state')
    }
}

function assertCacheSummary(cache, status) {
    if (!cache?.valid) {
        throw new HarnessFailure('cdn-cache-privacy', cache?.code || 'invalid')
    }
    if (!Number.isInteger(cache.hostCount) || cache.hostCount < 0) {
        throw new HarnessFailure('cdn-cache-privacy', 'invalid-host-count')
    }
    const cacheableRound = status.completed === status.total
        && status.budgetLimitedHosts.length === 0
        && status.unprobeableHosts.length === 0
        && (status.healthyHosts.length > 0 || status.failedHosts.length > 0)
        && (status.state !== 'partial'
            || (status.healthyHosts.length > 0 && status.failedHosts.length > 0))
    if (!cacheableRound) {
        throw new HarnessFailure('cdn-cache-coverage', 'not-exercised')
    }
    const expectedCacheHosts = cacheableRound
        ? [...new Set([...status.healthyHosts, ...status.failedHosts])].sort()
        : []
    if (expectedCacheHosts.length > 0 && (!cache.exists || cache.hostCount === 0)) {
        throw new HarnessFailure('cdn-cache-privacy', 'expected-cache-missing')
    }
    if (!Array.isArray(cache.cacheHosts)
        || cache.cacheHosts.length !== expectedCacheHosts.length
        || cache.cacheHosts.some((host, index) => host !== expectedCacheHosts[index])) {
        throw new HarnessFailure('cdn-cache-privacy', 'cache-host-mismatch')
    }
    const expectedHash = hashCandidateHosts(status.candidateHosts)
    if (cache.exists && cache.candidateHostHash !== expectedHash) {
        throw new HarnessFailure('cdn-cache-privacy', 'candidate-hash-mismatch')
    }
    return expectedCacheHosts
}

async function verifyCacheReuse(page, context, options, deadline, expectedCacheHosts) {
    await runStage('cdn-cache-reload', deadline, 45_000, timeout => page.reload({
        waitUntil: 'domcontentloaded',
        timeout,
    }))
    await assertPageIdentity(page, options)
    await assertHarnessConfiguration(page, context, deadline)
    await waitForUserscriptApi(page, deadline)
    await waitForCdnCandidates(page, deadline)

    const result = await runStage('cdn-cache-reuse', deadline, 10_000, () => page.evaluate(async () => {
        const api = window.bangumi_area_limit_hack
        const before = api.getCdnProbeStatus()
        const after = await api.testCurrentVideoCdn()
        return {
            beforeSource: before?.source,
            beforeUpdatedAt: before?.updatedAt,
            source: after?.source,
            updatedAt: after?.updatedAt,
            healthyHosts: Array.isArray(after?.healthyHosts) ? [...after.healthyHosts] : null,
            failedHosts: Array.isArray(after?.failedHosts) ? [...after.failedHosts] : null,
            unprobeableHosts: Array.isArray(after?.unprobeableHosts) ? [...after.unprobeableHosts] : null,
            budgetLimitedHosts: Array.isArray(after?.budgetLimitedHosts) ? [...after.budgetLimitedHosts] : null,
        }
    }))

    const actualCacheHosts = Array.isArray(result?.healthyHosts) && Array.isArray(result?.failedHosts)
        ? [...new Set([...result.healthyHosts, ...result.failedHosts])].sort()
        : null
    if (result?.beforeSource !== 'cache' || result?.source !== 'cache'
        || result.beforeUpdatedAt !== result.updatedAt
        || !Array.isArray(actualCacheHosts)
        || actualCacheHosts.length !== expectedCacheHosts.length
        || actualCacheHosts.some((host, index) => host !== expectedCacheHosts[index])
        || !Array.isArray(result.unprobeableHosts) || result.unprobeableHosts.length > 0
        || !Array.isArray(result.budgetLimitedHosts) || result.budgetLimitedHosts.length > 0) {
        throw new HarnessFailure('cdn-cache-reuse', 'network-free-cache-read-not-proven')
    }
    return { source: result.source, hostCount: actualCacheHosts.length }
}

function hashCandidateHosts(hosts) {
    let hash = 0x811c9dc5
    for (const character of [...new Set(hosts)].sort().join('\n')) {
        hash ^= character.charCodeAt(0)
        hash = Math.imul(hash, 0x01000193)
    }
    return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`
}

function printProbeSummary(status, cache, cacheReuse) {
    const counts = Object.fromEntries(hostListNames.map(name => [name, status[name].length]))
    const hosts = Object.fromEntries(hostListNames.map(name => [name, status[name]]))
    console.log(`[cdn-live-e2e] probeState=${status.state} probeHosts=${JSON.stringify(hosts)}`)
    console.log(`[cdn-live-e2e] probeCounts=${JSON.stringify({
        completed: status.completed,
        total: status.total,
        ...counts,
        cachedHosts: cache.hostCount,
    })}`)
    console.log(`[cdn-live-e2e] cacheReuse=${JSON.stringify(cacheReuse)}`)
}

function createDeadline(timeoutMs) {
    const end = Date.now() + timeoutMs
    return {
        remaining() {
            const remaining = end - Date.now()
            if (remaining <= 0) throw new HarnessFailure('deadline', 'exceeded')
            return remaining
        },
    }
}

async function runStage(stage, deadline, capMs, operation) {
    const timeoutMs = Math.max(1, Math.min(capMs, deadline.remaining()))
    let timer
    try {
        return await Promise.race([
            Promise.resolve().then(() => operation(timeoutMs)),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new HarnessFailure(stage, 'timeout')), timeoutMs)
            }),
        ])
    } catch (error) {
        if (error instanceof HarnessFailure) throw error
        throw new HarnessFailure(stage, error?.name === 'TimeoutError' ? 'timeout' : 'failed')
    } finally {
        clearTimeout(timer)
    }
}

async function closeWithDeadline(close, timeoutMs) {
    let timer
    try {
        return await Promise.race([
            Promise.resolve().then(close).then(() => true, () => false),
            new Promise(resolve => {
                timer = setTimeout(() => resolve(false), timeoutMs)
            }),
        ])
    } finally {
        clearTimeout(timer)
    }
}
