#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(rootDir, '.codex-tmp/tests')
const outFile = path.join(outDir, 'subtitle-web-view.mjs')
const textEncoder = new TextEncoder()

await mkdir(outDir, { recursive: true })
await build({
    entryPoints: [path.join(rootDir, 'packages/unblock-area-limit/src/feature/bili/subtitle_web_view.ts')],
    outfile: outFile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
})

globalThis.document = {
    location: {
        href: 'https://www.bilibili.com/bangumi/play/ep664928',
    },
}

const { rewriteSubtitleBodyJson, rewriteSubtitleMetadataUrl, rewriteSubtitleWebViewResponse } = await import(`${pathToFileURL(outFile).href}?t=${Date.now()}`)

const response = fieldMessage(1, fieldMessage(3, concat([
    fieldVarint(1, 10n),
    fieldString(2, '10'),
    fieldString(3, 'zh-Hant'),
    fieldString(4, '中文（繁體）'),
    fieldString(5, '//subtitle.bilibili.com/example?auth_key=test'),
    fieldString(8, '中文'),
])))

assert.equal(rewriteSubtitleWebViewResponse(response.buffer, { generateSub: false }), null)

const rewritten = rewriteSubtitleWebViewResponse(response.buffer, { generateSub: true })
assert.ok(rewritten instanceof ArrayBuffer)

const rewrittenText = Buffer.from(rewritten).toString('utf8')
assert.match(rewrittenText, /zh-Hant/)
assert.match(rewrittenText, /zh-Hans/)
assert.match(rewrittenText, /中文（简体）生成/)
assert.match(rewrittenText, /translate=1/)
assert.match(rewrittenText, /from=tw/)
assert.match(rewrittenText, /to=cn/)

const subtitleBody = {
    body: [
        { content: '繁體字幕 - 測試' },
        { content: '第二行—測試' },
    ],
}
const rewrittenBody = rewriteSubtitleBodyJson(subtitleBody, 'https://aisubtitle.hdslb.com/bfs/subtitle/example.json?translate=1&from=tw&to=cn')
assert.equal(rewrittenBody, subtitleBody)
assert.equal(subtitleBody.body[0].content, '繁体字幕\n- 测试')
assert.equal(subtitleBody.body[1].content, '第二行—测试')
assert.equal(rewriteSubtitleBodyJson({ body: [{ content: '繁體字幕' }] }, 'https://aisubtitle.hdslb.com/bfs/subtitle/example.json'), null)

const metadataIds = { aid: 856724277, cid: 794496427, durationMs: 1469870 }
const subtitleViewUrl = rewriteSubtitleMetadataUrl('https://api.bilibili.com/x/v2/subtitle/web/view?context_ext=%7B%22video_type%22%3A2%7D&type=1&cur_production_type=0', metadataIds)
assert.equal(subtitleViewUrl, 'https://api.bilibili.com/x/v2/subtitle/web/view?context_ext=%7B%22video_type%22%3A2%7D&type=1&cur_production_type=0&oid=794496427&pid=856724277&duration=1469870')

const dmViewUrl = rewriteSubtitleMetadataUrl('https://api.bilibili.com/x/v2/dm/web/view?type=1&oid=null&pid=null&duration=0&without_subtitle=true', metadataIds)
assert.equal(dmViewUrl, 'https://api.bilibili.com/x/v2/dm/web/view?type=1&oid=794496427&pid=856724277&duration=1469870&without_subtitle=false')

const dmViewWithIdsUrl = rewriteSubtitleMetadataUrl('https://api.bilibili.com/x/v2/dm/web/view?type=1&oid=123&pid=456&duration=789&without_subtitle=true', metadataIds)
assert.equal(dmViewWithIdsUrl, 'https://api.bilibili.com/x/v2/dm/web/view?type=1&oid=123&pid=456&duration=789&without_subtitle=false')

const dmViewWithoutGlobalIdsUrl = rewriteSubtitleMetadataUrl('https://api.bilibili.com/x/v2/dm/web/view?type=1&oid=123&pid=456&duration=0&without_subtitle=true', { durationMs: 789 })
assert.equal(dmViewWithoutGlobalIdsUrl, 'https://api.bilibili.com/x/v2/dm/web/view?type=1&oid=123&pid=456&duration=789&without_subtitle=false')

assert.equal(rewriteSubtitleMetadataUrl('https://api.bilibili.com/x/v2/subtitle/web/view?type=1&oid=794496427&pid=856724277', metadataIds), null)
assert.equal(rewriteSubtitleMetadataUrl('https://example.com/x/v2/subtitle/web/view', metadataIds), null)

console.log('subtitle-web-view tests passed')

function fieldVarint(fieldNumber, value) {
    return concat([
        writeVarint(BigInt((fieldNumber << 3) | 0)),
        writeVarint(value),
    ])
}

function fieldString(fieldNumber, value) {
    return fieldBytes(fieldNumber, textEncoder.encode(value))
}

function fieldMessage(fieldNumber, bytes) {
    return fieldBytes(fieldNumber, bytes)
}

function fieldBytes(fieldNumber, bytes) {
    return concat([
        writeVarint(BigInt((fieldNumber << 3) | 2)),
        writeVarint(BigInt(bytes.byteLength)),
        bytes,
    ])
}

function writeVarint(value) {
    const bytes = []
    let rest = value
    while (rest >= 0x80n) {
        bytes.push(Number((rest & 0x7fn) | 0x80n))
        rest >>= 7n
    }
    bytes.push(Number(rest))
    return new Uint8Array(bytes)
}

function concat(parts) {
    const length = parts.reduce((total, part) => total + part.byteLength, 0)
    const output = new Uint8Array(length)
    let offset = 0
    for (const part of parts) {
        output.set(part, offset)
        offset += part.byteLength
    }
    return output
}
