#!/usr/bin/env node

import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const testStateKey = '__cdnJqueryFinalDeliveryTestState'
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
const originalStateDescriptor = Object.getOwnPropertyDescriptor(globalThis, testStateKey)

const bundle = await build({
    stdin: {
        contents: `
            export {
                deferFinalCdnPlayUrlXhrDelivery,
                installCdnFinalDeliveryObservers,
            } from './packages/unblock-area-limit/src/feature/bili/cdn_final_delivery_observer.ts'
            export {
                beginFinalCdnPlayUrlDelivery,
                deliverFinalCdnPlayUrlResponse,
            } from './packages/unblock-area-limit/src/feature/bili/cdn_playurl.ts'
        `,
        resolveDir: rootDir,
        sourcefile: 'jquery-playurl-final-delivery-entry.ts',
        loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    write: false,
    plugins: [{
        name: 'jquery-playurl-final-delivery-runtime-stub',
        setup(buildContext) {
            buildContext.onResolve({ filter: /^\.\/cdn_runtime$/ }, () => ({
                path: 'jquery-playurl-final-delivery-runtime-stub',
                namespace: 'jquery-playurl-final-delivery-test',
            }))
            buildContext.onLoad({
                filter: /^jquery-playurl-final-delivery-runtime-stub$/,
                namespace: 'jquery-playurl-final-delivery-test',
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
                        deliveryOrder = Number.isSafeInteger(deliveryOrder) && deliveryOrder > 0
                            ? deliveryOrder
                            : beginFinalCdnDelivery()
                        if (state.throwObservation) throw new Error('fixture observation failure')
                        const stale = deliveryOrder < state.latestAcceptedOrder
                        if (!stale) {
                            state.latestAcceptedOrder = deliveryOrder
                            state.authoritativeMarker = value.marker
                        }
                        state.publications.push({
                            deliveryOrder,
                            marker: value.marker,
                            stale,
                            authoritativeMarker: state.authoritativeMarker,
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
const areaBundle = await build({
    stdin: {
        contents: `
            export { area_limit_xhr } from './packages/unblock-area-limit/src/feature/bili/area_limit_xhr_.ts'
            export { installCdnFinalDeliveryObservers } from './packages/unblock-area-limit/src/feature/bili/cdn_final_delivery_observer.ts'
        `,
        resolveDir: rootDir,
        sourcefile: 'jquery-playurl-area-integration-entry.ts',
        loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    write: false,
    plugins: [areaIntegrationStubPlugin()],
})
const areaModuleUrl = `data:text/javascript;base64,${Buffer.from(areaBundle.outputFiles[0].text).toString('base64')}`

try {
    await testRealJqueryWrapperFinalDelivery()
    await testWithoutInstalledObserverRemainsFailOpen()
    await testExactXhrIdentityPreventsBypassClaim()
} finally {
    restoreGlobal('window', originalWindowDescriptor)
    restoreGlobal(testStateKey, originalStateDescriptor)
}

console.log('jQuery playurl final delivery tests passed')

async function testRealJqueryWrapperFinalDelivery() {
    const savedGlobals = new Map([
        ['$', Object.getOwnPropertyDescriptor(globalThis, '$')],
        ['document', Object.getOwnPropertyDescriptor(globalThis, 'document')],
        ['localStorage', Object.getOwnPropertyDescriptor(globalThis, 'localStorage')],
    ])
    const originalComposeDescriptor = Object.getOwnPropertyDescriptor(Promise.prototype, 'compose')
    const NativeXMLHttpRequest = createNativeXhr()
    const state = createState()
    const proxyRequests = []
    const nativeAjaxRequests = []
    const config = new Proxy({
        blocked_vip: false,
        enable_in_av: true,
        flv_prefer_ws: false,
        is_closed: false,
        mode: 'default',
        server: 'https://proxy.example',
        server_custom: 'https://proxy.example',
        server_inner: '',
    }, {
        get(target, key, receiver) {
            return Reflect.has(target, key) ? Reflect.get(target, key, receiver) : false
        },
    })
    const windowValue = createWindow(NativeXMLHttpRequest)
    windowValue.Promise = Promise
    windowValue.Event = Event
    windowValue.top = windowValue
    windowValue.parent = windowValue
    windowValue.localStorage = createStorage()

    function jQuery() { }
    const originalAjaxError = new Error('fixture real originalAjax throw')
    jQuery.ajaxSettings = {
        xhr() { return new windowValue.XMLHttpRequest() },
    }
    jQuery.ajax = function originalAjax(param) {
        param.beforeSend?.()
        const xhrFactory = typeof param.xhr === 'function'
            ? param.xhr
            : jQuery.ajaxSettings.xhr
        const xhr = xhrFactory
            ? xhrFactory.call(param)
            : new windowValue.XMLHttpRequest()
        const doneCallbacks = []
        const failCallbacks = []
        xhr.done = callback => {
            doneCallbacks.push(callback)
            return xhr
        }
        xhr.fail = callback => {
            failCallbacks.push(callback)
            return xhr
        }
        const record = { param, xhr }
        nativeAjaxRequests.push(record)
        xhr.open('GET', param.url)
        xhr.addEventListener('readystatechange', () => {
            if (xhr.readyState !== 4) return
            if (xhr.status === 200) {
                param.success?.(xhr.response)
                for (const callback of doneCallbacks) callback(xhr.response)
            } else {
                param.error?.(xhr)
                for (const callback of failCallbacks) callback(xhr)
            }
        })
        xhr.send()
        if (param.url.includes('request=throw-original-ajax')) throw originalAjaxError
        return xhr
    }
    windowValue.jQuery = jQuery
    windowValue.$ = jQuery

    defineGlobal('window', windowValue)
    defineGlobal('document', windowValue.document)
    defineGlobal('localStorage', windowValue.localStorage)
    defineGlobal('$', jQuery)
    defineGlobal(testStateKey, state)
    defineGlobal('__cdnJqueryAreaConfig', config)
    defineGlobal('__cdnJqueryProxyRequests', proxyRequests)
    defineGlobal('__cdnJqueryAreaCalls', [])
    installPromiseCompose()

    try {
        const module = await import(`${areaModuleUrl}#real-jquery-wrapper`)
        module.area_limit_xhr()

        const noObserverSuccess = []
        const noObserverUrl = 'https://bangumi.bilibili.com/player/web_api/playurl?request=no-observer'
        const noObserverXhr = windowValue.jQuery.ajax({
            url: noObserverUrl,
            success(value) {
                noObserverSuccess.push({
                    marker: value.marker,
                    authoritativeMarker: state.authoritativeMarker,
                    value,
                })
            },
            error(error) { throw error },
        })
        const noObserverRaw = restrictedPlayUrl(
            'no-observer-real-origin',
            'https://no-observer-real-origin.example/video.m4s',
        )
        noObserverXhr.complete(noObserverRaw)
        await flushPromises()
        assert.equal(proxyRequests.length, 1)
        const noObserverProxy = directPlayUrl(
            'no-observer-real-proxy',
            'https://no-observer-real-proxy.example/video.m4s',
        )
        proxyRequests[0].resolve(noObserverProxy)
        await flushPromises()
        assert.strictEqual(noObserverXhr, NativeXMLHttpRequest.instances[0])
        assert.strictEqual(noObserverXhr.response, noObserverRaw)
        assert.deepEqual(state.publications, [{
            deliveryOrder: 1,
            marker: 'no-observer-real-proxy',
            stale: false,
            authoritativeMarker: 'no-observer-real-proxy',
        }], 'the real outer jQuery boundary must publish even before the XHR observer is installed')
        assert.deepEqual(noObserverSuccess.map(call => ({
            marker: call.marker,
            authoritativeMarker: call.authoritativeMarker,
        })), [{
            marker: 'no-observer-real-proxy',
            authoritativeMarker: 'no-observer-real-proxy',
        }])
        assert.strictEqual(noObserverSuccess[0].value, noObserverProxy)

        resetState(state)
        proxyRequests.length = 0
        nativeAjaxRequests.length = 0
        NativeXMLHttpRequest.instances.length = 0

        // Match main.ts: jQuery/XHR injection is installed before the outer
        // final-delivery observer, while originalAjax reads the constructor at request time.
        module.installCdnFinalDeliveryObservers()

        const successCalls = []
        const errors = []
        const olderUrl = 'https://bangumi.bilibili.com/player/web_api/playurl?cid=1&request=older'
        const newerUrl = 'https://legacy-player.example/player/web_api/v2/playurl?cid=2&request=newer'
        const olderXhr = windowValue.jQuery.ajax({
            url: olderUrl,
            success(value) {
                successCalls.push({
                    marker: value.marker,
                    authoritativeMarker: state.authoritativeMarker,
                    value,
                })
            },
            error(error) { errors.push(error) },
        })
        const newerXhr = windowValue.jQuery.ajax({
            url: newerUrl,
            success(value) {
                successCalls.push({
                    marker: value.marker,
                    authoritativeMarker: state.authoritativeMarker,
                    value,
                })
            },
            error(error) { errors.push(error) },
        })

        assert.equal(nativeAjaxRequests.length, 2)
        assert.strictEqual(olderXhr, nativeAjaxRequests[0].xhr, 'real wrapper must preserve older jqXHR identity')
        assert.strictEqual(newerXhr, nativeAjaxRequests[1].xhr, 'real wrapper must preserve newer jqXHR identity')
        assert.strictEqual(olderXhr, NativeXMLHttpRequest.instances[0])
        assert.strictEqual(newerXhr, NativeXMLHttpRequest.instances[1])
        assert.deepEqual(nativeAjaxRequests.map(request => request.param.url), [olderUrl, newerUrl])
        assert.equal(proxyRequests.length, 0, 'default mode must wait for each restricted raw response')
        assert.equal(state.deliveryOrder, 2, 'request-start token allocation must follow jQuery request order')

        const newerRaw = restrictedPlayUrl('newer-origin', 'https://origin-newer.example/video.m4s')
        const olderRaw = restrictedPlayUrl('older-origin', 'https://origin-older.example/video.m4s')
        newerXhr.complete(newerRaw)
        olderXhr.complete(olderRaw)
        await flushPromises()
        assert.deepEqual(
            state.publications,
            [],
            'real raw XHR DONE events must publish nothing while proxy transforms are pending',
        )
        assert.equal(proxyRequests.length, 2, 'each restricted raw response must start one proxy asyncAjax')
        const newerProxyRequest = proxyRequests.find(request => request.url.includes('request=newer'))
        const olderProxyRequest = proxyRequests.find(request => request.url.includes('request=older'))
        assert.ok(newerProxyRequest)
        assert.ok(olderProxyRequest)
        assert.equal(newerProxyRequest.url.startsWith('https://proxy.example/BPplayurl.php?'), true)
        assert.equal(olderProxyRequest.url.startsWith('https://proxy.example/BPplayurl.php?'), true)
        assert.notEqual(newerProxyRequest.url, newerUrl)
        assert.notEqual(olderProxyRequest.url, olderUrl)
        assert.equal(state.deliveryOrder, 2, 'different proxy URLs must not allocate final observer tokens')
        assert.strictEqual(newerXhr.response, newerRaw)
        assert.strictEqual(olderXhr.response, olderRaw)

        const newerProxy = directPlayUrl('newer-proxy', 'https://proxy-newer.example/video.m4s')
        const olderProxy = directPlayUrl('older-proxy', 'https://proxy-older.example/video.m4s')
        newerProxyRequest.resolve(newerProxy)
        await flushPromises()
        olderProxyRequest.resolve(olderProxy)
        await flushPromises()

        assert.deepEqual(state.publications, [
            {
                deliveryOrder: 2,
                marker: 'newer-proxy',
                stale: false,
                authoritativeMarker: 'newer-proxy',
            },
            {
                deliveryOrder: 1,
                marker: 'older-proxy',
                stale: true,
                authoritativeMarker: 'newer-proxy',
            },
        ], 'the real wrapper must publish final proxy payloads with request-start tokens')
        assert.deepEqual(successCalls.map(call => ({
            marker: call.marker,
            authoritativeMarker: call.authoritativeMarker,
        })), [
            { marker: 'newer-proxy', authoritativeMarker: 'newer-proxy' },
            { marker: 'older-proxy', authoritativeMarker: 'newer-proxy' },
        ], 'real oriSuccess callbacks must run after final publication')
        assert.strictEqual(successCalls[0].value, newerProxy)
        assert.strictEqual(successCalls[1].value, olderProxy)
        assert.deepEqual(errors, [])
        assert.equal(newerRaw.marker, 'newer-origin')
        assert.equal(olderRaw.marker, 'older-origin')

        resetState(state)
        proxyRequests.length = 0
        nativeAjaxRequests.length = 0
        NativeXMLHttpRequest.instances.length = 0

        const combinedCallbacks = []
        const combinedUrl = 'https://bangumi.bilibili.com/player/web_api/playurl?request=success-and-done'
        let combinedXhr
        combinedXhr = windowValue.jQuery.ajax({
            url: combinedUrl,
            success(value) {
                combinedCallbacks.push({
                    kind: 'success',
                    authoritativeMarker: state.authoritativeMarker,
                    publicationCount: state.publications.length,
                    value,
                })
                combinedXhr.done(reentrantValue => {
                    combinedCallbacks.push({
                        kind: 'done-reentrant',
                        authoritativeMarker: state.authoritativeMarker,
                        publicationCount: state.publications.length,
                        value: reentrantValue,
                    })
                })
            },
        })
        assert.strictEqual(combinedXhr.done(
            value => {
                combinedCallbacks.push({
                    kind: 'done-first',
                    authoritativeMarker: state.authoritativeMarker,
                    publicationCount: state.publications.length,
                    value,
                })
            },
            value => {
                combinedCallbacks.push({
                    kind: 'done-second',
                    authoritativeMarker: state.authoritativeMarker,
                    publicationCount: state.publications.length,
                    value,
                })
            },
        ), combinedXhr, 'combined success/.done registration must preserve jqXHR identity')
        const combinedRaw = restrictedPlayUrl(
            'success-and-done-origin',
            'https://success-and-done-origin.example/video.m4s',
        )
        combinedXhr.complete(combinedRaw)
        await flushPromises()
        assert.deepEqual(combinedCallbacks, [], 'neither callback may receive the raw XHR payload')
        assert.deepEqual(state.publications, [], 'combined callbacks must keep raw XHR publication deferred')
        const combinedProxyRequest = proxyRequests.find(request => request.url.includes('request=success-and-done'))
        assert.ok(combinedProxyRequest)
        const combinedProxy = directPlayUrl(
            'success-and-done-proxy',
            'https://success-and-done-proxy.example/video.m4s',
        )
        combinedProxyRequest.resolve(combinedProxy)
        await flushPromises()
        assert.deepEqual(combinedCallbacks.map(call => ({
            kind: call.kind,
            authoritativeMarker: call.authoritativeMarker,
            publicationCount: call.publicationCount,
        })), [
            { kind: 'success', authoritativeMarker: 'success-and-done-proxy', publicationCount: 1 },
            { kind: 'done-first', authoritativeMarker: 'success-and-done-proxy', publicationCount: 1 },
            { kind: 'done-second', authoritativeMarker: 'success-and-done-proxy', publicationCount: 1 },
            { kind: 'done-reentrant', authoritativeMarker: 'success-and-done-proxy', publicationCount: 1 },
        ], 'success and .done must receive the final payload in registration order after publication')
        assert.strictEqual(combinedCallbacks[0].value, combinedProxy)
        assert.strictEqual(combinedCallbacks[1].value, combinedProxy)
        assert.strictEqual(combinedCallbacks[2].value, combinedProxy)
        assert.strictEqual(combinedCallbacks[3].value, combinedProxy)
        assert.strictEqual(combinedXhr.done(value => {
            combinedCallbacks.push({
                kind: 'done-late',
                authoritativeMarker: state.authoritativeMarker,
                publicationCount: state.publications.length,
                value,
            })
        }), combinedXhr, 'late post-delivery .done registration must preserve jqXHR identity')
        assert.deepEqual({
            kind: combinedCallbacks[4].kind,
            authoritativeMarker: combinedCallbacks[4].authoritativeMarker,
            publicationCount: combinedCallbacks[4].publicationCount,
        }, {
            kind: 'done-late',
            authoritativeMarker: 'success-and-done-proxy',
            publicationCount: 1,
        }, 'late post-delivery .done registration must retain jqXHR memory semantics')
        assert.strictEqual(combinedCallbacks[4].value, combinedProxy)
        assert.strictEqual(combinedXhr.response, combinedRaw)

        resetState(state)
        proxyRequests.length = 0
        nativeAjaxRequests.length = 0
        NativeXMLHttpRequest.instances.length = 0

        const doneCallbacks = []
        const doneUrl = 'https://bangumi.bilibili.com/player/web_api/playurl?request=done-callback'
        const doneXhr = windowValue.jQuery.ajax({ url: doneUrl })
        assert.strictEqual(doneXhr.done(value => {
            doneCallbacks.push({
                observationAttempts: state.observationAttempts,
                value,
            })
        }), doneXhr, 'late .done registration must preserve jqXHR identity')
        const doneRaw = restrictedPlayUrl(
            'done-origin',
            'https://done-origin.example/video.m4s',
        )
        doneXhr.complete(doneRaw)
        await flushPromises()
        assert.deepEqual(state.publications, [], 'the .done path must also defer raw XHR publication')
        const doneProxyRequest = proxyRequests.find(request => request.url.includes('request=done-callback'))
        assert.ok(doneProxyRequest)
        const doneProxy = directPlayUrl(
            'done-proxy',
            'https://done-proxy.example/video.m4s',
        )
        state.throwObservation = true
        doneProxyRequest.resolve(doneProxy)
        await flushPromises()
        state.throwObservation = false
        assert.deepEqual(state.publications, [], 'failed final observation must remain fail-open')
        assert.deepEqual(doneCallbacks.map(call => call.observationAttempts), [1])
        assert.strictEqual(doneCallbacks[0].value, doneProxy)
        assert.strictEqual(doneXhr.response, doneRaw)

        resetState(state)
        proxyRequests.length = 0
        nativeAjaxRequests.length = 0
        NativeXMLHttpRequest.instances.length = 0

        const configuredXhrFactory = jQuery.ajaxSettings.xhr
        jQuery.ajaxSettings.xhr = undefined
        const missingFactorySuccess = []
        const missingFactoryUrl = 'https://bangumi.bilibili.com/player/web_api/playurl?request=missing-factory'
        const missingFactoryXhr = windowValue.jQuery.ajax({
            url: missingFactoryUrl,
            success(value) {
                missingFactorySuccess.push({
                    marker: value.marker,
                    authoritativeMarker: state.authoritativeMarker,
                    value,
                })
            },
            error(error) { errors.push(error) },
        })
        const missingFactoryRaw = restrictedPlayUrl(
            'missing-factory-origin',
            'https://missing-factory-origin.example/video.m4s',
        )
        missingFactoryXhr.complete(missingFactoryRaw)
        await flushPromises()
        const missingFactoryProxyRequest = proxyRequests.find(request => request.url.includes('request=missing-factory'))
        assert.ok(missingFactoryProxyRequest)
        const missingFactoryProxy = directPlayUrl(
            'missing-factory-proxy',
            'https://missing-factory-proxy.example/video.m4s',
        )
        missingFactoryProxyRequest.resolve(missingFactoryProxy)
        await flushPromises()
        jQuery.ajaxSettings.xhr = configuredXhrFactory
        assert.deepEqual(state.publications.map(publication => ({
            deliveryOrder: publication.deliveryOrder,
            marker: publication.marker,
        })), [
            { deliveryOrder: 2, marker: 'missing-factory-origin' },
            { deliveryOrder: 3, marker: 'missing-factory-proxy' },
        ], 'missing factory coordination must fail open and let the outer final payload supersede raw')
        assert.deepEqual(missingFactorySuccess.map(call => ({
            marker: call.marker,
            authoritativeMarker: call.authoritativeMarker,
        })), [{
            marker: 'missing-factory-proxy',
            authoritativeMarker: 'missing-factory-proxy',
        }])
        assert.strictEqual(missingFactorySuccess[0].value, missingFactoryProxy)
        assert.strictEqual(missingFactoryXhr.response, missingFactoryRaw)

        resetState(state)
        proxyRequests.length = 0
        nativeAjaxRequests.length = 0
        NativeXMLHttpRequest.instances.length = 0

        const bypassXhrs = []
        const bypassSuccess = []
        const bypassUrl = 'https://bangumi.bilibili.com/player/web_api/playurl?request=identity-bound'
        const publicationsBeforeBypass = state.publications.length
        const bypassIntendedXhr = windowValue.jQuery.ajax({
            url: bypassUrl,
            beforeSend() {
                const differentQuery = new windowValue.XMLHttpRequest()
                differentQuery.open(
                    'POST',
                    'https://bangumi.bilibili.com/player/web_api/playurl?request=bypass-different',
                )
                bypassXhrs.push(differentQuery)
                const sameUrl = new windowValue.XMLHttpRequest()
                sameUrl.open('GET', bypassUrl)
                bypassXhrs.push(sameUrl)
            },
            success(value) {
                bypassSuccess.push({
                    marker: value.marker,
                    authoritativeMarker: state.authoritativeMarker,
                    value,
                })
            },
            error(error) { errors.push(error) },
        })
        assert.equal(state.deliveryOrder, 3, 'bypass XHRs must allocate their own tokens')
        const bypassRaw = restrictedPlayUrl(
            'identity-bound-origin',
            'https://identity-bound-origin.example/video.m4s',
        )
        bypassIntendedXhr.complete(bypassRaw)
        await flushPromises()
        assert.equal(
            state.publications.length,
            publicationsBeforeBypass,
            'same-path and same-URL bypass opens must not steal the intended XHR deferral',
        )
        const bypassProxyRequest = proxyRequests.find(request => request.url.includes('request=identity-bound'))
        assert.ok(bypassProxyRequest)
        const bypassProxy = directPlayUrl(
            'identity-bound-proxy',
            'https://identity-bound-proxy.example/video.m4s',
        )
        bypassProxyRequest.resolve(bypassProxy)
        await flushPromises()
        assert.deepEqual(state.publications.at(-1), {
            deliveryOrder: 1,
            marker: 'identity-bound-proxy',
            stale: false,
            authoritativeMarker: 'identity-bound-proxy',
        })
        assert.deepEqual(bypassSuccess.map(call => ({
            marker: call.marker,
            authoritativeMarker: call.authoritativeMarker,
        })), [{
            marker: 'identity-bound-proxy',
            authoritativeMarker: 'identity-bound-proxy',
        }])
        assert.strictEqual(bypassSuccess[0].value, bypassProxy)
        bypassXhrs[0].complete(directPlayUrl(
            'bypass-different-final',
            'https://bypass-different-final.example/video.m4s',
        ))
        bypassXhrs[1].complete(directPlayUrl(
            'bypass-same-final',
            'https://bypass-same-final.example/video.m4s',
        ))
        assert.deepEqual(state.publications.slice(-2).map(publication => ({
            deliveryOrder: publication.deliveryOrder,
            marker: publication.marker,
        })), [
            { deliveryOrder: 2, marker: 'bypass-different-final' },
            { deliveryOrder: 3, marker: 'bypass-same-final' },
        ], 'bypass XHRs must retain ordinary independent observation')

        resetState(state)
        proxyRequests.length = 0
        nativeAjaxRequests.length = 0
        NativeXMLHttpRequest.instances.length = 0

        const beforeSendError = new Error('fixture beforeSend throw')
        const nativeCountBeforeBeforeSendThrow = NativeXMLHttpRequest.instances.length
        assert.throws(
            () => windowValue.jQuery.ajax({
                url: 'https://bangumi.bilibili.com/player/web_api/playurl?request=before-send-throw',
                beforeSend() { throw beforeSendError },
                success() {},
                error() {},
            }),
            error => error === beforeSendError,
            'a pre-factory originalAjax throw must retain its exact error',
        )
        assert.equal(
            NativeXMLHttpRequest.instances.length,
            nativeCountBeforeBeforeSendThrow,
            'a pre-factory throw must not create or mark an XHR',
        )

        const factoryError = new Error('fixture xhr factory throw')
        assert.throws(
            () => windowValue.jQuery.ajax({
                url: 'https://bangumi.bilibili.com/player/web_api/playurl?request=factory-throw',
                xhr() { throw factoryError },
                success() {},
                error() {},
            }),
            error => error === factoryError,
            'a custom XHR factory failure must remain fail-open and preserve its exact error',
        )
        assert.equal(NativeXMLHttpRequest.instances.length, nativeCountBeforeBeforeSendThrow)

        const throwingUrl = 'https://bangumi.bilibili.com/player/web_api/playurl?request=throw-original-ajax'
        assert.throws(
            () => windowValue.jQuery.ajax({ url: throwingUrl, success() {}, error() {} }),
            error => error === originalAjaxError,
            'the real wrapper must preserve the exact originalAjax exception',
        )
        const abandoned = nativeAjaxRequests.at(-1).xhr
        const publicationCountBeforeAbandoned = state.publications.length
        abandoned.complete(restrictedPlayUrl(
            'abandoned-real-original-ajax',
            'https://abandoned-real-original-ajax.example/video.m4s',
        ))
        await flushPromises()
        assert.equal(
            state.publications.length,
            publicationCountBeforeAbandoned,
            'the abandoned raw XHR must not publish a partial delivery',
        )

        const afterThrowXhr = new windowValue.XMLHttpRequest()
        afterThrowXhr.open('GET', throwingUrl)
        afterThrowXhr.complete(directPlayUrl(
            'after-real-original-ajax-throw',
            'https://after-real-original-ajax-throw.example/video.m4s',
        ))
        assert.deepEqual(state.publications.at(-1), {
            deliveryOrder: 4,
            marker: 'after-real-original-ajax-throw',
            stale: false,
            authoritativeMarker: 'after-real-original-ajax-throw',
        }, 'a throwing originalAjax must not leak its deferred scope')
    } finally {
        restoreGlobal('__cdnJqueryAreaCalls')
        restoreGlobal('__cdnJqueryProxyRequests')
        restoreGlobal('__cdnJqueryAreaConfig')
        for (const [name, descriptor] of savedGlobals) restoreGlobal(name, descriptor)
        restoreGlobal('window', originalWindowDescriptor)
        restoreGlobal(testStateKey, originalStateDescriptor)
        restoreProperty(Promise.prototype, 'compose', originalComposeDescriptor)
    }
}

async function testWithoutInstalledObserverRemainsFailOpen() {
    const NativeXMLHttpRequest = createNativeXhr()
    const state = createState()
    const windowValue = createWindow(NativeXMLHttpRequest)
    defineGlobal('window', windowValue)
    defineGlobal(testStateKey, state)
    const module = await import(`${moduleUrl}#jquery-without-observer`)

    const deliveryOrder = module.beginFinalCdnPlayUrlDelivery()
    const createdXhr = new windowValue.XMLHttpRequest()
    const returnedXhr = module.deferFinalCdnPlayUrlXhrDelivery(
        createdXhr,
        deliveryOrder,
    )
    createdXhr.open('GET', 'https://api.bilibili.com/pgc/player/web/playurl?fixture=no-observer')
    const raw = playUrlEnvelope('no-observer-origin', 'https://origin-no-observer.example/video.m4s')
    returnedXhr.complete(raw)
    assert.strictEqual(returnedXhr, createdXhr)
    assert.strictEqual(returnedXhr.response, raw)
    assert.deepEqual(state.publications, [], 'an absent observer must leave native XHR delivery untouched')

    const final = playUrlEnvelope('no-observer-final', 'https://proxy-no-observer.example/video.m4s')
    let delivered
    const result = module.deliverFinalCdnPlayUrlResponse(final, deliveryOrder, value => {
        delivered = value
        return 'no-observer-success-return'
    })
    assert.equal(result, 'no-observer-success-return')
    assert.strictEqual(delivered, final)
    assert.equal(state.authoritativeMarker, 'no-observer-final')

    const failedObservationOrder = module.beginFinalCdnPlayUrlDelivery()
    const failedObservationFinal = playUrlEnvelope(
        'failed-observation-final',
        'https://failed-observation-final.example/video.m4s',
    )
    let failedObservationDelivered
    state.throwObservation = true
    const failedObservationResult = module.deliverFinalCdnPlayUrlResponse(
        failedObservationFinal,
        failedObservationOrder,
        value => {
            failedObservationDelivered = value
            return 'failed-observation-success-return'
        },
    )
    state.throwObservation = false
    assert.equal(failedObservationResult, 'failed-observation-success-return')
    assert.strictEqual(failedObservationDelivered, failedObservationFinal)
}

async function testExactXhrIdentityPreventsBypassClaim() {
    const NativeXMLHttpRequest = createNativeXhr()
    const state = createState()
    const windowValue = createWindow(NativeXMLHttpRequest)
    defineGlobal('window', windowValue)
    defineGlobal(testStateKey, state)
    const module = await import(`${moduleUrl}#jquery-exact-xhr-identity`)
    module.installCdnFinalDeliveryObservers()

    const requestUrl = 'https://api.bilibili.com/x/player/playurl?fixture=intended'
    const deliveryOrder = module.beginFinalCdnPlayUrlDelivery()
    const intendedXhr = new windowValue.XMLHttpRequest()
    assert.strictEqual(
        module.deferFinalCdnPlayUrlXhrDelivery(intendedXhr, deliveryOrder),
        intendedXhr,
        'identity coordination must preserve the transport XHR',
    )

    const differentQueryBypass = new windowValue.XMLHttpRequest()
    differentQueryBypass.open('POST', 'https://api.bilibili.com/x/player/playurl?fixture=bypass')
    const sameUrlBypass = new windowValue.XMLHttpRequest()
    sameUrlBypass.open('GET', requestUrl)
    intendedXhr.open('GET', 'https://api.bilibili.com/x/player/pagelist?fixture=unsupported-first-open')
    intendedXhr.open('GET', requestUrl)

    intendedXhr.complete(playUrlEnvelope('intended-raw', 'https://intended-raw.example/video.m4s'))
    assert.deepEqual(
        state.publications,
        [],
        'only the exact factory-returned XHR may consume the deferred token',
    )
    const intendedFinal = playUrlEnvelope(
        'intended-final',
        'https://intended-final.example/video.m4s',
    )
    module.deliverFinalCdnPlayUrlResponse(intendedFinal, deliveryOrder, value => value)
    differentQueryBypass.complete(playUrlEnvelope(
        'different-query-bypass',
        'https://different-query-bypass.example/video.m4s',
    ))
    sameUrlBypass.complete(playUrlEnvelope(
        'same-url-bypass',
        'https://same-url-bypass.example/video.m4s',
    ))
    assert.deepEqual(state.publications.map(publication => ({
        deliveryOrder: publication.deliveryOrder,
        marker: publication.marker,
    })), [
        { deliveryOrder: 1, marker: 'intended-final' },
        { deliveryOrder: 2, marker: 'different-query-bypass' },
        { deliveryOrder: 3, marker: 'same-url-bypass' },
    ])

    const nextXhr = new windowValue.XMLHttpRequest()
    nextXhr.open('GET', requestUrl)
    const nextRaw = playUrlEnvelope('after-identity-delivery', 'https://after-identity.example/video.m4s')
    nextXhr.complete(nextRaw)
    assert.equal(state.deliveryOrder, 4)
    assert.deepEqual(state.publications.at(-1), {
        deliveryOrder: 4,
        marker: 'after-identity-delivery',
        stale: false,
        authoritativeMarker: 'after-identity-delivery',
    })

    resetState(state)
    const retryOrder = module.beginFinalCdnPlayUrlDelivery()
    const retryXhr = new windowValue.XMLHttpRequest()
    module.deferFinalCdnPlayUrlXhrDelivery(retryXhr, retryOrder)
    const openError = new Error('fixture native open throw')
    retryXhr.nextOpenError = openError
    assert.throws(
        () => retryXhr.open('GET', requestUrl),
        error => error === openError,
        'native open failure must preserve its exact error',
    )
    retryXhr.open('GET', requestUrl)
    retryXhr.complete(playUrlEnvelope('retry-raw', 'https://retry-raw.example/video.m4s'))
    assert.deepEqual(state.publications, [], 'a retry must retain the exact-XHR deferred token')
    module.deliverFinalCdnPlayUrlResponse(
        playUrlEnvelope('retry-final', 'https://retry-final.example/video.m4s'),
        retryOrder,
        value => value,
    )
    assert.deepEqual(state.publications.map(publication => ({
        deliveryOrder: publication.deliveryOrder,
        marker: publication.marker,
    })), [{ deliveryOrder: 1, marker: 'retry-final' }])
}

function createState() {
    return {
        authoritativeMarker: undefined,
        deliveryOrder: 0,
        latestAcceptedOrder: 0,
        observationAttempts: 0,
        publications: [],
        throwObservation: false,
    }
}

function resetState(state) {
    state.authoritativeMarker = undefined
    state.deliveryOrder = 0
    state.latestAcceptedOrder = 0
    state.observationAttempts = 0
    state.publications.length = 0
    state.throwObservation = false
}

function createWindow(XMLHttpRequest) {
    const location = new URL('https://www.bilibili.com/bangumi/play/ep1')
    return {
        XMLHttpRequest,
        fetch: () => Promise.reject(new Error('fetch is unused in this fixture')),
        location,
        document: {
            location,
            title: '',
            head: { appendChild() { } },
            addEventListener() { },
            querySelector() { return null },
        },
        setTimeout() { return 1 },
    }
}

function directPlayUrl(marker, mediaUrl) {
    return {
        marker,
        dash: {
            video: [{ base_url: mediaUrl, backup_url: [] }],
            audio: [],
        },
    }
}

function restrictedPlayUrl(marker, mediaUrl) {
    return {
        ...directPlayUrl(marker, mediaUrl),
        code: -403,
        message: 'restricted fixture',
    }
}

function createStorage() {
    const values = new Map()
    return {
        getItem(key) { return values.get(String(key)) ?? null },
        setItem(key, value) { values.set(String(key), String(value)) },
        removeItem(key) { values.delete(String(key)) },
    }
}

function flushPromises() {
    return new Promise(resolve => setTimeout(resolve, 0))
}

function installPromiseCompose() {
    Object.defineProperty(Promise.prototype, 'compose', {
        configurable: true,
        writable: true,
        value(transformer) {
            return transformer ? transformer(this) : this
        },
    })
}

function areaIntegrationStubPlugin() {
    const stubs = new Map([
        ['../../util/objects', `
            export const Objects = {
                convertKeyToSnakeCase() {},
                stringify(value) { return JSON.stringify(value) },
            }
        `],
        ['../../util/converters', `export const Converters = {}`],
        ['../../util/react', `export function _() { return {} }`],
        ['../../util/async', `
            export const Promise = window.Promise
            export const Async = {
                ajax(url) {
                    return new window.Promise((resolve, reject) => {
                        globalThis.__cdnJqueryProxyRequests.push({ url, resolve, reject })
                    })
                },
                timeout() { return window.Promise.resolve() },
            }
        `],
        ['../../feature/r', `
            export const r = {
                const: {
                    mode: { REDIRECT: 'redirect', DEFAULT: 'default' },
                    server: { CUSTOM: 'custom' },
                },
                regex: { bilibili_api_proxy: /$a/ },
            }
            export const _t = value => value
        `],
        ['../../util/log', `
            const record = (...args) => globalThis.__cdnJqueryAreaCalls.push(args)
            export { record as log, record as util_error, record as util_warn }
        `],
        ['../../util/cookie', `
            export const cookieStorage = { get() {}, set() {} }
        `],
        ['../../feature/config', `
            export const balh_config = globalThis.__cdnJqueryAreaConfig
            export function isClosed() { return false }
        `],
        ['../../feature/page', `
            export const util_page = {
                anime_ep_m() { return false },
                anime_ss_m() { return false },
                av_new() { return false },
                movie() { return false },
                player_in_av() { return false },
                ssId: 0,
            }
        `],
        ['../../api/bilibili-utils', `
            export const access_key_param_if_exist = () => ''
            export const platform_android_param_if_app_only = () => ''
        `],
        ['../../api/biliplus', `
            export const generateMobiPlayUrlParams = () => ''
            export const getMobiPlayUrl = value => value
            export const fixMobiPlayUrlJson = value => value
            export const fixThailandPlayUrlJson = value => value
        `],
        ['../../util/ui', `
            const noop = () => {}
            export const ui = { alert: noop, playerMsg: noop, pop: noop }
        `],
        ['../../util/strings', `
            export const Strings = {
                getSearchParam(url, key) {
                    try { return new URL(url, document.location.href).searchParams.get(key) }
                    catch { return null }
                },
            }
        `],
        ['../../util/initiator', `export function util_init() {}`],
        ['../../util/message', `
            export const util_ui_msg = { showOnNetErrorInPromise() { return undefined } }
        `],
        ['../../util/regexps', `
            export const RegExps = {
                url(value) {
                    const escaped = value.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&')
                    return new RegExp('^(?:https?:)?\\\\/\\\\/' + escaped)
                },
                urlPath(value) { return new RegExp(value) },
            }
        `],
        ['./bilibili_login', `
            export const bilibili_login = { isLogin() { return false }, showLogin() {} }
        `],
        ['../../feature/bili/area_limit_fetch', `
            export function injectFetch() {}
            export function injectFetch4Mobile() {}
        `],
        ['../../feature/bili/space_account_info_map', `export default {}`],
        ['../../feature/bili/area_limit_for_vue', `export function removeEpAreaLimit() {}`],
        ['./subtitle_web_view', `
            export const isSubtitleBodyUrl = () => false
            export const rewriteSubtitleBodyJson = value => value
            export const rewriteSubtitleMetadataUrl = () => null
            export const rewriteSubtitleWebViewResponse = () => null
        `],
        ['../../util/inject-xhr', `export function injectXhr() {}`],
        ['./cdn_recovery_browser', `
            export function prepareCdnRecoveryRequestUrl(url) {
                return { decision: { url }, commit() {}, discard() {} }
            }
        `],
    ])
    return {
        name: 'jquery-playurl-area-integration-stubs',
        setup(buildContext) {
            buildContext.onResolve({ filter: /^\.\/cdn_runtime$/ }, () => ({
                path: 'jquery-playurl-area-runtime-stub',
                namespace: 'jquery-playurl-area-integration',
            }))
            buildContext.onLoad({
                filter: /^jquery-playurl-area-runtime-stub$/,
                namespace: 'jquery-playurl-area-integration',
            }, () => ({
                contents: `
                    const state = globalThis.${testStateKey}

                    export function transformCdnPolicyForFinalDelivery(value) { return value }
                    export function beginFinalCdnDelivery() {
                        state.deliveryOrder += 1
                        return state.deliveryOrder
                    }
                    export function observeFinalCdnDelivery(value, deliveryOrder) {
                        deliveryOrder = Number.isSafeInteger(deliveryOrder) && deliveryOrder > 0
                            ? deliveryOrder
                            : beginFinalCdnDelivery()
                        state.observationAttempts += 1
                        if (state.throwObservation) throw new Error('fixture observation failure')
                        const stale = deliveryOrder < state.latestAcceptedOrder
                        if (!stale) {
                            state.latestAcceptedOrder = deliveryOrder
                            state.authoritativeMarker = value.marker
                        }
                        state.publications.push({
                            deliveryOrder,
                            marker: value.marker,
                            stale,
                            authoritativeMarker: state.authoritativeMarker,
                        })
                        return value
                    }
                `,
                loader: 'js',
            }))
            buildContext.onResolve({ filter: /.*/ }, args => {
                if (!stubs.has(args.path)) return undefined
                return { path: args.path, namespace: 'jquery-playurl-area-integration' }
            })
            buildContext.onLoad({
                filter: /.*/,
                namespace: 'jquery-playurl-area-integration',
            }, args => ({ contents: stubs.get(args.path), loader: 'js' }))
        },
    }
}

function playUrlEnvelope(marker, mediaUrl) {
    return {
        code: 0,
        message: 'success',
        result: {
            marker,
            dash: {
                video: [{ base_url: mediaUrl, backup_url: [] }],
                audio: [],
            },
        },
    }
}

function createNativeXhr() {
    return class NativeXMLHttpRequest extends EventTarget {
        static instances = []

        constructor() {
            super()
            this.readyState = 0
            this.response = null
            this.responseText = ''
            this.responseType = ''
            this.responseURL = ''
            this.status = 0
            NativeXMLHttpRequest.instances.push(this)
        }

        open(method, url) {
            if (this.nextOpenError) {
                const error = this.nextOpenError
                this.nextOpenError = undefined
                throw error
            }
            this.method = method
            this.url = url
            this.readyState = 1
            this.dispatchEvent(new Event('readystatechange'))
        }

        send() { }

        complete(response) {
            this.response = response
            this.responseText = JSON.stringify(response)
            this.responseURL = new URL(this.url, window.location.href).href
            this.status = 200
            this.readyState = 4
            this.dispatchEvent(new Event('readystatechange'))
        }
    }
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

function restoreProperty(target, name, descriptor) {
    if (descriptor) {
        Object.defineProperty(target, name, descriptor)
    } else {
        delete target[name]
    }
}
