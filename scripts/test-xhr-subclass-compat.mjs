#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(rootDir, '.codex-tmp/tests')
const outFile = path.join(outDir, 'xhr-subclass-compat.mjs')

await mkdir(outDir, { recursive: true })
await build({
    entryPoints: [path.join(rootDir, 'packages/unblock-area-limit/src/util/inject-xhr.ts')],
    outfile: outFile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
})

const getterCalls = []
const lifecycle = []
const nativeInstances = new WeakSet()
const nativeState = new WeakMap()

class NativeXMLHttpRequest {
    constructor() {
        nativeInstances.add(this)
        nativeState.set(this, {
            readyState: 0,
            responseURL: '',
            response: 'native-response:initial',
            responseText: 'native-response-text:initial',
            onreadystatechange: null,
        })
    }

    get readyState() {
        return getNativeState(this).readyState
    }

    get responseURL() {
        return getNativeState(this).responseURL
    }

    get onreadystatechange() {
        return getNativeState(this).onreadystatechange
    }

    set onreadystatechange(value) {
        getNativeState(this).onreadystatechange = value
    }

    get response() {
        getterCalls.push('native:response')
        return getNativeState(this).response
    }

    get responseText() {
        getterCalls.push('native:responseText')
        return getNativeState(this).responseText
    }

    open(method, url, ...rest) {
        const state = getNativeState(this)
        lifecycle.push('native:open')
        state.openCalls = (state.openCalls ?? 0) + 1
        state.openArgs = [method, url, ...rest]
        state.method = method
        state.url = url
        state.readyState = 1
    }

    send(body) {
        const state = getNativeState(this)
        lifecycle.push('native:send')
        state.requestBody = body
        state.response = 'native-response:complete'
        state.responseText = 'native-response-text:complete'
        state.responseURL = new URL(state.url, document.location.href).href
        state.readyState = 4
        state.onreadystatechange?.call(this, { type: 'readystatechange' })
    }
}

Object.defineProperty(NativeXMLHttpRequest.prototype, 'onloadend', {
    configurable: true,
    get() {
        return null
    },
})

function getNativeState(instance) {
    assert.equal(nativeInstances.has(instance), true, 'native access must retain the real XHR receiver')
    return nativeState.get(instance)
}

const documentMock = {
    location: {
        href: 'https://www.bilibili.com/bangumi/play/ep1',
    },
    getElementById() {
        return null
    },
}
const windowMock = {
    XMLHttpRequest: NativeXMLHttpRequest,
    Promise,
    console,
    document: documentMock,
    top: null,
    parent: null,
    addEventListener() { },
    postMessage() { },
}
windowMock.top = windowMock
windowMock.parent = windowMock

globalThis.window = windowMock
globalThis.document = documentMock
globalThis.XMLHttpRequest = NativeXMLHttpRequest
globalThis.GM_info = {
    script: {
        name: '解除B站区域限制.test',
    },
}

const { injectXhr } = await import(pathToFileURL(outFile).href)

const openUrlCalls = []
const requestCalls = []
const responseCalls = []
injectXhr({
    transformOpenUrl(url) {
        lifecycle.push('balh:transformOpenUrl')
        openUrlCalls.push(url)
        return url === '/media/original' ? '/media/routed' : null
    },
    transformRequest({ url, container }) {
        lifecycle.push('balh:transformRequest')
        requestCalls.push({
            url,
            method: container.__method,
        })
        return null
    },
    transformResponse({ url, response, xhr }) {
        lifecycle.push('balh:transformResponse')
        responseCalls.push({
            url,
            response,
            responseText: xhr.responseText,
            isOuterSubclass: xhr instanceof XMLHttpRequest,
        })
        return `balh:${response}`
    },
})

const BALHWrappedXHR = windowMock.XMLHttpRequest
const outerState = new WeakMap()
class XMLHttpRequest extends BALHWrappedXHR {
    #privatePrefix = 'outer-private'

    constructor() {
        super()
        outerState.set(this, { prefix: 'outer-weak' })
    }

    get response() {
        getterCalls.push('outer:response')
        return `${this.#privatePrefix}:${outerState.get(this).prefix}:${super.response}`
    }

    get responseText() {
        getterCalls.push('outer:responseText')
        return `${this.#privatePrefix}:${outerState.get(this).prefix}:${super.responseText}`
    }

    privateState() {
        return `${this.#privatePrefix}:${outerState.get(this).prefix}`
    }
}

const xhr = new XMLHttpRequest()

assert.equal(Object.getPrototypeOf(xhr), XMLHttpRequest.prototype)
assert.equal(xhr instanceof XMLHttpRequest, true)
assert.equal(xhr instanceof BALHWrappedXHR, true)
assert.equal(xhr instanceof NativeXMLHttpRequest, true)
assert.equal(nativeInstances.has(xhr), true)
assert.equal(outerState.has(xhr), true)
assert.equal(xhr.privateState(), 'outer-private:outer-weak')
assert.equal('onloadend' in xhr, false)
assert.equal(typeof Object.getOwnPropertyDescriptor(xhr, 'response').get, 'function')
assert.equal(typeof Object.getOwnPropertyDescriptor(xhr, 'responseText').get, 'function')
assert.equal(typeof Object.getOwnPropertyDescriptor(NativeXMLHttpRequest.prototype, 'response').get, 'function')
assert.equal(typeof Object.getOwnPropertyDescriptor(NativeXMLHttpRequest.prototype, 'responseText').get, 'function')
assert.equal(xhr.response, 'outer-private:outer-weak:native-response:initial')
assert.equal(xhr.responseText, 'outer-private:outer-weak:native-response-text:initial')

const callbackCalls = []
xhr.open('POST', '/api/playurl')
xhr.onreadystatechange = function (event) {
    lifecycle.push('outer:onreadystatechange')
    callbackCalls.push({
        eventType: event.type,
        receiver: this,
        response: this.response,
        responseText: this.responseText,
    })
}
xhr.send('request-body')

assert.deepEqual(lifecycle, [
    'native:open',
    'native:send',
    'balh:transformRequest',
    'balh:transformResponse',
    'outer:onreadystatechange',
])
assert.deepEqual(requestCalls, [{
    url: '/api/playurl',
    method: 'POST',
}])
assert.deepEqual(responseCalls, [{
    url: 'https://www.bilibili.com/api/playurl',
    response: 'outer-private:outer-weak:native-response:complete',
    responseText: 'outer-private:outer-weak:native-response-text:complete',
    isOuterSubclass: true,
}])
assert.equal(callbackCalls.length, 1)
assert.equal(callbackCalls[0].eventType, 'readystatechange')
assert.equal(callbackCalls[0].receiver, xhr)
assert.equal(callbackCalls[0].response, 'balh:outer-private:outer-weak:native-response:complete')
assert.equal(callbackCalls[0].responseText, 'balh:outer-private:outer-weak:native-response:complete')
assert.deepEqual(getterCalls, [
    'outer:response',
    'native:response',
    'outer:responseText',
    'native:responseText',
    'outer:response',
    'native:response',
    'outer:responseText',
    'native:responseText',
])
assert.deepEqual(openUrlCalls, [], 'POST must bypass the pre-open URL mapper')

lifecycle.length = 0
getterCalls.length = 0
requestCalls.length = 0
responseCalls.length = 0

const routedXhr = new XMLHttpRequest()
assert.equal(Object.getPrototypeOf(routedXhr), XMLHttpRequest.prototype)
assert.equal(routedXhr instanceof XMLHttpRequest, true)
assert.equal(routedXhr instanceof BALHWrappedXHR, true)
assert.equal(routedXhr instanceof NativeXMLHttpRequest, true)
assert.equal(nativeInstances.has(routedXhr), true)
assert.equal(outerState.has(routedXhr), true)
assert.equal(routedXhr.privateState(), 'outer-private:outer-weak')

routedXhr.open('gEt', '/media/original', false, 'media-user', 'media-password')
routedXhr.send('media-body')

const routedNativeState = nativeState.get(routedXhr)
assert.equal(routedNativeState.openCalls, 1, 'routing must call native open exactly once')
assert.deepEqual(routedNativeState.openArgs, [
    'gEt',
    '/media/routed',
    false,
    'media-user',
    'media-password',
])
assert.equal(routedNativeState.requestBody, 'media-body')
assert.deepEqual(openUrlCalls, ['/media/original'])
assert.deepEqual(requestCalls, [{
    url: '/media/routed',
    method: 'gEt',
}])
assert.deepEqual(responseCalls, [{
    url: 'https://www.bilibili.com/media/routed',
    response: 'outer-private:outer-weak:native-response:complete',
    responseText: 'outer-private:outer-weak:native-response-text:complete',
    isOuterSubclass: true,
}])
assert.deepEqual(lifecycle, [
    'balh:transformOpenUrl',
    'native:open',
    'native:send',
    'balh:transformRequest',
    'balh:transformResponse',
])
assert.equal(routedXhr.privateState(), 'outer-private:outer-weak')
assert.equal(nativeInstances.has(routedXhr), true)
assert.equal(outerState.has(routedXhr), true)

console.log('xhr-subclass-compat tests passed')
