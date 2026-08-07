#!/usr/bin/env node

import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const testStateKey = '__cdnFinalDeliveryObserverTestState'
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
const originalStateDescriptor = Object.getOwnPropertyDescriptor(globalThis, testStateKey)

const bundle = await build({
    entryPoints: [path.join(
        rootDir,
        'packages/unblock-area-limit/src/feature/bili/cdn_final_delivery_observer.ts',
    )],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    write: false,
    plugins: [{
        name: 'cdn-final-delivery-observer-stub',
        setup(buildContext) {
            buildContext.onResolve({ filter: /^\.\/cdn_playurl$/ }, () => ({
                path: 'cdn-final-delivery-observer-stub',
                namespace: 'cdn-final-delivery-observer-test',
            }))
            buildContext.onLoad({
                filter: /^cdn-final-delivery-observer-stub$/,
                namespace: 'cdn-final-delivery-observer-test',
            }, () => ({
                contents: `
                    const state = globalThis.${testStateKey}
                    export function beginFinalCdnPlayUrlDelivery() {
                        state.deliveryOrder += 1
                        return state.deliveryOrder
                    }
                    export function observeFinalCdnPlayUrlResponse(value, deliveryOrder) {
                        if (state.throwObservation) throw new Error('observation failure')
                        state.observations.push(value)
                        state.observationOrders.push(deliveryOrder)
                        return value
                    }
                `,
                loader: 'js',
            }))
        },
    }],
})
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
let scenarioId = 0
const supportedPlayUrlEndpoints = [
    {
        label: 'x-player',
        url: 'https://api.bilibili.com/x/player/playurl',
    },
    {
        label: 'x-player-wbi',
        url: 'https://api.bilibili.com/x/player/wbi/playurl',
    },
    {
        label: 'pgc-player-web',
        url: 'https://api.bilibili.com/pgc/player/web/playurl',
    },
    {
        label: 'pgc-player-web-v2',
        url: 'https://api.bilibili.com/pgc/player/web/v2/playurl',
    },
    {
        label: 'pugv-player-web',
        url: 'https://api.bilibili.com/pugv/player/web/playurl',
    },
    {
        label: 'interface-v2',
        url: 'https://interface.bilibili.com/v2/playurl',
    },
    {
        label: 'legacy-web-api',
        url: 'https://bangumi.bilibili.com/player/web_api/playurl',
    },
    {
        label: 'legacy-web-api-v2-any-host',
        url: 'https://legacy-player.example/player/web_api/v2/playurl',
    },
]

try {
    await testFetchCompositionAndRepair()
    await testFetchOutOfOrderDeliveryTokens()
    await testXhrOutOfOrderDeliveryTokens()
    await testUnknownAccessorFailOpen()
    await testXhrComposition('observer-first')
    await testXhrComposition('downstream-first')
} finally {
    restoreGlobal('window', originalWindowDescriptor)
    restoreGlobal(testStateKey, originalStateDescriptor)
}

console.log('CDN final delivery observer tests passed')

async function testFetchCompositionAndRepair() {
    const calls = []
    let nextResponse
    const predecessor = function (input, init) {
        calls.push({ receiver: this, input, init })
        assert.ok(nextResponse, 'fetch fixture must provide a response')
        const response = nextResponse
        nextResponse = undefined
        return Promise.resolve(response)
    }
    const harness = await createHarness('fetch', {
        fetch: predecessor,
        XMLHttpRequest: class extends EventTarget { },
    })

    harness.module.installCdnFinalDeliveryObservers()
    const firstObservedFetch = harness.window.fetch
    const firstObservedXhr = harness.window.XMLHttpRequest
    harness.module.installCdnFinalDeliveryObservers()
    assert.strictEqual(harness.window.fetch, firstObservedFetch, 'repeat install must not stack Fetch observers')
    assert.strictEqual(harness.window.XMLHttpRequest, firstObservedXhr, 'repeat install must not stack XHR observers')
    assert.deepEqual(harness.timers.map(timer => timer.delayMs), [0, 50, 250, 1_000])

    const receiver = { name: 'fetch-receiver' }
    const init = { credentials: 'include' }
    const observedInputs = supportedPlayUrlEndpoints.map((endpoint, index) => {
        const url = `${endpoint.url}?fixture=${endpoint.label}`
        if (index === 1) return new URL(url)
        if (index === 2) return new Request(url)
        return url
    })

    for (const [index, input] of observedInputs.entries()) {
        const payload = { marker: `endpoint-${index}` }
        const response = jsonResponse(payload)
        nextResponse = response
        const delivered = await harness.window.fetch.call(receiver, input, init)
        assert.strictEqual(delivered, response, 'Fetch observer must preserve predecessor Response identity')
        assert.strictEqual(calls.at(-1).receiver, receiver, 'Fetch observer must preserve the predecessor receiver')
        assert.strictEqual(calls.at(-1).input, input)
        assert.strictEqual(calls.at(-1).init, init)
        assert.equal(harness.state.observations.at(-1).marker, payload.marker)
    }

    const protocolRelativePayload = { marker: 'protocol-relative-https' }
    nextResponse = jsonResponse(protocolRelativePayload)
    await harness.window.fetch('//interface.bilibili.com/v2/playurl?fixture=protocol-relative')
    assert.equal(harness.state.observations.at(-1).marker, protocolRelativePayload.marker)
    const observedEndpointCount = supportedPlayUrlEndpoints.length + 1
    assert.equal(harness.state.observations.length, observedEndpointCount)

    const securePageHref = harness.window.location.href
    harness.window.location.href = 'http://www.bilibili.com/video/BV1observer'
    nextResponse = jsonResponse({ marker: 'protocol-relative-http-ignored' })
    await harness.window.fetch('//interface.bilibili.com/v2/playurl?fixture=protocol-relative-http')
    harness.window.location.href = securePageHref
    assert.equal(
        harness.state.observations.length,
        observedEndpointCount,
        'protocol-relative endpoints resolved to HTTP must be ignored',
    )

    for (const ignoredUrl of [
        'https://www.bilibili.com/x/player/playurl?fixture=page-host',
        'https://api.bilibili.com.example/x/player/playurl?fixture=lookalike-host',
        'http://api.bilibili.com/x/player/playurl?fixture=insecure',
        'http://interface.bilibili.com/v2/playurl?fixture=insecure-interface',
        'http://legacy-player.example/player/web_api/playurl?fixture=insecure-legacy',
        'https://api.bilibili.com/x/player/playurl/extra?fixture=path-suffix',
        'https://interface.bilibili.com/v2/playurl/extra?fixture=interface-path-suffix',
        'https://legacy-player.example/player/web_api/v2/playurl/extra?fixture=legacy-path-suffix',
        'https://api.bilibili.com/x/player/pagelist?fixture=other-api',
    ]) {
        nextResponse = jsonResponse({ marker: 'ignored' })
        await harness.window.fetch(ignoredUrl)
    }
    assert.equal(
        harness.state.deliveryOrder,
        observedEndpointCount,
        'non-HTTPS and non-endpoint Fetch calls must not allocate delivery tokens',
    )
    const malformedResponse = new Response('{"marker":', { headers: { 'content-type': 'application/json' } })
    nextResponse = malformedResponse
    const malformedDelivered = await harness.window.fetch(
        'https://api.bilibili.com/x/player/playurl?fixture=malformed',
    )
    assert.strictEqual(malformedDelivered, malformedResponse)
    assert.equal(await malformedDelivered.text(), '{"marker":')
    assert.equal(harness.state.observations.length, observedEndpointCount, 'non-playurl and invalid JSON must be ignored')

    const publicationFailureResponse = jsonResponse({ marker: 'publication-failure' })
    nextResponse = publicationFailureResponse
    harness.state.throwObservation = true
    const publicationFailureDelivered = await harness.window.fetch(
        'https://api.bilibili.com/x/player/playurl?fixture=publication-failure',
    )
    harness.state.throwObservation = false
    assert.strictEqual(publicationFailureDelivered, publicationFailureResponse)
    assert.equal((await publicationFailureDelivered.json()).marker, 'publication-failure')
    assert.equal(harness.state.observations.length, observedEndpointCount)

    harness.state.observations.length = 0
    const capturedObserver = harness.window.fetch
    const nativeResponse = jsonResponse({ marker: 'fetch-native' })
    let downstreamResponse
    let downstreamPredecessorResponse
    let downstreamCall
    let downstreamCalls = 0
    const downstream = async function (input, requestInit) {
        downstreamCalls += 1
        downstreamCall = { receiver: this, input, requestInit }
        downstreamPredecessorResponse = await capturedObserver.call(this, input, requestInit)
        const transformed = await downstreamPredecessorResponse.clone().json()
        transformed.marker = 'fetch-downstream-final'
        downstreamResponse = jsonResponse(transformed)
        return downstreamResponse
    }
    harness.window.fetch = downstream
    const finalObservedFetch = harness.window.fetch
    harness.module.installCdnFinalDeliveryObservers()
    assert.strictEqual(harness.window.fetch, finalObservedFetch, 'repeat install must preserve a late Fetch composition')

    const callsBeforeComposition = calls.length
    nextResponse = nativeResponse
    const downstreamInput = 'https://api.bilibili.com/x/player/wbi/playurl?fixture=downstream'
    const delivered = await finalObservedFetch.call(
        receiver,
        downstreamInput,
        init,
    )
    assert.equal(calls.length, callsBeforeComposition + 1, 'captured predecessor must run exactly once without recursion')
    assert.equal(downstreamCalls, 1)
    assert.strictEqual(calls.at(-1).receiver, receiver)
    assert.strictEqual(downstreamCall.receiver, receiver)
    assert.strictEqual(downstreamCall.input, downstreamInput)
    assert.strictEqual(downstreamCall.requestInit, init)
    assert.strictEqual(downstreamPredecessorResponse, nativeResponse)
    assert.strictEqual(delivered, downstreamResponse, 'outer observer must preserve the downstream Response identity')
    assert.deepEqual(harness.state.observations.map(value => value.marker), [
        'fetch-downstream-final',
    ])

    harness.state.observations.length = 0
    const repairedResponse = jsonResponse({ marker: 'fetch-repaired' })
    const replacement = function () {
        return Promise.resolve(repairedResponse)
    }
    Object.defineProperty(harness.window, 'fetch', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: replacement,
    })
    assert.strictEqual(harness.window.fetch, replacement)
    harness.runTimer(0)
    assert.notStrictEqual(harness.window.fetch, replacement, 'scheduled repair must restore the observer data slot')
    const repairedDescriptor = Object.getOwnPropertyDescriptor(harness.window, 'fetch')
    assert.equal(typeof repairedDescriptor.get, 'function')
    assert.equal(typeof repairedDescriptor.set, 'function')
    const repairedDelivered = await harness.window.fetch(
        'https://api.bilibili.com/x/player/playurl?fixture=repaired',
    )
    assert.strictEqual(repairedDelivered, repairedResponse)
    assert.equal(harness.state.observations.at(-1).marker, 'fetch-repaired')
}

async function testFetchOutOfOrderDeliveryTokens() {
    const pending = []
    const predecessor = input => new Promise(resolve => {
        pending.push({ input, resolve })
    })
    const harness = await createHarness('fetch-out-of-order', {
        fetch: predecessor,
        XMLHttpRequest: class extends EventTarget { },
    })
    harness.module.installCdnFinalDeliveryObservers()

    const firstUrl = 'https://legacy-player.example/player/web_api/v2/playurl?fixture=out-of-order-first'
    const secondUrl = 'https://interface.bilibili.com/v2/playurl?fixture=out-of-order-second'
    const firstDelivery = harness.window.fetch(firstUrl)
    const secondDelivery = harness.window.fetch(secondUrl)
    assert.deepEqual(pending.map(item => item.input), [firstUrl, secondUrl])
    assert.equal(harness.state.deliveryOrder, 2, 'Fetch tokens must be allocated before completion')
    assert.deepEqual(harness.state.observations, [])

    const secondResponse = jsonResponse({ marker: 'fetch-out-of-order-second' })
    pending[1].resolve(secondResponse)
    assert.strictEqual(await secondDelivery, secondResponse)
    assert.deepEqual(harness.state.observations.map(value => value.marker), [
        'fetch-out-of-order-second',
    ])
    assert.deepEqual(harness.state.observationOrders, [2])

    const firstResponse = jsonResponse({ marker: 'fetch-out-of-order-first' })
    pending[0].resolve(firstResponse)
    assert.strictEqual(await firstDelivery, firstResponse)
    assert.deepEqual(harness.state.observations.map(value => value.marker), [
        'fetch-out-of-order-second',
        'fetch-out-of-order-first',
    ])
    assert.deepEqual(harness.state.observationOrders, [2, 1])
}

async function testXhrOutOfOrderDeliveryTokens() {
    const native = createNativeXhr()
    const harness = await createHarness('xhr-out-of-order', {
        fetch: () => Promise.resolve(jsonResponse({ marker: 'unused' })),
        XMLHttpRequest: native.XMLHttpRequest,
    })
    harness.module.installCdnFinalDeliveryObservers()

    const firstXhr = new harness.window.XMLHttpRequest()
    const secondXhr = new harness.window.XMLHttpRequest()
    firstXhr.open('GET', 'https://bangumi.bilibili.com/player/web_api/playurl?fixture=xhr-out-of-order-first')
    secondXhr.open('GET', 'https://interface.bilibili.com/v2/playurl?fixture=xhr-out-of-order-second')
    assert.equal(harness.state.deliveryOrder, 2, 'XHR tokens must be allocated during open()')
    assert.deepEqual(harness.state.observations, [])

    secondXhr.complete({
        responseURL: 'https://interface.bilibili.com/v2/playurl?fixture=xhr-out-of-order-second-final',
        response: { marker: 'xhr-out-of-order-second' },
    })
    firstXhr.complete({
        responseURL: 'https://bangumi.bilibili.com/player/web_api/playurl?fixture=xhr-out-of-order-first-final',
        response: { marker: 'xhr-out-of-order-first' },
    })
    assert.deepEqual(harness.state.observations.map(value => value.marker), [
        'xhr-out-of-order-second',
        'xhr-out-of-order-first',
    ])
    assert.deepEqual(harness.state.observationOrders, [2, 1])
}

async function testUnknownAccessorFailOpen() {
    const nativeXhr = createNativeXhr()
    const fetchResponse = jsonResponse({ marker: 'unknown-accessor-fetch' })
    const fetchReceiver = { name: 'unknown-accessor-receiver' }
    let fetchDelegateCalls = 0
    let fetchWrapperCalls = 0
    let fetchSetterCalls = 0
    let xhrWrapperCalls = 0
    let xhrSetterCalls = 0

    let fetchDelegate = function () {
        fetchDelegateCalls += 1
        assert.strictEqual(this, fetchReceiver)
        return Promise.resolve(fetchResponse)
    }
    const stableFetchWrapper = function (...args) {
        fetchWrapperCalls += 1
        return fetchDelegate.apply(this, args)
    }
    const fetchGetter = () => stableFetchWrapper
    const fetchSetter = value => {
        fetchSetterCalls += 1
        fetchDelegate = value
    }

    let xhrDelegate = nativeXhr.XMLHttpRequest
    function StableXMLHttpRequest(...args) {
        xhrWrapperCalls += 1
        return Reflect.construct(xhrDelegate, args, new.target)
    }
    StableXMLHttpRequest.prototype = nativeXhr.XMLHttpRequest.prototype
    const xhrGetter = () => StableXMLHttpRequest
    const xhrSetter = value => {
        xhrSetterCalls += 1
        xhrDelegate = value
    }

    const harness = await createHarness(
        'unknown-accessor',
        {},
        windowValue => {
            Object.defineProperty(windowValue, 'fetch', {
                configurable: true,
                enumerable: true,
                get: fetchGetter,
                set: fetchSetter,
            })
            Object.defineProperty(windowValue, 'XMLHttpRequest', {
                configurable: true,
                enumerable: true,
                get: xhrGetter,
                set: xhrSetter,
            })
        },
    )
    const fetchDescriptor = Object.getOwnPropertyDescriptor(harness.window, 'fetch')
    const xhrDescriptor = Object.getOwnPropertyDescriptor(harness.window, 'XMLHttpRequest')

    harness.module.installCdnFinalDeliveryObservers()
    harness.module.installCdnFinalDeliveryObservers()
    const installedFetchDescriptor = Object.getOwnPropertyDescriptor(harness.window, 'fetch')
    const installedXhrDescriptor = Object.getOwnPropertyDescriptor(harness.window, 'XMLHttpRequest')
    assert.strictEqual(installedFetchDescriptor.get, fetchDescriptor.get)
    assert.strictEqual(installedFetchDescriptor.set, fetchDescriptor.set)
    assert.strictEqual(installedXhrDescriptor.get, xhrDescriptor.get)
    assert.strictEqual(installedXhrDescriptor.set, xhrDescriptor.set)
    assert.equal(fetchSetterCalls, 0, 'unknown Fetch accessors must not receive an observer writeback')
    assert.equal(xhrSetterCalls, 0, 'unknown XHR accessors must not receive an observer writeback')

    const delivered = await harness.window.fetch.call(
        fetchReceiver,
        'https://api.bilibili.com/x/player/playurl?fixture=unknown-accessor-fetch',
    )
    assert.strictEqual(delivered, fetchResponse)
    assert.equal(fetchWrapperCalls, 1)
    assert.equal(fetchDelegateCalls, 1)

    const xhr = new harness.window.XMLHttpRequest()
    xhr.open('GET', 'https://api.bilibili.com/x/player/playurl?fixture=unknown-accessor-xhr')
    xhr.complete({
        responseURL: 'https://api.bilibili.com/x/player/playurl?fixture=unknown-accessor-xhr-final',
        response: { marker: 'unknown-accessor-xhr' },
    })
    assert.equal(xhrWrapperCalls, 1)
    assert.equal(nativeXhr.openReceivers.length, 1)
    assert.equal(nativeXhr.completeReceivers.length, 1)
    assert.deepEqual(harness.state.observations, [])
    assert.deepEqual(harness.state.observationOrders, [])
    assert.equal(fetchSetterCalls, 0)
    assert.equal(xhrSetterCalls, 0)
}

async function testXhrComposition(order) {
    const native = createNativeXhr()
    let harness
    let downstream

    if (order === 'observer-first') {
        harness = await createHarness(order, {
            fetch: () => Promise.resolve(jsonResponse({ marker: 'unused' })),
            XMLHttpRequest: native.XMLHttpRequest,
        })
        harness.module.installCdnFinalDeliveryObservers()
        downstream = createDownstreamXhr(harness.window.XMLHttpRequest, order)
        harness.window.XMLHttpRequest = downstream.XMLHttpRequest
    } else {
        downstream = createDownstreamXhr(native.XMLHttpRequest, order)
        harness = await createHarness(order, {
            fetch: () => Promise.resolve(jsonResponse({ marker: 'unused' })),
            XMLHttpRequest: downstream.XMLHttpRequest,
        })
        harness.module.installCdnFinalDeliveryObservers()
    }

    const PublicXMLHttpRequest = harness.window.XMLHttpRequest
    harness.module.installCdnFinalDeliveryObservers()
    assert.strictEqual(
        harness.window.XMLHttpRequest,
        PublicXMLHttpRequest,
        `${order}: repeat install must not stack XHR observers`,
    )

    const xhr = new PublicXMLHttpRequest()
    assert.equal(xhr instanceof PublicXMLHttpRequest, true)
    assert.equal(xhr instanceof downstream.XMLHttpRequest, true)
    assert.equal(xhr instanceof native.XMLHttpRequest, true)
    assert.equal(native.instances.has(xhr), true)

    const pageReceivers = []
    const pageTargets = []
    const pageSnapshots = []
    xhr.addEventListener('readystatechange', function (event) {
        if (this.readyState !== 4) return
        pageReceivers.push(this)
        pageTargets.push(event.target)
        pageSnapshots.push({
            observedMarker: harness.state.observations.at(-1)?.marker,
            responseMarker: this.response?.marker,
        })
    })

    const requests = supportedPlayUrlEndpoints.map((endpoint, index) => ({
        requestUrl: `${endpoint.url}?fixture=xhr-${endpoint.label}`,
        responseUrl: `${endpoint.url}?fixture=xhr-${endpoint.label}-final`,
        marker: `${order}-${endpoint.label}`,
        responseAsText: index % 2 === 1,
    }))

    for (const [index, request] of requests.entries()) {
        const response = request.responseAsText
            ? JSON.stringify({ marker: request.marker })
            : { marker: request.marker }
        xhr.open('GET', request.requestUrl)
        xhr.complete({
            responseURL: request.responseUrl,
            response,
        })
        assert.equal(xhr.response.marker, `${request.marker}:downstream`)
        assert.deepEqual(pageSnapshots.at(-1), {
            observedMarker: `${request.marker}:downstream`,
            responseMarker: `${request.marker}:downstream`,
        }, `${order}: final observation must precede the page listener`)

        if (index === 0) {
            const observedCount = harness.state.observations.length
            xhr.complete({ responseURL: request.responseUrl, response })
            assert.equal(observedCount, harness.state.observations.length, `${order}: duplicate DONE must be ignored`)
        }
    }

    const expected = requests.map(request => `${request.marker}:downstream`)
    assert.deepEqual(harness.state.observations.map(value => value.marker), expected)
    assert.equal(native.openReceivers.length, requests.length, `${order}: the same XHR must support a reused open()`)
    assert.equal(native.openReceivers.every(receiver => receiver === xhr), true)
    assert.equal(native.completeReceivers.every(receiver => receiver === xhr), true)
    assert.equal(downstream.receivers.every(receiver => receiver === xhr), true)
    assert.equal(pageReceivers.every(receiver => receiver === xhr), true)
    assert.equal(pageTargets.every(target => target === xhr), true)

    const observedAfterRequests = harness.state.observations.length
    xhr.open('GET', 'https://api.bilibili.com/x/player/playurl?fixture=xhr-malformed')
    xhr.complete({
        responseURL: 'https://api.bilibili.com/x/player/playurl?fixture=xhr-malformed-final',
        response: '{"marker":',
    })
    assert.equal(harness.state.observations.length, observedAfterRequests, `${order}: malformed XHR JSON must be ignored`)

    const nonJsonResponses = [
        ['blob', new Blob(['{"marker":"blob"}'], { type: 'application/json' })],
        ['arraybuffer', new ArrayBuffer(8)],
        ['document', new (class SyntheticDocumentResponse { })()],
    ]
    for (const [responseType, response] of nonJsonResponses) {
        xhr.open('GET', `https://api.bilibili.com/x/player/playurl?fixture=xhr-${responseType}`)
        xhr.responseType = responseType
        xhr.complete({
            responseURL: `https://api.bilibili.com/x/player/playurl?fixture=xhr-${responseType}-final`,
            response,
        })
        assert.equal(
            harness.state.observations.length,
            observedAfterRequests,
            `${order}: ${responseType} XHR response must remain unobserved`,
        )
    }
    xhr.responseType = ''

    const pageCallsBeforePublicationFailure = pageReceivers.length
    harness.state.throwObservation = true
    xhr.open('GET', 'https://api.bilibili.com/x/player/playurl?fixture=xhr-publication-failure')
    xhr.complete({
        responseURL: 'https://api.bilibili.com/x/player/playurl?fixture=xhr-publication-failure-final',
        response: { marker: `${order}-publication-failure` },
    })
    harness.state.throwObservation = false
    assert.equal(harness.state.observations.length, observedAfterRequests)
    assert.equal(pageReceivers.length, pageCallsBeforePublicationFailure + 1)
    assert.equal(xhr.response.marker, `${order}-publication-failure:downstream`)

    xhr.open('GET', 'https://api.bilibili.com/x/player/playurl?fixture=request-only-playurl')
    xhr.complete({
        responseURL: 'https://api.bilibili.com/x/player/pagelist?fixture=final-non-playurl',
        response: { marker: `${order}-request-only-playurl` },
    })
    assert.equal(
        harness.state.observations.length,
        observedAfterRequests,
        `${order}: a playurl open() must not override a non-playurl responseURL`,
    )

    xhr.open('GET', 'https://api.bilibili.com/x/player/pagelist?fixture=request-non-playurl')
    xhr.complete({
        responseURL: 'https://api.bilibili.com/x/player/playurl?fixture=final-playurl',
        response: { marker: `${order}-response-only-playurl` },
    })
    assert.equal(
        harness.state.observations.length,
        observedAfterRequests,
        `${order}: a playurl responseURL must not synthesize a request delivery`,
    )
    assert.equal(pageSnapshots.at(-1).responseMarker, `${order}-response-only-playurl:downstream`)

    xhr.open('GET', 'https://api.bilibili.com/x/player/playurl?fixture=xhr-after-failure')
    xhr.complete({
        responseURL: 'https://api.bilibili.com/x/player/playurl?fixture=xhr-after-failure-final',
        response: { marker: `${order}-after-failure` },
    })
    assert.deepEqual(pageSnapshots.at(-1), {
        observedMarker: `${order}-after-failure:downstream`,
        responseMarker: `${order}-after-failure:downstream`,
    })

    const observedAfterRecovery = harness.state.observations.length
    xhr.open('GET', 'https://api.bilibili.com/x/player/pagelist?fixture=xhr-ignored')
    xhr.complete({
        responseURL: 'https://api.bilibili.com/x/player/pagelist?fixture=xhr-ignored-final',
        response: { marker: `${order}-ignored` },
    })
    assert.equal(
        harness.state.observations.length,
        observedAfterRecovery,
        `${order}: non-playurl XHR must be ignored`,
    )
    assert.strictEqual(pageReceivers.at(-1), xhr)

    if (order === 'downstream-first') {
        const replacement = createNativeXhr()
        Object.defineProperty(harness.window, 'XMLHttpRequest', {
            configurable: true,
            enumerable: true,
            writable: true,
            value: replacement.XMLHttpRequest,
        })
        harness.runTimer(0)
        assert.notStrictEqual(harness.window.XMLHttpRequest, replacement.XMLHttpRequest)
        const repairedXhr = new harness.window.XMLHttpRequest()
        repairedXhr.open('GET', 'https://api.bilibili.com/x/player/playurl?fixture=xhr-repaired')
        repairedXhr.complete({
            responseURL: 'https://api.bilibili.com/x/player/playurl?fixture=xhr-repaired-final',
            response: { marker: 'xhr-repaired' },
        })
        assert.equal(harness.state.observations.at(-1).marker, 'xhr-repaired')
    }
}

async function createHarness(name, initialWindow, configureWindow) {
    const state = { deliveryOrder: 0, observationOrders: [], observations: [] }
    const timers = []
    const documentListeners = new Map()
    const windowValue = {
        ...initialWindow,
        location: { href: 'https://www.bilibili.com/video/BV1observer' },
        document: {
            addEventListener(type, listener) {
                const listeners = documentListeners.get(type) ?? []
                listeners.push(listener)
                documentListeners.set(type, listeners)
            },
        },
        setTimeout(callback, delayMs) {
            timers.push({ callback, delayMs })
            return timers.length
        },
    }
    configureWindow?.(windowValue)
    defineGlobal('window', windowValue)
    defineGlobal(testStateKey, state)
    const module = await import(`${moduleUrl}#scenario-${scenarioId++}-${name}`)

    return {
        module,
        state,
        timers,
        window: windowValue,
        runTimer(delayMs) {
            const index = timers.findIndex(timer => timer.delayMs === delayMs)
            assert.notEqual(index, -1, `missing ${delayMs} ms repair timer`)
            const [timer] = timers.splice(index, 1)
            timer.callback()
        },
    }
}

function createNativeXhr() {
    const instances = new WeakSet()
    const openReceivers = []
    const completeReceivers = []

    class XMLHttpRequest extends EventTarget {
        constructor() {
            super()
            instances.add(this)
            this.readyState = 0
            this.responseURL = ''
            this.responseType = ''
            this.response = null
            this.responseText = ''
        }

        open(method, url) {
            openReceivers.push(this)
            this.method = method
            this.url = url
            this.readyState = 1
            this.responseURL = ''
            this.response = null
            this.responseText = ''
            this.dispatchEvent(new Event('readystatechange'))
        }

        complete({ responseURL, response }) {
            completeReceivers.push(this)
            this.responseURL = responseURL
            this.response = response
            this.responseText = typeof response === 'string' ? response : JSON.stringify(response)
            this.readyState = 4
            this.dispatchEvent(new Event('readystatechange'))
        }
    }

    return { XMLHttpRequest, instances, openReceivers, completeReceivers }
}

function createDownstreamXhr(Predecessor, label) {
    const receivers = []

    class XMLHttpRequest extends Predecessor {
        constructor() {
            super()
            this.addEventListener('readystatechange', function () {
                receivers.push(this)
                if (this.readyState !== 4) return
                if (this.responseType && this.responseType !== 'json'
                    && this.responseType !== 'text') return
                let response = this.response
                if (typeof response === 'string') {
                    try {
                        response = JSON.parse(response)
                    } catch {
                        return
                    }
                }
                this.response = {
                    ...response,
                    marker: `${response.marker}:downstream`,
                    downstream: label,
                }
                this.responseText = JSON.stringify(this.response)
            })
        }
    }

    return { XMLHttpRequest, receivers }
}

function jsonResponse(value) {
    return new Response(JSON.stringify(value), {
        headers: { 'content-type': 'application/json' },
    })
}

function defineGlobal(name, value) {
    Object.defineProperty(globalThis, name, {
        configurable: true,
        writable: true,
        value,
    })
}

function restoreGlobal(name, descriptor) {
    if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor)
    } else {
        delete globalThis[name]
    }
}
