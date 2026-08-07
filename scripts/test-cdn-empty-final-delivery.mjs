#!/usr/bin/env node

import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const testStateKey = '__cdnEmptyFinalDeliveryTestState'
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
        name: 'cdn-empty-final-delivery-runtime-stub',
        setup(buildContext) {
            buildContext.onResolve({ filter: /^\.\/cdn_runtime$/ }, () => ({
                path: 'cdn-empty-final-delivery-runtime-stub',
                namespace: 'cdn-empty-final-delivery-test',
            }))
            buildContext.onLoad({
                filter: /^cdn-empty-final-delivery-runtime-stub$/,
                namespace: 'cdn-empty-final-delivery-test',
            }, () => ({
                contents: `
                    const state = globalThis.${testStateKey}

                    export function transformCdnPolicyForFinalDelivery(value) {
                        return value
                    }

                    export function beginFinalCdnDelivery() {
                        state.deliveryOrder += 1
                        return state.deliveryOrder
                    }

                    export function observeFinalCdnDelivery(value, deliveryOrder) {
                        const hasMedia = !!value && typeof value === 'object'
                            && (!!value.dash || !!value.durl)
                        const markers = hasMedia ? [value.marker] : []
                        const stale = deliveryOrder < state.latestAcceptedOrder
                        if (!stale) {
                            state.latestAcceptedOrder = deliveryOrder
                            state.authoritativeMarkers = markers
                        }
                        state.publications.push({
                            deliveryOrder,
                            stale,
                            markers: [...state.authoritativeMarkers],
                            observedValue: value,
                        })
                        return value
                    }
                `,
                loader: 'js',
            }))
        },
    }],
})
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`

try {
    await testFetchErrorSupersedesOlderSuccess()
    await testXhrErrorSupersedesOlderSuccess()
} finally {
    restoreGlobal('window', originalWindowDescriptor)
    restoreGlobal(testStateKey, originalStateDescriptor)
}

console.log('CDN empty final delivery tests passed')

async function testFetchErrorSupersedesOlderSuccess() {
    const pending = []
    const harness = await createHarness('fetch', {
        fetch(input) {
            return new Promise(resolve => pending.push({ input, resolve }))
        },
        XMLHttpRequest: class extends EventTarget { },
    })
    harness.module.installCdnFinalDeliveryObservers()

    const olderUrl = 'https://api.bilibili.com/x/player/playurl?fixture=older-success'
    const newerUrl = 'https://api.bilibili.com/x/player/playurl?fixture=newer-error'
    const olderDelivery = harness.window.fetch(olderUrl)
    const newerDelivery = harness.window.fetch(newerUrl)
    assert.deepEqual(pending.map(item => item.input), [olderUrl, newerUrl])
    assert.equal(harness.state.deliveryOrder, 2)

    const errorResponse = jsonResponse({ code: -404, message: 'fixture error' })
    pending[1].resolve(errorResponse)
    assert.strictEqual(await newerDelivery, errorResponse)
    assert.deepEqual(harness.state.publications, [{
        deliveryOrder: 2,
        stale: false,
        markers: [],
        observedValue: {},
    }], 'a newer valid error response must publish an authoritative empty delivery')

    const olderResponse = jsonResponse(successEnvelope('fetch-older-success'))
    pending[0].resolve(olderResponse)
    assert.strictEqual(await olderDelivery, olderResponse)
    assert.deepEqual(harness.state.publications.map(publication => ({
        deliveryOrder: publication.deliveryOrder,
        stale: publication.stale,
        markers: publication.markers,
    })), [
        { deliveryOrder: 2, stale: false, markers: [] },
        { deliveryOrder: 1, stale: true, markers: [] },
    ], 'the older success must not replace the newer authoritative empty delivery')
}

async function testXhrErrorSupersedesOlderSuccess() {
    const native = createNativeXhr()
    const harness = await createHarness('xhr', {
        fetch: () => Promise.resolve(jsonResponse({ code: 0 })),
        XMLHttpRequest: native.XMLHttpRequest,
    })
    harness.module.installCdnFinalDeliveryObservers()

    const olderXhr = new harness.window.XMLHttpRequest()
    const newerXhr = new harness.window.XMLHttpRequest()
    olderXhr.open('GET', 'https://api.bilibili.com/x/player/playurl?fixture=xhr-older-success')
    newerXhr.open('GET', 'https://api.bilibili.com/x/player/playurl?fixture=xhr-newer-error')
    assert.equal(harness.state.deliveryOrder, 2)

    newerXhr.complete({
        responseURL: 'https://api.bilibili.com/x/player/playurl?fixture=xhr-newer-error-final',
        response: JSON.stringify({ code: -404, message: 'fixture error' }),
    })
    assert.deepEqual(harness.state.publications, [{
        deliveryOrder: 2,
        stale: false,
        markers: [],
        observedValue: {},
    }], 'a newer valid XHR error response must publish an authoritative empty delivery')

    olderXhr.complete({
        responseURL: 'https://api.bilibili.com/x/player/playurl?fixture=xhr-older-success-final',
        response: successEnvelope('xhr-older-success'),
    })
    assert.deepEqual(harness.state.publications.map(publication => ({
        deliveryOrder: publication.deliveryOrder,
        stale: publication.stale,
        markers: publication.markers,
    })), [
        { deliveryOrder: 2, stale: false, markers: [] },
        { deliveryOrder: 1, stale: true, markers: [] },
    ], 'the older XHR success must not replace the newer authoritative empty delivery')
}

async function createHarness(name, initialWindow) {
    const state = {
        authoritativeMarkers: [],
        deliveryOrder: 0,
        latestAcceptedOrder: 0,
        publications: [],
    }
    const windowValue = {
        ...initialWindow,
        location: { href: 'https://www.bilibili.com/video/BV1emptyfinal' },
        document: { addEventListener() { } },
        setTimeout() { return 1 },
    }
    defineGlobal('window', windowValue)
    defineGlobal(testStateKey, state)
    const module = await import(`${moduleUrl}#${name}`)
    return { module, state, window: windowValue }
}

function createNativeXhr() {
    class XMLHttpRequest extends EventTarget {
        constructor() {
            super()
            this.readyState = 0
            this.responseURL = ''
            this.response = null
            this.responseText = ''
        }

        open(_method, _url) {
            this.readyState = 1
            this.responseURL = ''
            this.response = null
            this.responseText = ''
            this.dispatchEvent(new Event('readystatechange'))
        }

        complete({ responseURL, response }) {
            this.responseURL = responseURL
            this.response = response
            this.responseText = typeof response === 'string' ? response : JSON.stringify(response)
            this.readyState = 4
            this.dispatchEvent(new Event('readystatechange'))
        }
    }
    return { XMLHttpRequest }
}

function successEnvelope(marker) {
    return {
        code: 0,
        data: {
            marker,
            durl: [{
                url: `https://${marker}.test.bilivideo.com/video.mp4?deadline=1&sign=fixture`,
            }],
        },
    }
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
