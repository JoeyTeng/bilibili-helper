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
const userscriptPath = userscriptOption ? path.resolve(rootDir, userscriptOption) : undefined
const tampermonkeyExtensionPath = tampermonkeyExtensionOption ? path.resolve(rootDir, tampermonkeyExtensionOption) : undefined
const tampermonkeyInstallPath = tampermonkeyInstallOption ? path.resolve(rootDir, tampermonkeyInstallOption) : undefined
const accessKeyFile = accessKeyFileOption ? path.resolve(rootDir, accessKeyFileOption) : undefined
const proxyServer = proxyServerOption || ((launch || userscriptPath || tampermonkeyInstallPath) ? 'https://atri.ink' : undefined)
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
  --proxy-server <url>   Set BALH custom proxy cookies. Defaults to https://atri.ink with --launch/--userscript.
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

function createPageInitScript({ userscript, accessKey, proxyServer }) {
    const biliHostGuard = `(location.hostname === 'bilibili.com' || location.hostname.endsWith('.bilibili.com'))`
    const cookieLines = proxyServer ? [
        ['balh_server_inner', '__custom__'],
        ['balh_server_custom', proxyServer],
        ['balh_server_custom_hk', proxyServer],
        ['balh_server_custom_tw', proxyServer],
        ['balh_server_custom_cn', proxyServer],
        ['balh_server_custom_th', proxyServer],
        ['balh_is_closed', ''],
    ].map(([key, value]) => {
        return `document.cookie = ${JSON.stringify(`${key}=${value}; domain=.bilibili.com; path=/; max-age=94608000`)}`
    }).join('\n')
        : ''

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
        if (userscript || accessKey || proxyServer) {
            await context.addInitScript({
                content: createPageInitScript({ userscript, accessKey, proxyServer }),
            })
            record(`installed init script userscript=${Boolean(userscript)} access_key=${Boolean(accessKey)} proxy=${proxyServer || 'unchanged'}`)
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

        await clickEpisode(page, blockedUrl)
        await page.waitForTimeout(15000)
        await samplePlayer(page, 'after blocked')

        await clickEpisode(page, returnUrl)
        await waitForVideoReady(page, 'after return')
        await samplePlayer(page, 'after return')

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
