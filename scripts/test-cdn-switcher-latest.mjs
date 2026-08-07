#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const execFileAsync = promisify(execFile)
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const taskDir = path.join(rootDir, '.codex-tmp', 'cdn-switcher-latest')
const downloadPath = path.join(taskDir, 'Bilibili Video CDN Switcher.user.js')
const balhPath = path.join(rootDir, 'dist', 'unblock-area-limit.user.js')
const buildScriptPath = path.join(rootDir, 'scripts', 'build.mjs')

const cdnSwitcherUrl = 'https://update.greasyfork.org/scripts/500213/Bilibili%20Video%20CDN%20Switcher.user.js'
const cdnSwitcherMetaUrl = 'https://update.greasyfork.org/scripts/500213/Bilibili%20Video%20CDN%20Switcher.meta.js'
const expectedCdnName = 'Bilibili Video CDN Switcher'
const expectedCdnNamespace = 'mailto:1332019995@qq.com'
const pageUrl = 'https://www.bilibili.com/bangumi/play/ep737262'
const playUrlApi = 'https://api.bilibili.com/pgc/player/web/playurl?ep_id=737262&qn=80'
const sourceMediaHost = 'upos-hz-mirrorakam.akamaized.net'
const expectedCdnHost = 'compat-cdn.invalid'
const mediaPath = '/compat/video.m4s'
const mediaToken = 'controlled-response'
const stage3MediaToken = 'controlled-stage3-response'
const stage3Candidates = Object.freeze([
    createStage3Candidate('fetch', 'primary', '/compat/stage3/fetch-primary.m4s'),
    createStage3Candidate('fetch', 'alternate', '/compat/stage3/fetch-alternate.m4s'),
    createStage3Candidate('xhr', 'primary', '/compat/stage3/xhr-primary.m4s'),
    createStage3Candidate('xhr', 'alternate', '/compat/stage3/xhr-alternate.m4s'),
])

const downloadTimeoutMs = 30_000
const downloadByteLimit = 2 * 1024 * 1024
const buildTimeoutMs = 60_000
const buildOutputByteLimit = 512 * 1024
const browserLaunchTimeoutMs = 20_000
const navigationTimeoutMs = 15_000
const requestTimeoutMs = 8_000
const orderTimeoutMs = 35_000
const cleanupTimeoutMs = 5_000
const browserCleanupTimeoutMs = 20_000
const stage3HeldRequestTimeoutMs = 30_000
const stage3GraceMs = 3_000
const stage3GraceProbeDelayMs = 2_850
const stage3MinimumCooldownMs = 15_000
const stage3CooldownProbeMarginMs = 400
const stage3EarlyGraceCheckMs = 2_200
const stage3CooldownCheckMs = 750
const stage3ProbeBaselineStabilityMs = 500

run().catch(error => {
    console.error(`[cdn-switcher-compat] FAIL\n${formatError(error)}`)
    process.exitCode = 1
})

async function run() {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) {
        printUsage()
        return
    }
    await main(options)
}

async function main({ expectVersion, expectSha256 }) {
    await mkdir(taskDir, { recursive: true })

    const [downloaded, downloadedMeta] = await Promise.all([
        downloadUserscript(cdnSwitcherUrl),
        downloadUserscript(cdnSwitcherMetaUrl),
    ])
    const cdnName = readMetadataField(downloaded.source, 'name', 'CDN Switcher')
    const cdnNamespace = readMetadataField(downloaded.source, 'namespace', 'CDN Switcher')
    const cdnVersion = readMetadataField(downloaded.source, 'version', 'CDN Switcher')
    const metadataIdentity = {
        name: readMetadataField(downloadedMeta.source, 'name', 'CDN Switcher metadata'),
        namespace: readMetadataField(downloadedMeta.source, 'namespace', 'CDN Switcher metadata'),
        version: readMetadataField(downloadedMeta.source, 'version', 'CDN Switcher metadata'),
    }
    const sha256 = createHash('sha256').update(downloaded.bytes).digest('hex')

    if (cdnName !== expectedCdnName || cdnNamespace !== expectedCdnNamespace) {
        throw new Error([
            'CDN Switcher metadata identity mismatch.',
            `Expected @name=${JSON.stringify(expectedCdnName)} and @namespace=${JSON.stringify(expectedCdnNamespace)};`,
            `downloaded @name=${JSON.stringify(cdnName)} and @namespace=${JSON.stringify(cdnNamespace)}.`,
        ].join(' '))
    }
    if (metadataIdentity.name !== cdnName
        || metadataIdentity.namespace !== cdnNamespace
        || metadataIdentity.version !== cdnVersion) {
        throw new Error([
            'CDN Switcher latest metadata does not match the downloaded source.',
            `Source identity=${JSON.stringify({ name: cdnName, namespace: cdnNamespace, version: cdnVersion })};`,
            `metadata identity=${JSON.stringify(metadataIdentity)}.`,
        ].join(' '))
    }

    if (expectVersion !== undefined && cdnVersion !== expectVersion) {
        throw new Error([
            `CDN Switcher version mismatch: expected ${JSON.stringify(expectVersion)}, downloaded ${JSON.stringify(cdnVersion)}.`,
            'Review the new upstream release, then update the documented compatibility matrix and pre-tag expectation together.',
        ].join(' '))
    }
    if (expectSha256 !== undefined && sha256 !== expectSha256) {
        throw new Error([
            `CDN Switcher SHA-256 mismatch: expected ${expectSha256}, downloaded ${sha256}.`,
            'Do not execute the changed upstream bytes until they have been reviewed; then update the documented compatibility matrix and pre-tag hash together.',
        ].join(' '))
    }

    await writeFile(downloadPath, downloaded.bytes, { mode: 0o600 })
    console.log(`[cdn-switcher-compat] CDN @name=${JSON.stringify(cdnName)} @namespace=${JSON.stringify(cdnNamespace)} @version=${JSON.stringify(cdnVersion)} sha256=${sha256}`)
    console.log(`[cdn-switcher-compat] Downloaded ${downloaded.finalUrl} -> ${path.relative(rootDir, downloadPath)} (${downloaded.bytes.length} bytes)`)
    console.log(`[cdn-switcher-compat] Latest metadata matched ${downloadedMeta.finalUrl}`)

    const balhSource = await buildAndReadBalh()
    const balhVersion = readMetadataField(balhSource, 'version', 'BALH')
    console.log(`[cdn-switcher-compat] BALH @version=${JSON.stringify(balhVersion)} (fresh build)`)

    const launched = await launchPreferredBrowser()
    const browserVersion = launched.browser.version()
    console.log(`[cdn-switcher-compat] Browser=${JSON.stringify(launched.label)} version=${JSON.stringify(browserVersion)}`)

    const orders = [
        ['balh', 'cdn'],
        ['cdn', 'balh'],
    ]
    const results = []
    const failures = []

    let browserCloseError
    try {
        for (const order of orders) {
            try {
                const result = await exerciseOrder({
                    browser: launched.browser,
                    order,
                    balhSource,
                    balhVersion,
                    cdnSource: downloaded.source,
                })
                results.push(result)
                console.log([
                    `[cdn-switcher-compat] PASS order=${order.join('->')}`,
                    `fetchHost=${result.fetch.host}`,
                    `xhrHost=${result.xhr.host}`,
                    `stage3Fetch=${result.stage3.fetch.join('->')}`,
                    `stage3Xhr=${result.stage3.xhr.join('->')}`,
                ].join(' '))
            } catch (error) {
                failures.push({ order, error })
                console.error(`[cdn-switcher-compat] FAIL order=${order.join('->')}: ${firstLine(error.message)}`)
            }
        }
    } finally {
        browserCloseError = await closeWithDeadline(
            () => launched.browser.close(),
            browserCleanupTimeoutMs,
            'browser cleanup',
        )
    }
    if (browserCloseError) {
        failures.push({ order: ['browser-cleanup'], error: browserCloseError })
    }

    if (failures.length > 0) {
        throw new Error([
            `${failures.length} compatibility or cleanup failure(s) occurred.`,
            ...failures.map(({ order, error }) => `\n--- ${order.join('->')} ---\n${clip(formatError(error), 10_000)}`),
        ].join('\n'))
    }

    const summary = {
        name: cdnName,
        namespace: cdnNamespace,
        version: cdnVersion,
        sha256,
        balhVersion,
        browser: {
            label: launched.label,
            version: browserVersion,
        },
        orders: results.map(result => ({
            order: result.order.join('->'),
            fetchHost: result.fetch.host,
            xhrHost: result.xhr.host,
            stage3Fetch: result.stage3.fetch,
            stage3Xhr: result.stage3.xhr,
        })),
    }
    console.log(`COMPAT_SUMMARY ${JSON.stringify(summary)}`)
}

function parseArgs(args) {
    let expectVersion
    let expectSha256
    let help = false

    for (let index = 0; index < args.length; index++) {
        const arg = args[index]
        if (arg === '--help' || arg === '-h') {
            help = true
            continue
        }
        if (arg === '--expect-version') {
            if (expectVersion !== undefined) {
                throw new Error('--expect-version may only be provided once')
            }
            const value = args[++index]
            if (!value || value.startsWith('--')) {
                throw new Error('Missing value for --expect-version')
            }
            expectVersion = value
            continue
        }
        if (arg.startsWith('--expect-version=')) {
            if (expectVersion !== undefined) {
                throw new Error('--expect-version may only be provided once')
            }
            expectVersion = arg.slice('--expect-version='.length)
            if (!expectVersion) {
                throw new Error('Missing value for --expect-version')
            }
            continue
        }
        if (arg === '--expect-sha256') {
            if (expectSha256 !== undefined) {
                throw new Error('--expect-sha256 may only be provided once')
            }
            const value = args[++index]
            if (!value || value.startsWith('--')) {
                throw new Error('Missing value for --expect-sha256')
            }
            expectSha256 = normalizeExpectedSha256(value)
            continue
        }
        if (arg.startsWith('--expect-sha256=')) {
            if (expectSha256 !== undefined) {
                throw new Error('--expect-sha256 may only be provided once')
            }
            expectSha256 = normalizeExpectedSha256(arg.slice('--expect-sha256='.length))
            continue
        }
        throw new Error(`Unknown argument: ${arg}`)
    }

    if (!help && (expectVersion === undefined || expectSha256 === undefined)) {
        throw new Error('--expect-version and --expect-sha256 are both required before executing third-party userscript bytes')
    }

    return { expectVersion, expectSha256, help }
}

function normalizeExpectedSha256(value) {
    if (!/^[0-9a-fA-F]{64}$/.test(value)) {
        throw new Error('--expect-sha256 must be exactly 64 hexadecimal characters')
    }
    return value.toLowerCase()
}

function printUsage() {
    console.log(`Usage: node scripts/test-cdn-switcher-latest.mjs [options]

Downloads the latest Bilibili Video CDN Switcher into ignored .codex-tmp storage,
builds the current BALH userscript, and checks both hook load orders in Playwright.

Options:
  --expect-version <version>  Required. Fail before browser execution when @version differs.
  --expect-sha256 <hex>       Required. Fail before browser execution when source bytes differ.
  -h, --help                  Show this help.

Browser overrides:
  BALH_CDN_COMPAT_BROWSER_PATH     Exact Chromium-family executable path.
  BALH_CDN_COMPAT_BROWSER_CHANNEL  Playwright channel such as chrome-beta.`)
}

async function downloadUserscript(url) {
    if (typeof fetch !== 'function') {
        throw new Error('This compatibility test requires a Node.js runtime with global fetch support')
    }

    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
        timedOut = true
        controller.abort(new Error('download timeout'))
    }, downloadTimeoutMs)
    let response
    try {
        response = await fetch(url, {
            redirect: 'follow',
            cache: 'no-store',
            headers: {
                accept: 'text/javascript, application/javascript, text/plain;q=0.9, */*;q=0.1',
                'user-agent': 'bilibili-helper-cdn-compat-test',
            },
            signal: controller.signal,
        })
        if (!response.ok) {
            throw new Error(`Download returned HTTP ${response.status} ${response.statusText}`)
        }
        if (!response.body) {
            throw new Error('Download returned an empty response body')
        }

        const declaredLength = Number(response.headers.get('content-length'))
        if (Number.isFinite(declaredLength) && declaredLength > downloadByteLimit) {
            throw new Error(`Download declared ${declaredLength} bytes, above the ${downloadByteLimit}-byte safety limit`)
        }

        const chunks = []
        let byteLength = 0
        for await (const chunk of response.body) {
            const bytes = Buffer.from(chunk)
            byteLength += bytes.length
            if (byteLength > downloadByteLimit) {
                controller.abort(new Error('download byte limit exceeded'))
                throw new Error(`Download exceeded the ${downloadByteLimit}-byte safety limit`)
            }
            chunks.push(bytes)
        }

        const bytes = Buffer.concat(chunks, byteLength)
        if (bytes.length === 0) {
            throw new Error('Download returned zero bytes')
        }

        let source
        try {
            source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        } catch (error) {
            throw new Error('Downloaded userscript is not valid UTF-8', { cause: error })
        }
        if (!source.includes('// ==UserScript==') || !source.includes('// ==/UserScript==')) {
            throw new Error('Downloaded response does not contain a userscript metadata block')
        }

        return { bytes, source, finalUrl: response.url }
    } catch (error) {
        if (!controller.signal.aborted) {
            controller.abort(error)
        }
        if (timedOut) {
            throw new Error(`Timed out downloading CDN Switcher after ${downloadTimeoutMs} ms from ${url}`, { cause: error })
        }
        throw new Error(`Unable to download CDN Switcher from ${url}: ${error.message}`, { cause: error })
    } finally {
        clearTimeout(timer)
    }
}

function readMetadataField(source, field, label) {
    const metadata = source.match(/^\/\/ ==UserScript==\r?\n([\s\S]*?)^\/\/ ==\/UserScript==\s*$/m)
    if (!metadata) {
        throw new Error(`${label} userscript metadata block is missing or malformed`)
    }

    const values = metadata[1]
        .split(/\r?\n/)
        .map(line => line.match(/^\/\/\s*@([^\s]+)\s+(.+?)\s*$/))
        .filter(match => match?.[1] === field)
        .map(match => match[2])

    if (values.length !== 1) {
        throw new Error(`${label} metadata must contain exactly one @${field}; found ${values.length}`)
    }
    return values[0]
}

async function buildAndReadBalh() {
    try {
        const result = await execFileAsync(process.execPath, [
            buildScriptPath,
            '--build-id',
            'cdn-switcher-compat',
        ], {
            cwd: rootDir,
            timeout: buildTimeoutMs,
            maxBuffer: buildOutputByteLimit,
            windowsHide: true,
        })
        const output = [result.stdout, result.stderr]
            .map(value => value.trim())
            .filter(Boolean)
            .join('\n')
        if (output) {
            console.log(`[cdn-switcher-compat] Build: ${clip(output, 2_000)}`)
        }
    } catch (error) {
        const output = [error.stdout, error.stderr]
            .filter(Boolean)
            .join('\n')
        throw new Error([
            `BALH build failed or exceeded its ${buildTimeoutMs}-ms/${buildOutputByteLimit}-byte limits.`,
            clip(output, 4_000),
        ].filter(Boolean).join('\n'), { cause: error })
    }

    try {
        return await readFile(balhPath, 'utf8')
    } catch (error) {
        throw new Error(`BALH build did not produce ${balhPath}`, { cause: error })
    }
}

async function launchPreferredBrowser() {
    const executablePath = process.env.BALH_CDN_COMPAT_BROWSER_PATH?.trim()
    const channel = process.env.BALH_CDN_COMPAT_BROWSER_CHANNEL?.trim()
    if (executablePath && channel) {
        throw new Error('Set only one of BALH_CDN_COMPAT_BROWSER_PATH or BALH_CDN_COMPAT_BROWSER_CHANNEL')
    }

    if (executablePath) {
        try {
            await access(executablePath, fsConstants.X_OK)
        } catch (error) {
            throw new Error(`BALH_CDN_COMPAT_BROWSER_PATH is not executable: ${executablePath}`, { cause: error })
        }
        return launchBrowserAttempt(`executable:${executablePath}`, { executablePath })
    }

    if (channel) {
        return launchBrowserAttempt(`channel:${channel}`, { channel })
    }

    const failures = []
    for (const attempt of [
        { label: 'channel:chrome', launchOptions: { channel: 'chrome' } },
        { label: 'playwright:chromium', launchOptions: {} },
    ]) {
        try {
            return await launchBrowserAttempt(attempt.label, attempt.launchOptions)
        } catch (error) {
            failures.push(`${attempt.label}: ${firstLine(error.message)}`)
        }
    }

    throw new Error([
        'Unable to launch installed Chrome or Playwright Chromium.',
        ...failures.map(failure => `- ${failure}`),
        'Install a Playwright browser or set BALH_CDN_COMPAT_BROWSER_PATH / BALH_CDN_COMPAT_BROWSER_CHANNEL.',
    ].join('\n'))
}

async function launchBrowserAttempt(label, launchOptions) {
    try {
        const browser = await chromium.launch({
            ...launchOptions,
            headless: true,
            timeout: browserLaunchTimeoutMs,
        })
        return { browser, label }
    } catch (error) {
        throw new Error(`Browser launch failed for ${label}: ${error.message}`, { cause: error })
    }
}

async function exerciseOrder({ browser, order, balhSource, balhVersion, cdnSource }) {
    const consoleMessages = []
    const pageErrors = []
    const controlledRequests = []
    const mediaRequests = []
    const cdnProbeRequests = []
    const cdnProbeFailures = []
    const mediaRequestFailures = []
    const mediaRouteErrors = []
    const unexpectedRequests = []
    const unexpectedWebSockets = []
    const heldMediaRelease = createDeferred()
    let cdnProbeRequestCount = 0
    let cdnProbeFailureCount = 0
    let mediaRequestOverflow = 0
    let stage3RequestViolationCount = 0
    let unexpectedRequestViolationCount = 0
    const allowlistedBackgroundPlayUrlCounts = { fetch: 0, xhr: 0 }
    let sensitiveConsoleMessageCount = 0
    let heldMediaReleased = false
    const releaseHeldMedia = () => {
        if (heldMediaReleased) return
        heldMediaReleased = true
        heldMediaRelease.resolve()
    }
    let context
    let evaluation
    let executionError
    try {
        evaluation = await withHostTimeout((async () => {
            context = await browser.newContext({
                acceptDownloads: false,
                locale: 'en-US',
                serviceWorkers: 'block',
            })
            await context.addCookies([{
                name: 'balh_server_custom',
                value: 'https://proxy.compat.invalid',
                url: 'https://www.bilibili.com',
            }, {
                name: 'balh_cdn_mode',
                value: 'auto',
                url: 'https://www.bilibili.com',
            }])

            await context.route('**/*', async route => {
                const request = route.request()
                const url = request.url()
                if (request.method() === 'GET' && request.resourceType() === 'document' && url === pageUrl) {
                    await route.fulfill({
                        status: 200,
                        contentType: 'text/html; charset=utf-8',
                        body: createPageHtml(),
                    })
                    return
                }
                if (request.method() === 'GET' && url === playUrlApi) {
                    const accept = request.headers().accept
                    const responseScope = accept === 'application/vnd.balh-compat.fetch+json'
                        ? 'fetch'
                        : accept === 'application/vnd.balh-compat.xhr+json'
                            ? 'xhr'
                            : 'unknown'
                    pushBounded(controlledRequests, {
                        method: request.method(),
                        resourceType: request.resourceType(),
                        accept,
                    }, 10)
                    await route.fulfill({
                        status: 200,
                        contentType: 'application/json; charset=utf-8',
                        headers: {
                            'access-control-allow-origin': 'https://www.bilibili.com',
                            'access-control-expose-headers': 'x-compat-origin',
                            'x-compat-origin': 'controlled',
                        },
                        body: JSON.stringify(createPlayUrlResponse(responseScope)),
                    })
                    return
                }

                const mediaCandidate = findStage3Candidate(url)
                const rawMediaCandidate = findRawStage3Candidate(url)
                const requestCandidate = mediaCandidate ?? rawMediaCandidate
                if (request.method() === 'GET' && requestCandidate) {
                    const accept = request.headers().accept ?? null
                    const controlledAccept = `application/vnd.balh-stage3.${requestCandidate.transport}+octet-stream`
                    if (accept !== controlledAccept) {
                        cdnProbeRequestCount += 1
                        pushBounded(cdnProbeRequests, {
                            groupTransport: requestCandidate.transport,
                            candidate: requestCandidate.position,
                            requestTransport: request.resourceType(),
                            accept,
                            postCdnCandidate: Boolean(mediaCandidate),
                        }, 20)
                        try {
                            await route.fulfill({
                                status: 200,
                                contentType: 'application/octet-stream',
                                headers: {
                                    'access-control-allow-origin': 'https://www.bilibili.com',
                                    'cache-control': 'no-store',
                                },
                                body: 'cdn-probe-response',
                            })
                        } catch (error) {
                            cdnProbeFailureCount += 1
                            pushBounded(cdnProbeFailures, {
                                groupTransport: requestCandidate.transport,
                                candidate: requestCandidate.position,
                                requestTransport: request.resourceType(),
                                operation: 'fulfill',
                                reason: firstLine(sanitizeDiagnosticText(error?.message)),
                            }, 20)
                        }
                        return
                    }
                    if (!mediaCandidate) {
                        stage3RequestViolationCount += 1
                        await route.abort('blockedbyclient')
                        return
                    }
                    const previousCount = mediaRequests.filter(item => (
                        item.transport === mediaCandidate.transport
                    )).length
                    const record = {
                        transport: mediaCandidate.transport,
                        candidate: mediaCandidate.position,
                        ordinal: previousCount + 1,
                        observedAt: Date.now(),
                        resourceType: request.resourceType(),
                        accept: request.headers().accept ?? null,
                        held: mediaCandidate.position === 'primary' && previousCount === 0,
                    }
                    if (mediaRequests.length < 20) mediaRequests.push(record)
                    else mediaRequestOverflow += 1

                    try {
                        if (record.held) await heldMediaRelease.promise
                        await route.fulfill({
                            status: 200,
                            contentType: 'application/octet-stream',
                            headers: {
                                'access-control-allow-origin': 'https://www.bilibili.com',
                                'access-control-expose-headers': 'x-compat-media-candidate',
                                'cache-control': 'no-store',
                                'x-compat-media-candidate': `${mediaCandidate.transport}-${mediaCandidate.position}`,
                            },
                            body: `${mediaCandidate.transport}-${mediaCandidate.position}`,
                        })
                    } catch (error) {
                        pushBounded(mediaRouteErrors, {
                            transport: mediaCandidate.transport,
                            candidate: mediaCandidate.position,
                            operation: 'fulfill',
                            error: firstLine(sanitizeDiagnosticText(error?.message)),
                        }, 10)
                        throw error
                    }
                    return
                }

                const accept = request.headers().accept ?? null
                const resourceType = request.resourceType()
                const unexpectedEvidence = classifyUnexpectedRequest({
                    method: request.method(),
                    value: url,
                    resourceType,
                    accept,
                    controlledRequestCount: controlledRequests.length,
                })
                if (unexpectedEvidence.allowlistedBackgroundPlayUrl) {
                    allowlistedBackgroundPlayUrlCounts[resourceType] += 1
                    if (allowlistedBackgroundPlayUrlCounts[resourceType] > 1) {
                        unexpectedEvidence.violation = 'duplicate-allowlisted-background-playurl'
                    }
                }
                pushBounded(unexpectedRequests, {
                    method: request.method(),
                    resourceType,
                    host: safeHostname(url),
                    accept,
                    acceptTransport: accept === 'application/vnd.balh-compat.fetch+json'
                        ? 'fetch'
                        : accept === 'application/vnd.balh-compat.xhr+json'
                            ? 'xhr'
                            : null,
                    controlledRequestCount: controlledRequests.length,
                    ...unexpectedEvidence,
                }, 20)
                if (unexpectedEvidence.violation) {
                    unexpectedRequestViolationCount += 1
                }
                await route.abort('blockedbyclient')
            })
            await context.routeWebSocket(/.*/, async websocket => {
                pushBounded(unexpectedWebSockets, safeHostname(websocket.url()), 20)
                await websocket.close({ code: 1008, reason: 'Blocked by compatibility harness' })
            })

            const page = await context.newPage()
            page.setDefaultTimeout(requestTimeoutMs)
            page.setDefaultNavigationTimeout(navigationTimeoutMs)
            page.on('console', message => {
                const text = message.text()
                if (containsSensitiveMediaValue(text)) sensitiveConsoleMessageCount += 1
                pushBounded(consoleMessages, {
                    type: message.type(),
                    text: clip(sanitizeDiagnosticText(text), 600),
                }, 40)
            })
            page.on('pageerror', error => pushBounded(
                pageErrors,
                clip(sanitizeDiagnosticText(error.stack || String(error)), 2_000),
                10,
            ))
            page.on('requestfailed', request => {
                const candidate = findStage3Candidate(request.url())
                if (!candidate) return
                const accept = request.headers().accept ?? null
                if (accept !== `application/vnd.balh-stage3.${candidate.transport}+octet-stream`) {
                    cdnProbeFailureCount += 1
                    pushBounded(cdnProbeFailures, {
                        groupTransport: candidate.transport,
                        candidate: candidate.position,
                        requestTransport: request.resourceType(),
                        operation: 'requestfailed',
                        reason: firstLine(sanitizeDiagnosticText(request.failure()?.errorText)),
                    }, 20)
                    return
                }
                pushBounded(mediaRequestFailures, {
                    transport: candidate.transport,
                    candidate: candidate.position,
                    reason: firstLine(sanitizeDiagnosticText(request.failure()?.errorText)),
                }, 10)
            })

            await page.addInitScript(createHarnessBootstrap, {
                order,
                sources: { balh: balhSource, cdn: cdnSource },
                balhVersion,
                expectedCdnHost,
                sensitiveFragments: [
                    stage3MediaToken,
                    ...stage3Candidates.map(candidate => candidate.url),
                ],
            })

            await page.goto(pageUrl, { waitUntil: 'domcontentloaded' })
            const initialEvaluation = await page.evaluate(async ({
                playUrlApi,
                requestTimeoutMs,
                stage3HeldRequestTimeoutMs,
                expectedMediaToken,
                expectedStage3Candidates,
            }) => {
                function inspectResponseBody(body) {
                    const video = body?.result?.dash?.video?.find(item => item?.id === 81)
                    const mediaUrl = video?.baseUrl || video?.base_url
                    let parsed
                    try {
                        parsed = new URL(mediaUrl)
                    } catch {
                        parsed = null
                    }
                    return {
                        code: body?.code,
                        hasDash: Array.isArray(body?.result?.dash?.video),
                        mediaHost: parsed?.hostname ?? null,
                        mediaPath: parsed?.pathname ?? null,
                        mediaTokenMatches: parsed?.searchParams.get('compat_token') === expectedMediaToken,
                    }
                }

                function readCandidatePair(stream) {
                    const primary = stream?.baseUrl || stream?.base_url
                    const backups = stream?.backupUrl || stream?.backup_url
                    return typeof primary === 'string' && Array.isArray(backups)
                        && typeof backups[0] === 'string'
                        ? [primary, backups[0]]
                        : []
                }

                function readStage3CandidateUrls(body) {
                    const dash = body?.result?.dash
                    const video = Array.isArray(dash?.video)
                        ? dash.video.find(item => item?.id === 80)
                        : undefined
                    const audio = Array.isArray(dash?.audio)
                        ? dash.audio.find(item => item?.id === 30280)
                        : undefined
                    return {
                        fetch: readCandidatePair(video),
                        xhr: readCandidatePair(audio),
                    }
                }

                function readPublishedGroupKinds() {
                    try {
                        const status = window.bangumi_area_limit_hack?.getCdnRecoveryStatus?.()
                        return Array.isArray(status?.groups)
                            ? status.groups
                                .filter(group => group.candidateCount >= 2)
                                .map(group => group.kind)
                                .sort()
                            : []
                    } catch {
                        return []
                    }
                }

                function installStage3Fixture(state, candidateUrls) {
                    const video = document.getElementById('compat-stage3-video')
                    if (!(video instanceof HTMLVideoElement)) {
                        throw new Error('Stage3 video fixture is missing')
                    }

                    const playback = {
                        paused: false,
                        seeking: false,
                        ended: false,
                        currentTime: 10,
                        duration: 60,
                        bufferAhead: 4,
                        advancing: false,
                        advancingFrom: 10,
                        advancingStartedAt: 0,
                        lowBufferTriggeredAt: null,
                    }
                    const readCurrentTime = () => playback.advancing
                        ? playback.advancingFrom + (performance.now() - playback.advancingStartedAt) / 1_000
                        : playback.currentTime
                    Object.defineProperties(video, {
                        paused: { configurable: true, get: () => playback.paused },
                        seeking: { configurable: true, get: () => playback.seeking },
                        ended: { configurable: true, get: () => playback.ended },
                        currentTime: { configurable: true, get: readCurrentTime },
                        duration: { configurable: true, get: () => playback.duration },
                        buffered: {
                            configurable: true,
                            get: () => ({
                                length: 1,
                                start: index => {
                                    if (index !== 0) throw new DOMException('IndexSizeError', 'IndexSizeError')
                                    return 0
                                },
                                end: index => {
                                    if (index !== 0) throw new DOMException('IndexSizeError', 'IndexSizeError')
                                    return readCurrentTime() + playback.bufferAhead
                                },
                            }),
                        },
                    })

                    state.stage3CandidateUrls = candidateUrls
                    state.stage3Runs = Object.create(null)
                    state.triggerStage3LowBuffer = () => {
                        playback.paused = false
                        playback.seeking = false
                        playback.ended = false
                        playback.currentTime = readCurrentTime()
                        playback.advancing = false
                        playback.bufferAhead = 0.1
                        playback.lowBufferTriggeredAt = Date.now()
                        video.dispatchEvent(new Event('waiting', { bubbles: true }))
                        return playback.lowBufferTriggeredAt
                    }
                    state.startStage3HealthyPlayback = () => {
                        playback.paused = false
                        playback.seeking = false
                        playback.ended = false
                        playback.advancingFrom = readCurrentTime()
                        playback.advancingStartedAt = performance.now()
                        playback.advancing = true
                        playback.bufferAhead = 4
                        video.dispatchEvent(new Event('playing', { bubbles: true }))
                    }
                    state.snapshotStage3Run = phase => {
                        const run = state.stage3Runs[phase]
                        if (!run) return null
                        return Object.fromEntries(['fetch', 'xhr'].map(transport => {
                            const result = run[transport]
                            return [transport, result ? {
                                settled: result.settled,
                                status: result.status ?? null,
                                candidate: result.candidate ?? null,
                                bodyMatchesCandidate: result.bodyMatchesCandidate === true,
                                transportError: result.transportError ?? null,
                                abortCount: result.abortCount,
                                signalAborted: result.signalAborted === true,
                                predecessorStartedAt: result.predecessorStartedAt ?? null,
                            } : null]
                        }))
                    }

                    const startRequest = (transport, phase) => {
                        const url = state.stage3CandidateUrls[transport]?.[0]
                        if (typeof url !== 'string') throw new Error('Stage3 candidate pair is unavailable')
                        const result = {
                            settled: false,
                            abortCount: 0,
                            signalAborted: false,
                        }
                        state.stage3Runs[phase][transport] = result
                        const accept = `application/vnd.balh-stage3.${transport}+octet-stream`

                        if (transport === 'fetch') {
                            const controller = new AbortController()
                            const request = new Request(url, { headers: { accept }, signal: controller.signal })
                            result.predecessorStartedAt = Date.now()
                            return fetch(request)
                                .then(async response => {
                                    const candidate = response.headers.get('x-compat-media-candidate')
                                    const body = await response.text()
                                    Object.assign(result, {
                                        status: response.status,
                                        candidate,
                                        bodyMatchesCandidate: body === candidate,
                                    })
                                }, error => {
                                    result.transportError = error?.name || 'fetch-error'
                                })
                                .finally(() => {
                                    result.signalAborted = controller.signal.aborted
                                    result.settled = true
                                })
                        }

                        return new Promise(resolve => {
                            const xhr = new XMLHttpRequest()
                            let settled = false
                            const finish = value => {
                                if (settled) return
                                settled = true
                                Object.assign(result, value, { settled: true })
                                resolve()
                            }
                            xhr.timeout = stage3HeldRequestTimeoutMs
                            xhr.onreadystatechange = () => {
                                if (xhr.readyState !== 4) return
                                const candidate = xhr.getResponseHeader('x-compat-media-candidate')
                                finish({
                                    status: xhr.status,
                                    candidate,
                                    bodyMatchesCandidate: xhr.responseText === candidate,
                                })
                            }
                            xhr.onerror = () => finish({ transportError: 'xhr-error', status: xhr.status })
                            xhr.ontimeout = () => finish({ transportError: 'xhr-timeout', status: xhr.status })
                            xhr.onabort = () => {
                                result.abortCount += 1
                                finish({ transportError: 'xhr-abort', status: xhr.status })
                            }
                            result.predecessorStartedAt = Date.now()
                            xhr.open('GET', url, true)
                            xhr.setRequestHeader('accept', accept)
                            xhr.send()
                        })
                    }

                    state.startStage3Pair = phase => {
                        if (state.stage3Runs[phase]) throw new Error('Stage3 phase already started')
                        state.stage3Runs[phase] = Object.create(null)
                        return Promise.all([
                            startRequest('fetch', phase),
                            startRequest('xhr', phase),
                        ])
                    }
                }

                const fetchController = new AbortController()
                const fetchTimer = setTimeout(() => fetchController.abort(), requestTimeoutMs)
                let fetchResult
                let fetchBody
                let fetchPublicationKinds
                try {
                    const request = new Request(playUrlApi, {
                        headers: { accept: 'application/vnd.balh-compat.fetch+json' },
                    })
                    const response = await fetch(request, { signal: fetchController.signal })
                    const text = await response.text()
                    let body
                    let parseError
                    try {
                        body = JSON.parse(text)
                        fetchBody = body
                    } catch (error) {
                        parseError = String(error)
                    }
                    fetchResult = {
                        status: response.status,
                        ok: response.ok,
                        originHeader: response.headers.get('x-compat-origin'),
                        textLength: text.length,
                        parseError,
                        ...inspectResponseBody(body),
                    }
                    fetchPublicationKinds = readPublishedGroupKinds()
                } finally {
                    clearTimeout(fetchTimer)
                }

                let xhrBody
                const xhrResult = await new Promise(resolve => {
                    const xhr = new XMLHttpRequest()
                    let settled = false
                    const finish = value => {
                        if (settled) return
                        settled = true
                        resolve(value)
                    }
                    xhr.timeout = requestTimeoutMs
                    xhr.onreadystatechange = () => {
                        if (xhr.readyState !== 4) return
                        let text
                        let body
                        let parseError
                        try {
                            text = xhr.responseText
                            body = JSON.parse(text)
                            xhrBody = body
                        } catch (error) {
                            parseError = String(error)
                        }
                        finish({
                            status: xhr.status,
                            originHeader: xhr.getResponseHeader('x-compat-origin'),
                            textLength: typeof text === 'string' ? text.length : null,
                            parseError,
                            ...inspectResponseBody(body),
                        })
                    }
                    xhr.onerror = () => finish({ transportError: 'error', status: xhr.status })
                    xhr.ontimeout = () => finish({ transportError: 'timeout', status: xhr.status })
                    xhr.onabort = () => finish({ transportError: 'abort', status: xhr.status })
                    xhr.open('GET', playUrlApi)
                    xhr.setRequestHeader('accept', 'application/vnd.balh-compat.xhr+json')
                    xhr.send()
                })
                const xhrPublicationKinds = readPublishedGroupKinds()

                const state = window.__cdnSwitcherCompatState
                const fetchCandidates = readStage3CandidateUrls(fetchBody)
                const xhrCandidates = readStage3CandidateUrls(xhrBody)
                const finalCandidates = {
                    fetch: fetchCandidates.fetch,
                    xhr: xhrCandidates.xhr,
                }
                const expectedByTransport = Object.fromEntries(['fetch', 'xhr'].map(transport => [
                    transport,
                    expectedStage3Candidates
                        .filter(candidate => candidate.transport === transport)
                        .map(candidate => candidate.url),
                ]))
                const candidatesMatchExpected = JSON.stringify(finalCandidates) === JSON.stringify(expectedByTransport)
                installStage3Fixture(state, finalCandidates)
                const recoveryApi = window.bangumi_area_limit_hack?.getCdnRecoveryStatus
                let recoveryStatus
                let recoveryStatusError
                try {
                    recoveryStatus = typeof recoveryApi === 'function' ? recoveryApi() : null
                } catch (error) {
                    recoveryStatusError = error?.name || 'status-error'
                }
                return {
                    fetchResult,
                    xhrResult,
                    stage3Setup: {
                        fetchResponseScoped: fetchCandidates.fetch.length === 2
                            && fetchCandidates.xhr.length === 0,
                        xhrResponseIntroducedAudio: xhrCandidates.fetch.length === 2
                            && xhrCandidates.xhr.length === 2,
                        fetchPublicationKinds,
                        xhrPublicationKinds,
                        candidatesMatchExpected,
                        candidateCounts: {
                            fetch: finalCandidates.fetch.length,
                            xhr: finalCandidates.xhr.length,
                        },
                        hasRecoveryStatusApi: typeof recoveryApi === 'function',
                        recoveryStatusError,
                        recoveryStatus,
                        documentVisibility: document.visibilityState,
                    },
                    state: {
                        stages: state?.stages,
                        scriptErrors: state?.scriptErrors,
                        gmReads: state?.gmReads,
                        gmWrites: state?.gmWrites,
                        gmMenus: state?.gmMenus,
                        hasBalhApi: typeof window.bangumi_area_limit_hack === 'object',
                        hasCdnRecoveryStatus: typeof recoveryApi === 'function',
                    },
                }
            }, {
                playUrlApi,
                requestTimeoutMs,
                stage3HeldRequestTimeoutMs,
                expectedMediaToken: mediaToken,
                expectedStage3Candidates: stage3Candidates.map(candidate => ({
                    transport: candidate.transport,
                    position: candidate.position,
                    url: candidate.url,
                })),
            })
            const stage3 = await exerciseStage3Compatibility({
                page,
                initialEvaluation,
                mediaRequests,
                mediaRequestFailures,
                mediaRouteErrors,
                releaseHeldMedia,
                getCdnProbeRequestCount: () => cdnProbeRequestCount,
                getCdnProbeFailureCount: () => cdnProbeFailureCount,
                getMediaRequestOverflow: () => mediaRequestOverflow,
                getStage3RequestViolationCount: () => stage3RequestViolationCount,
                getSensitiveConsoleMessageCount: () => sensitiveConsoleMessageCount,
            })
            return { ...initialEvaluation, stage3 }
        })(), orderTimeoutMs, () => {
            releaseHeldMedia()
            return context?.close()
        }, `order ${order.join('->')}`)
    } catch (error) {
        executionError = error
    }

    releaseHeldMedia()
    const contextCloseError = context
        ? await closeWithDeadline(
            () => context.close(),
            cleanupTimeoutMs,
            `context cleanup for ${order.join('->')}`,
        )
        : undefined
    if (contextCloseError) {
        pushBounded(pageErrors, formatError(contextCloseError), 10)
    }

    const diagnostics = {
        evaluation,
        pageErrors,
        controlledRequests,
        mediaRequests,
        cdnProbeRequests,
        cdnProbeFailures,
        cdnProbeRequestCount,
        cdnProbeFailureCount,
        mediaRequestFailures,
        mediaRouteErrors,
        mediaRequestOverflow,
        stage3RequestViolationCount,
        unexpectedRequestViolationCount,
        allowlistedBackgroundPlayUrlCounts,
        sensitiveConsoleMessageCount,
        unexpectedRequests,
        unexpectedWebSockets,
        consoleMessages,
    }
    if (executionError) {
        throw orderFailure(order, `browser execution failed: ${executionError.message}`, diagnostics, executionError)
    }
    assertOrderResult(order, evaluation, pageErrors, controlledRequests, diagnostics)

    return {
        order,
        fetch: inspectMediaResult(order, 'Fetch', evaluation.fetchResult, diagnostics),
        xhr: inspectMediaResult(order, 'XHR', evaluation.xhrResult, diagnostics),
        stage3: evaluation.stage3,
    }
}

async function exerciseStage3Compatibility({
    page,
    initialEvaluation,
    mediaRequests,
    mediaRequestFailures,
    mediaRouteErrors,
    releaseHeldMedia,
    getCdnProbeRequestCount,
    getCdnProbeFailureCount,
    getMediaRequestOverflow,
    getStage3RequestViolationCount,
    getSensitiveConsoleMessageCount,
}) {
    const setup = initialEvaluation?.stage3Setup
    assertCompat(setup, 'Stage3 setup result is missing')
    assertCompat(setup.hasRecoveryStatusApi, 'Stage3 recovery status API is unavailable')
    assertCompat(!setup.recoveryStatusError, 'Stage3 recovery status API threw during setup')
    assertCompat(setup.documentVisibility === 'visible', 'controlled document is not visible')
    assertCompat(setup.fetchResponseScoped,
        'Fetch playurl response did not isolate its unique Stage3 video publication')
    assertCompat(setup.xhrResponseIntroducedAudio,
        'XHR playurl response did not introduce its unique Stage3 audio publication')
    assertCompat(JSON.stringify(setup.fetchPublicationKinds) === JSON.stringify(['dash-video']),
        'Fetch response did not independently publish exactly its Stage3 video group')
    assertCompat(JSON.stringify(setup.xhrPublicationKinds) === JSON.stringify(['dash-audio', 'dash-video']),
        'XHR response did not independently publish the Stage3 audio group and final combined registry')
    assertCompat(setup.candidatesMatchExpected, 'CDN hook chain changed the controlled Stage3 candidate pairs')
    assertCompat(setup.candidateCounts?.fetch === 2 && setup.candidateCounts?.xhr === 2,
        'controlled Stage3 playurl groups must each contain exactly two candidates')

    const publishedStatus = setup.recoveryStatus
    assertCompat(publishedStatus?.enabled === true, 'Stage3 recovery was not enabled in auto mode')
    assertCompat(publishedStatus.activeGroupCount === 0, 'Stage3 groups activated before a media request')
    assertCompat(findRecoveryGroup(publishedStatus, 'dash-video')?.candidateCount === 2,
        'Stage3 video group was not published with two exact candidates')
    assertCompat(findRecoveryGroup(publishedStatus, 'dash-audio')?.candidateCount === 2,
        'Stage3 audio group was not published with two exact candidates')

    const probeBaseline = await waitForCdnProbeBaseline(
        page,
        getCdnProbeRequestCount,
        getCdnProbeFailureCount,
    )
    const assertProbeBaseline = () => {
        assertCompat(getCdnProbeRequestCount() === probeBaseline.requestCount
            && getCdnProbeFailureCount() === probeBaseline.failureCount,
        'a probe-shaped candidate request started after the Stage3 baseline')
    }

    await page.evaluate(() => {
        const state = window.__cdnSwitcherCompatState
        state.stage3RunPromises = Object.create(null)
        state.stage3RunPromises.current = state.startStage3Pair('current')
    })
    await waitForCondition(
        () => mediaRequests.length >= 2,
        requestTimeoutMs,
        'current Fetch/XHR media requests did not reach their predecessors',
    )
    assertMediaRequestSequence(mediaRequests, {
        fetch: ['primary'],
        xhr: ['primary'],
    })
    assertCompat(mediaRequests.every(request => request.held === true),
        'a current media request was not held at its original predecessor')
    assertProbeBaseline()

    const monitoringStatus = await waitForRecoveryState(page, 'monitoring')
    assertRecoveryGroups(monitoringStatus, {
        state: 'monitoring',
        candidateIndex: 0,
        pendingCandidateIndex: null,
        attemptedCount: 1,
        switchAttempts: 0,
        timerPending: false,
    })
    const routeRevisionBeforeIntentByKind = Object.fromEntries(
        activeRecoveryGroups(monitoringStatus).map(group => [group.kind, group.routeRevision]),
    )
    const lowBufferStartedAt = await page.evaluate(({ graceProbeDelayMs }) => {
        const state = window.__cdnSwitcherCompatState
        state.traceStage3RecoveryTimers = true
        const startedAt = state.triggerStage3LowBuffer()
        state.stage3RunPromises.grace = new Promise((resolve, reject) => {
            setTimeout(() => {
                Promise.resolve()
                    .then(() => state.startStage3Pair('grace'))
                    .then(resolve, reject)
            }, graceProbeDelayMs)
        })
        return startedAt
    }, { graceProbeDelayMs: stage3GraceProbeDelayMs })
    const confirmingStatus = await waitForRecoveryState(page, 'confirming')
    assertRecoveryGroups(confirmingStatus, {
        state: 'confirming',
        candidateIndex: 0,
        pendingCandidateIndex: null,
        attemptedCount: 1,
        switchAttempts: 0,
        timerPending: true,
    })

    await page.waitForTimeout(stage3EarlyGraceCheckMs)
    const earlyStatus = await readRecoveryStatus(page)
    assertRecoveryGroups(earlyStatus, {
        state: 'confirming',
        candidateIndex: 0,
        pendingCandidateIndex: null,
        attemptedCount: 1,
        switchAttempts: 0,
        timerPending: true,
    })
    const currentDuringGrace = await readStage3Run(page, 'current')
    assertRunPending(currentDuringGrace, 'current request during grace')
    assertCompat(mediaRequests.length === 2,
        'a current request was reopened or a future request started before grace expired')
    assertTransportHealth(
        mediaRequestFailures,
        mediaRouteErrors,
        getMediaRequestOverflow(),
        getStage3RequestViolationCount(),
    )
    assertProbeBaseline()

    const graceResult = await page.evaluate(async () => {
        const state = window.__cdnSwitcherCompatState
        await state.stage3RunPromises.grace
        return state.snapshotStage3Run('grace')
    })
    assertRunComplete(graceResult, {
        fetch: 'fetch-primary',
        xhr: 'xhr-primary',
    }, 'future request immediately before grace expiry')
    assertMediaRequestSequence(mediaRequests, {
        fetch: ['primary', 'primary'],
        xhr: ['primary', 'primary'],
    })
    assertRunPending(await readStage3Run(page, 'current'),
        'current request immediately before grace expiry')

    const routeIntentStatus = await waitForRecoveryState(page, 'waiting-retry')
    assertRecoveryGroups(routeIntentStatus, {
        state: 'waiting-retry',
        candidateIndex: 0,
        pendingCandidateIndex: 1,
        attemptedCount: 1,
        switchAttempts: 1,
        timerPending: false,
    })
    const routeIntentEvents = await page.evaluate(() => {
        const state = window.__cdnSwitcherCompatState
        state.traceStage3RecoveryTimers = false
        return state.stage3RouteIntentEvents.map(event => ({ ...event }))
    })
    assertCompat(routeIntentEvents.length === 2,
        `Stage3 did not record exactly two recovery route-intent events: ${JSON.stringify(routeIntentEvents)}`)
    for (const group of activeRecoveryGroups(routeIntentStatus)) {
        const event = routeIntentEvents.find(candidate => candidate.kind === group.kind)
        assertCompat(event?.fromCandidateIndex === 0 && event?.toCandidateIndex === 0
            && event?.fromPendingCandidateIndex === null
            && event?.toPendingCandidateIndex === 1,
        `Stage3 ${group.kind} route intent changed the committed candidate before a future request`)
        assertCompat(event?.fromRouteRevision === routeRevisionBeforeIntentByKind[group.kind]
            && event?.toRouteRevision === group.routeRevision
            && event.toRouteRevision === event.fromRouteRevision + 1,
        `Stage3 ${group.kind} route intent did not advance exactly one route revision`)
        assertCompat(Number.isFinite(event.routeIntentAt)
            && event.callbackStartedAt <= event.routeIntentAt
            && event.routeIntentAt <= event.callbackFinishedAt,
        `Stage3 ${group.kind} route-intent timestamp was not captured inside its recovery timer`)
        assertCompat(event.routeIntentAt - lowBufferStartedAt >= stage3GraceMs,
            `Stage3 ${group.kind} route intent was installed before the 3-second confirmation grace elapsed`)
        assertCompat(typeof group.retryAt === 'number'
            && group.retryAt - event.routeIntentAt >= stage3MinimumCooldownMs,
        `Stage3 ${group.kind} route intent did not establish the 15-second minimum cooldown`)
        const transport = group.kind === 'dash-video' ? 'fetch' : 'xhr'
        const graceRequest = mediaRequests.filter(request => request.transport === transport).at(-1)
        assertCompat(graceRequest?.candidate === 'primary'
            && Number.isFinite(graceRequest.observedAt)
            && graceRequest.observedAt < event.routeIntentAt,
        `Stage3 ${group.kind} grace probe did not reach its predecessor before the route intent`)
    }
    assertMediaRequestSequence(mediaRequests, {
        fetch: ['primary', 'primary'],
        xhr: ['primary', 'primary'],
    })
    assertRunPending(await readStage3Run(page, 'current'),
        'current request when future route intent changed')

    const futureResult = await page.evaluate(async () => {
        const state = window.__cdnSwitcherCompatState
        state.stage3RunPromises.future = state.startStage3Pair('future')
        await state.stage3RunPromises.future
        return state.snapshotStage3Run('future')
    })
    assertRunComplete(futureResult, {
        fetch: 'fetch-alternate',
        xhr: 'xhr-alternate',
    }, 'future request after recovery')
    assertMediaRequestSequence(mediaRequests, {
        fetch: ['primary', 'primary', 'alternate'],
        xhr: ['primary', 'primary', 'alternate'],
    })
    const committedStatus = await readRecoveryStatus(page)
    assertRecoveryGroups(committedStatus, {
        state: 'waiting-retry',
        candidateIndex: 1,
        pendingCandidateIndex: null,
        attemptedCount: 2,
        switchAttempts: 1,
        timerPending: false,
    })
    const retryAtByKind = {}
    for (const group of activeRecoveryGroups(committedStatus)) {
        const intentGroup = findRecoveryGroup(routeIntentStatus, group.kind)
        const transport = group.kind === 'dash-video' ? 'fetch' : 'xhr'
        const predecessorStartedAt = futureResult?.[transport]?.predecessorStartedAt
        assertCompat(group.routeRevision === intentGroup?.routeRevision,
            `Stage3 ${group.kind} predecessor commit unexpectedly changed the route revision`)
        assertCompat(typeof group.retryAt === 'number'
            && typeof intentGroup?.retryAt === 'number'
            && group.retryAt >= intentGroup.retryAt,
        `Stage3 ${group.kind} predecessor commit shortened the provisional cooldown`)
        assertCompat(Number.isFinite(predecessorStartedAt)
            && group.retryAt - predecessorStartedAt >= stage3MinimumCooldownMs,
        `Stage3 ${group.kind} predecessor commit did not retain a 15-second cooldown`)
        retryAtByKind[group.kind] = group.retryAt
    }
    assertRunPending(await readStage3Run(page, 'current'),
        'current request while future route is active')

    await page.evaluate(() => {
        window.__cdnSwitcherCompatState.triggerStage3LowBuffer()
    })
    await page.waitForTimeout(stage3CooldownCheckMs)
    const cooldownStatus = await readRecoveryStatus(page)
    assertRecoveryGroups(cooldownStatus, {
        state: 'waiting-retry',
        candidateIndex: 1,
        pendingCandidateIndex: null,
        attemptedCount: 2,
        switchAttempts: 1,
        timerPending: false,
    })

    await page.evaluate(async () => {
        const state = window.__cdnSwitcherCompatState
        state.startStage3HealthyPlayback()
        await new Promise(resolve => setTimeout(resolve, 5_500))
    })
    const stableStatus = await waitForStableRecoveryReset(page)
    assertRecoveryGroups(stableStatus, {
        state: 'waiting-retry',
        candidateIndex: 1,
        pendingCandidateIndex: null,
        attemptedCount: 1,
        switchAttempts: 0,
        timerPending: false,
    })
    assertCompat(activeRecoveryGroups(stableStatus).every(group => (
        group.retryAt === retryAtByKind[group.kind]
    )), 'stable playback shortened the existing cooldown')

    await page.evaluate(() => {
        window.__cdnSwitcherCompatState.triggerStage3LowBuffer()
    })
    await page.waitForTimeout(stage3CooldownCheckMs)
    const resumedCooldownStatus = await readRecoveryStatus(page)
    assertRecoveryGroups(resumedCooldownStatus, {
        state: 'waiting-retry',
        candidateIndex: 1,
        pendingCandidateIndex: null,
        attemptedCount: 1,
        switchAttempts: 0,
        timerPending: false,
    })
    const resumedRetryAtByKind = Object.fromEntries(activeRecoveryGroups(resumedCooldownStatus).map(group => (
        [group.kind, group.retryAt]
    )))
    assertCompat(Object.keys(retryAtByKind).every(kind => (
        resumedRetryAtByKind[kind] === retryAtByKind[kind]
    )), 'renewed low buffer changed the existing Stage3 cooldown deadline')

    const retryAtValues = Object.values(resumedRetryAtByKind)
    const earliestRetryAt = Math.min(...retryAtValues)
    const cooldownBoundary = await page.evaluate(async ({ targetTime }) => {
        const delayMs = Math.max(0, targetTime - Date.now())
        await new Promise(resolve => setTimeout(resolve, delayMs))
        return {
            sampledAt: Date.now(),
            status: window.bangumi_area_limit_hack.getCdnRecoveryStatus(),
        }
    }, { targetTime: earliestRetryAt - stage3CooldownProbeMarginMs })
    assertCompat(cooldownBoundary.sampledAt < earliestRetryAt,
        'Stage3 cooldown boundary probe ran after retry became eligible')
    assertRecoveryGroups(cooldownBoundary.status, {
        state: 'waiting-retry',
        candidateIndex: 1,
        pendingCandidateIndex: null,
        attemptedCount: 1,
        switchAttempts: 0,
        timerPending: false,
    })
    assertCompat(activeRecoveryGroups(cooldownBoundary.status).every(group => (
        group.retryAt === resumedRetryAtByKind[group.kind]
    )), 'Stage3 cooldown deadline changed before the boundary probe')
    assertRunPending(await readStage3Run(page, 'current'),
        'current request at the cooldown boundary')

    const cooldownResult = await page.evaluate(async () => {
        const state = window.__cdnSwitcherCompatState
        state.stage3RunPromises.cooldown = state.startStage3Pair('cooldown')
        await state.stage3RunPromises.cooldown
        return state.snapshotStage3Run('cooldown')
    })
    assertRunComplete(cooldownResult, {
        fetch: 'fetch-alternate',
        xhr: 'xhr-alternate',
    }, 'future request during cooldown')
    assertMediaRequestSequence(mediaRequests, {
        fetch: ['primary', 'primary', 'alternate', 'alternate'],
        xhr: ['primary', 'primary', 'alternate', 'alternate'],
    })
    const cooldownRetryAtByTransport = {
        fetch: retryAtByKind['dash-video'],
        xhr: retryAtByKind['dash-audio'],
    }
    for (const transport of ['fetch', 'xhr']) {
        const request = mediaRequests.filter(item => item.transport === transport).at(-1)
        assertCompat(request?.candidate === 'alternate'
            && Number.isFinite(request.observedAt)
            && request.observedAt < cooldownRetryAtByTransport[transport],
            `${transport.toUpperCase()} cooldown probe did not reach its predecessor before retryAt`)
    }
    assertRunPending(await readStage3Run(page, 'current'),
        'current request during cooldown')
    assertTransportHealth(
        mediaRequestFailures,
        mediaRouteErrors,
        getMediaRequestOverflow(),
        getStage3RequestViolationCount(),
    )
    assertProbeBaseline()

    releaseHeldMedia()
    await page.waitForFunction(() => {
        const run = window.__cdnSwitcherCompatState.snapshotStage3Run('current')
        return run?.fetch?.settled === true && run?.xhr?.settled === true
    }, undefined, { timeout: requestTimeoutMs })
    const currentResult = await readStage3Run(page, 'current')
    assertRunComplete(currentResult, {
        fetch: 'fetch-primary',
        xhr: 'xhr-primary',
    }, 'held current request')
    await page.waitForTimeout(50)
    assertMediaRequestSequence(mediaRequests, {
        fetch: ['primary', 'primary', 'alternate', 'alternate'],
        xhr: ['primary', 'primary', 'alternate', 'alternate'],
    })
    assertTransportHealth(
        mediaRequestFailures,
        mediaRouteErrors,
        getMediaRequestOverflow(),
        getStage3RequestViolationCount(),
    )
    assertProbeBaseline()
    const privacy = await page.evaluate(() => {
        const status = window.bangumi_area_limit_hack.getCdnRecoveryStatus()
        const storageEntries = Object.keys(localStorage).map(key => [key, localStorage.getItem(key)])
        const state = window.__cdnSwitcherCompatState
        const exactCandidateUrls = Object.values(state.stage3CandidateUrls).flat()
        const unsafe = value => {
            try {
                const serialized = JSON.stringify(value)
                return exactCandidateUrls.some(url => serialized.includes(url))
                    || serialized.includes('controlled-stage3-response')
            } catch {
                return true
            }
        }
        let publicLog
        let diagnosticReport
        let publicDiagnosticsReadable = true
        try {
            publicLog = window.bangumi_area_limit_hack.getLog()
            diagnosticReport = window.bangumi_area_limit_hack.getDiagnosticReport()
        } catch {
            publicDiagnosticsReadable = false
        }
        return {
            statusSafe: !unsafe(status),
            storageSafe: !unsafe(storageEntries),
            gmWritesSafe: !unsafe(state.gmWrites),
            publicDiagnosticsReadable,
            publicLogSafe: !unsafe(publicLog),
            diagnosticReportSafe: !unsafe(diagnosticReport),
            structuredConsoleSafe: state.sensitiveConsoleArgumentCount === 0,
            structuredConsoleComplete: state.incompleteConsoleArgumentCount === 0,
        }
    })
    assertProbeBaseline()
    assertCompat(privacy.statusSafe, 'Stage3 status exposed an exact media URL')
    assertCompat(privacy.storageSafe, 'Stage3 persisted an exact media URL')
    assertCompat(privacy.gmWritesSafe, 'Stage3 sent an exact media URL to GM storage')
    assertCompat(privacy.publicDiagnosticsReadable, 'public diagnostics could not be inspected')
    assertCompat(privacy.publicLogSafe, 'public log exposed an exact media URL')
    assertCompat(privacy.diagnosticReportSafe, 'diagnostic report exposed an exact media URL')
    assertCompat(privacy.structuredConsoleSafe, 'structured console output exposed an exact media URL')
    assertCompat(privacy.structuredConsoleComplete, 'structured console privacy scan was incomplete')
    assertCompat(getSensitiveConsoleMessageCount() === 0,
        'Stage3 emitted an exact media URL through the page console')

    return {
        fetch: mediaRequests
            .filter(request => request.transport === 'fetch')
            .map(request => request.candidate),
        xhr: mediaRequests
            .filter(request => request.transport === 'xhr')
            .map(request => request.candidate),
        graceMs: 3_000,
        cooldownHeld: true,
        currentRequestsPreserved: true,
        stablePlaybackReset: true,
    }
}

function assertRecoveryGroups(status, expected) {
    assertCompat(status?.enabled === true, 'Stage3 recovery became disabled')
    assertCompat(status.activeGroupCount === 2, 'Stage3 did not retain exactly two active groups')
    const active = activeRecoveryGroups(status)
    assertCompat(active.length === 2, 'Stage3 active group status is inconsistent')
    assertCompat(active.some(group => group.kind === 'dash-video'), 'Stage3 video group is not active')
    assertCompat(active.some(group => group.kind === 'dash-audio'), 'Stage3 audio group is not active')
    for (const group of active) {
        for (const [field, value] of Object.entries(expected)) {
            assertCompat(group[field] === value,
                `Stage3 ${group.kind} ${field} mismatch: expected ${JSON.stringify(value)}, got ${JSON.stringify(group[field])}`)
        }
    }
}

function activeRecoveryGroups(status) {
    return Array.isArray(status?.groups)
        ? status.groups.filter(group => group.state !== 'disabled' && group.state !== 'unseen')
        : []
}

function findRecoveryGroup(status, kind) {
    return status?.groups?.find(group => group.kind === kind && group.candidateCount >= 2)
}

async function waitForCdnProbeBaseline(page, getRequestCount, getFailureCount) {
    await page.waitForFunction(() => {
        const status = window.bangumi_area_limit_hack?.getCdnProbeStatus?.()
        return ['ready', 'partial', 'unprobeable', 'failed'].includes(status?.state)
            && Array.isArray(status?.candidateHosts)
            && status.candidateHosts.length >= 2
    }, undefined, { timeout: requestTimeoutMs })

    const deadline = Date.now() + requestTimeoutMs
    let requestCount = getRequestCount()
    let failureCount = getFailureCount()
    let stableSince = Date.now()
    while (Date.now() < deadline) {
        if (getRequestCount() !== requestCount || getFailureCount() !== failureCount) {
            requestCount = getRequestCount()
            failureCount = getFailureCount()
            stableSince = Date.now()
        } else if (Date.now() - stableSince >= stage3ProbeBaselineStabilityMs) {
            return { requestCount, failureCount }
        }
        await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error('CDN probe request/failure counts did not stabilize before Stage3')
}

async function waitForRecoveryState(page, state) {
    await page.waitForFunction(expectedState => {
        const status = window.bangumi_area_limit_hack?.getCdnRecoveryStatus?.()
        const active = status?.groups?.filter(group => (
            group.state !== 'disabled' && group.state !== 'unseen'
        )) ?? []
        return status?.activeGroupCount === 2
            && active.length === 2
            && active.every(group => group.state === expectedState)
    }, state, { timeout: requestTimeoutMs })
    return readRecoveryStatus(page)
}

async function waitForStableRecoveryReset(page) {
    try {
        await page.waitForFunction(() => {
            const status = window.bangumi_area_limit_hack?.getCdnRecoveryStatus?.()
            const active = status?.groups?.filter(group => (
                group.state !== 'disabled' && group.state !== 'unseen'
            )) ?? []
            return active.length === 2 && active.every(group => (
                group.state === 'waiting-retry'
                    && group.candidateIndex === 1
                    && group.pendingCandidateIndex === null
                    && group.attemptedCount === 1
                    && group.switchAttempts === 0
            ))
        }, undefined, { timeout: requestTimeoutMs })
    } catch (error) {
        const status = await readRecoveryStatus(page)
        const summary = activeRecoveryGroups(status).map(group => ({
            kind: group.kind,
            state: group.state,
            candidateIndex: group.candidateIndex,
            pendingCandidateIndex: group.pendingCandidateIndex,
            attemptedCount: group.attemptedCount,
            switchAttempts: group.switchAttempts,
        }))
        throw new Error(`stable playback reset did not complete: ${JSON.stringify(summary)}`, { cause: error })
    }
    return readRecoveryStatus(page)
}

function readRecoveryStatus(page) {
    return page.evaluate(() => window.bangumi_area_limit_hack.getCdnRecoveryStatus())
}

function readStage3Run(page, phase) {
    return page.evaluate(value => (
        window.__cdnSwitcherCompatState.snapshotStage3Run(value)
    ), phase)
}

function assertRunPending(run, label) {
    for (const transport of ['fetch', 'xhr']) {
        const result = run?.[transport]
        assertCompat(result && result.settled === false, `${label}: ${transport} settled unexpectedly`)
        assertCompat(result.abortCount === 0, `${label}: ${transport} emitted an abort`)
        assertCompat(result.signalAborted === false, `${label}: ${transport} signal was aborted`)
    }
}

function assertRunComplete(run, expectedCandidates, label) {
    for (const transport of ['fetch', 'xhr']) {
        const result = run?.[transport]
        assertCompat(result?.settled === true, `${label}: ${transport} did not settle`)
        assertCompat(!result.transportError, `${label}: ${transport} failed with ${result?.transportError || 'unknown error'}`)
        assertCompat(result.status === 200, `${label}: ${transport} returned status ${result?.status}`)
        assertCompat(result.candidate === expectedCandidates[transport],
            `${label}: ${transport} reached ${JSON.stringify(result.candidate)} instead of its exact expected candidate`)
        assertCompat(result.bodyMatchesCandidate === true,
            `${label}: ${transport} predecessor response marker did not round-trip`)
        assertCompat(result.abortCount === 0, `${label}: ${transport} emitted an abort`)
        assertCompat(result.signalAborted === false, `${label}: ${transport} signal was aborted`)
    }
}

function assertMediaRequestSequence(mediaRequests, expected) {
    for (const transport of ['fetch', 'xhr']) {
        const requests = mediaRequests.filter(request => request.transport === transport)
        const candidates = requests.map(request => request.candidate)
        assertCompat(JSON.stringify(candidates) === JSON.stringify(expected[transport]),
            `${transport} predecessor sequence mismatch: ${JSON.stringify(candidates)}`)
        assertCompat(requests.every(request => request.resourceType === transport),
            `${transport} request did not use the real ${transport.toUpperCase()} predecessor`)
        assertCompat(requests.every(request => (
            request.accept === `application/vnd.balh-stage3.${transport}+octet-stream`
        )), `${transport} request semantics changed in the hook chain`)
    }
}

function assertTransportHealth(requestFailures, routeErrors, overflow, requestViolations) {
    assertCompat(requestFailures.length === 0, 'a controlled Stage3 request failed')
    assertCompat(routeErrors.length === 0, 'a controlled Stage3 predecessor could not be fulfilled')
    assertCompat(overflow === 0, 'controlled Stage3 request diagnostics exceeded their bound')
    assertCompat(requestViolations === 0, 'a controlled Stage3 request used a pre-CDN or unknown exact URL')
}

function assertCompat(condition, message) {
    if (!condition) throw new Error(message)
}

function createHarnessBootstrap({
    order,
    sources,
    balhVersion,
    expectedCdnHost,
    sensitiveFragments,
}) {
    const state = {
        stages: [],
        scriptErrors: [],
        gmReads: [],
        gmWrites: [],
        gmMenus: [],
        stage3RouteIntentEvents: [],
        traceStage3RecoveryTimers: false,
        sensitiveConsoleArgumentCount: 0,
        incompleteConsoleArgumentCount: 0,
    }
    Object.defineProperty(window, '__cdnSwitcherCompatState', {
        configurable: false,
        enumerable: false,
        value: state,
    })

    const nativeSetTimeout = globalThis.setTimeout.bind(globalThis)
    const nativeDateNow = Date.now.bind(Date)
    const readRecoveryRoutes = () => {
        try {
            const groups = globalThis.bangumi_area_limit_hack?.getCdnRecoveryStatus?.()?.groups
            if (!Array.isArray(groups)) return null
            return Object.fromEntries(groups
                .filter(group => typeof group?.kind === 'string'
                    && Number.isInteger(group.candidateIndex)
                    && Number.isInteger(group.routeRevision))
                .map(group => [group.kind, {
                    candidateIndex: group.candidateIndex,
                    pendingCandidateIndex: group.pendingCandidateIndex ?? null,
                    routeRevision: group.routeRevision,
                }]))
        } catch {
            return null
        }
    }
    globalThis.setTimeout = function (callback, delayMs = 0, ...args) {
        const numericDelayMs = Number(delayMs)
        const tracesRecoveryTimer = state.traceStage3RecoveryTimers === true
            && typeof callback === 'function'
            && Number.isFinite(numericDelayMs)
        if (!tracesRecoveryTimer) {
            return nativeSetTimeout(callback, delayMs, ...args)
        }
        return nativeSetTimeout(function (...callbackArgs) {
            const before = readRecoveryRoutes()
            const callbackStartedAt = nativeDateNow()
            const nowCalls = []
            const previousDateNow = Date.now
            Date.now = () => {
                const value = nativeDateNow()
                nowCalls.push(value)
                return value
            }
            try {
                return Reflect.apply(callback, this, callbackArgs)
            } finally {
                Date.now = previousDateNow
                const callbackFinishedAt = nativeDateNow()
                const after = readRecoveryRoutes()
                if (before && after && nowCalls.length > 0) {
                    for (const [kind, fromRoute] of Object.entries(before)) {
                        const toRoute = after[kind]
                        if (!toRoute
                            || toRoute.routeRevision === fromRoute.routeRevision) continue
                        if (state.stage3RouteIntentEvents.length >= 10) continue
                        state.stage3RouteIntentEvents.push({
                            kind,
                            fromCandidateIndex: fromRoute.candidateIndex,
                            toCandidateIndex: toRoute.candidateIndex,
                            fromPendingCandidateIndex: fromRoute.pendingCandidateIndex,
                            toPendingCandidateIndex: toRoute.pendingCandidateIndex,
                            fromRouteRevision: fromRoute.routeRevision,
                            toRouteRevision: toRoute.routeRevision,
                            routeIntentAt: nowCalls[0],
                            callbackStartedAt,
                            callbackFinishedAt,
                            requestedDelayMs: numericDelayMs,
                        })
                    }
                }
            }
        }, delayMs, ...args)
    }

    const gmStore = new Map([
        ['CustomCDN', expectedCdnHost],
        ['disabled', false],
        ['ReplaceBackupURLs', false],
    ])
    globalThis.unsafeWindow = globalThis
    globalThis.GM_info = {
        script: { name: 'BALH CDN compatibility test', version: balhVersion },
        scriptHandler: 'Playwright compatibility harness',
    }
    globalThis.GM_getValue = (key, fallback) => {
        state.gmReads.push(String(key))
        return gmStore.has(key) ? gmStore.get(key) : fallback
    }
    globalThis.GM_setValue = (key, value) => {
        gmStore.set(key, value)
        state.gmWrites.push({ key: String(key), value })
    }
    globalThis.GM_registerMenuCommand = label => {
        state.gmMenus.push(String(label))
        return state.gmMenus.length
    }

    const scanConsoleValue = (value, seen = new WeakSet(), depth = 0, budget = { remaining: 200 }) => {
        if (budget.remaining-- <= 0 || depth > 4) return 'incomplete'
        if (typeof value === 'string') {
            return sensitiveFragments.some(fragment => value.includes(fragment))
                ? 'sensitive'
                : 'safe'
        }
        if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return 'safe'
        if (seen.has(value)) return 'safe'
        seen.add(value)
        let descriptors
        try {
            descriptors = Object.getOwnPropertyDescriptors(value)
        } catch {
            return 'incomplete'
        }
        let outcome = 'safe'
        for (const key of Reflect.ownKeys(descriptors)) {
            if (typeof key === 'string') {
                const keyOutcome = scanConsoleValue(key, seen, depth + 1, budget)
                if (keyOutcome === 'sensitive') return keyOutcome
                if (keyOutcome === 'incomplete') outcome = keyOutcome
            }
            const descriptor = descriptors[key]
            if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) continue
            const valueOutcome = scanConsoleValue(descriptor.value, seen, depth + 1, budget)
            if (valueOutcome === 'sensitive') return valueOutcome
            if (valueOutcome === 'incomplete') outcome = valueOutcome
        }
        return outcome
    }
    for (const method of ['debug', 'info', 'log', 'warn', 'error']) {
        const original = console[method]
        if (typeof original !== 'function') continue
        console[method] = function (...args) {
            const outcomes = args.map(value => scanConsoleValue(value))
            if (outcomes.includes('sensitive')) {
                state.sensitiveConsoleArgumentCount += 1
            }
            if (outcomes.includes('incomplete')) {
                state.incompleteConsoleArgumentCount += 1
            }
            return original.apply(console, args)
        }
    }

    for (const name of order) {
        const beforeFetch = globalThis.fetch
        const beforeXhr = globalThis.XMLHttpRequest
        try {
            const sourceUrl = name === 'balh'
                ? 'balh-current.user.js'
                : 'cdn-switcher-latest.user.js'
            new Function(`${sources[name]}\n//# sourceURL=${sourceUrl}`)()
        } catch (error) {
            state.scriptErrors.push({
                name,
                message: String(error),
                stack: String(error?.stack || ''),
            })
            throw error
        }
        state.stages.push({
            name,
            fetchChanged: globalThis.fetch !== beforeFetch,
            xhrChanged: globalThis.XMLHttpRequest !== beforeXhr,
            fetchName: globalThis.fetch?.name,
            xhrName: globalThis.XMLHttpRequest?.name,
        })
    }
}

function createPlayUrlResponse(scope) {
    const mediaUrl = `https://${sourceMediaHost}${mediaPath}?compat_token=${mediaToken}`
    const fetchPrimary = getRawStage3CandidateUrl('fetch', 'primary')
    const fetchAlternate = getRawStage3CandidateUrl('fetch', 'alternate')
    const xhrPrimary = getRawStage3CandidateUrl('xhr', 'primary')
    const xhrAlternate = getRawStage3CandidateUrl('xhr', 'alternate')
    const video = [{
        id: 81,
        baseUrl: mediaUrl,
        bandwidth: 1_000_000,
        mimeType: 'video/mp4',
        codecs: 'avc1.640028',
    }]
    if (scope === 'fetch' || scope === 'xhr') {
        video.unshift({
            id: 80,
            baseUrl: fetchPrimary,
            backupUrl: [fetchAlternate],
            bandwidth: 1_000_000,
            mimeType: 'video/mp4',
            codecs: 'avc1.640028',
        })
    }
    const audio = scope === 'xhr' ? [{
        id: 30280,
        baseUrl: xhrPrimary,
        backupUrl: [xhrAlternate],
        bandwidth: 128_000,
        mimeType: 'audio/mp4',
        codecs: 'mp4a.40.2',
    }] : []
    return {
        code: 0,
        message: 'success',
        result: {
            dash: {
                duration: 30,
                minBufferTime: 1.5,
                video,
                audio,
            },
        },
    }
}

function createPageHtml() {
    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <link rel="icon" href="data:,">
    <title>BALH CDN compatibility test</title>
</head>
<body>
    <div id="bilibili-player">
        <video id="compat-stage3-video"></video>
        <div class="bpx-player-ctrl-setting-others"></div>
    </div>
    <script>window.__INITIAL_STATE__ = {};</script>
</body>
</html>`
}

function assertOrderResult(order, evaluation, pageErrors, controlledRequests, diagnostics) {
    const label = order.join('->')
    if (pageErrors.length > 0) {
        throw orderFailure(order, `page emitted ${pageErrors.length} uncaught error(s)`, diagnostics)
    }
    if (!evaluation?.state) {
        throw orderFailure(order, 'compatibility harness state is missing', diagnostics)
    }
    if (evaluation.state.scriptErrors?.length) {
        throw orderFailure(order, 'a userscript threw during initialization', diagnostics)
    }
    if (!evaluation.state.hasBalhApi) {
        throw orderFailure(order, 'BALH did not expose window.bangumi_area_limit_hack', diagnostics)
    }

    const stages = evaluation.state.stages || []
    if (stages.length !== order.length || stages.some((stage, index) => stage.name !== order[index])) {
        throw orderFailure(order, `initialization stages do not match ${label}`, diagnostics)
    }
    for (const stage of stages) {
        if (!stage.fetchChanged || !stage.xhrChanged) {
            throw orderFailure(order, `${stage.name} did not install both Fetch and XHR hooks`, diagnostics)
        }
    }
    if (!evaluation.state.gmReads?.includes('CustomCDN')) {
        throw orderFailure(order, 'CDN Switcher did not read its CustomCDN setting', diagnostics)
    }
    if (!evaluation.state.gmMenus?.length) {
        throw orderFailure(order, 'CDN Switcher did not register its menu command', diagnostics)
    }
    if (controlledRequests.length !== 2
        || controlledRequests[0]?.method !== 'GET'
        || controlledRequests[0]?.resourceType !== 'fetch'
        || controlledRequests[0]?.accept !== 'application/vnd.balh-compat.fetch+json'
        || controlledRequests[1]?.method !== 'GET'
        || controlledRequests[1]?.resourceType !== 'xhr'
        || controlledRequests[1]?.accept !== 'application/vnd.balh-compat.xhr+json') {
        throw orderFailure(order, 'hook chain changed request semantics or issued recursive playurl requests', diagnostics)
    }
    if (diagnostics.unexpectedRequestViolationCount !== 0) {
        throw orderFailure(order, 'hook chain issued a non-allowlisted or transformed playurl request', diagnostics)
    }
    if (diagnostics.allowlistedBackgroundPlayUrlCounts.fetch !== 1
        || diagnostics.allowlistedBackgroundPlayUrlCounts.xhr !== 1) {
        throw orderFailure(order, 'fixture background proxy playurl transport count changed', diagnostics)
    }
}

function inspectMediaResult(order, transport, result, diagnostics) {
    if (!result || result.transportError) {
        throw orderFailure(order, `${transport} playurl request failed: ${result?.transportError || 'missing result'}`, diagnostics)
    }
    if (result.status !== 200 || result.originHeader !== 'controlled') {
        throw orderFailure(order, `${transport} response metadata is unusable (status=${result.status}, x-compat-origin=${JSON.stringify(result.originHeader)})`, diagnostics)
    }
    if (result.parseError || result.code !== 0 || !result.hasDash || !result.mediaHost) {
        throw orderFailure(order, `${transport} response body is not usable playurl JSON`, diagnostics)
    }

    if (result.mediaHost !== expectedCdnHost) {
        throw orderFailure(order, `${transport} hook chain did not preserve CDN rewriting: expected host ${expectedCdnHost}, got ${result.mediaHost}`, diagnostics)
    }
    if (result.mediaPath !== mediaPath || result.mediaTokenMatches !== true) {
        throw orderFailure(order, `${transport} CDN rewrite corrupted the media path or query`, diagnostics)
    }

    return {
        host: result.mediaHost,
        path: result.mediaPath,
        textLength: result.textLength,
    }
}

function orderFailure(order, message, diagnostics, cause) {
    return new Error([
        `[order=${order.join('->')}] ${sanitizeDiagnosticText(message)}`,
        `Diagnostics: ${clip(sanitizeDiagnosticText(JSON.stringify(diagnostics, null, 2)), 12_000)}`,
    ].join('\n'), cause ? { cause } : undefined)
}

async function withHostTimeout(promise, timeoutMs, onTimeout, label) {
    let timer
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            Promise.resolve()
                .then(onTimeout)
                .catch(() => undefined)
            reject(new Error(`${label} exceeded the host-side ${timeoutMs}-ms deadline`))
        }, timeoutMs)
    })
    try {
        return await Promise.race([promise, timeout])
    } finally {
        clearTimeout(timer)
    }
}

async function closeWithDeadline(close, timeoutMs, label) {
    let timer
    const closeResult = Promise.resolve()
        .then(close)
        .then(() => undefined, error => error)
    const deadline = new Promise(resolve => {
        timer = setTimeout(() => {
            resolve(new Error(`${label} exceeded the ${timeoutMs}-ms deadline`))
        }, timeoutMs)
    })
    try {
        return await Promise.race([closeResult, deadline])
    } finally {
        clearTimeout(timer)
    }
}

function pushBounded(items, value, limit) {
    items.push(value)
    if (items.length > limit) {
        items.shift()
    }
}

function clip(value, maxLength) {
    const text = String(value || '')
    if (text.length <= maxLength) return text
    return `${text.slice(0, maxLength)}…[truncated ${text.length - maxLength} chars]`
}

function firstLine(value) {
    return String(value || '').split(/\r?\n/, 1)[0]
}

function formatError(error) {
    if (error?.stack) return sanitizeDiagnosticText(error.stack)
    return sanitizeDiagnosticText(error)
}

function createStage3Candidate(transport, position, pathname) {
    const hostname = position === 'primary' ? expectedCdnHost : sourceMediaHost
    return Object.freeze({
        transport,
        position,
        url: `https://${hostname}${pathname}?compat_token=${stage3MediaToken}`,
    })
}

function getRawStage3CandidateUrl(transport, position) {
    const parsed = new URL(getStage3Candidate(transport, position).url)
    parsed.hostname = sourceMediaHost
    return parsed.toString()
}

function getStage3Candidate(transport, position) {
    const candidate = stage3Candidates.find(item => (
        item.transport === transport && item.position === position
    ))
    if (!candidate) throw new Error(`Missing controlled ${transport} ${position} candidate`)
    return candidate
}

function findStage3Candidate(url) {
    return stage3Candidates.find(candidate => candidate.url === url)
}

function findRawStage3Candidate(url) {
    return stage3Candidates.find(candidate => (
        getRawStage3CandidateUrl(candidate.transport, candidate.position) === url
    ))
}

function createDeferred() {
    let resolve
    const promise = new Promise(settle => {
        resolve = settle
    })
    return { promise, resolve }
}

async function waitForCondition(predicate, timeoutMs, message) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (predicate()) return
        await new Promise(resolve => setTimeout(resolve, 25))
    }
    if (predicate()) return
    throw new Error(`${message} within ${timeoutMs} ms`)
}

function safeHostname(value) {
    try {
        return new URL(value).hostname
    } catch {
        return 'unparseable'
    }
}

function classifyUnexpectedRequest({
    method,
    value,
    resourceType,
    accept,
    controlledRequestCount,
}) {
    if (method !== 'GET') {
        return {
            violation: 'non-get',
            pathClass: 'unknown',
            hostMatchesControlled: false,
            queryMatchesControlled: false,
            allowlistedBackgroundPlayUrl: false,
        }
    }
    try {
        const parsed = new URL(value)
        const controlled = new URL(playUrlApi)
        const pathMatchesControlled = parsed.pathname === controlled.pathname
        const hostMatchesControlled = parsed.hostname === controlled.hostname
        const queryMatchesControlled = parsed.search === controlled.search
        const lowerPathname = parsed.pathname.toLowerCase()
        const harnessProxyBackgroundPath = parsed.pathname
            === '/bangumi/play/https://proxy.compat.invalid/pgc/player/web/playurl'
        const pathClass = pathMatchesControlled
            ? 'controlled-playurl-path'
            : harnessProxyBackgroundPath
                ? 'harness-proxy-background-playurl'
                : (lowerPathname.includes('playurl')
                    ? 'other-playurl-path'
                    : 'non-playurl-path')
        const allowlistedBackgroundPlayUrl = parsed.hostname === 'www.bilibili.com'
            && harnessProxyBackgroundPath
            && !queryMatchesControlled
            && accept === '*/*'
            && controlledRequestCount === 2
            && (resourceType === 'fetch' || resourceType === 'xhr')
        if (allowlistedBackgroundPlayUrl) {
            return {
                violation: null,
                pathClass,
                hostMatchesControlled,
                queryMatchesControlled,
                allowlistedBackgroundPlayUrl: true,
            }
        }
        if (pathClass !== 'non-playurl-path') {
            return {
                violation: 'transformed-playurl',
                pathClass,
                hostMatchesControlled,
                queryMatchesControlled,
                allowlistedBackgroundPlayUrl: false,
            }
        }
        const allowed = new Set([
            'api.bilibili.com',
            'proxy.compat.invalid',
            sourceMediaHost,
            'www.bilibili.com',
        ]).has(parsed.hostname)
        return {
            violation: allowed ? null : 'host-not-allowlisted',
            pathClass,
            hostMatchesControlled,
            queryMatchesControlled,
            allowlistedBackgroundPlayUrl: false,
        }
    } catch {
        return {
            violation: 'unparseable-url',
            pathClass: 'unknown',
            hostMatchesControlled: false,
            queryMatchesControlled: false,
            allowlistedBackgroundPlayUrl: false,
        }
    }
}

function containsSensitiveMediaValue(value) {
    const text = String(value || '')
    return text.includes(stage3MediaToken)
        || text.includes(mediaToken)
        || text.includes('/compat/stage3/')
        || stage3Candidates.some(candidate => text.includes(candidate.url))
}

function sanitizeDiagnosticText(value) {
    return String(value || '')
        .replace(/https?:\/\/[^\s"'<>]+/giu, rawUrl => {
            try {
                const parsed = new URL(rawUrl)
                return `${parsed.protocol}//${parsed.host}/[redacted]`
            } catch {
                return '[url redacted]'
            }
        })
        .replaceAll(stage3MediaToken, '[media-token-redacted]')
        .replaceAll(mediaToken, '[media-token-redacted]')
}
