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

const downloadTimeoutMs = 30_000
const downloadByteLimit = 2 * 1024 * 1024
const buildTimeoutMs = 60_000
const buildOutputByteLimit = 512 * 1024
const browserLaunchTimeoutMs = 20_000
const navigationTimeoutMs = 15_000
const requestTimeoutMs = 8_000
const orderTimeoutMs = 35_000
const cleanupTimeoutMs = 5_000

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
                console.log(`[cdn-switcher-compat] PASS order=${order.join('->')} fetchHost=${result.fetch.host} xhrHost=${result.xhr.host}`)
            } catch (error) {
                failures.push({ order, error })
                console.error(`[cdn-switcher-compat] FAIL order=${order.join('->')}: ${firstLine(error.message)}`)
            }
        }
    } finally {
        browserCloseError = await closeWithDeadline(
            () => launched.browser.close(),
            cleanupTimeoutMs,
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
    const unexpectedRequests = []
    const unexpectedWebSockets = []
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
            }])

            const controlledResponse = createPlayUrlResponse()
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
                    pushBounded(controlledRequests, {
                        method: request.method(),
                        accept: request.headers().accept,
                    }, 10)
                    await route.fulfill({
                        status: 200,
                        contentType: 'application/json; charset=utf-8',
                        headers: {
                            'access-control-allow-origin': 'https://www.bilibili.com',
                            'access-control-expose-headers': 'x-compat-origin',
                            'x-compat-origin': 'controlled',
                        },
                        body: JSON.stringify(controlledResponse),
                    })
                    return
                }

                pushBounded(unexpectedRequests, {
                    method: request.method(),
                    resourceType: request.resourceType(),
                    url: clip(url, 500),
                }, 20)
                await route.abort('blockedbyclient')
            })
            await context.routeWebSocket(/.*/, async websocket => {
                pushBounded(unexpectedWebSockets, clip(websocket.url(), 500), 20)
                await websocket.close({ code: 1008, reason: 'Blocked by compatibility harness' })
            })

            const page = await context.newPage()
            page.setDefaultTimeout(requestTimeoutMs)
            page.setDefaultNavigationTimeout(navigationTimeoutMs)
            page.on('console', message => pushBounded(consoleMessages, {
                type: message.type(),
                text: clip(message.text(), 600),
            }, 40))
            page.on('pageerror', error => pushBounded(pageErrors, clip(error.stack || String(error), 2_000), 10))

            await page.addInitScript(createHarnessBootstrap, {
                order,
                sources: { balh: balhSource, cdn: cdnSource },
                balhVersion,
                expectedCdnHost,
            })

            await page.goto(pageUrl, { waitUntil: 'domcontentloaded' })
            return page.evaluate(async ({ playUrlApi, requestTimeoutMs }) => {
                function inspectResponseBody(body) {
                    const video = body?.result?.dash?.video?.[0]
                    const mediaUrl = video?.baseUrl || video?.base_url
                    return {
                        code: body?.code,
                        hasDash: Array.isArray(body?.result?.dash?.video),
                        mediaUrl,
                    }
                }

                const fetchController = new AbortController()
                const fetchTimer = setTimeout(() => fetchController.abort(), requestTimeoutMs)
                let fetchResult
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
                } finally {
                    clearTimeout(fetchTimer)
                }

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

                const state = window.__cdnSwitcherCompatState
                return {
                    fetchResult,
                    xhrResult,
                    state: {
                        stages: state?.stages,
                        scriptErrors: state?.scriptErrors,
                        gmReads: state?.gmReads,
                        gmWrites: state?.gmWrites,
                        gmMenus: state?.gmMenus,
                        hasBalhApi: typeof window.bangumi_area_limit_hack === 'object',
                    },
                }
            }, { playUrlApi, requestTimeoutMs })
        })(), orderTimeoutMs, () => context?.close(), `order ${order.join('->')}`)
    } catch (error) {
        executionError = error
    }

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
    }
}

function createHarnessBootstrap({ order, sources, balhVersion, expectedCdnHost }) {
    const state = {
        stages: [],
        scriptErrors: [],
        gmReads: [],
        gmWrites: [],
        gmMenus: [],
    }
    Object.defineProperty(window, '__cdnSwitcherCompatState', {
        configurable: false,
        enumerable: false,
        value: state,
    })

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

function createPlayUrlResponse() {
    const mediaUrl = `https://${sourceMediaHost}${mediaPath}?compat_token=${mediaToken}`
    return {
        code: 0,
        message: 'success',
        result: {
            dash: {
                duration: 30,
                minBufferTime: 1.5,
                video: [{
                    id: 80,
                    baseUrl: mediaUrl,
                    bandwidth: 1_000_000,
                    mimeType: 'video/mp4',
                    codecs: 'avc1.640028',
                }],
                audio: [],
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
        || controlledRequests[0]?.accept !== 'application/vnd.balh-compat.fetch+json'
        || controlledRequests[1]?.accept !== 'application/vnd.balh-compat.xhr+json') {
        throw orderFailure(order, 'hook chain changed request semantics or issued recursive playurl requests', diagnostics)
    }
}

function inspectMediaResult(order, transport, result, diagnostics) {
    if (!result || result.transportError) {
        throw orderFailure(order, `${transport} playurl request failed: ${result?.transportError || 'missing result'}`, diagnostics)
    }
    if (result.status !== 200 || result.originHeader !== 'controlled') {
        throw orderFailure(order, `${transport} response metadata is unusable (status=${result.status}, x-compat-origin=${JSON.stringify(result.originHeader)})`, diagnostics)
    }
    if (result.parseError || result.code !== 0 || !result.hasDash || !result.mediaUrl) {
        throw orderFailure(order, `${transport} response body is not usable playurl JSON`, diagnostics)
    }

    let mediaUrl
    try {
        mediaUrl = new URL(result.mediaUrl)
    } catch (error) {
        throw orderFailure(order, `${transport} returned an invalid media URL: ${JSON.stringify(result.mediaUrl)}`, diagnostics, error)
    }
    if (mediaUrl.hostname !== expectedCdnHost) {
        throw orderFailure(order, `${transport} hook chain did not preserve CDN rewriting: expected host ${expectedCdnHost}, got ${mediaUrl.hostname}`, diagnostics)
    }
    if (mediaUrl.pathname !== mediaPath || mediaUrl.searchParams.get('compat_token') !== mediaToken) {
        throw orderFailure(order, `${transport} CDN rewrite corrupted the media path or query`, diagnostics)
    }

    return {
        host: mediaUrl.hostname,
        path: mediaUrl.pathname,
        textLength: result.textLength,
    }
}

function orderFailure(order, message, diagnostics, cause) {
    return new Error([
        `[order=${order.join('->')}] ${message}`,
        `Diagnostics: ${clip(JSON.stringify(diagnostics, null, 2), 12_000)}`,
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
    if (error?.stack) return error.stack
    return String(error)
}
