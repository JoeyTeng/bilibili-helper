import { logHub } from "../../util/log"
import { Objects } from "../../util/objects"
import { balh_config } from "../config"
import { bilibili_login } from "./bilibili_login"

declare const __BALH_BUILD_VERSION__: string
declare const invokeBy: string

type SecretMap = Record<string, string | undefined | null>

const sensitiveParamNames = [
    'access_key',
    'access_token',
    'auth_key',
    'refresh_token',
    'token',
    'bili_jct',
    'csrf',
    'csrf_token',
    'SESSDATA',
    'DedeUserID',
    'DedeUserID__ckMd5',
    'sid',
]

const signedMediaParamNames = [
    'agrr',
    'allo_id',
    'build',
    'buvid',
    'bvc',
    'bw',
    'deadline',
    'dl',
    'e',
    'f',
    'gen',
    'lrs',
    'mid',
    'nbs',
    'nettype',
    'og',
    'oi',
    'orderid',
    'os',
    'platform',
    'qn_dyeid',
    'trid',
    'uipk',
    'uparams',
    'upsig',
]

const relevantLogPattern = /(playurl|proxy|解析|服务器|伺服器|subtitle|字幕|__playinfo__|hydrate|status|error|warn|failed|retry|timeout|地区|地區|区域|區域|大会员|大會員|权限|權限)/i
const urlTextPattern = /(?:https?:)?\/\/[^\s"'<>\\{}]+/gi

export interface DiagnosticReportOptions {
    buildVersion?: string
    invokeBy?: string
    logText?: string
    now?: Date
    extraSecrets?: SecretMap
    fileName?: string
}

export interface DiagnosticArtifacts {
    report: string
    summary: string
    fileName: string
}

export function createDiagnosticArtifacts(options: DiagnosticReportOptions = {}): DiagnosticArtifacts {
    const now = options.now ?? new Date()
    const normalizedOptions = { ...options, now }
    const fileName = options.fileName || createDiagnosticFileName(normalizedOptions)
    return {
        report: createDiagnosticReport(normalizedOptions),
        summary: createDiagnosticSummary({ ...normalizedOptions, fileName }),
        fileName,
    }
}

export function createDiagnosticReport(options: DiagnosticReportOptions = {}) {
    const rawLog = options.logText ?? logHub.getAllMsg()
    const sanitizedLog = sanitizeDiagnosticText(rawLog, options.extraSecrets)
    const runtimeLog = limitLogText(sanitizedLog, 600, 60000)
    const relevantLog = limitLogText(sanitizedLog.split('\n').filter(line => relevantLogPattern.test(line)).join('\n'), 120, 30000)
    const report = [
        '# BALH Diagnostic Report',
        '',
        '## Script',
        formatRows(getScriptSnapshot(options)),
        '',
        '## Page',
        formatRows(getPageSnapshot()),
        '',
        '## Settings',
        formatRows(getSettingsSnapshot()),
        '',
        '## Playback',
        formatRows(getPlaybackSnapshot()),
        '',
        '## Recent Relevant Log Lines',
        codeBlock(relevantLog || '(empty)'),
        '',
        '## Runtime Log',
        codeBlock(runtimeLog || '(empty)'),
        '',
        '## Redaction',
        '- access keys, tokens, selected cookies, and proxy credentials are redacted before download.',
    ].join('\n')
    return sanitizeDiagnosticText(report, options.extraSecrets)
}

export function createDiagnosticSummary(options: DiagnosticReportOptions = {}) {
    const script = getScriptSnapshot(options)
    const page = getPageSnapshot()
    const settings = getSettingsSnapshot()
    const playback = getPlaybackSnapshot()
    const summary = [
        '# BALH Issue Summary',
        '',
        formatRows({
            generated_at: script.generated_at,
            script_version: script.script_version,
            build_version: script.build_version,
            page_url: page.url,
            current_ep_id: playback.current_ep_id,
            playinfo_ep_id: playback.playinfo_ep_id,
            aid: playback.aid,
            cid: playback.cid,
            server_inner: settings.server_inner,
            server_custom: settings.server_custom,
            server_custom_hk: settings.server_custom_hk,
            server_custom_tw: settings.server_custom_tw,
            subtitle_ui_present: playback.subtitle_ui_present,
            player_status_state: playback.player_status_state,
            video_current_time: playback.video_current_time,
            diagnostic_file: options.fileName || createDiagnosticFileName(options),
        }),
        '',
        'Please attach the downloaded diagnostic file to this GitHub issue.',
    ].join('\n')
    return sanitizeDiagnosticText(summary, options.extraSecrets)
}

export function createDiagnosticFileName(options: DiagnosticReportOptions = {}) {
    const script = getScriptSnapshot(options)
    const playback = getPlaybackSnapshot()
    const timestamp = script.generated_at.replace(/[-:.]/g, '').replace(/Z$/, 'Z')
    const version = sanitizeFileName(`v${script.script_version}`)
    const build = sanitizeFileName(script.build_version || 'unknown-build')
    const episode = sanitizeFileName(playback.current_ep_id ? `ep${playback.current_ep_id}` : 'unknown-episode')
    return `balh-diagnostic-${version}-${build}-${episode}-${timestamp}.txt`
}

export function downloadDiagnosticReport(report: string, fileName: string) {
    try {
        const blob = new Blob([report], { type: 'text/plain;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = fileName
        link.rel = 'noopener'
        link.style.display = 'none'
        document.body.appendChild(link)
        link.click()
        setTimeout(() => {
            URL.revokeObjectURL(url)
            link.remove()
        }, 0)
        return true
    } catch (_) {
        return false
    }
}

export function sanitizeDiagnosticText(text: string, extraSecrets: SecretMap = {}) {
    let output = text
    output = redactMediaUrlQueries(output)
    output = output.replace(/((?:\bhttps?:)?\/\/)([^/\s?#@]+)@/g, '$1redacted@')
    output = output.replace(/\b[^\s:/?#@]+:[^\s/?#@]+@([a-z0-9.-]+\.[a-z]{2,}(?::\d+)?)/gi, 'redacted@$1')
    output = output.replace(new RegExp(`([?&](?:${sensitiveParamNames.join('|')})=)[^&#\\s"']+`, 'gi'), '$1<redacted>')
    output = output.replace(new RegExp(`(["']?(?:${sensitiveParamNames.join('|')})["']?\\s*[:=]\\s*["']?)[^"',}\\]\\s&]+`, 'gi'), '$1<redacted>')

    const secrets = collectSensitiveValues(extraSecrets)
    for (const [key, value] of Object.entries(secrets)) {
        if (!value) continue
        output = output.replace(new RegExp(escapeRegExp(value), 'g'), () => `<${sanitizeSecretLabel(key)}:redacted>`)
    }
    return output
}

function redactMediaUrlQueries(text: string) {
    return text.replace(urlTextPattern, (rawUrl) => {
        try {
            const url = new URL(rawUrl, window.location.href)
            if (!shouldRedactMediaUrlQuery(url)) return rawUrl
            return `${url.origin}${url.pathname}${url.search ? '?<media-query:redacted>' : ''}${url.hash ? '#<redacted>' : ''}`
        } catch (_) {
            return rawUrl
        }
    })
}

function shouldRedactMediaUrlQuery(url: URL) {
    if (!url.search) return false
    const host = url.hostname.toLowerCase()
    const path = url.pathname.toLowerCase()
    const isBilibiliMediaHost = host === 'bilivideo.com'
        || host.endsWith('.bilivideo.com')
        || host.endsWith('.bilivideo.cn')
    const hasSignedParam = signedMediaParamNames.some(name => url.searchParams.has(name))
    const hasMediaPath = /\/upgcxcode\//.test(path)
        || /\.(?:m4s|mp4|flv|m3u8)$/i.test(path)
    return hasSignedParam && (isBilibiliMediaHost || hasMediaPath)
}

function getScriptSnapshot(options: DiagnosticReportOptions) {
    return {
        generated_at: (options.now ?? new Date()).toISOString(),
        script_name: GM_info.script.name,
        script_version: GM_info.script.version,
        build_version: options.buildVersion ?? getBuildVersion(),
        script_handler: GM_info.scriptHandler,
        invoke_by: options.invokeBy ?? getInvokeBy(),
    }
}

function getPageSnapshot() {
    return {
        url: redactUrl(window.location.href),
        title: document.title,
        ready_state: document.readyState,
        referrer: document.referrer ? redactUrl(document.referrer) : '',
        user_agent: navigator.userAgent,
        language: navigator.language,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
    }
}

function getSettingsSnapshot() {
    return {
        mode: balh_config.mode,
        closed: boolLabel(balh_config.is_closed),
        blocked_vip: boolLabel(balh_config.blocked_vip),
        generate_sub: boolLabel(balh_config.generate_sub),
        enable_in_av: boolLabel(balh_config.enable_in_av),
        remove_pre_ad: boolLabel(balh_config.remove_pre_ad),
        server: redactUrl(balh_config.server),
        server_inner: balh_config.server_inner,
        server_custom: redactUrl(balh_config.server_custom),
        server_custom_hk: redactUrl(balh_config.server_custom_hk),
        server_custom_tw: redactUrl(balh_config.server_custom_tw),
        server_custom_cn: redactUrl(balh_config.server_custom_cn),
        server_custom_th: redactUrl(balh_config.server_custom_th),
        upos_server: balh_config.upos_server || '',
        has_access_key: boolLabel(hasStorageValue('access_key') || hasStorageValue('access_token')),
        is_login_balh: boolLabel(bilibili_login.isLogin()),
        is_login_bilibili: boolLabel(bilibili_login.isLoginBiliBili()),
    }
}

function getPlaybackSnapshot() {
    const anyWindow = window as any
    const playInfo = anyWindow.__PLAYURL_HYDRATE_DATA__ || anyWindow.__playinfo__ || anyWindow.__playinfo__origin
    const result = playInfo?.result || {}
    const videoInfo = result.video_info || playInfo?.video_info || {}
    const arc = result.arc || {}
    const episode = result.supplement?.ogv_episode_info || {}
    const season = result.supplement?.ogv_season_info || {}
    const initialState = anyWindow.__INITIAL_STATE__ || {}
    const initialEp = initialState.epInfo || {}
    const video = document.querySelector('video') as HTMLVideoElement | null
    const playerStatus = document.getElementById('balh-player-status')
    return {
        current_ep_id: window.location.pathname.match(/\/bangumi\/play\/ep(\d+)/)?.[1] || '',
        playinfo_ep_id: firstNonEmpty(episode.episode_id, initialEp.id, initialEp.ep_id),
        season_id: firstNonEmpty(season.season_id, result.season_id, initialState.mediaInfo?.season_id, initialState.mediaInfo?.seasonId),
        aid: firstNonEmpty(arc.aid, episode.aid, initialEp.aid, initialState.aid),
        cid: firstNonEmpty(arc.cid, episode.cid, initialEp.cid, initialState.cid),
        play_video_type: result.play_video_type || '',
        has_dash: boolLabel(!!videoInfo.dash),
        video_streams: videoInfo.dash?.video?.length ?? '',
        audio_streams: videoInfo.dash?.audio?.length ?? '',
        has_durl: boolLabel(Array.isArray(videoInfo.durl)),
        app_only: boolLabel(anyWindow.__balh_app_only__ === true),
        subtitle_ui_present: boolLabel(!!document.body?.innerText?.includes('多语言字幕')),
        player_status: playerStatus?.innerText?.trim() || '',
        player_status_state: playerStatus?.dataset?.state || '',
        video_current_time: video ? finiteNumber(video.currentTime) : '',
        video_duration: video ? finiteNumber(video.duration) : '',
        video_paused: video ? boolLabel(video.paused) : '',
        video_ready_state: video?.readyState ?? '',
        video_network_state: video?.networkState ?? '',
        video_error: video?.error ? formatMediaError(video.error) : '',
    }
}

function collectSensitiveValues(extraSecrets: SecretMap) {
    const values: Record<string, string> = {}
    const add = (key: string, value: any) => {
        if (typeof value !== 'string') return
        const trimmed = value.trim()
        if (trimmed.length < 4) return
        if (/^(true|false|null|undefined)$/i.test(trimmed)) return
        values[key] = trimmed
    }

    for (const key of sensitiveParamNames) {
        add(key, safeLocalStorageGet(key))
    }
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i)
            if (key && isSensitiveName(key)) {
                add(key, localStorage.getItem(key))
            }
        }
    } catch (_) {
    }
    try {
        for (const item of document.cookie.split('; ')) {
            const [key, value] = item.split('=')
            if (key && isSensitiveName(key)) {
                add(key, value)
            }
        }
    } catch (_) {
    }
    for (const [key, value] of Object.entries(extraSecrets)) {
        add(key, value)
    }
    return values
}

function redactUrl(value: any) {
    if (value == null || value === '') return ''
    const text = String(value)
    if (!/^(https?:)?\/\//i.test(text)) return sanitizeDiagnosticText(text)
    try {
        const parsedUrl = new URL(text, window.location.href)
        if (parsedUrl.username || parsedUrl.password) {
            parsedUrl.username = 'redacted'
            parsedUrl.password = ''
        }
        parsedUrl.searchParams.forEach((_, key) => {
            if (isSensitiveName(key)) {
                parsedUrl.searchParams.set(key, '<redacted>')
            }
        })
        return sanitizeDiagnosticText(parsedUrl.href)
    } catch (_) {
        return sanitizeDiagnosticText(text)
    }
}

function formatRows(rows: Record<string, any>) {
    return Object.entries(rows)
        .map(([key, value]) => `- ${key}: ${formatValue(value)}`)
        .join('\n')
}

function formatValue(value: any) {
    if (value == null || value === '') return '(empty)'
    if (typeof value === 'object') return sanitizeDiagnosticText(Objects.stringify(value))
    return sanitizeDiagnosticText(String(value))
}

function codeBlock(value: string) {
    return `\`\`\`text\n${sanitizeDiagnosticText(value).replace(/```/g, '`\\`\\`')}\n\`\`\``
}

function boolLabel(value: any) {
    return value ? 'true' : 'false'
}

function firstNonEmpty(...values: any[]) {
    const value = values.find(value => value != null && value !== '' && value !== '0')
    return value == null ? '' : String(value)
}

function finiteNumber(value: number) {
    return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : ''
}

function formatMediaError(error: MediaError) {
    return `code=${error.code}${error.message ? ` message=${error.message}` : ''}`
}

function safeLocalStorageGet(key: string) {
    try {
        return localStorage.getItem(key) || (localStorage as any)[key]
    } catch (_) {
        return undefined
    }
}

function hasStorageValue(key: string) {
    return !!safeLocalStorageGet(key)
}

function isSensitiveName(name: string) {
    return sensitiveParamNames.some(key => key.toLowerCase() === name.toLowerCase())
        || /(access|refresh|token|sess|secret|csrf|bili_jct)/i.test(name)
}

function lastLines(text: string, count: number) {
    const lines = text.split('\n')
    return lines.slice(Math.max(0, lines.length - count)).join('\n')
}

function limitLogText(text: string, maxLines: number, maxLength: number) {
    const lines = lastLines(text, maxLines)
        .split('\n')
        .map(line => limitLine(line, 3000))
        .join('\n')
    return limitText(lines, maxLength)
}

function limitLine(text: string, maxLength: number) {
    if (text.length <= maxLength) return text
    const edgeLength = Math.floor((maxLength - 80) / 2)
    return `${text.slice(0, edgeLength)}\n... line omitted ${text.length - maxLength} characters ...\n${text.slice(text.length - edgeLength)}`
}

function limitText(text: string, maxLength: number) {
    if (text.length <= maxLength) return text
    return `${text.slice(0, 1000)}\n... omitted ${text.length - maxLength} characters ...\n${text.slice(text.length - maxLength + 1000)}`
}

function getBuildVersion() {
    return typeof __BALH_BUILD_VERSION__ === 'string' ? __BALH_BUILD_VERSION__ : ''
}

function getInvokeBy() {
    return typeof invokeBy === 'string' ? invokeBy : ''
}

function escapeRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function sanitizeSecretLabel(value: string) {
    return value.replace(/[^a-z0-9._-]+/gi, '_').slice(0, 60) || 'secret'
}

function sanitizeFileName(value: string) {
    return value.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'unknown'
}
