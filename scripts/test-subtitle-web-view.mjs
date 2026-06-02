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

const { rewriteSubtitleWebViewResponse } = await import(`${pathToFileURL(outFile).href}?t=${Date.now()}`)

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
