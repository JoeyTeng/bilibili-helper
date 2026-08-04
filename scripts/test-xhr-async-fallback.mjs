#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(rootDir, '.codex-tmp/tests')
const outFile = path.join(outDir, 'xhr-async-fallback.mjs')

await mkdir(outDir, { recursive: true })
await build({
    entryPoints: [path.join(rootDir, 'packages/unblock-area-limit/src/util/inject-xhr.ts')],
    outfile: outFile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
})

const documentMock = {
    location: {
        href: 'https://www.bilibili.com/bangumi/play/ep1',
    },
    getElementById() {
        return null
    },
}
const windowMock = {
    XMLHttpRequest: null,
    Event,
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
globalThis.GM_info = {
    script: {
        name: '解除B站区域限制.test',
    },
}

const reportedErrors = []
globalThis.reportError = error => reportedErrors.push(error)

const { injectXhr } = await import(pathToFileURL(outFile).href)

await testProxySuccessBeforeLateNative()
await testListenerOnlyNativeFallback()
await testNativeFallbackMetadata()
await testCallbackThrowIsolation()
await testReusedInstanceClearsReplacement()
await testFailedOpenPreservesCompletedReplacement()
await testFailedOpenPreservesPendingNativeFallback()
await testSyntheticConverterDoesNotPrecommitValidOpen()
await testFailedOuterOpenPreservesReentrantInnerCompletion()
await testReusedInstanceIgnoresStaleAsyncResult()
await testAbortInvalidatesAsyncResult()
await testInvalidSendHasNoProxySideEffects()
await testTransformFailuresFallBackToNative()
await testSynchronousNativeCompletionRemainsBlocked()
await testTransformResponseThenable()

console.log('xhr async fallback tests passed')

async function testProxySuccessBeforeLateNative() {
    const request = createDeferred()
    let transformResponseCalls = 0
    const { NativeXMLHttpRequest } = installInjectedXhr({
        transformRequest() {
            return request.promise
        },
        transformResponse() {
            transformResponseCalls += 1
            return { source: 'native-transformed' }
        },
    })
    const xhr = new window.XMLHttpRequest()
    const callbacks = []
    const listeners = []
    xhr.open('GET', '/x/player/playurl')
    xhr.onreadystatechange = function (event) {
        callbacks.push(snapshotCallback(this, event))
    }
    xhr.addEventListener('readystatechange', function (event) {
        listeners.push(snapshotCallback(this, event))
    })
    xhr.send()

    const proxyResponse = { source: 'proxy' }
    request.resolve(proxyResponse)
    await flushPromises()
    assert.equal(callbacks.length, 0, 'proxy data must wait for trustworthy native completion metadata')
    assert.equal(listeners.length, 0)
    assert.equal(xhr.readyState, 1)

    const nativeFixture = createNativeFixture({
        response: { source: 'late-native' },
        responseText: '{"source":"late-native"}',
        responseURL: 'https://api.bilibili.com/trusted-final-url',
        status: 206,
        statusText: 'Partial Content',
    })
    NativeXMLHttpRequest.instances[0].complete(nativeFixture)
    await flushPromises()
    assert.equal(callbacks.length, 1)
    assert.equal(listeners.length, 1)
    for (const delivery of [callbacks[0], listeners[0]]) {
        assert.equal(delivery.receiver, xhr)
        assert.equal(delivery.eventType, 'readystatechange')
        assert.equal(delivery.eventTarget, xhr)
        assert.equal(delivery.eventCurrentTarget, xhr)
        assert.equal(delivery.response, proxyResponse)
        assert.equal(delivery.responseText, JSON.stringify(proxyResponse))
        assert.equal(delivery.readyState, 4)
        assert.equal(delivery.responseURL, nativeFixture.responseURL)
        assert.equal(delivery.status, nativeFixture.status)
        assert.equal(delivery.statusText, nativeFixture.statusText)
    }
    assert.equal(xhr.response, proxyResponse, 'late native completion must not overwrite proxy data')
    assert.equal(transformResponseCalls, 0, 'blocked native data must not enter transformResponse')
}

async function testListenerOnlyNativeFallback() {
    const request = createDeferred()
    const { NativeXMLHttpRequest } = installInjectedXhr({
        transformRequest() {
            return request.promise
        },
        transformResponse() {
            return null
        },
    })
    const xhr = new window.XMLHttpRequest()
    const listeners = []
    xhr.open('GET', '/listener-only')
    xhr.addEventListener('readystatechange', function (event) {
        listeners.push(snapshotCallback(this, event))
    })
    xhr.send()
    NativeXMLHttpRequest.instances[0].complete(createNativeFixture({ response: 'listener-native' }))
    assert.equal(listeners.length, 0, 'listener-only consumers must remain blocked while proxy is pending')

    request.reject(new Error('listener proxy unavailable'))
    await flushPromises()
    assert.equal(listeners.length, 1)
    assert.equal(listeners[0].receiver, xhr)
    assert.equal(listeners[0].eventTarget, xhr)
    assert.equal(listeners[0].eventCurrentTarget, xhr)
    assert.equal(listeners[0].response, 'listener-native')
}

async function testNativeFallbackMetadata() {
    const fixtures = [
        createNativeFixture({
            response: null,
            responseText: '',
            responseURL: 'https://api.bilibili.com/null-response',
            status: 204,
            statusText: 'No Content',
            headers: { 'content-type': 'application/json', 'x-fixture': 'null' },
        }),
        createNativeFixture({
            response: 'native-response',
            responseText: 'native-response-text',
            responseURL: 'https://api.bilibili.com/text-response',
            status: 206,
            statusText: 'Partial Content',
            headers: { 'content-type': 'text/plain', 'x-fixture': 'text' },
        }),
    ]

    for (const fixture of fixtures) {
        const request = createDeferred()
        let transformResponseCalls = 0
        const { NativeXMLHttpRequest } = installInjectedXhr({
            transformRequest() {
                return request.promise
            },
            transformResponse() {
                transformResponseCalls += 1
                return 'unexpected-transform'
            },
        })
        const xhr = new window.XMLHttpRequest()
        const callbacks = []
        const listeners = []
        xhr.open('GET', '/pgc/player/web/playurl')
        xhr.onreadystatechange = function (event) {
            callbacks.push(snapshotCallback(this, event))
        }
        xhr.addEventListener('readystatechange', function (event) {
            listeners.push(snapshotCallback(this, event))
        })
        xhr.send()

        NativeXMLHttpRequest.instances[0].complete(fixture)
        await flushPromises()
        assert.equal(callbacks.length, 0, 'native completion must wait while proxy is pending')
        assert.equal(listeners.length, 0)
        assert.equal(transformResponseCalls, 0)

        request.reject(new Error('proxy unavailable'))
        await flushPromises()
        assert.equal(callbacks.length, 1, 'proxy failure must dispatch the saved native completion once')
        assert.equal(listeners.length, 1)
        for (const delivery of [callbacks[0], listeners[0]]) {
            assert.equal(delivery.receiver, xhr)
            assert.equal(delivery.eventType, 'readystatechange')
            assert.equal(delivery.eventTarget, xhr)
            assert.equal(delivery.eventCurrentTarget, xhr)
            assert.equal(delivery.readyState, 4)
            assert.equal(delivery.response, fixture.response)
            assert.equal(delivery.responseText, fixture.responseText)
            assert.equal(delivery.responseType, fixture.responseType)
            assert.equal(delivery.responseURL, fixture.responseURL)
            assert.equal(delivery.responseXML, fixture.responseXML)
            assert.equal(delivery.status, fixture.status)
            assert.equal(delivery.statusText, fixture.statusText)
            assert.equal(delivery.allResponseHeaders, serializeHeaders(fixture.headers))
            assert.equal(delivery.fixtureHeader, fixture.headers['x-fixture'])
        }
    }
}

async function testCallbackThrowIsolation() {
    reportedErrors.length = 0
    const request = createDeferred()
    let capturedContainer
    const { NativeXMLHttpRequest } = installInjectedXhr({
        transformRequest({ container }) {
            capturedContainer = container
            return request.promise
        },
        transformResponse() {
            return null
        },
    })
    const xhr = new window.XMLHttpRequest()
    const callbackError = new Error('callback failure')
    let callbackCalls = 0
    xhr.open('GET', '/x/player/playurl')
    xhr.onreadystatechange = function () {
        callbackCalls += 1
        throw callbackError
    }
    xhr.send()
    NativeXMLHttpRequest.instances[0].complete(createNativeFixture({
        response: { source: 'native-fallback' },
        responseText: '{"source":"native-fallback"}',
    }))

    const proxyResponse = { source: 'proxy' }
    request.resolve(proxyResponse)
    await flushPromises()
    assert.equal(callbackCalls, 1, 'callback failure must not trigger native fallback dispatch')
    assert.deepEqual(reportedErrors, [callbackError])
    assert.equal(capturedContainer.__block_response, true)
    assert.equal(xhr.response, proxyResponse)
}

async function testReusedInstanceClearsReplacement() {
    const requests = [createDeferred(), createDeferred()]
    const containers = []
    const { NativeXMLHttpRequest } = installInjectedXhr({
        transformRequest({ container }) {
            containers.push(container)
            return requests[containers.length - 1].promise
        },
        transformResponse() {
            return null
        },
    })
    const xhr = new window.XMLHttpRequest()
    const callbacks = []
    xhr.onreadystatechange = function (event) {
        callbacks.push(snapshotCallback(this, event))
    }

    xhr.open('GET', '/first')
    xhr.send()
    requests[0].resolve({ request: 1 })
    await flushPromises()
    assert.equal(xhr.readyState, 1, 'proxy data must not publish before native completion')
    assert.equal(xhr.response, null)
    NativeXMLHttpRequest.instances[0].complete(createNativeFixture())
    await flushPromises()
    assert.deepEqual(xhr.response, { request: 1 })
    assert.equal(xhr.responseText, '{"request":1}')
    assert.equal(xhr.readyState, 4)

    xhr.open('GET', '/second')
    assert.equal(xhr.response, null, 'open must remove the previous response overlay')
    assert.equal(xhr.responseText, '', 'open must remove the previous responseText overlay')
    assert.equal(xhr.readyState, 1, 'open must expose the new native readyState')
    assert.equal('__has_replacement' in containers[0], false)
    assert.equal('__block_response' in containers[0], false)
    assert.equal('__response' in containers[0], false)
    assert.equal('__redirect' in containers[0], false)

    xhr.send()
    NativeXMLHttpRequest.instances[0].complete(createNativeFixture({
        response: 'second-native',
        responseText: 'second-native',
    }))
    requests[1].reject(new Error('second proxy failed'))
    await flushPromises()
    assert.equal(callbacks.length, 2)
    assert.equal(callbacks[1].response, 'second-native')
    assert.equal(callbacks[1].receiver, xhr)
}

async function testFailedOpenPreservesCompletedReplacement() {
    const request = createDeferred()
    let container
    const { NativeXMLHttpRequest } = installInjectedXhr({
        transformRequest(context) {
            container = context.container
            return request.promise
        },
        transformResponse() {
            return null
        },
    })
    const xhr = new window.XMLHttpRequest()
    const callbacks = []
    xhr.open('GET', '/completed-before-invalid-open')
    xhr.onreadystatechange = function (event) {
        callbacks.push(snapshotCallback(this, event))
    }
    xhr.send()
    NativeXMLHttpRequest.instances[0].complete(createNativeFixture())
    request.resolve({ source: 'completed-proxy' })
    await flushPromises()
    assert.equal(callbacks.length, 1)
    assert.deepEqual(xhr.response, { source: 'completed-proxy' })

    let stateDuringMethodConversion
    const invalidMethod = {
        toString() {
            xhr.dispatchEvent(new Event('readystatechange'))
            stateDuringMethodConversion = {
                readyState: xhr.readyState,
                response: xhr.response,
                responseText: xhr.responseText,
            }
            return 'INVALID METHOD'
        },
    }
    assert.throws(
        () => xhr.open(invalidMethod, '/must-not-reset-completed-request'),
        error => error?.name === 'SyntaxError',
    )
    assert.deepEqual(stateDuringMethodConversion, {
        readyState: 4,
        response: { source: 'completed-proxy' },
        responseText: '{"source":"completed-proxy"}',
    })
    assert.equal(callbacks.length, 1, 'failed open must not redispatch the completed request')
    assert.equal(xhr.readyState, 4)
    assert.deepEqual(xhr.response, { source: 'completed-proxy' })
    assert.equal(xhr.responseText, '{"source":"completed-proxy"}')
    assert.equal(container.__method, 'GET')
    assert.equal(container.__url, '/completed-before-invalid-open')
    assert.equal(container.__has_replacement, true)
    assert.equal(container.__block_response, true)

    NativeXMLHttpRequest.instances[0].dispatchReadyStateChangeOnNextOpen()
    xhr.open('GET', '/successful-open-after-failure')
    assert.equal(callbacks.length, 2)
    assert.equal(callbacks[1].readyState, 1)
    assert.equal(callbacks[1].response, null, 'successful open must clear overlays before its native event is observed')
    assert.equal(container.__method, 'GET')
    assert.equal(container.__url, '/successful-open-after-failure')
    assert.equal('__has_replacement' in container, false)
    assert.equal('__block_response' in container, false)
}

async function testFailedOpenPreservesPendingNativeFallback() {
    const request = createDeferred()
    let container
    const { NativeXMLHttpRequest } = installInjectedXhr({
        transformRequest(context) {
            container = context.container
            return request.promise
        },
        transformResponse() {
            return null
        },
    })
    const xhr = new window.XMLHttpRequest()
    const callbacks = []
    xhr.open('GET', '/pending-before-invalid-open')
    xhr.onreadystatechange = function (event) {
        callbacks.push(snapshotCallback(this, event))
    }
    xhr.send()
    NativeXMLHttpRequest.instances[0].complete(createNativeFixture({
        response: 'held-native',
        responseText: 'held-native',
    }))
    assert.equal(callbacks.length, 0, 'native DONE must remain held while proxy conversion is pending')

    const invalidMethod = {
        toString() {
            xhr.dispatchEvent(new Event('readystatechange'))
            return 'INVALID METHOD'
        },
    }
    assert.throws(
        () => xhr.open(invalidMethod, '/must-not-reset-pending-request'),
        error => error?.name === 'SyntaxError',
    )
    assert.equal(callbacks.length, 0)
    assert.equal(container.__method, 'GET')
    assert.equal(container.__url, '/pending-before-invalid-open')
    assert.equal(container.__block_response, true)

    request.resolve({ source: 'pending-proxy' })
    await flushPromises()
    await flushPromises()
    assert.equal(callbacks.length, 1, 'the original held DONE must be delivered exactly once')
    assert.deepEqual(callbacks[0].response, { source: 'pending-proxy' })
    assert.equal(callbacks[0].readyState, 4)
}

async function testSyntheticConverterDoesNotPrecommitValidOpen() {
    const { NativeXMLHttpRequest } = installInjectedXhr({
        transformRequest() {
            return null
        },
        transformResponse({ url }) {
            return url.endsWith('/old-native') ? { source: 'old-replacement' } : null
        },
    })
    const xhr = new window.XMLHttpRequest()
    const callbacks = []
    xhr.onreadystatechange = function (event) {
        callbacks.push(snapshotCallback(this, event))
    }
    xhr.open('GET', '/old-request')
    xhr.send()
    NativeXMLHttpRequest.instances[0].complete(createNativeFixture({
        responseURL: 'https://api.bilibili.com/old-native',
    }))
    assert.equal(callbacks.length, 1)
    assert.deepEqual(callbacks[0].response, { source: 'old-replacement' })

    const validMethod = {
        toString() {
            xhr.dispatchEvent(new Event('readystatechange'))
            return 'GET'
        },
    }
    xhr.open(validMethod, '/valid-after-synthetic-converter-event')
    assert.equal(callbacks.length, 1, 'converter event must not publish or precommit the new request')
    assert.equal(xhr.readyState, 1)
    assert.equal(xhr.response, null)

    xhr.send()
    NativeXMLHttpRequest.instances[0].complete(createNativeFixture({
        response: 'new-native',
        responseText: 'new-native',
        responseURL: 'https://api.bilibili.com/new-native',
    }))
    assert.equal(callbacks.length, 2, 'the valid request DONE must not be suppressed by old completion state')
    assert.equal(callbacks[1].response, 'new-native')
}

async function testFailedOuterOpenPreservesReentrantInnerCompletion() {
    const request = createDeferred()
    const { NativeXMLHttpRequest } = installInjectedXhr({
        transformRequest() {
            return request.promise
        },
        transformResponse() {
            return null
        },
    })
    const xhr = new window.XMLHttpRequest()
    const callbacks = []
    xhr.onreadystatechange = function (event) {
        callbacks.push(snapshotCallback(this, event))
    }
    const invalidOuterMethod = {
        toString() {
            NativeXMLHttpRequest.instances[0].dispatchReadyStateChangeOnNextOpen()
            xhr.open('GET', '/reentrant-inner')
            xhr.send()
            NativeXMLHttpRequest.instances[0].complete(createNativeFixture({
                response: 'inner-native',
                responseText: 'inner-native',
            }))
            return 'INVALID METHOD'
        },
    }

    assert.throws(
        () => xhr.open(invalidOuterMethod, '/invalid-outer'),
        error => error?.name === 'SyntaxError',
    )
    assert.equal(callbacks.length, 1, 'inner OPENED should publish, while its DONE remains held')
    assert.equal(callbacks[0].readyState, 1)

    request.resolve({ source: 'inner-proxy' })
    await flushPromises()
    await flushPromises()
    assert.equal(callbacks.length, 2, 'failed outer open must not consume the inner held DONE')
    assert.deepEqual(callbacks[1].response, { source: 'inner-proxy' })
    assert.equal(callbacks[1].readyState, 4)
}

async function testReusedInstanceIgnoresStaleAsyncResult() {
    const requests = [createDeferred(), createDeferred()]
    let requestIndex = 0
    let currentContainer
    let transformResponseCalls = 0
    const { NativeXMLHttpRequest } = installInjectedXhr({
        transformRequest({ container }) {
            currentContainer = container
            return requests[requestIndex++].promise
        },
        transformResponse() {
            transformResponseCalls += 1
            return 'unexpected-transform'
        },
    })
    const xhr = new window.XMLHttpRequest()
    const callbacks = []
    xhr.onreadystatechange = function (event) {
        callbacks.push(snapshotCallback(this, event))
    }

    xhr.open('GET', '/first')
    xhr.send()
    xhr.open('GET', '/second')
    xhr.send()
    NativeXMLHttpRequest.instances[0].complete(createNativeFixture({
        response: 'second-native',
        responseText: 'second-native',
    }))
    assert.equal(callbacks.length, 0)

    requests[0].resolve({ request: 'stale-success' })
    await flushPromises()
    assert.equal(callbacks.length, 0, 'stale success must not replace or release the current native fallback')
    assert.equal(currentContainer.__block_response, true)

    requests[1].resolve({ request: 2 })
    await flushPromises()
    assert.equal(callbacks.length, 1)
    assert.deepEqual(callbacks[0].response, { request: 2 })
    assert.equal(callbacks[0].receiver, xhr)
    assert.equal(transformResponseCalls, 0)

    assert.equal(callbacks.length, 1)
    assert.deepEqual(xhr.response, { request: 2 })
}

async function testAbortInvalidatesAsyncResult() {
    const request = createDeferred()
    const { NativeXMLHttpRequest } = installInjectedXhr({
        transformRequest() {
            return request.promise
        },
        transformResponse() {
            return null
        },
    })
    const xhr = new window.XMLHttpRequest()
    const callbacks = []
    xhr.open('GET', '/abort')
    xhr.onreadystatechange = function (event) {
        callbacks.push(snapshotCallback(this, event))
    }
    xhr.send()
    NativeXMLHttpRequest.instances[0].complete(createNativeFixture({
        response: 'abort-native',
        responseText: 'abort-native',
    }))
    assert.equal(callbacks.length, 0)
    xhr.abort()
    const callbackCountAfterAbort = callbacks.length
    assert.equal(NativeXMLHttpRequest.instances[0].abortCalls, 1)

    request.resolve({ source: 'aborted-proxy' })
    await flushPromises()
    assert.equal(callbacks.length, callbackCountAfterAbort, 'aborted proxy completion must not revive the request')
    assert.equal(xhr.readyState, 0)
    assert.equal(xhr.response, null)
}

async function testInvalidSendHasNoProxySideEffects() {
    let transformRequestCalls = 0
    const request = createDeferred()
    const { NativeXMLHttpRequest } = installInjectedXhr({
        transformRequest() {
            transformRequestCalls += 1
            return request.promise
        },
        transformResponse() {
            return null
        },
    })
    const xhr = new window.XMLHttpRequest()
    assert.throws(() => xhr.send(), error => error?.name === 'InvalidStateError')
    assert.equal(transformRequestCalls, 0, 'send validation must happen before proxy work starts')

    xhr.open('GET', '/valid-once')
    xhr.send()
    assert.equal(transformRequestCalls, 1)
    assert.throws(() => xhr.send(), error => error?.name === 'InvalidStateError')
    assert.equal(transformRequestCalls, 1, 'repeated send must not start a ghost proxy request')
    assert.equal(NativeXMLHttpRequest.instances[0].sendCalls, 1)

    const callbacks = []
    xhr.onreadystatechange = function (event) {
        callbacks.push(snapshotCallback(this, event))
    }
    NativeXMLHttpRequest.instances[0].complete(createNativeFixture())
    request.resolve('first-request-still-live')
    await flushPromises()
    assert.equal(callbacks.length, 1, 'invalid repeated send must not corrupt the first request state')
    assert.equal(callbacks[0].response, 'first-request-still-live')
}

async function testTransformFailuresFallBackToNative() {
    let requestTransformCalls = 0
    const requestFailure = installInjectedXhr({
        transformRequest() {
            requestTransformCalls += 1
            throw new Error('synthetic request transform failure')
        },
        transformResponse() {
            return null
        },
    })
    const requestXhr = new window.XMLHttpRequest()
    const requestCallbacks = []
    requestXhr.open('GET', '/request-transform-failure')
    requestXhr.onreadystatechange = function (event) {
        requestCallbacks.push(snapshotCallback(this, event))
    }
    assert.doesNotThrow(() => requestXhr.send(), 'internal request transform failure must not escape send()')
    requestFailure.NativeXMLHttpRequest.instances[0].complete(createNativeFixture({
        response: 'request-native',
        responseText: 'request-native',
    }))
    await flushPromises()
    assert.equal(requestTransformCalls, 1)
    assert.equal(requestCallbacks.length, 1)
    assert.equal(requestCallbacks[0].response, 'request-native')

    const responseFailure = installInjectedXhr({
        transformRequest() {
            return null
        },
        transformResponse() {
            throw new Error('synthetic response transform failure')
        },
    })
    const responseXhr = new window.XMLHttpRequest()
    const responseCallbacks = []
    responseXhr.open('GET', '/response-transform-failure')
    responseXhr.onreadystatechange = function (event) {
        responseCallbacks.push(snapshotCallback(this, event))
    }
    responseXhr.send()
    responseFailure.NativeXMLHttpRequest.instances[0].complete(createNativeFixture({
        response: 'response-native',
        responseText: 'response-native',
    }))
    await flushPromises()
    assert.equal(responseCallbacks.length, 1)
    assert.equal(responseCallbacks[0].response, 'response-native')
}

async function testSynchronousNativeCompletionRemainsBlocked() {
    const request = createDeferred()
    const { NativeXMLHttpRequest } = installInjectedXhr({
        transformRequest() {
            return request.promise
        },
        transformResponse() {
            return 'unexpected-native-transform'
        },
    })
    const xhr = new window.XMLHttpRequest()
    const callbacks = []
    xhr.open('GET', '/sync-native')
    xhr.onreadystatechange = function (event) {
        callbacks.push(snapshotCallback(this, event))
    }
    NativeXMLHttpRequest.instances[0].completeOnNextSend(createNativeFixture({
        response: 'sync-native',
        responseText: 'sync-native',
    }))
    xhr.send()
    assert.equal(callbacks.length, 0, 'provisional block must cover synchronous native completion')

    request.resolve('sync-proxy')
    await flushPromises()
    assert.equal(callbacks.length, 1)
    assert.equal(callbacks[0].response, 'sync-proxy')
}

async function testTransformResponseThenable() {
    let thenReads = 0
    const { NativeXMLHttpRequest } = installInjectedXhr({
        transformRequest() {
            return null
        },
        transformResponse() {
            return {
                get then() {
                    thenReads += 1
                    return resolve => {
                        resolve({ source: 'thenable-response' })
                    }
                },
            }
        },
    })
    const xhr = new window.XMLHttpRequest()
    const callbacks = []
    const listeners = []
    xhr.open('GET', '/thenable-response')
    xhr.onreadystatechange = function (event) {
        callbacks.push(snapshotCallback(this, event))
    }
    xhr.addEventListener('readystatechange', function (event) {
        listeners.push(snapshotCallback(this, event))
    })
    xhr.send()
    NativeXMLHttpRequest.instances[0].complete(createNativeFixture())
    await flushPromises()
    assert.equal(callbacks.length, 1)
    assert.equal(listeners.length, 1)
    assert.equal(thenReads, 1, 'thenable getter must be read exactly once')
    assert.deepEqual(callbacks[0].response, { source: 'thenable-response' })
    assert.deepEqual(listeners[0].response, { source: 'thenable-response' })
}

function installInjectedXhr(transforms) {
    const NativeXMLHttpRequest = createNativeXhrClass()
    windowMock.XMLHttpRequest = NativeXMLHttpRequest
    globalThis.XMLHttpRequest = NativeXMLHttpRequest
    injectXhr(transforms)
    return { NativeXMLHttpRequest }
}

function createNativeXhrClass() {
    const instances = new WeakSet()
    const stateByInstance = new WeakMap()
    class NativeXMLHttpRequest extends EventTarget {
        static instances = []

        constructor() {
            super()
            instances.add(this)
            stateByInstance.set(this, createInitialNativeState())
            NativeXMLHttpRequest.instances.push(this)
            this.sendCalls = 0
            this.abortCalls = 0
        }

        get readyState() {
            return getState(this).readyState
        }

        get response() {
            return getState(this).response
        }

        get responseText() {
            return getState(this).responseText
        }

        get responseType() {
            return getState(this).responseType
        }

        set responseType(value) {
            getState(this).responseType = value
        }

        get responseURL() {
            return getState(this).responseURL
        }

        get responseXML() {
            return getState(this).responseXML
        }

        get status() {
            return getState(this).status
        }

        get statusText() {
            return getState(this).statusText
        }

        get onreadystatechange() {
            return getState(this).onreadystatechange
        }

        set onreadystatechange(value) {
            const state = getState(this)
            if (state.onreadystatechange) {
                EventTarget.prototype.removeEventListener.call(this, 'readystatechange', state.onreadystatechange)
            }
            state.onreadystatechange = value
            if (value) {
                EventTarget.prototype.addEventListener.call(this, 'readystatechange', value)
            }
        }

        open(method, url) {
            const normalizedMethod = String(method)
            if (normalizedMethod === 'INVALID METHOD') {
                throw new DOMException('Invalid HTTP method', 'SyntaxError')
            }
            const state = getState(this)
            Object.assign(state, createInitialNativeState(), {
                method: normalizedMethod,
                url,
                readyState: 1,
                onreadystatechange: state.onreadystatechange,
            })
            if (this.dispatchOnOpen) {
                this.dispatchOnOpen = false
                this.dispatchEvent(createNativeReadyStateChangeEvent())
            }
        }

        send(body) {
            const state = getState(this)
            if (state.readyState !== 1 || state.sent) {
                throw new DOMException('Invalid XMLHttpRequest state', 'InvalidStateError')
            }
            state.sent = true
            state.requestBody = body
            this.sendCalls += 1
            if (state.completeOnSend) {
                const fixture = state.completeOnSend
                state.completeOnSend = undefined
                this.complete(fixture)
            }
        }

        abort() {
            const state = getState(this)
            this.abortCalls += 1
            state.sent = false
            state.readyState = 0
            state.response = null
            state.responseText = ''
            state.responseURL = ''
            state.status = 0
            state.statusText = ''
            this.dispatchEvent(createNativeReadyStateChangeEvent())
        }

        dispatchEvent(event) {
            // Node's EventTarget clears currentTarget after its first listener,
            // unlike browser EventTarget. Pin the observable target values so
            // this mock exercises browser XHR listener semantics.
            Object.defineProperties(event, {
                target: { configurable: true, value: this },
                currentTarget: { configurable: true, value: this },
            })
            return EventTarget.prototype.dispatchEvent.call(this, event)
        }

        completeOnNextSend(fixture) {
            getState(this).completeOnSend = fixture
        }

        dispatchReadyStateChangeOnNextOpen() {
            this.dispatchOnOpen = true
        }

        getAllResponseHeaders() {
            return serializeHeaders(getState(this).headers)
        }

        getResponseHeader(name) {
            const headers = getState(this).headers
            const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === String(name).toLowerCase())
            return entry?.[1] ?? null
        }

        complete(fixture) {
            const state = getState(this)
            Object.assign(state, fixture, { readyState: 4 })
            this.dispatchEvent(createNativeReadyStateChangeEvent())
        }
    }

    Object.defineProperty(NativeXMLHttpRequest.prototype, 'onloadend', {
        configurable: true,
        get() {
            return null
        },
    })

    function getState(instance) {
        assert.equal(instances.has(instance), true, 'native operation must retain the real XHR receiver')
        return stateByInstance.get(instance)
    }

    return NativeXMLHttpRequest
}

function createNativeReadyStateChangeEvent() {
    const event = new Event('readystatechange')
    Object.defineProperty(event, 'isTrusted', { value: true })
    return event
}

function createInitialNativeState() {
    return {
        readyState: 0,
        response: null,
        responseText: '',
        responseType: '',
        responseURL: '',
        responseXML: null,
        status: 0,
        statusText: '',
        headers: {},
        onreadystatechange: null,
        sent: false,
    }
}

function createNativeFixture(overrides = {}) {
    return {
        response: 'native-response',
        responseText: 'native-response',
        responseType: '',
        responseURL: 'https://api.bilibili.com/native-response',
        responseXML: null,
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'text/plain', 'x-fixture': 'default' },
        ...overrides,
    }
}

function serializeHeaders(headers) {
    return Object.entries(headers)
        .map(([key, value]) => `${key}: ${value}\r\n`)
        .join('')
}

function snapshotCallback(receiver, event) {
    return {
        receiver,
        eventType: event?.type,
        eventTarget: event?.target,
        eventCurrentTarget: event?.currentTarget,
        readyState: receiver.readyState,
        response: receiver.response,
        responseText: receiver.responseText,
        responseType: receiver.responseType,
        responseURL: receiver.responseURL,
        responseXML: receiver.responseXML,
        status: receiver.status,
        statusText: receiver.statusText,
        allResponseHeaders: receiver.getAllResponseHeaders(),
        fixtureHeader: receiver.getResponseHeader('x-fixture'),
    }
}

function createDeferred() {
    let resolve
    let reject
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
    })
    return { promise, resolve, reject }
}

function flushPromises() {
    return new Promise(resolve => setTimeout(resolve, 0))
}
