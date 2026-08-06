#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const userscriptPath = path.join(rootDir, 'dist', 'unblock-area-limit.user.js')
const buildScriptPath = path.join(rootDir, 'scripts', 'build.mjs')

const pageUrl = 'https://www.bilibili.com/bangumi/play/ep900001'
const playUrlApi = 'https://api.bilibili.com/x/player/playurl?aid=900001&cid=900002&qn=80'
const pageOrigin = new URL(pageUrl).origin
const mediaUrls = Object.freeze({
    primary: 'https://primary.recovery.invalid/media/video.m4s?fixture=primary-v1',
    alternate: 'https://alternate.recovery.invalid/media/video.m4s?fixture=alternate-v1',
    risky: 'https://risky.recovery.invalid/media/video.m4s?fixture=risky-v1&os=mcdn',
})
const mediaLabels = new Map(Object.entries(mediaUrls).map(([label, url]) => [url, label]))
const privateFixtureFragments = [
    ...Object.values(mediaUrls),
    'primary-v1',
    'alternate-v1',
    'risky-v1',
    '/media/video.m4s',
    'fixture=',
]
const outputRedactionFragments = [
    pageUrl,
    playUrlApi,
    pageOrigin,
    '/bangumi/play/ep900001',
    '/x/player/playurl',
    'aid=900001',
    'cid=900002',
    ...privateFixtureFragments,
]

const defaultTimeoutMs = 90_000
const minTimeoutMs = 45_000
const maxTimeoutMs = 180_000
const buildTimeoutMs = 60_000
const buildOutputByteLimit = 512 * 1024
const browserLaunchTimeoutMs = 20_000
const navigationTimeoutMs = 12_000
const operationTimeoutMs = 10_000
const scenarioTimeoutMs = 30_000
const cleanupStepTimeoutMs = 1_000
const contextCleanupTimeoutMs = 5_000
const browserCleanupTimeoutMs = 5_000
const cleanupForceExitMs = 2_000
const processWatchdogSlackMs = 20_000
const browserRequestTimeoutMs = scenarioTimeoutMs + 5_000
const beforeGraceDelayMs = 2_200
const minimumMeasuredGraceMs = 2_900
const cooldownLowWindowMs = 3_400
const rangeHeader = 'bytes=0-31'
const maxConsoleInspections = 100

class HarnessFailure extends Error {
    constructor(stage, reason, cause) {
        super(`${stage}:${reason}`, cause ? { cause } : undefined)
        this.name = 'HarnessFailure'
        this.stage = stage
        this.reason = reason
        this.cleanupUnverified = false
    }
}

run().catch(error => {
    const failure = normalizeFailure(error)
    console.error(`[cdn-recovery-browser] FAIL stage=${failure.stage} reason=${failure.reason}`)
    const detail = safeErrorDetail(error)
    if (detail) console.error(`[cdn-recovery-browser] detail=${detail}`)
    process.exitCode = 1
})

async function run() {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) {
        printUsage()
        return
    }

    const watchdog = setTimeout(() => {
        console.error('[cdn-recovery-browser] FAIL stage=process-watchdog reason=timeout')
        process.exit(1)
    }, options.timeoutMs + processWatchdogSlackMs)
    let cleanupUnverified = false
    try {
        await runHarness(options)
    } catch (error) {
        cleanupUnverified = error?.cleanupUnverified === true
        throw error
    } finally {
        clearTimeout(watchdog)
        if (cleanupUnverified) {
            setTimeout(() => process.exit(1), cleanupForceExitMs)
        }
    }
}

async function runHarness(options) {

    // Playwright protocol logging can contain request URLs, so this gate never inherits it.
    delete process.env.DEBUG
    delete process.env.PWDEBUG

    const deadline = createDeadline(options.timeoutMs)
    const userscript = await runStage('userscript-build', deadline, buildTimeoutMs + 5_000, () => (
        buildAndReadUserscript()
    ))
    const { chromium } = await runStage('playwright-load', deadline, 5_000, () => import('playwright'))
    const launched = await launchPreferredBrowser(chromium, options, deadline)
    const browserVersion = launched.browser.version()
    console.log(`[cdn-recovery-browser] browser=${JSON.stringify(launched.label)} version=${JSON.stringify(browserVersion)}`)

    const results = []
    let failure
    try {
        for (const transport of ['fetch', 'xhr']) {
            const result = await runStage(
                `${transport}-scenario`,
                deadline,
                scenarioTimeoutMs,
                timeoutMs => exerciseTransport({
                    browser: launched.browser,
                    transport,
                    userscript,
                    timeoutMs,
                }),
            )
            results.push(result)
        }
    } catch (error) {
        failure = error
    }

    const browserCloseResult = launched.browser.isConnected()
        ? await closeWithDeadline(
            () => launched.browser.close({ reason: 'CDN recovery browser E2E complete' }),
            browserCleanupTimeoutMs,
        )
        : { ok: true }
    const browserCleanupVerified = isBrowserCleanupVerified(launched.browser)
    if (!browserCleanupVerified) {
        failure = new HarnessFailure(
            'browser-cleanup',
            browserCloseResult.ok ? 'terminal-state-unverified' : browserCloseResult.reason,
            browserCloseResult.error ?? failure,
        )
    }
    if (failure) {
        failure.cleanupUnverified = !browserCleanupVerified
        throw failure
    }

    for (const result of results) {
        console.log(`[cdn-recovery-browser] PASS transport=${result.transport} currentHeld=true futureRoute=alternate cooldownRoute=alternate`)
    }

    const summary = {
        browser: launched.label,
        browserCleanupVerified,
        browserVersion,
        transports: results.map(result => ({
            transport: result.transport,
            documentRequests: result.documentRequests,
            currentRequests: result.currentRequests,
            futureRequests: result.futureRequests,
            measuredGraceMs: result.measuredGraceMs,
            cooldownRequests: result.cooldownRequests,
            finalCandidate: result.finalCandidate,
            exactUrlSurfacesClean: result.exactUrlSurfacesClean,
            predecessorIdentityVerified: result.predecessorIdentityVerified,
            predecessorVideoReplacementVerified: result.predecessorVideoReplacementVerified,
        })),
    }
    console.log(`RECOVERY_BROWSER_SUMMARY ${JSON.stringify(summary)}`)
    console.log('[cdn-recovery-browser] PASS')
}

function parseArgs(args) {
    let timeoutMs = defaultTimeoutMs
    let headless = true
    let help = false

    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index]
        if (arg === '--help' || arg === '-h') {
            help = true
        } else if (arg === '--headless') {
            headless = true
        } else if (arg === '--headed') {
            headless = false
        } else if (arg === '--timeout-ms' || arg.startsWith('--timeout-ms=')) {
            const option = readOptionValue(args, index, '--timeout-ms')
            timeoutMs = Number(option.value)
            index = option.index
        } else {
            throw new HarnessFailure('arguments', 'unknown-option')
        }
    }

    if (help) return { help: true }
    if (!Number.isInteger(timeoutMs) || timeoutMs < minTimeoutMs || timeoutMs > maxTimeoutMs) {
        throw new HarnessFailure('arguments', 'invalid-timeout')
    }
    return { headless, help: false, timeoutMs }
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
    console.log(`Usage: node scripts/test-cdn-recovery-browser.mjs [options]

Builds the current userscript and runs deterministic Fetch/XHR recovery scenarios
against a synthetic Bilibili-origin page in installed Chrome or Playwright Chromium.

Options:
  --timeout-ms <ms>  Global deadline (${minTimeoutMs}-${maxTimeoutMs}). Default: ${defaultTimeoutMs}.
  --headless         Run headlessly (default).
  --headed           Run with a visible browser window.
  -h, --help         Show this help.

Browser overrides:
  BALH_CDN_RECOVERY_BROWSER_PATH     Exact Chromium-family executable path.
  BALH_CDN_RECOVERY_BROWSER_CHANNEL  Playwright channel such as chrome-beta.`)
}

async function buildAndReadUserscript() {
    try {
        await execFileAsync(process.execPath, [
            buildScriptPath,
            '--build-id',
            'cdn-recovery-browser',
        ], {
            cwd: rootDir,
            timeout: buildTimeoutMs,
            maxBuffer: buildOutputByteLimit,
            windowsHide: true,
        })
    } catch (error) {
        throw new HarnessFailure('userscript-build', 'failed-or-bounded-output-exceeded', error)
    }

    let source
    try {
        source = await readFile(userscriptPath, 'utf8')
    } catch (error) {
        throw new HarnessFailure('userscript-read', 'missing-build-output', error)
    }
    if (!source.includes('window.bangumi_area_limit_hack')
        || !source.includes('getCdnRecoveryStatus')) {
        throw new HarnessFailure('userscript-read', 'recovery-api-marker-missing')
    }
    return source
}

async function launchPreferredBrowser(chromium, options, deadline) {
    const executablePath = process.env.BALH_CDN_RECOVERY_BROWSER_PATH?.trim()
    const channel = process.env.BALH_CDN_RECOVERY_BROWSER_CHANNEL?.trim()
    if (executablePath && channel) {
        throw new HarnessFailure('browser-launch', 'conflicting-overrides')
    }

    if (executablePath) {
        try {
            await access(executablePath, fsConstants.X_OK)
        } catch (error) {
            throw new HarnessFailure('browser-launch', 'custom-executable-unavailable', error)
        }
        return launchBrowserAttempt(chromium, 'custom-executable', {
            executablePath,
            headless: options.headless,
        }, deadline)
    }
    if (channel) {
        return launchBrowserAttempt(chromium, 'custom-channel', {
            channel,
            headless: options.headless,
        }, deadline)
    }

    const failures = []
    for (const attempt of [
        { label: 'channel:chrome', options: { channel: 'chrome', headless: options.headless } },
        { label: 'playwright:chromium', options: { headless: options.headless } },
    ]) {
        try {
            return await launchBrowserAttempt(
                chromium,
                attempt.label,
                attempt.options,
                deadline,
            )
        } catch (error) {
            failures.push(normalizeFailure(error).reason)
        }
    }
    throw new HarnessFailure(
        'browser-launch',
        failures.length === 2 ? 'installed-chrome-and-playwright-chromium-unavailable' : 'unavailable',
    )
}

async function launchBrowserAttempt(chromium, label, options, deadline) {
    const timeout = Math.max(1, Math.min(browserLaunchTimeoutMs, deadline.remaining()))
    try {
        const browser = await chromium.launch({
            ...options,
            timeout,
            args: ['--disk-cache-size=0', '--media-cache-size=0'],
        })
        return { browser, label }
    } catch (error) {
        throw new HarnessFailure('browser-launch', `attempt-failed-${safeLabel(label)}`, error)
    }
}

async function exerciseTransport({ browser, transport, userscript, timeoutMs }) {
    const deadline = createDeadline(timeoutMs)
    const observations = {
        consoleExactUrlLeak: false,
        consoleInspectionFailed: false,
        consoleInspectionIncomplete: false,
        consoleInspections: [],
        consoleMessages: [],
        documentRequests: 0,
        mainFrameNavigations: 0,
        mediaRequests: [],
        pageErrorExactUrlLeak: false,
        pageErrors: [],
        probeRequests: [],
        requestFailures: [],
        unexpectedMediaRequests: [],
        unexpectedRequests: [],
    }
    const heldRoutes = []
    let context
    let page
    let result
    let failure
    let initialRetryAt
    let measuredGraceMs
    let publishedContextEpoch
    let requestBaseline

    try {
        context = await runStage(`${transport}-context`, deadline, 5_000, () => browser.newContext({
            acceptDownloads: false,
            locale: 'en-US',
            serviceWorkers: 'block',
        }))
        await runStage(`${transport}-cookie`, deadline, 3_000, () => context.addCookies([{
            name: 'balh_cdn_mode',
            value: 'auto',
            domain: '.bilibili.com',
            path: '/',
            secure: true,
            sameSite: 'Lax',
        }]))

        await context.route('**/*', route => handleRoute({
            heldRoutes,
            observations,
            route,
            transport,
        }))
        if (typeof context.routeWebSocket === 'function') {
            await context.routeWebSocket(/.*/, websocket => {
                try {
                    websocket.close({ code: 1008, reason: 'Blocked by recovery harness' })
                } catch {
                    // The HTTP route boundary remains authoritative for this fixture.
                }
            })
        }

        await context.addInitScript(createHarnessBootstrap, {
            primaryUrl: mediaUrls.primary,
            scenarioTransport: transport,
            userscript,
        })
        page = await runStage(`${transport}-page`, deadline, 3_000, () => context.newPage())
        page.setDefaultTimeout(Math.min(operationTimeoutMs, timeoutMs))
        page.setDefaultNavigationTimeout(Math.min(navigationTimeoutMs, timeoutMs))
        page.on('console', message => {
            const rawText = message.text()
            observations.consoleExactUrlLeak ||= containsPrivateFixtureFragment(rawText)
            if (observations.consoleInspections.length >= maxConsoleInspections) {
                observations.consoleInspectionFailed = true
            } else {
                observations.consoleInspections.push(inspectConsoleArguments(message).then(
                    inspection => {
                        observations.consoleExactUrlLeak ||= inspection.containsUrl
                        observations.consoleInspectionIncomplete ||= inspection.incomplete
                    },
                    () => {
                        observations.consoleInspectionFailed = true
                    },
                ))
            }
            pushBounded(observations.consoleMessages, {
                type: message.type(),
                text: sanitizeText(rawText),
            }, 40)
        })
        page.on('pageerror', error => {
            const rawText = [error?.message, error?.stack].filter(Boolean).join('\n') || String(error)
            observations.pageErrorExactUrlLeak ||= containsPrivateFixtureFragment(rawText)
            pushBounded(observations.pageErrors, sanitizeText(rawText), 10)
        })
        page.on('requestfailed', request => {
            const label = mediaLabels.get(request.url())
            if (!label) return
            pushBounded(observations.requestFailures, {
                label,
                method: request.method(),
                resourceType: request.resourceType(),
            }, 20)
        })
        page.on('framenavigated', frame => {
            if (frame === page.mainFrame()) observations.mainFrameNavigations += 1
        })

        await runStage(`${transport}-navigation`, deadline, navigationTimeoutMs, timeout => (
            page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout })
        ))
        assertPageIdentity(page)
        await waitForRecoveryApi(page, transport, deadline)
        await installControlledVideo(page, transport, deadline)
        await deliverPlayUrl(page, transport, deadline)
        publishedContextEpoch = await assertPublishedRegistry(page, transport, deadline)
        await assertPrivateSurfaces(page, transport, deadline)
        requestBaseline = await waitForStageTwoProbeSettlement(
            page,
            observations,
            transport,
            deadline,
        )

        await startMediaRequest(page, transport, 'initial', deadline)
        await waitForMediaObservation(observations, 'initial', deadline)
        assertInitialRequest(observations, transport)
        const confirmingObservedAtMs = await waitForGroupState(
            page,
            transport,
            'confirming',
            deadline,
            2_000,
        )

        await runStage(`${transport}-before-grace`, deadline, beforeGraceDelayMs + 500, () => (
            page.waitForTimeout(beforeGraceDelayMs)
        ))
        await assertBeforeGrace(page, observations, transport, deadline)
        const waitingObservedAtMs = await waitForGroupState(
            page,
            transport,
            'waiting-retry',
            deadline,
            2_000,
        )
        const afterGrace = await assertAfterGrace(
            page,
            observations,
            transport,
            confirmingObservedAtMs,
            waitingObservedAtMs,
            publishedContextEpoch,
            deadline,
        )
        measuredGraceMs = afterGrace.measuredGraceMs
        initialRetryAt = afterGrace.retryAt

        await startMediaRequest(page, transport, 'future', deadline)
        await waitForMediaObservation(observations, 'future', deadline)
        await waitForMediaSettlement(page, transport, 'future', deadline)
        assertRoutedObservation(observations, transport, 'future')
        await assertFutureState(page, transport, deadline)

        await beginHealthyPlayback(page, transport, deadline)
        await waitForStableReset(page, transport, initialRetryAt, deadline)
        await beginLowPlayback(page, transport, initialRetryAt, deadline)
        await runStage(`${transport}-cooldown-window`, deadline, cooldownLowWindowMs + 500, () => (
            page.waitForTimeout(cooldownLowWindowMs)
        ))
        await assertCooldownState(page, transport, initialRetryAt, deadline)

        await startMediaRequest(page, transport, 'cooldown', deadline)
        await waitForMediaObservation(observations, 'cooldown', deadline)
        await waitForMediaSettlement(page, transport, 'cooldown', deadline)
        assertRoutedObservation(observations, transport, 'cooldown')
        await assertRoutedMediaCompleted(page, transport, 'cooldown', deadline)
        await assertCooldownState(page, transport, initialRetryAt, deadline)

        await assertCurrentRequestHeld(page, observations, transport, deadline)
        await releaseHeldRoutes(heldRoutes)
        await waitForMediaSettlement(page, transport, 'initial', deadline)
        await assertCurrentRequestCompleted(page, observations, transport, deadline)
        await assertPrivateSurfaces(page, transport, deadline)
        await settleConsoleInspections(observations, transport, deadline)
        assertRecoveryRequestBaseline(observations, requestBaseline, transport)

        if (observations.consoleInspectionFailed) {
            throw new HarnessFailure(`${transport}-privacy`, 'console-argument-inspection-failed')
        }
        if (observations.consoleInspectionIncomplete) {
            throw new HarnessFailure(`${transport}-privacy`, 'console-argument-inspection-incomplete')
        }
        if (observations.consoleExactUrlLeak || observations.pageErrorExactUrlLeak) {
            throw new HarnessFailure(`${transport}-privacy`, 'exact-url-emitted-by-page')
        }
        if (observations.unexpectedMediaRequests.length > 0) {
            throw new HarnessFailure(`${transport}-routing`, 'unclassified-media-request')
        }

        if (observations.pageErrors.length > 0) {
            throw new HarnessFailure(`${transport}-page`, 'uncaught-error')
        }

        result = {
            transport,
            documentRequests: observations.documentRequests,
            currentRequests: countPhase(observations, 'initial'),
            futureRequests: countPhase(observations, 'future'),
            measuredGraceMs: Math.floor(measuredGraceMs),
            cooldownRequests: countPhase(observations, 'cooldown'),
            finalCandidate: 'alternate',
            exactUrlSurfacesClean: true,
            predecessorIdentityVerified: true,
            predecessorVideoReplacementVerified: true,
        }
    } catch (error) {
        failure = error
    } finally {
        await closeWithDeadline(() => stopHarnessTimers(page), cleanupStepTimeoutMs)
        await closeWithDeadline(() => releaseHeldRoutes(heldRoutes), cleanupStepTimeoutMs)
        const contextCloseResult = context
            ? await closeWithDeadline(() => context.close(), contextCleanupTimeoutMs)
            : { ok: true }
        if (!isContextCleanupVerified(browser, context, page)) {
            failure = new HarnessFailure(
                `${transport}-cleanup`,
                contextCloseResult.ok ? 'terminal-state-unverified' : contextCloseResult.reason,
                contextCloseResult.error ?? failure,
            )
        }
    }

    if (failure) throw failure
    return result
}

async function handleRoute({ heldRoutes, observations, route, transport }) {
    const request = route.request()
    const url = request.url()
    const method = request.method()

    if (method === 'GET' && request.resourceType() === 'document' && url === pageUrl) {
        observations.documentRequests += 1
        await route.fulfill({
            status: 200,
            contentType: 'text/html; charset=utf-8',
            body: createPageHtml(),
        })
        return
    }
    if (method === 'GET' && url === playUrlApi) {
        await route.fulfill({
            status: 200,
            contentType: 'application/json; charset=utf-8',
            headers: corsHeaders(),
            body: JSON.stringify(createPlayUrlResponse()),
        })
        return
    }

    const label = mediaLabels.get(url)
    if (label) {
        if (method === 'OPTIONS') {
            await route.fulfill({
                status: 204,
                headers: corsHeaders({
                    'access-control-allow-headers': 'accept, range',
                    'access-control-allow-methods': 'GET, OPTIONS',
                }),
            })
            return
        }

        const headers = request.headers()
        const phase = phaseFromAccept(headers.accept, transport)
        if (!phase) {
            // Stage 2 health probes use the captured predecessor and deliberately do not
            // activate Stage 3. Settle them quickly so they cannot perturb this scenario.
            const isStageTwoProbe = method === 'GET'
                && request.resourceType() === 'fetch'
                && headers.accept === '*/*'
                && headers.range === undefined
            if (isStageTwoProbe) {
                pushBounded(observations.probeRequests, { label }, 20)
            } else {
                pushBounded(observations.unexpectedMediaRequests, {
                    label,
                    method,
                    resourceType: request.resourceType(),
                }, 20)
            }
            await route.fulfill({
                status: 503,
                contentType: 'application/octet-stream',
                headers: corsHeaders(),
                body: '',
            })
            return
        }

        pushBounded(observations.mediaRequests, {
            acceptPreserved: headers.accept === acceptFor(transport, phase),
            label,
            method,
            phase,
            rangePreserved: headers.range === rangeHeader,
            resourceType: request.resourceType(),
        }, 20)
        if (phase === 'initial' && label === 'primary') {
            heldRoutes.push({ handled: false, route })
            return
        }
        await fulfillMediaRoute(route)
        return
    }

    let hostname = 'invalid-url'
    try {
        hostname = new URL(url).hostname
    } catch {
        // Preserve the structural label only.
    }
    pushBounded(observations.unexpectedRequests, {
        hostname,
        method,
        resourceType: request.resourceType(),
    }, 20)
    await route.abort('blockedbyclient')
}

function createHarnessBootstrap({ primaryUrl, scenarioTransport, userscript }) {
    localStorage.setItem('balh_migrate_to_2', 'Y')
    localStorage.removeItem('access_key')
    globalThis.unsafeWindow = globalThis
    globalThis.GM_info = Object.freeze({
        script: Object.freeze({ name: 'BALH CDN recovery browser E2E', version: 'local' }),
        scriptHandler: 'Playwright recovery E2E',
    })
    const harness = globalThis.__cdnRecoveryBrowserHarness = {
        fetchPredecessorCalls: new Map(),
        fetchPredecessorInputs: new Map(),
        fetchPredecessorReceiverMatches: new Map(),
        fetchPredecessorResponses: new Map(),
        fetchExpectedReceiver: globalThis,
        media: Object.create(null),
        nativeXhrOpenCounts: new WeakMap(),
        nativeXhrOpenReceivers: new WeakSet(),
        nativeXhrResponses: new WeakMap(),
        nativeXhrSendCounts: new WeakMap(),
        nativeXhrSendReceivers: new WeakSet(),
        predecessorVideoReplacements: 0,
        progressTimer: null,
        scenarioTransport,
        signals: null,
    }

    const phaseFromHeaders = (input, init) => {
        try {
            const source = init?.headers !== undefined
                ? init.headers
                : input instanceof Request
                    ? input.headers
                    : undefined
            const accept = new Headers(source).get('accept') || ''
            return accept.match(/^application\/vnd\.balh-recovery\.(?:fetch|xhr)\.(initial|future|cooldown)$/)?.[1]
                || null
        } catch {
            return null
        }
    }

    const predecessorFetch = globalThis.fetch
    globalThis.fetch = function () {
        'use strict'
        const args = [...arguments]
        const phase = phaseFromHeaders(args[0], args[1])
        if (phase) {
            harness.fetchPredecessorCalls.set(
                phase,
                (harness.fetchPredecessorCalls.get(phase) || 0) + 1,
            )
            harness.fetchPredecessorReceiverMatches.set(
                phase,
                this === harness.fetchExpectedReceiver,
            )
            try {
                const effective = args[0] instanceof Request && args[1] === undefined
                    ? args[0]
                    : new Request(args[0], args[1])
                harness.fetchPredecessorInputs.set(phase, {
                    credentials: effective.credentials,
                    method: effective.method,
                    range: effective.headers.get('range'),
                    signalAborted: effective.signal.aborted,
                })
            } catch {
                harness.fetchPredecessorInputs.set(phase, { invalid: true })
            }
        }
        const result = predecessorFetch.apply(this, args)
        if (phase === 'initial' && harness.scenarioTransport === 'fetch') {
            harness.replaceVideoDuringPredecessor?.('fetch')
        }
        if (!phase) return result
        return result.then(response => {
            harness.fetchPredecessorResponses.set(phase, response)
            return response
        })
    }

    const nativeXhrOpen = XMLHttpRequest.prototype.open
    XMLHttpRequest.prototype.open = function (...args) {
        harness.nativeXhrOpenReceivers.add(this)
        harness.nativeXhrOpenCounts.set(
            this,
            (harness.nativeXhrOpenCounts.get(this) || 0) + 1,
        )
        const result = nativeXhrOpen.apply(this, args)
        if (harness.scenarioTransport === 'xhr'
            && String(args[0]).toUpperCase() === 'GET' && args[1] === primaryUrl) {
            harness.replaceVideoDuringPredecessor?.('xhr')
        }
        return result
    }
    const nativeXhrSend = XMLHttpRequest.prototype.send
    XMLHttpRequest.prototype.send = function (...args) {
        harness.nativeXhrSendReceivers.add(this)
        harness.nativeXhrSendCounts.set(
            this,
            (harness.nativeXhrSendCounts.get(this) || 0) + 1,
        )
        return nativeXhrSend.apply(this, args)
    }

    let responseOwner = XMLHttpRequest.prototype
    let nativeXhrResponseDescriptor
    while (responseOwner && !nativeXhrResponseDescriptor) {
        nativeXhrResponseDescriptor = Object.getOwnPropertyDescriptor(responseOwner, 'response')
        if (!nativeXhrResponseDescriptor) responseOwner = Object.getPrototypeOf(responseOwner)
    }
    if (nativeXhrResponseDescriptor?.get && nativeXhrResponseDescriptor.configurable) {
        Object.defineProperty(responseOwner, 'response', {
            ...nativeXhrResponseDescriptor,
            get() {
                const response = nativeXhrResponseDescriptor.get.call(this)
                harness.nativeXhrResponses.set(this, response)
                return response
            },
        })
    }

    new Function(`${userscript}\n//# sourceURL=balh-cdn-recovery-browser.user.js`)()
}

function createPageHtml() {
    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <link rel="icon" href="data:,">
    <title>BALH CDN recovery browser E2E</title>
</head>
<body>
    <main id="bilibili-player">
        <div class="bpx-player-ctrl-setting-others"></div>
        <video id="recovery-video" muted playsinline></video>
    </main>
    <script>window.__INITIAL_STATE__ = {};</script>
</body>
</html>`
}

function createPlayUrlResponse() {
    return {
        code: 0,
        message: '0',
        data: {
            dash: {
                duration: 120,
                minBufferTime: 1.5,
                video: [{
                    id: 80,
                    base_url: mediaUrls.primary,
                    backup_url: [mediaUrls.alternate, mediaUrls.risky],
                    bandwidth: 1_000_000,
                    mime_type: 'video/mp4',
                    codecs: 'avc1.640028',
                }],
                audio: [],
            },
        },
    }
}

function corsHeaders(extra = {}) {
    return {
        'access-control-allow-credentials': 'true',
        'access-control-allow-origin': pageOrigin,
        ...extra,
    }
}

function mediaResponseHeaders() {
    return corsHeaders({
        'accept-ranges': 'bytes',
        'access-control-expose-headers': 'content-range, x-recovery-fixture',
        'content-range': 'bytes 0-31/32',
        'x-recovery-fixture': 'controlled',
    })
}

async function fulfillMediaRoute(route) {
    await route.fulfill({
        status: 206,
        contentType: 'application/octet-stream',
        headers: mediaResponseHeaders(),
        body: '0123456789abcdefghijklmnopqrstuv',
    })
}

async function releaseHeldRoutes(heldRoutes) {
    for (const held of heldRoutes) {
        if (held.handled) continue
        held.handled = true
        try {
            await fulfillMediaRoute(held.route)
        } catch {
            // Context cleanup remains bounded even if the browser already discarded a route.
        }
    }
}

function isContextCleanupVerified(browser, context, page) {
    if (!context) return true
    try {
        return !browser.isConnected()
            || (!browser.contexts().includes(context) && (!page || page.isClosed()))
    } catch {
        return false
    }
}

function isBrowserCleanupVerified(browser) {
    try {
        return !browser.isConnected() && browser.contexts().length === 0
    } catch {
        return false
    }
}

function assertPageIdentity(page) {
    let actual
    try {
        actual = new URL(page.url())
    } catch {
        throw new HarnessFailure('page-identity', 'invalid-location')
    }
    const expected = new URL(pageUrl)
    if (actual.origin !== expected.origin || actual.pathname !== expected.pathname) {
        throw new HarnessFailure('page-identity', 'unexpected-location')
    }
}

async function waitForRecoveryApi(page, transport, deadline) {
    await runStage(`${transport}-recovery-api`, deadline, 5_000, timeout => page.waitForFunction(() => {
        const api = window.bangumi_area_limit_hack
        return typeof api === 'object' && typeof api.getCdnRecoveryStatus === 'function'
    }, undefined, { timeout }))
}

async function installControlledVideo(page, transport, deadline) {
    const result = await runStage(`${transport}-video-fixture`, deadline, 3_000, () => page.evaluate(() => {
        let video = document.querySelector('#recovery-video')
        if (!(video instanceof HTMLVideoElement)) {
            video = document.createElement('video')
            video.id = 'recovery-video'
            document.body.append(video)
        }

        const signals = {
            bufferedAhead: 0.1,
            currentTime: 10,
            duration: 120,
            ended: false,
            paused: false,
            seeking: false,
        }
        const harness = window.__cdnRecoveryBrowserHarness
        harness.signals = signals
        harness.initialVideo = video
        const installSignalGetters = target => {
            const define = (name, getter, setter) => Object.defineProperty(target, name, {
                configurable: true,
                enumerable: false,
                get: getter,
                ...(setter ? { set: setter } : {}),
            })
            define('paused', () => signals.paused)
            define('seeking', () => signals.seeking)
            define('ended', () => signals.ended)
            define('currentTime', () => signals.currentTime, value => {
                if (Number.isFinite(Number(value))) signals.currentTime = Number(value)
            })
            define('duration', () => signals.duration)
            define('buffered', () => ({
                length: 1,
                start(index) {
                    if (index !== 0) throw new DOMException('Index out of range', 'IndexSizeError')
                    return signals.currentTime
                },
                end(index) {
                    if (index !== 0) throw new DOMException('Index out of range', 'IndexSizeError')
                    return signals.currentTime + signals.bufferedAhead
                },
            }))
        }
        installSignalGetters(video)
        harness.replaceVideoDuringPredecessor = selectedTransport => {
            if (harness.predecessorVideoReplacements !== 0
                || selectedTransport !== harness.scenarioTransport) return false
            const current = document.querySelector('#recovery-video')
            if (!(current instanceof HTMLVideoElement)) return false
            const replacement = document.createElement('video')
            replacement.id = 'recovery-video'
            replacement.muted = true
            replacement.playsInline = true
            installSignalGetters(replacement)
            current.replaceWith(replacement)
            harness.replacementVideo = replacement
            harness.predecessorVideoReplacements += 1
            return true
        }
        return {
            connected: video.isConnected,
            ownBuffered: Object.hasOwn(video, 'buffered'),
            ownCurrentTime: Object.hasOwn(video, 'currentTime'),
            ownPaused: Object.hasOwn(video, 'paused'),
            tagName: video.tagName,
        }
    }))
    if (!result?.connected || result.tagName !== 'VIDEO'
        || !result.ownBuffered || !result.ownCurrentTime || !result.ownPaused) {
        throw new HarnessFailure(`${transport}-video-fixture`, 'own-getter-installation-failed')
    }
}

async function deliverPlayUrl(page, transport, deadline) {
    const result = await runStage(`${transport}-playurl-delivery`, deadline, 5_000, () => page.evaluate(
        async ({ playUrlApi: apiUrl, expected, transport: selectedTransport }) => {
            let body
            let status
            if (selectedTransport === 'fetch') {
                const response = await fetch(apiUrl, {
                    credentials: 'include',
                    headers: { accept: 'application/json' },
                })
                status = response.status
                body = await response.json()
            } else {
                const delivery = await new Promise((resolve, reject) => {
                    const xhr = new XMLHttpRequest()
                    xhr.timeout = 4_000
                    xhr.withCredentials = true
                    xhr.addEventListener('load', () => {
                        try {
                            resolve({ body: JSON.parse(xhr.responseText), status: xhr.status })
                        } catch (error) {
                            reject(error)
                        }
                    })
                    xhr.addEventListener('error', () => reject(new Error('playurl XHR error')))
                    xhr.addEventListener('timeout', () => reject(new Error('playurl XHR timeout')))
                    xhr.open('GET', apiUrl, true)
                    xhr.setRequestHeader('accept', 'application/json')
                    xhr.send()
                })
                body = delivery.body
                status = delivery.status
            }
            const video = body?.data?.dash?.video?.[0]
            const candidates = [video?.base_url, ...(video?.backup_url || [])]
            return {
                candidateCount: candidates.length,
                code: body?.code,
                orderMatches: candidates.length === 3
                    && candidates.every((value, index) => value === expected[index]),
                status,
            }
        },
        { playUrlApi, expected: Object.values(mediaUrls), transport },
    ))
    if (result?.status !== 200 || result.code !== 0
        || result.candidateCount !== 3 || !result.orderMatches) {
        throw new HarnessFailure(`${transport}-playurl-delivery`, 'final-candidate-group-mismatch')
    }
}

async function assertPublishedRegistry(page, transport, deadline) {
    const status = await readRecoveryStatus(page, transport, deadline)
    const group = status?.groups?.[0]
    if (!status?.enabled || status.groupCount !== 1 || status.activeGroupCount !== 0
        || status.groups.length !== 1 || group.candidateCount !== 3
        || group.kind !== 'dash-video' || group.state !== 'unseen'
        || group.candidateIndex !== null || group.attemptedCount !== 0
        || !Number.isInteger(status.contextEpoch)) {
        throw new HarnessFailure(`${transport}-registry`, 'unexpected-final-publication')
    }
    assertUrlFreeStatus(status, `${transport}-registry`)
    return status.contextEpoch
}

async function waitForStageTwoProbeSettlement(page, observations, transport, deadline) {
    await runStage(`${transport}-probe-terminal`, deadline, 10_000, timeout => page.waitForFunction(
        terminalStates => {
            const status = window.bangumi_area_limit_hack?.getCdnProbeStatus?.()
            return terminalStates.includes(status?.state)
                && Number.isInteger(status?.completed)
                && Number.isInteger(status?.total)
                && status.total >= 0
                && status.completed >= 0
                && status.completed <= status.total
        },
        ['ready', 'partial', 'unprobeable', 'failed'],
        { polling: 25, timeout },
    ))
    const probeStatus = await runStage(`${transport}-probe-status`, deadline, 1_000, () => (
        page.evaluate(() => {
            const status = window.bangumi_area_limit_hack.getCdnProbeStatus()
            return {
                candidateCount: Array.isArray(status.candidateHosts)
                    ? status.candidateHosts.length
                    : -1,
                completed: status.completed,
                state: status.state,
                total: status.total,
            }
        })
    ))
    await runStage(`${transport}-probe-observations`, deadline, 1_000, timeout => waitForHostCondition(
        () => observations.probeRequests.length >= probeStatus.completed,
        timeout,
    ))
    await runStage(`${transport}-probe-quiet`, deadline, 2_000, () => waitForStableCount(
        () => observations.probeRequests.length,
        500,
        2_000,
    ))
    if (probeStatus.state !== 'unprobeable'
        || probeStatus.completed !== 0
        || probeStatus.total !== 0
        || probeStatus.candidateCount !== Object.keys(mediaUrls).length
        || observations.probeRequests.length !== 0
        || observations.unexpectedMediaRequests.length > 0
        || observations.probeRequests.length < probeStatus.completed) {
        throw new HarnessFailure(`${transport}-probe-terminal`, 'unclassified-or-overlapping-media-request')
    }
    return {
        probeCount: observations.probeRequests.length,
        unexpectedRequestCount: observations.unexpectedRequests.length,
    }
}

function assertRecoveryRequestBaseline(observations, baseline, transport) {
    if (!Number.isInteger(baseline?.probeCount)
        || !Number.isInteger(baseline?.unexpectedRequestCount)
        || observations.probeRequests.length !== baseline.probeCount
        || observations.unexpectedRequests.length !== baseline.unexpectedRequestCount
        || observations.unexpectedMediaRequests.length > 0) {
        throw new HarnessFailure(`${transport}-routing`, 'background-or-unclassified-media-request-after-baseline')
    }
}

async function startMediaRequest(page, transport, phase, deadline) {
    const result = await runStage(`${transport}-${phase}-start`, deadline, 3_000, () => page.evaluate(
        ({ accept, primaryUrl, range, requestTimeoutMs, transport: selectedTransport, phase: selectedPhase }) => {
            const harness = window.__cdnRecoveryBrowserHarness
            const state = {
                abortCount: 0,
                errorCount: 0,
                loadCount: 0,
                loadEndCount: 0,
                outcome: 'pending',
                settled: false,
                status: null,
                startedAtEpochMs: Date.now(),
                timeoutCount: 0,
            }
            harness.media[selectedPhase] = state

            if (selectedTransport === 'fetch') {
                const controller = new AbortController()
                const timeout = setTimeout(() => controller.abort(), requestTimeoutMs)
                const request = new Request(primaryUrl, {
                    credentials: 'include',
                    headers: { accept, range },
                    method: 'GET',
                    signal: controller.signal,
                })
                state.request = request
                state.controller = controller
                void Reflect.apply(fetch, harness.fetchExpectedReceiver, [request]).then(async response => {
                    state.responseIdentityPreserved = harness.fetchPredecessorResponses
                        .get(selectedPhase) === response
                    state.status = response.status
                    await response.arrayBuffer()
                    state.outcome = 'load'
                    state.loadCount += 1
                }, error => {
                    state.outcome = error?.name === 'AbortError' ? 'abort' : 'error'
                    if (state.outcome === 'abort') state.abortCount += 1
                    else state.errorCount += 1
                }).finally(() => {
                    clearTimeout(timeout)
                    state.settled = true
                    state.loadEndCount += 1
                })
                return { started: true, inputKind: 'Request' }
            }

            const xhr = new XMLHttpRequest()
            state.xhr = xhr
            xhr.responseType = 'arraybuffer'
            xhr.timeout = requestTimeoutMs
            xhr.withCredentials = true
            xhr.addEventListener('load', () => {
                const response = xhr.response
                state.responseIdentityPreserved = harness.nativeXhrResponses.get(xhr) === response
                state.status = xhr.status
                state.outcome = 'load'
                state.loadCount += 1
            })
            xhr.addEventListener('abort', () => {
                state.outcome = 'abort'
                state.abortCount += 1
            })
            xhr.addEventListener('error', () => {
                state.outcome = 'error'
                state.errorCount += 1
            })
            xhr.addEventListener('timeout', () => {
                state.outcome = 'timeout'
                state.timeoutCount += 1
            })
            xhr.addEventListener('loadend', () => {
                state.status = xhr.status
                state.settled = true
                state.loadEndCount += 1
            })
            xhr.open('GET', primaryUrl, true)
            xhr.setRequestHeader('accept', accept)
            xhr.setRequestHeader('range', range)
            xhr.send()
            return { started: true, inputKind: 'XMLHttpRequest' }
        },
        {
            accept: acceptFor(transport, phase),
            phase,
            primaryUrl: mediaUrls.primary,
            range: rangeHeader,
            requestTimeoutMs: browserRequestTimeoutMs,
            transport,
        },
    ))
    if (!result?.started
        || (transport === 'fetch' && result.inputKind !== 'Request')
        || (transport === 'xhr' && result.inputKind !== 'XMLHttpRequest')) {
        throw new HarnessFailure(`${transport}-${phase}-start`, 'request-not-started')
    }
}

async function waitForMediaObservation(observations, phase, deadline) {
    await runStage(`media-${phase}-observation`, deadline, 3_000, timeout => waitForHostCondition(
        () => observations.mediaRequests.some(request => request.phase === phase),
        timeout,
    ))
}

function assertInitialRequest(observations, transport) {
    const requests = observations.mediaRequests.filter(request => request.phase === 'initial')
    const request = requests[0]
    if (requests.length !== 1 || request.label !== 'primary' || request.method !== 'GET'
        || request.resourceType !== transport || !request.acceptPreserved || !request.rangePreserved) {
        throw new HarnessFailure(`${transport}-initial-request`, 'predecessor-semantics-mismatch')
    }
}

async function assertBeforeGrace(page, observations, transport, deadline) {
    const [status, media] = await Promise.all([
        readRecoveryStatus(page, transport, deadline),
        readMediaState(page, transport, 'initial', deadline),
    ])
    const group = status.groups[0]
    if (group.state !== 'confirming' || group.candidateIndex !== 0
        || group.attemptedCount !== 1 || group.switchAttempts !== 0
        || !group.timerPending) {
        throw new HarnessFailure(`${transport}-before-grace`, 'advanced-before-confirmation-grace')
    }
    if (media.settled || media.outcome !== 'pending' || media.abortCount !== 0
        || countPhase(observations, 'initial') !== 1
        || observations.documentRequests !== 1
        || observations.mainFrameNavigations !== 1
        || observations.requestFailures.length !== 0) {
        throw new HarnessFailure(`${transport}-before-grace`, 'current-request-interfered')
    }
    assertTransportObjectState(media, transport, false, `${transport}-before-grace`)
}

async function assertAfterGrace(
    page,
    observations,
    transport,
    confirmingObservedAtMs,
    waitingObservedAtMs,
    publishedContextEpoch,
    deadline,
) {
    const [status, media] = await Promise.all([
        readRecoveryStatus(page, transport, deadline),
        readMediaState(page, transport, 'initial', deadline),
    ])
    const group = status.groups[0]
    if (status.contextEpoch !== publishedContextEpoch + 1
        || group.state !== 'waiting-retry' || group.candidateIndex !== 1
        || group.attemptedCount !== 2 || group.switchAttempts !== 1
        || group.timerPending || typeof group.retryAt !== 'number') {
        throw new HarnessFailure(`${transport}-after-grace`, 'future-route-not-advanced')
    }
    if (media.settled || media.outcome !== 'pending' || media.abortCount !== 0
        || countPhase(observations, 'initial') !== 1
        || observations.documentRequests !== 1
        || observations.mainFrameNavigations !== 1
        || observations.requestFailures.length !== 0) {
        throw new HarnessFailure(`${transport}-after-grace`, 'in-flight-request-changed')
    }
    assertTransportObjectState(media, transport, false, `${transport}-after-grace`)
    assertUrlFreeStatus(status, `${transport}-after-grace`)
    const measuredGraceMs = waitingObservedAtMs - confirmingObservedAtMs
    if (!Number.isFinite(measuredGraceMs) || measuredGraceMs < minimumMeasuredGraceMs) {
        throw new HarnessFailure(`${transport}-after-grace`, 'confirmation-grace-too-short')
    }
    const remainingCooldownMs = group.retryAt - waitingObservedAtMs
    if (!Number.isFinite(remainingCooldownMs)
        || remainingCooldownMs < 14_800 || remainingCooldownMs > 15_100) {
        throw new HarnessFailure(`${transport}-after-grace`, 'initial-cooldown-mismatch')
    }
    return { measuredGraceMs, retryAt: group.retryAt }
}

function assertRoutedObservation(observations, transport, phase) {
    const requests = observations.mediaRequests.filter(request => request.phase === phase)
    const request = requests[0]
    if (requests.length !== 1 || request.label !== 'alternate' || request.method !== 'GET'
        || request.resourceType !== transport || !request.acceptPreserved || !request.rangePreserved) {
        throw new HarnessFailure(`${transport}-${phase}-route`, 'not-same-group-ordinary-alternate')
    }
    if (observations.mediaRequests.some(item => item.phase && item.label === 'risky')) {
        throw new HarnessFailure(`${transport}-${phase}-route`, 'risky-fallback-used-early')
    }
}

async function assertFutureState(page, transport, deadline) {
    const [status, future, initial] = await Promise.all([
        readRecoveryStatus(page, transport, deadline),
        readMediaState(page, transport, 'future', deadline),
        readMediaState(page, transport, 'initial', deadline),
    ])
    const group = status.groups[0]
    if (future.outcome !== 'load' || future.status !== 206 || future.loadCount !== 1
        || future.loadEndCount !== 1 || future.abortCount !== 0
        || initial.settled || initial.outcome !== 'pending'
        || group.state !== 'waiting-retry' || group.candidateIndex !== 1
        || group.switchAttempts !== 1) {
        throw new HarnessFailure(`${transport}-future-state`, 'alternate-delivery-or-current-hold-failed')
    }
    assertTransportObjectState(future, transport, true, `${transport}-future-state`)
}

async function assertRoutedMediaCompleted(page, transport, phase, deadline) {
    const media = await readMediaState(page, transport, phase, deadline)
    if (!media.settled || media.outcome !== 'load' || media.status !== 206
        || media.loadCount !== 1 || media.loadEndCount !== 1
        || media.abortCount !== 0 || media.errorCount !== 0 || media.timeoutCount !== 0) {
        throw new HarnessFailure(`${transport}-${phase}-completion`, 'routed-request-failed')
    }
    assertTransportObjectState(media, transport, true, `${transport}-${phase}-completion`)
}

async function beginHealthyPlayback(page, transport, deadline) {
    await runStage(`${transport}-healthy-signals`, deadline, 3_000, () => page.evaluate(() => {
        const harness = window.__cdnRecoveryBrowserHarness
        const video = document.querySelector('#recovery-video')
        if (!harness?.signals || !(video instanceof HTMLVideoElement)) return false
        if (harness.progressTimer !== null) clearInterval(harness.progressTimer)
        harness.signals.bufferedAhead = 6
        harness.signals.currentTime = 30
        harness.signals.paused = false
        harness.signals.seeking = false
        harness.signals.ended = false
        harness.progressTimer = setInterval(() => {
            harness.signals.currentTime += 0.05
            video.dispatchEvent(new Event('timeupdate'))
        }, 100)
        video.dispatchEvent(new Event('playing'))
        video.dispatchEvent(new Event('progress'))
        return true
    }).then(ok => {
        if (!ok) throw new HarnessFailure(`${transport}-healthy-signals`, 'video-fixture-missing')
    }))
}

async function waitForStableReset(page, transport, expectedRetryAt, deadline) {
    await runStage(`${transport}-stable-reset`, deadline, 7_000, timeout => page.waitForFunction(retryAt => {
        const status = window.bangumi_area_limit_hack?.getCdnRecoveryStatus?.()
        const group = status?.groups?.[0]
        return group?.state === 'waiting-retry'
            && group.candidateIndex === 1
            && group.attemptedCount === 1
            && group.switchAttempts === 0
            && group.retryAt === retryAt
            && group.retryAt > Date.now()
    }, expectedRetryAt, { polling: 25, timeout }))
}

async function beginLowPlayback(page, transport, expectedRetryAt, deadline) {
    const result = await runStage(`${transport}-cooldown-low-signals`, deadline, 3_000, () => page.evaluate(() => {
        const harness = window.__cdnRecoveryBrowserHarness
        const video = document.querySelector('#recovery-video')
        if (!harness?.signals || !(video instanceof HTMLVideoElement)) return null
        if (harness.progressTimer !== null) {
            clearInterval(harness.progressTimer)
            harness.progressTimer = null
        }
        harness.signals.bufferedAhead = 0.1
        video.dispatchEvent(new Event('waiting'))
        video.dispatchEvent(new Event('stalled'))
        const group = window.bangumi_area_limit_hack.getCdnRecoveryStatus().groups[0]
        return {
            currentTime: harness.signals.currentTime,
            retryAt: group.retryAt,
            retryRemainingMs: group.retryAt - Date.now(),
        }
    }))
    if (!result || !Number.isFinite(result.currentTime)
        || result.retryAt !== expectedRetryAt
        || !Number.isFinite(result.retryRemainingMs)
        || result.retryRemainingMs <= cooldownLowWindowMs + 500) {
        throw new HarnessFailure(`${transport}-cooldown-low-signals`, 'insufficient-cooldown-window')
    }
}

async function assertCooldownState(page, transport, expectedRetryAt, deadline) {
    const status = await readRecoveryStatus(page, transport, deadline)
    const group = status.groups[0]
    if (group.state !== 'waiting-retry' || group.candidateIndex !== 1
        || group.attemptedCount !== 1 || group.switchAttempts !== 0
        || group.retryAt !== expectedRetryAt || group.retryAt <= Date.now()
        || group.timerPending) {
        throw new HarnessFailure(`${transport}-cooldown`, 'ping-pong-or-cooldown-shortened')
    }
}

async function assertCurrentRequestHeld(page, observations, transport, deadline) {
    const media = await readMediaState(page, transport, 'initial', deadline)
    if (media.settled || media.outcome !== 'pending' || media.abortCount !== 0
        || countPhase(observations, 'initial') !== 1
        || observations.documentRequests !== 1
        || observations.mainFrameNavigations !== 1
        || observations.requestFailures.length !== 0) {
        throw new HarnessFailure(`${transport}-current-hold`, 'abort-reload-or-replay-observed')
    }
    assertTransportObjectState(media, transport, false, `${transport}-current-hold`)
}

async function assertCurrentRequestCompleted(page, observations, transport, deadline) {
    const media = await readMediaState(page, transport, 'initial', deadline)
    if (!media.settled || media.outcome !== 'load' || media.status !== 206
        || media.loadCount !== 1 || media.loadEndCount !== 1 || media.abortCount !== 0
        || media.errorCount !== 0 || media.timeoutCount !== 0
        || countPhase(observations, 'initial') !== 1
        || observations.documentRequests !== 1
        || observations.mainFrameNavigations !== 1
        || observations.requestFailures.length !== 0) {
        throw new HarnessFailure(`${transport}-current-completion`, 'held-request-did-not-complete-once')
    }
    assertTransportObjectState(media, transport, true, `${transport}-current-completion`)
}

async function waitForGroupState(page, transport, state, deadline, capMs) {
    await runStage(`${transport}-state-${state}`, deadline, capMs, timeout => page.waitForFunction(
        expected => window.bangumi_area_limit_hack?.getCdnRecoveryStatus?.().groups?.[0]?.state === expected,
        state,
        { polling: 25, timeout },
    ))
    return runStage(`${transport}-state-${state}-observed-at`, deadline, 1_000, () => (
        page.evaluate(() => Date.now())
    ))
}

async function waitForMediaSettlement(page, transport, phase, deadline) {
    await runStage(`${transport}-${phase}-settlement`, deadline, 5_000, timeout => page.waitForFunction(
        selectedPhase => window.__cdnRecoveryBrowserHarness?.media?.[selectedPhase]?.settled === true,
        phase,
        { timeout },
    ))
}

async function readRecoveryStatus(page, transport, deadline) {
    const status = await runStage(`${transport}-status`, deadline, 2_000, () => page.evaluate(() => (
        window.bangumi_area_limit_hack?.getCdnRecoveryStatus?.()
    )))
    if (!status || !Array.isArray(status.groups)) {
        throw new HarnessFailure(`${transport}-status`, 'missing-or-invalid')
    }
    return status
}

async function readMediaState(page, transport, phase, deadline) {
    const state = await runStage(`${transport}-${phase}-state`, deadline, 2_000, () => page.evaluate(
        selectedPhase => {
            const harness = window.__cdnRecoveryBrowserHarness
            const media = harness?.media?.[selectedPhase]
            if (!media) return null
            return {
                abortCount: media.abortCount,
                errorCount: media.errorCount,
                loadCount: media.loadCount,
                loadEndCount: media.loadEndCount,
                outcome: media.outcome,
                predecessorVideoReplacements: harness.predecessorVideoReplacements,
                replacementVideoIdentityVerified: harness.initialVideo instanceof HTMLVideoElement
                    && harness.replacementVideo instanceof HTMLVideoElement
                    && harness.initialVideo !== harness.replacementVideo
                    && harness.initialVideo.isConnected === false
                    && document.querySelector('#recovery-video') === harness.replacementVideo,
                requestCredentials: media.request?.credentials ?? null,
                fetchPredecessorCallCount: harness.fetchPredecessorCalls?.get?.(selectedPhase) ?? null,
                fetchPredecessorInput: harness.fetchPredecessorInputs?.get?.(selectedPhase) ?? null,
                fetchPredecessorReceiverIdentity: harness.fetchPredecessorReceiverMatches
                    ?.get?.(selectedPhase) ?? null,
                fetchResponseIdentityPreserved: media.responseIdentityPreserved ?? null,
                requestMethod: media.request?.method ?? null,
                requestRange: media.request?.headers?.get?.('range') ?? null,
                requestSignalAborted: media.request?.signal?.aborted ?? null,
                settled: media.settled,
                startedAtEpochMs: media.startedAtEpochMs,
                status: media.status,
                timeoutCount: media.timeoutCount,
                xhrNativeOpenCount: media.xhr
                    ? harness.nativeXhrOpenCounts?.get?.(media.xhr) ?? 0
                    : null,
                xhrNativeOpenReceiverIdentity: media.xhr
                    ? harness.nativeXhrOpenReceivers?.has?.(media.xhr) ?? false
                    : null,
                xhrReadyState: media.xhr?.readyState ?? null,
                xhrResponseType: media.xhr?.responseType ?? null,
                xhrNativeSendCount: media.xhr
                    ? harness.nativeXhrSendCounts?.get?.(media.xhr) ?? 0
                    : null,
                xhrNativeSendReceiverIdentity: media.xhr
                    ? harness.nativeXhrSendReceivers?.has?.(media.xhr) ?? false
                    : null,
                xhrResponseIdentityPreserved: media.responseIdentityPreserved ?? null,
                xhrWithCredentials: media.xhr?.withCredentials ?? null,
            }
        },
        phase,
    ))
    if (!state) throw new HarnessFailure(`${transport}-${phase}-state`, 'missing')
    return state
}

function assertTransportObjectState(media, transport, completed, stage) {
    if (media.predecessorVideoReplacements !== 1
        || media.replacementVideoIdentityVerified !== true) {
        throw new HarnessFailure(stage, 'predecessor-window-video-replacement-not-observed')
    }
    if (transport === 'fetch') {
        if (media.requestMethod !== 'GET' || media.requestCredentials !== 'include'
            || media.requestRange !== rangeHeader || media.requestSignalAborted !== false
            || media.fetchPredecessorCallCount !== 1
            || media.fetchPredecessorInput?.method !== 'GET'
            || media.fetchPredecessorInput?.credentials !== 'include'
            || media.fetchPredecessorInput?.range !== rangeHeader
            || media.fetchPredecessorInput?.signalAborted !== false
            || media.fetchPredecessorReceiverIdentity !== true
            || (completed && media.fetchResponseIdentityPreserved !== true)) {
            throw new HarnessFailure(stage, 'fetch-request-state-changed')
        }
        return
    }
    if (media.xhrReadyState !== (completed ? 4 : 1)
        || media.xhrResponseType !== 'arraybuffer'
        || media.xhrWithCredentials !== true
        || media.xhrNativeOpenCount !== 1 || media.xhrNativeSendCount !== 1
        || media.xhrNativeOpenReceiverIdentity !== true
        || media.xhrNativeSendReceiverIdentity !== true
        || (completed && media.xhrResponseIdentityPreserved !== true)) {
        throw new HarnessFailure(stage, 'xhr-instance-state-changed')
    }
}

async function assertPrivateSurfaces(page, transport, deadline) {
    const result = await runStage(`${transport}-privacy`, deadline, 3_000, () => page.evaluate(urls => {
        const api = window.bangumi_area_limit_hack
        const storageText = storage => {
            const entries = []
            for (let index = 0; index < storage.length; index += 1) {
                const key = storage.key(index)
                if (key !== null) entries.push([key, storage.getItem(key)])
            }
            return JSON.stringify(entries)
        }
        const surfaces = {
            diagnostic: JSON.stringify(api?.getDiagnosticReport?.() ?? null),
            log: JSON.stringify(api?.getLog?.() ?? null),
            localStorage: storageText(localStorage),
            sessionStorage: storageText(sessionStorage),
            status: JSON.stringify(api?.getCdnRecoveryStatus?.() ?? null),
        }
        return Object.fromEntries(Object.entries(surfaces).map(([name, text]) => [
            name,
            urls.every(url => !text.includes(url)),
        ]))
    }, privateFixtureFragments))
    if (!result || Object.values(result).some(clean => clean !== true)) {
        throw new HarnessFailure(`${transport}-privacy`, 'exact-url-escaped-memory-only-surface')
    }
}

async function settleConsoleInspections(observations, transport, deadline) {
    const pending = observations.consoleInspections.splice(0)
    await runStage(`${transport}-console-privacy`, deadline, 3_000, () => Promise.all(pending))
}

async function inspectConsoleArguments(message) {
    const handles = message.args()
    const results = await Promise.all(handles.map(handle => handle.evaluate((value, fragments) => {
        const maxDepth = 8
        const maxEntries = 1_000
        const maxKeys = 1_000
        const maxVisited = 5_000
        const seen = new WeakSet()
        const pending = [{ depth: 0, value }]
        let visited = 0
        let incomplete = false
        const containsFragment = text => fragments.some(fragment => text.includes(fragment))
        while (pending.length > 0) {
            if (visited >= maxVisited) {
                incomplete = true
                break
            }
            const entry = pending.pop()
            const current = entry.value
            visited += 1
            if (typeof current === 'string') {
                if (containsFragment(current)) return 'leak'
                continue
            }
            if ((typeof current !== 'object' && typeof current !== 'function') || current === null) {
                continue
            }
            if (seen.has(current)) continue
            if (entry.depth >= maxDepth) {
                incomplete = true
                continue
            }
            seen.add(current)

            if (current instanceof Error) {
                pending.push(
                    { depth: entry.depth + 1, value: current.message },
                    { depth: entry.depth + 1, value: current.stack },
                )
            }
            if (current instanceof URL) {
                pending.push({ depth: entry.depth + 1, value: current.href })
            }
            if (current instanceof Map) {
                let count = 0
                for (const [key, item] of current) {
                    if (count >= maxEntries) {
                        incomplete = true
                        break
                    }
                    pending.push(
                        { depth: entry.depth + 1, value: key },
                        { depth: entry.depth + 1, value: item },
                    )
                    count += 1
                }
                continue
            }
            if (current instanceof Set) {
                let count = 0
                for (const item of current) {
                    if (count >= maxEntries) {
                        incomplete = true
                        break
                    }
                    pending.push({ depth: entry.depth + 1, value: item })
                    count += 1
                }
                continue
            }

            let keys
            try {
                keys = Reflect.ownKeys(current)
            } catch {
                incomplete = true
                continue
            }
            if (keys.length > maxKeys) incomplete = true
            for (const key of keys.slice(0, maxKeys)) {
                const keyText = typeof key === 'symbol' ? key.description : key
                if (typeof keyText === 'string' && containsFragment(keyText)) return 'leak'
                let descriptor
                try {
                    descriptor = Object.getOwnPropertyDescriptor(current, key)
                } catch {
                    incomplete = true
                    continue
                }
                if (descriptor && 'value' in descriptor) {
                    pending.push({ depth: entry.depth + 1, value: descriptor.value })
                }
            }
        }
        return incomplete ? 'incomplete' : 'clean'
    }, privateFixtureFragments)))
    return {
        containsUrl: results.includes('leak'),
        incomplete: results.includes('incomplete'),
    }
}

function assertUrlFreeStatus(status, stage) {
    const serialized = JSON.stringify(status)
    if (privateFixtureFragments.some(fragment => serialized.includes(fragment))
        || /https?:\/\//i.test(serialized)
        || serialized.includes('/media/video.m4s')) {
        throw new HarnessFailure(stage, 'status-contained-url')
    }
}

async function stopHarnessTimers(page) {
    if (!page || page.isClosed()) return
    try {
        await page.evaluate(() => {
            const harness = window.__cdnRecoveryBrowserHarness
            if (harness?.progressTimer !== null) {
                clearInterval(harness.progressTimer)
                harness.progressTimer = null
            }
        })
    } catch {
        // Context cleanup is the final timer boundary.
    }
}

function acceptFor(transport, phase) {
    return `application/vnd.balh-recovery.${transport}.${phase}`
}

function phaseFromAccept(accept, transport) {
    for (const phase of ['initial', 'future', 'cooldown']) {
        if (accept === acceptFor(transport, phase)) return phase
    }
    return null
}

function countPhase(observations, phase) {
    return observations.mediaRequests.filter(request => request.phase === phase).length
}

function waitForHostCondition(predicate, timeoutMs) {
    return new Promise((resolve, reject) => {
        const startedAt = Date.now()
        const poll = () => {
            if (predicate()) {
                resolve()
                return
            }
            if (Date.now() - startedAt >= timeoutMs) {
                reject(new HarnessFailure('host-observation', 'timeout'))
                return
            }
            setTimeout(poll, 20)
        }
        poll()
    })
}

function waitForStableCount(readCount, quietMs, timeoutMs) {
    return new Promise((resolve, reject) => {
        const startedAt = Date.now()
        let lastCount = readCount()
        let stableSince = startedAt
        const poll = () => {
            const now = Date.now()
            const count = readCount()
            if (count !== lastCount) {
                lastCount = count
                stableSince = now
            }
            if (now - stableSince >= quietMs) {
                resolve(lastCount)
                return
            }
            if (now - startedAt >= timeoutMs) {
                reject(new HarnessFailure('host-stable-count', 'timeout'))
                return
            }
            setTimeout(poll, 20)
        }
        poll()
    })
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
        throw new HarnessFailure(stage, error?.name === 'TimeoutError' ? 'timeout' : 'failed', error)
    } finally {
        clearTimeout(timer)
    }
}

async function closeWithDeadline(close, timeoutMs) {
    let timer
    try {
        return await Promise.race([
            Promise.resolve().then(close).then(
                () => ({ ok: true }),
                error => ({ ok: false, reason: 'failure', error }),
            ),
            new Promise(resolve => {
                timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), timeoutMs)
            }),
        ])
    } finally {
        clearTimeout(timer)
    }
}

function pushBounded(items, value, limit) {
    items.push(value)
    if (items.length > limit) items.shift()
}

function normalizeFailure(error) {
    if (error instanceof HarnessFailure) return error
    return new HarnessFailure('unexpected', 'failed', error)
}

function safeErrorDetail(error) {
    const cause = error instanceof HarnessFailure ? error.cause : error
    return cause ? 'cause=external-error' : ''
}

function sanitizeText(value) {
    let text = String(value || '')
    for (const fixture of outputRedactionFragments) {
        text = text.split(fixture).join('<synthetic-media>')
    }
    return text.length <= 1_000
        ? text
        : `${text.slice(0, 1_000)}…[truncated]`
}

function containsPrivateFixtureFragment(value) {
    const text = String(value || '')
    return privateFixtureFragments.some(fragment => text.includes(fragment))
}

function safeLabel(value) {
    return String(value).replace(/[^a-z0-9_-]+/gi, '-').slice(0, 80)
}
