#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(rootDir, '.codex-tmp/tests')
const outFile = path.join(outDir, 'async-request.mjs')

await mkdir(outDir, { recursive: true })
await build({
    entryPoints: [path.join(rootDir, 'packages/unblock-area-limit/src/util/async.ts')],
    outfile: outFile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
})

const windowMock = {
    Promise,
    console,
    top: null,
    parent: null,
    addEventListener() { },
    postMessage() { },
}
windowMock.top = windowMock
windowMock.parent = windowMock

globalThis.window = windowMock
globalThis.document = {
    location: {
        href: 'https://www.bilibili.com/bangumi/play/ep664928',
    },
}
windowMock.document = globalThis.document
globalThis.GM_info = {
    script: {
        name: '解除B站区域限制.test',
    },
}
globalThis.DOMParser = class MockDOMParser {
    parseFromString(text, contentType) {
        return {
            contentType,
            documentElement: {
                nodeName: 'root',
                textContent: text,
                children: [],
            },
        }
    }
}

let fetchCalls = []
windowMock.fetch = async (url, init = {}) => {
    fetchCalls.push({ url, init })
    if (url.includes('/json-text')) {
        return new Response('{"ok":"text"}', {
            status: 200,
            headers: { 'content-type': 'text/plain' },
        })
    }
    if (url.includes('/json')) {
        return new Response('{"ok":true}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
        })
    }
    if (url.includes('/html')) {
        return new Response('<html>ok</html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
        })
    }
    if (url.includes('/xml')) {
        return new Response('<root>ok</root>', {
            status: 200,
            headers: { 'content-type': 'application/xml' },
        })
    }
    if (url.includes('/fetch-fail') || url.includes('/fetch-and-xhr-fail')) {
        throw new Error('fetch failed')
    }
    return new Response('not found', { status: 404 })
}

const xhrCalls = []
class MockXMLHttpRequest {
    readyState = 0
    status = 0
    statusText = ''
    responseText = ''
    contentType = ''
    withCredentials = false
    headers = {}
    onreadystatechange = null

    open(method, url) {
        this.method = method
        this.url = url
    }

    setRequestHeader(name, value) {
        this.headers[name] = value
    }

    getResponseHeader(name) {
        return name.toLowerCase() === 'content-type' ? this.contentType : null
    }

    send() {
        xhrCalls.push(this)
        this.readyState = 4
        if (this.url.includes('/fetch-and-xhr-fail')) {
            this.status = 0
            this.statusText = ''
            this.responseText = ''
            this.onreadystatechange?.({})
            return
        }
        this.status = 200
        if (this.url.includes('/fetch-fail-html')) {
            this.contentType = 'text/html'
            this.responseText = '<html>fallback</html>'
        } else if (this.url.includes('/fetch-fail-xml')) {
            this.contentType = 'application/xml'
            this.responseText = '<root>fallback</root>'
        } else {
            this.contentType = 'application/json'
            this.responseText = '{"fallback":true}'
        }
        this.onreadystatechange?.({})
    }
}
globalThis.XMLHttpRequest = MockXMLHttpRequest

const { Async } = await import(`${pathToFileURL(outFile).href}?t=${Date.now()}`)

const json = await Async.ajax('https://user:pass@example.com/json')
assert.deepEqual(json, { ok: true })
assert.equal(fetchCalls[0].url, 'https://example.com/json')
assert.equal(fetchCalls[0].init.credentials, 'include')
assert.equal(fetchCalls[0].init.headers.Authorization, 'Basic dXNlcjpwYXNz')

const jsonFromText = await Async.ajax('https://example.com/json-text')
assert.deepEqual(jsonFromText, { ok: 'text' })

const html = await Async.ajax('https://example.com/html')
assert.equal(html, '<html>ok</html>')

const xml = await Async.ajax('https://example.com/xml')
assert.equal(xml.documentElement.nodeName, 'root')
assert.equal(xml.documentElement.textContent, '<root>ok</root>')

const fallback = await Async.ajax('https://example.com/fetch-fail')
assert.deepEqual(fallback, { fallback: true })
assert.equal(xhrCalls.length, 1)
assert.equal(xhrCalls[0].withCredentials, true)

const fallbackHtml = await Async.ajax('https://example.com/fetch-fail-html')
assert.equal(fallbackHtml, '<html>fallback</html>')

const fallbackXml = await Async.ajax('https://example.com/fetch-fail-xml')
assert.equal(fallbackXml.documentElement.nodeName, 'root')
assert.equal(fallbackXml.documentElement.textContent, '<root>fallback</root>')

await assert.rejects(
    Async.ajax('https://example.com/fetch-and-xhr-fail'),
    {
        status: 0,
        statusText: 'error',
        readyState: 0,
    }
)

console.log('async-request tests passed')
