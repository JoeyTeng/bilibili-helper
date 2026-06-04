#!/usr/bin/env node
import { existsSync } from 'node:fs'
import http from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)

const cdp = readOption('--cdp') || 'http://127.0.0.1:9222'
const launch = args.includes('--launch')
const chromeExecutable = readOption('--chrome-executable') || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const profileDir = path.resolve(rootDir, readOption('--profile-dir') || '.codex-tmp/chrome-balh-profile')
const startUrl = readOption('--start-url') || 'https://www.bilibili.com/bangumi/play/ep664928'
const blockedUrl = readOption('--blocked-url') || 'https://www.bilibili.com/bangumi/play/ep664929'
const returnUrl = readOption('--return-url') || startUrl
const outDir = path.resolve(rootDir, readOption('--out-dir') || '.codex-tmp/playwright-logs')
const userscriptOption = readOption('--userscript')
const tampermonkeyExtensionOption = readOption('--tampermonkey-extension')
const tampermonkeyInstallOption = readOption('--tampermonkey-install')
const tampermonkeyInstallUrlOption = readOption('--tampermonkey-install-url')
const accessKeyFileOption = readOption('--access-key-file')
const proxyServerOption = readOption('--proxy-server')
const generateSub = args.includes('--generate-sub')
const probeSubtitleMenu = args.includes('--probe-subtitle-menu')
const probeFetchPlayUrlOption = args.includes('--probe-fetch-playurl')
const skipSwitch = args.includes('--skip-switch')
const waitAfterStartMs = Number(readOption('--wait-after-start-ms') || 0)
const reloadCount = Number(readOption('--reload-count') || 0)
const reloadWaitMs = Number(readOption('--reload-wait-ms') || 3000)
const seekToSeconds = parseNumberList(readOption('--seek-to-seconds') || '')
const seekWaitMs = Number(readOption('--seek-wait-ms') || 8000)
const userscriptPath = userscriptOption ? path.resolve(rootDir, userscriptOption) : undefined
const tampermonkeyExtensionPath = tampermonkeyExtensionOption ? path.resolve(rootDir, tampermonkeyExtensionOption) : undefined
const tampermonkeyInstallPath = tampermonkeyInstallOption ? path.resolve(rootDir, tampermonkeyInstallOption) : undefined
const accessKeyFile = accessKeyFileOption ? path.resolve(rootDir, accessKeyFileOption) : undefined
const proxyServer = proxyServerOption || ((launch || userscriptPath || tampermonkeyInstallPath || tampermonkeyInstallUrlOption) ? 'https://atri.ink' : undefined)
const tag = readOption('--tag') || new Date().toISOString().replace(/[-:.]/g, '')
const logPath = path.join(outDir, `${tag}.log`)

if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: pnpm run debug:bangumi -- [options]

Options:
  --launch               Launch a dedicated Chrome profile instead of connecting to CDP.
  --cdp <url>            Chrome DevTools endpoint. Default: http://127.0.0.1:9222
  --chrome-executable    Chrome executable for --launch.
  --profile-dir <path>   User data dir for --launch. Default: .codex-tmp/chrome-balh-profile
  --userscript <path>    Inject a built userscript at document-start.
  --tampermonkey-extension <path>
                          Load a Tampermonkey extension directory in --launch mode.
  --tampermonkey-install <path>
                          Serve and install a userscript through Tampermonkey before testing.
  --tampermonkey-install-url <url>
                          Install a userscript URL through Tampermonkey before testing.
  --access-key-file      Read Bilibili access_key from a local file and set localStorage.
  --proxy-server <url>   Set BALH custom proxy cookies. Defaults to https://atri.ink with --launch/--userscript/Tampermonkey install.
  --generate-sub         Enable BALH generated simplified/traditional subtitles.
  --probe-subtitle-menu  Open the player subtitle menu and click a generated subtitle if present.
  --probe-fetch-playurl  Fetch the PGC playurl API from the page to exercise fetch interception.
  --reload-count <n>    Run normal page.reload() cycles after the initial page probe.
  --reload-wait-ms      Wait after each normal reload before probing. Default: 3000.
  --skip-switch         Do not switch to blocked/return episodes after the initial probes.
  --wait-after-start-ms  Wait after the first playable episode before switching.
  --seek-to-seconds      Comma-separated video positions to seek before switching.
  --seek-wait-ms         Wait after each seek. Default: 8000.
  --start-url <url>      Initial playable episode URL.
  --blocked-url <url>    Episode URL expected to fail because of account entitlement.
  --return-url <url>     URL to click back to after the blocked episode.
  --out-dir <path>       Log output directory. Default: .codex-tmp/playwright-logs
  --tag <name>           Log filename stem.

Before running, start Chrome with a Tampermonkey profile, for example:
  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome \\
    --remote-debugging-port=9222 \\
    --user-data-dir="$PWD/.codex-tmp/chrome-balh-profile"

Or let this script launch Chrome and inject the local userscript:
  pnpm run debug:bangumi -- --launch --userscript dist/unblock-area-limit.user.js --access-key-file auth.txt

Or test through a real Tampermonkey extension:
  pnpm run debug:bangumi -- --launch \\
    --tampermonkey-extension "$HOME/Library/Application Support/Google/Chrome/Default/Extensions/dhdgffkkebhmkfjojejmpbldmpobfkfo/5.5.0_0" \\
    --tampermonkey-install dist/unblock-area-limit.user.js \\
    --access-key-file auth.txt
`)
    process.exit(0)
}

function readOption(name) {
    const inline = args.find((arg) => arg.startsWith(`${name}=`))
    if (inline) return inline.slice(name.length + 1)
    const index = args.indexOf(name)
    if (index === -1) return undefined
    const value = args[index + 1]
    if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${name}`)
    }
    return value
}

function parseNumberList(value) {
    return String(value)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => Number(item))
        .filter((item) => Number.isFinite(item) && item >= 0)
}

function episodeId(url) {
    return new URL(url).pathname.match(/\/bangumi\/play\/ep(\d+)/)?.[1]
}

function now() {
    return new Date().toISOString()
}

const lines = []
function record(line) {
    const text = `[${now()}] ${redactSensitive(line)}`
    lines.push(text)
    console.log(text)
}

function redactSensitive(text) {
    return String(text)
        .replace(/(https?:\/\/)[^\s"'\/@]+:[^\s"'\/@]+@/g, '$1<redacted>@')
        .replace(/([?&]access_key=)[^&\s"']+/g, '$1<redacted>')
        .replace(/(localStorage\.access_key\s*=\s*["'])[^"']+/g, '$1<redacted>')
}

function normalizeAccessKey(text) {
    const value = text.trim()
    if (!value) return ''
    const match = value.match(/(?:^|[?&\s])access_key=([^&\s]+)/)
    if (match) return decodeURIComponent(match[1])
    return value
}

function interestingUrl(url) {
    return url.includes('/pgc/player/web/playurl')
        || url.includes('/x/player/')
        || url.includes('/x/v2/subtitle/web/view')
        || url.includes('subtitle.bilibili.com')
        || url.includes('.m4s')
        || url.includes('bilivideo.com')
        || url.includes('atri.ink')
}

async function serveUserscript(filePath) {
    const body = await readFile(filePath, 'utf8')
    const server = http.createServer((request, response) => {
        if (request.url?.startsWith('/unblock-area-limit.user.js')) {
            response.writeHead(200, {
                'access-control-allow-origin': '*',
                'cache-control': 'no-store',
                'content-type': 'application/javascript; charset=utf-8',
            })
            response.end(body)
            return
        }
        response.writeHead(404)
        response.end('not found')
    })
    await new Promise((resolve, reject) => {
        server.listen(0, '127.0.0.1', resolve)
        server.once('error', reject)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Cannot bind local userscript server')
    return {
        server,
        url: `http://127.0.0.1:${address.port}/unblock-area-limit.user.js?t=${encodeURIComponent(tag)}`,
    }
}

async function installTampermonkeyScript(context, installUrl) {
    for (const oldPage of context.pages()) {
        if (oldPage.url().startsWith('chrome-extension://') && oldPage.url().includes('/ask.html')) {
            await oldPage.close().catch(() => {})
        }
    }

    const pagesBefore = new Set(context.pages())
    const page = await context.newPage()
    record(`install userscript ${installUrl}`)
    const downloadPromise = page.waitForEvent('download', { timeout: 60000 }).catch(() => undefined)
    try {
        await page.goto(installUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
    } catch (error) {
        if (!String(error).includes('Download is starting')) throw error
        const download = await downloadPromise
        record(`Tampermonkey did not intercept userscript URL; browser downloaded ${download?.suggestedFilename() || installUrl}`)
        await page.close().catch(() => {})
        return false
    }
    await page.waitForTimeout(5000)

    const pages = context.pages()
    const candidates = pages
        .filter((candidate) => candidate === page || candidate.url().startsWith('chrome-extension://'))
        .sort((a, b) => Number(pagesBefore.has(a)) - Number(pagesBefore.has(b)))
    for (const candidate of candidates) {
        const url = candidate.url()
        for (const locator of [
            candidate.locator('input.button.install[value="Install"], input.button.install[value="Reinstall"], input.button.install[value="Update"]'),
            candidate.getByText(/^Install$/i),
            candidate.getByText(/^Reinstall$/i),
            candidate.getByText(/^Update$/i),
            candidate.getByText('安装'),
            candidate.getByText('重新安装'),
            candidate.locator('input.button.install[value="安装"], input.button.install[value="重新安装"], input.button.install[value="更新"]'),
            candidate.locator('button, input[type="button"], input[type="submit"]').filter({ hasText: /Install|Reinstall|Update|安装|重新安装|更新/i }),
        ]) {
            try {
                await locator.first().click({ timeout: 3000, force: true })
                record(`clicked Tampermonkey install control on ${url}`)
                await candidate.waitForTimeout(3000).catch(() => {})
                await page.close().catch(() => {})
                return true
            } catch (_) {
                // Try the next likely install control.
            }
        }
    }

    record(`Tampermonkey install control not found; open pages: ${pages.map(page => page.url()).join(' | ')}`)
    await page.close().catch(() => {})
    return false
}

function createPageInitScript({ userscript, accessKey, proxyServer, generateSub }) {
    const biliHostGuard = `(location.hostname === 'bilibili.com' || location.hostname.endsWith('.bilibili.com'))`
    const cookiePairs = [
        ...(proxyServer ? [
        ['balh_server_inner', '__custom__'],
        ['balh_server_custom', proxyServer],
        ['balh_server_custom_hk', proxyServer],
        ['balh_server_custom_tw', proxyServer],
        ['balh_server_custom_cn', proxyServer],
        ['balh_server_custom_th', proxyServer],
        ['balh_is_closed', ''],
        ] : []),
        ...(generateSub ? [['balh_generate_sub', 'Y']] : []),
    ]
    const cookieLines = cookiePairs.map(([key, value]) => {
        return `document.cookie = ${JSON.stringify(`${key}=${value}; domain=.bilibili.com; path=/; max-age=94608000`)}`
    }).join('\n')

    const setup = `
        if (${biliHostGuard}) {
            ${cookieLines}
            localStorage.balh_migrate_to_2 = 'Y'
            ${accessKey ? `localStorage.access_key = ${JSON.stringify(accessKey)}` : ''}
        }
    `

    if (!userscript) return setup
    return `
        ;(() => {
            ${setup}
            if (!${biliHostGuard}) return
            const GM_info = {
                script: { name: '解除B站区域限制.dev.playwright', version: 'local' },
                scriptHandler: 'Playwright',
            }
            ${userscript}
        })();
    `
}

async function clickEpisode(page, url) {
    const epId = episodeId(url)
    if (!epId) throw new Error(`Cannot find episode id in ${url}`)
    const selector = `a[href*="/bangumi/play/ep${epId}"]`
    const link = page.locator(selector).first()
    try {
        await link.click({ timeout: 10000 })
        record(`clicked ${selector}`)
    } catch (error) {
        record(`click failed for ${selector}; falling back to page.goto: ${error}`)
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
    }
}

async function samplePlayer(page, label) {
    const sample = await page.evaluate(() => {
        const anyWindow = window
        return Array.from(document.querySelectorAll('video')).map((video) => ({
            currentTime: video.currentTime,
            duration: video.duration,
            ended: video.ended,
            error: video.error ? {
                code: video.error.code,
                message: video.error.message,
            } : null,
            networkState: video.networkState,
            paused: video.paused,
            readyState: video.readyState,
            src: video.currentSrc || video.src,
        }))
            .concat([{
                location: location.href,
                documentReadyState: document.readyState,
                bodyText: document.body?.innerText?.slice(0, 300),
                hasNano: !!anyWindow.nano,
                hasNanoCreatePlayer: !!anyWindow.nano?.createPlayer,
                hasPlayUrlHydrateData: !!anyWindow.__PLAYURL_HYDRATE_DATA__,
                playUrlHydrateType: anyWindow.__PLAYURL_HYDRATE_DATA__?.result?.play_video_type,
                playUrlHydrateEpId: anyWindow.__PLAYURL_HYDRATE_DATA__?.result?.supplement?.ogv_episode_info?.episode_id,
                playUrlHydrateVideoCount: anyWindow.__PLAYURL_HYDRATE_DATA__?.result?.video_info?.dash?.video?.length,
                playInfoType: anyWindow.__playinfo__?.result?.play_video_type,
                playInfoEpId: anyWindow.__playinfo__?.result?.supplement?.ogv_episode_info?.episode_id,
                playInfoVideoCount: anyWindow.__playinfo__?.result?.video_info?.dash?.video?.length,
                balhPlayerStatus: document.querySelector('#balh-player-status')?.textContent,
            }])
    }).catch((error) => ({ error: String(error) }))
    record(`${label} player sample ${JSON.stringify(sample)}`)
}

async function seekVideo(page, seconds, label) {
    const result = await page.evaluate(async (targetSeconds) => {
        const video = Array.from(document.querySelectorAll('video'))
            .find((item) => Number.isFinite(item.duration) && item.duration > 0)
            || document.querySelector('video')
        if (!video) return { ok: false, reason: 'video not found' }
        const hasSource = Boolean(video.currentSrc || video.src)
        if (!hasSource && !(Number.isFinite(video.duration) && video.duration > 0)) {
            return {
                ok: false,
                reason: 'video has no playable source',
                currentTime: video.currentTime,
                duration: video.duration,
                networkState: video.networkState,
                paused: video.paused,
                readyState: video.readyState,
            }
        }

        const before = {
            currentTime: video.currentTime,
            duration: video.duration,
            networkState: video.networkState,
            paused: video.paused,
            readyState: video.readyState,
        }
        const maxTarget = Number.isFinite(video.duration) && video.duration > 3
            ? Math.max(0, video.duration - 2)
            : targetSeconds
        const target = Math.min(targetSeconds, maxTarget)
        let playResult = 'not-called'
        let seeked = false

        const seekedPromise = new Promise((resolve) => {
            const timeout = window.setTimeout(() => resolve(false), 5000)
            video.addEventListener('seeked', () => {
                window.clearTimeout(timeout)
                resolve(true)
            }, { once: true })
        })

        video.currentTime = target
        try {
            await Promise.race([
                video.play(),
                new Promise((_, reject) => window.setTimeout(() => reject(new Error('play timeout')), 5000)),
            ])
            playResult = 'resolved'
        } catch (error) {
            playResult = `${error?.name || 'Error'}: ${error?.message || String(error)}`
        }
        seeked = await seekedPromise

        return {
            ok: true,
            before,
            after: {
                currentTime: video.currentTime,
                duration: video.duration,
                networkState: video.networkState,
                paused: video.paused,
                readyState: video.readyState,
            },
            playResult,
            seeked,
            target,
        }
    }, seconds).catch((error) => ({ ok: false, error: String(error) }))

    record(`${label} seek ${seconds}s result ${JSON.stringify(result)}`)
}

async function probePgcFetchPlayUrl(page, label = 'fetch playurl') {
    const result = await page.evaluate(async () => {
        const anyWindow = window
        const playInfo = anyWindow.__PLAYURL_HYDRATE_DATA__ || anyWindow.__playinfo__
        const arc = playInfo?.result?.arc || {}
        const episode = playInfo?.result?.supplement?.ogv_episode_info || {}
        const aid = arc.aid
        const cid = arc.cid
        const epId = episode.episode_id
        if (!aid || !cid || !epId) {
            return { ok: false, reason: 'missing aid/cid/ep_id', aid, cid, epId }
        }
        const params = new URLSearchParams({
            avid: String(aid),
            cid: String(cid),
            qn: '64',
            type: '',
            otype: 'json',
            ep_id: String(epId),
            fourk: '1',
            fnver: '0',
            fnval: '4048',
            session: '',
            module: 'bangumi',
        })
        const response = await fetch(`https://api.bilibili.com/pgc/player/web/playurl?${params}`, {
            credentials: 'include',
        })
        const json = await response.json()
        const playUrl = json?.result?.video_info ?? json?.result
        return {
            ok: true,
            status: response.status,
            code: json?.code,
            message: json?.message,
            hasDash: !!playUrl?.dash,
            videoCount: playUrl?.dash?.video?.length,
            audioCount: playUrl?.dash?.audio?.length,
            hasDurl: Array.isArray(playUrl?.durl),
        }
    }).catch((error) => ({ ok: false, error: String(error) }))
    record(`${label} fetch playurl probe ${JSON.stringify(result)}`)
}

async function probeGeneratedSubtitle(page, label = 'subtitle') {
    try {
        await page.mouse.move(720, 500)
        await page.waitForTimeout(300)
        const subtitleTrigger = page.getByText('多语言字幕').last()
        await subtitleTrigger.click({ timeout: 5000, force: true })
        await page.waitForTimeout(800)

        const menuText = await page.evaluate(() => {
            const text = document.body?.innerText || ''
            const index = text.indexOf('多语言字幕')
            return index >= 0 ? text.slice(index, index + 500) : text.slice(0, 500)
        })
        record(`${label} subtitle menu text ${JSON.stringify(menuText)}`)

        const generatedOption = page.getByText(/生成/).first()
        const count = await generatedOption.count()
        record(`${label} subtitle generated option count ${count}`)
        if (count > 0) {
            await generatedOption.click({ timeout: 5000, force: true })
            record(`${label} clicked generated subtitle option`)
            await page.waitForTimeout(2000)
        }
    } catch (error) {
        record(`${label} subtitle menu probe failed ${error.stack || error.message || error}`)
    }
}

async function probeNormalReloads(page) {
    for (let index = 1; index <= reloadCount; index += 1) {
        const label = `after reload ${index}`
        record(`normal reload ${index}/${reloadCount}`)
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
        await waitForVideoReady(page, label)
        await page.waitForTimeout(reloadWaitMs)
        await samplePlayer(page, label)
        if (probeFetchPlayUrlOption) {
            await probePgcFetchPlayUrl(page, label)
        }
        if (probeSubtitleMenu) {
            await probeGeneratedSubtitle(page, label)
            await samplePlayer(page, `${label} subtitle probe`)
        }
    }
}

async function waitForVideoReady(page, label, timeout = 45000) {
    try {
        await page.waitForFunction(() => {
            return Array.from(document.querySelectorAll('video')).some((video) => {
                return !!(video.currentSrc || video.src) && video.readyState >= HTMLMediaElement.HAVE_METADATA
            })
        }, undefined, { timeout })
        record(`${label} video ready`)
        return true
    } catch (error) {
        record(`${label} video not ready after ${timeout}ms: ${error}`)
        return false
    }
}

function recordContextState(context, label) {
    record(`${label} pages ${context.pages().map(page => page.url()).join(' | ')}`)
    record(`${label} service workers ${context.serviceWorkers().map(worker => worker.url()).join(' | ')}`)
}

async function main() {
    await mkdir(outDir, { recursive: true })
    let browser
    let context
    let page
    let userscriptServer

    try {
        if (launch) {
            record(`launching ${chromeExecutable} with ${path.relative(rootDir, profileDir)}`)
            const launchArgs = []
            if (tampermonkeyExtensionPath) {
                launchArgs.push(`--disable-extensions-except=${tampermonkeyExtensionPath}`)
                launchArgs.push(`--load-extension=${tampermonkeyExtensionPath}`)
            }
            context = await chromium.launchPersistentContext(profileDir, {
                executablePath: chromeExecutable,
                headless: false,
                args: launchArgs,
                ignoreDefaultArgs: ['--disable-extensions'],
                viewport: { width: 1440, height: 1000 },
            })
        } else {
            record(`connecting ${cdp}`)
            browser = await chromium.connectOverCDP(cdp)
            context = browser.contexts()[0] || await browser.newContext()
        }

        const accessKey = accessKeyFile && existsSync(accessKeyFile)
            ? normalizeAccessKey(await readFile(accessKeyFile, 'utf8'))
            : undefined
        const userscript = userscriptPath && existsSync(userscriptPath)
            ? await readFile(userscriptPath, 'utf8')
            : undefined
        if (userscript || accessKey || proxyServer || generateSub) {
            await context.addInitScript({
                content: createPageInitScript({ userscript, accessKey, proxyServer, generateSub }),
            })
            record(`installed init script userscript=${Boolean(userscript)} access_key=${Boolean(accessKey)} proxy=${proxyServer || 'unchanged'} generate_sub=${generateSub}`)
        }
        recordContextState(context, 'after setup')

        if (tampermonkeyInstallPath || tampermonkeyInstallUrlOption) {
            let installUrl = tampermonkeyInstallUrlOption
            if (tampermonkeyInstallPath) {
                const served = await serveUserscript(tampermonkeyInstallPath)
                userscriptServer = served.server
                installUrl = served.url
            }
            const installed = await installTampermonkeyScript(context, installUrl)
            record(`tampermonkey install result=${installed}`)
            recordContextState(context, 'after tampermonkey install')
        }

        page = launch
            ? (context.pages()[0] || await context.newPage())
            : await context.newPage()

        page.on('console', (message) => record(`console.${message.type()} ${message.text()}`))
        page.on('pageerror', (error) => record(`pageerror ${error.stack || error.message}`))
        page.on('requestfailed', (request) => {
            record(`requestfailed ${request.method()} ${request.url()} ${request.failure()?.errorText || ''}`)
        })
        page.on('response', (response) => {
            const url = response.url()
            if (response.status() >= 400 || interestingUrl(url)) {
                record(`response ${response.status()} ${url}`)
            }
        })
        page.on('framenavigated', (frame) => {
            if (frame === page.mainFrame()) record(`navigated ${frame.url()}`)
        })

        record(`goto ${startUrl}`)
        await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
        recordContextState(context, 'after goto')
        await waitForVideoReady(page, 'after start')
        await samplePlayer(page, 'after start')
        if (probeFetchPlayUrlOption) {
            await probePgcFetchPlayUrl(page, 'after start')
        }
        for (const seconds of seekToSeconds) {
            await seekVideo(page, seconds, `after start`)
            await page.waitForTimeout(seekWaitMs)
            await samplePlayer(page, `after seek ${seconds}s`)
        }
        if (waitAfterStartMs > 0) {
            record(`wait after start ${waitAfterStartMs}ms`)
            await page.waitForTimeout(waitAfterStartMs)
            await samplePlayer(page, 'after start wait')
        }
        if (probeSubtitleMenu) {
            await probeGeneratedSubtitle(page, 'after start')
            await samplePlayer(page, 'after subtitle probe')
        }
        if (reloadCount > 0) {
            await probeNormalReloads(page)
        }
        if (skipSwitch) {
            await writeFile(logPath, `${lines.join('\n')}\n`)
            record(`wrote ${path.relative(rootDir, logPath)}`)
            return
        }

        await clickEpisode(page, blockedUrl)
        await page.waitForTimeout(15000)
        await samplePlayer(page, 'after blocked')

        await clickEpisode(page, returnUrl)
        await waitForVideoReady(page, 'after return')
        await samplePlayer(page, 'after return')
        if (probeSubtitleMenu) {
            await probeGeneratedSubtitle(page, 'after return')
            await samplePlayer(page, 'after return subtitle probe')
        }

        await writeFile(logPath, `${lines.join('\n')}\n`)
        record(`wrote ${path.relative(rootDir, logPath)}`)
    } finally {
        if (userscriptServer) {
            await new Promise((resolve, reject) => {
                userscriptServer.close((error) => error ? reject(error) : resolve())
            }).catch((error) => record(`close userscript server failed ${error.stack || error.message || error}`))
        }
        if (launch) {
            await context?.close().catch((error) => record(`close context failed ${error.stack || error.message || error}`))
        } else {
            await page?.close().catch(() => {})
            await browser?.close().catch((error) => record(`close browser failed ${error.stack || error.message || error}`))
        }
    }
}

main().catch(async (error) => {
    record(`fatal ${error.stack || error.message || error}`)
    await mkdir(outDir, { recursive: true })
    await writeFile(logPath, `${lines.join('\n')}\n`)
    process.exitCode = 1
})
