#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const userscriptPath = path.join(rootDir, 'dist', 'unblock-area-limit.user.js')
const defaultUrl = 'https://www.bilibili.com/video/BV17x411w7KC/'
const defaultTimeoutMs = 120_000
const minTimeoutMs = 15_000
const maxTimeoutMs = 180_000
const cleanupTimeoutMs = 5_000
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

run().catch(error => {
    const stage = error instanceof HarnessFailure ? error.stage : 'unexpected'
    const reason = error instanceof HarnessFailure ? error.reason : 'unexpected-error'
    console.error(`[cdn-live-e2e] FAIL stage=${stage} reason=${reason}`)
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
    await main(options)
}

async function main(options) {
    const deadline = createDeadline(options.timeoutMs)
    let browser
    let context
    let failure

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
            content: createInitScript(userscript),
        }))

        const page = await runStage('page-create', deadline, 5_000, () => context.newPage())
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

        const probe = await forceCdnProbe(page, deadline)
        assertProbeSummary(probe.status)
        const expectedCacheHosts = assertCacheSummary(probe.cache, probe.status)
        const cacheReuse = await verifyCacheReuse(page, context, options, deadline, expectedCacheHosts)
        printProbeSummary(probe.status, probe.cache, cacheReuse)

        if (probe.status.state === 'failed') {
            throw new HarnessFailure('cdn-probe', 'failed')
        }

        await assertHarnessConfiguration(page, context, deadline)
        console.log('[cdn-live-e2e] PASS')
    } catch (error) {
        failure = error instanceof HarnessFailure
            ? error
            : new HarnessFailure('browser-operation', error?.name === 'TimeoutError' ? 'timeout' : 'failed')
    } finally {
        const closed = await closeWithDeadline(
            () => browser ? browser.close() : context?.close(),
            cleanupTimeoutMs,
        )
        if (!closed && !failure) {
            failure = new HarnessFailure('cleanup', 'failed')
        }
    }

    if (failure) throw failure
}

function parseArgs(args) {
    let rawUrl = defaultUrl
    let timeoutMs = defaultTimeoutMs
    let headless = true
    let help = false

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

    return { bvid, headless, help: false, timeoutMs, url: normalizedUrl }
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
  --help, -h           Show this help.

This live gate uses a fresh, logged-out browser context and no BALH proxy.`)
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

function createInitScript(userscript) {
    return `;(() => {
        const isBilibili = location.hostname === 'bilibili.com'
            || location.hostname.endsWith('.bilibili.com')
        if (!isBilibili) return
        localStorage.setItem('balh_migrate_to_2', 'Y')
        const GM_info = Object.freeze({
            script: Object.freeze({ name: 'BALH CDN live E2E', version: 'local' }),
            scriptHandler: 'Playwright live E2E',
        })
        ${userscript}
    })();`
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
