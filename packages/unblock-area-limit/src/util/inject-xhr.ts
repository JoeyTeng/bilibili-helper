// @ts-nocheck
import { util_debug } from "./log"
import { Scripts } from "./scripts"
let noReferrerHostArray: string[] = []
/// 注入Xhr
///
/// [transformRequest]:
/// {@macro xhr_transform_request}
///
/// [transformResponse]:
/// {@macro xhr_transform_response}
export function injectXhr({ transformRequest, transformResponse }) {
    // util_debug('XMLHttpRequest的描述符:', Object.getOwnPropertyDescriptor(window, 'XMLHttpRequest'))
    const NativeXMLHttpRequest = window.XMLHttpRequest
    const nativePrototype = NativeXMLHttpRequest.prototype
    const nativeOpen = Reflect.get(nativePrototype, 'open')
    const nativeSend = Reflect.get(nativePrototype, 'send')
    const nativeAbort = Reflect.get(nativePrototype, 'abort')
    const nativeAddEventListener = Reflect.get(nativePrototype, 'addEventListener')
    const nativeRemoveEventListener = Reflect.get(nativePrototype, 'removeEventListener')
    const nativeDispatchEvent = Reflect.get(nativePrototype, 'dispatchEvent')
    const nativeReadyStateChangeDescriptor = findPropertyDescriptor(nativePrototype, 'onreadystatechange')
    const NativePromise = window.Promise
    const EventConstructor = window.Event
    const states = new WeakMap()
    const pendingNativeValues = new WeakMap()
    const pendingNativeReadyStateChanges = new WeakMap()
    let firstCreateXHR = true

    const nativePrototypeFacade = new Proxy(Object.create(nativePrototype), {
        has: function (target, prop) {
            if (prop === 'onloadend') {
                // Keep consumers on the onreadystatechange compatibility path.
                return false
            }
            return Reflect.has(target, prop)
        },
    })

    class InjectedXMLHttpRequest extends NativeXMLHttpRequest {
        constructor(...args) {
            super(...args)
            // 第一次创建XHR时, 打上断点...
            if (firstCreateXHR && Scripts.isDev) {
                firstCreateXHR = false
                // debugger
            }
            initializeInstance(this)
        }

        get onreadystatechange() {
            const state = states.get(this)
            if (!state) return pendingNativeReadyStateChanges.get(this) ?? null
            return state.publicReadyStateChange ?? null
        }

        set onreadystatechange(value) {
            const state = states.get(this)
            if (!state) {
                pendingNativeReadyStateChanges.set(this, value)
                setNativeReadyStateChange(this, value)
                return
            }
            state.publicReadyStateChange = value
            if (state.usesNativeEventTarget) {
                const wrapped = typeof value === 'function'
                    ? wrapReadyStateChangeCallback(value)
                    : null
                state.wrappedReadyStateChange = wrapped
                setNativeReadyStateChange(this, wrapped)
            }
        }

        addEventListener(type, listener, options) {
            const state = requireState(this)
            if (type !== 'readystatechange' || !state.usesNativeEventTarget || listener == null) {
                return nativeAddEventListener?.call(this, type, listener, options)
            }
            const capture = getEventListenerCapture(options)
            let record = state.readyStateChangeListeners.find(candidate => (
                candidate.listener === listener && candidate.capture === capture
            ))
            if (!record) {
                record = {
                    listener,
                    capture,
                    wrapped: wrapReadyStateChangeListener(listener),
                }
                state.readyStateChangeListeners.push(record)
            }
            return nativeAddEventListener.call(this, type, record.wrapped, options)
        }

        removeEventListener(type, listener, options) {
            const state = requireState(this)
            if (type !== 'readystatechange' || !state.usesNativeEventTarget || listener == null) {
                return nativeRemoveEventListener?.call(this, type, listener, options)
            }
            const capture = getEventListenerCapture(options)
            const record = state.readyStateChangeListeners.find(candidate => (
                candidate.listener === listener && candidate.capture === capture
            ))
            return nativeRemoveEventListener.call(this, type, record?.wrapped ?? listener, options)
        }

        get response() {
            return readNativeProperty(this, 'response')
        }

        set response(value) {
            writeNativeProperty(this, 'response', value)
        }

        get responseText() {
            return readNativeProperty(this, 'responseText')
        }

        set responseText(value) {
            writeNativeProperty(this, 'responseText', value)
        }

        get readyState() {
            return readNativeProperty(this, 'readyState')
        }

        set readyState(value) {
            writeNativeProperty(this, 'readyState', value)
        }

        open(...args) {
            const state = requireState(this)
            // WebIDL argument conversion can run page code before native open
            // validates the call. Keep a stack for reentrant conversion hooks,
            // and only commit the new request after native success is known.
            const transaction = {
                args,
                committed: false,
            }
            state.openTransactions.push(transaction)
            let result
            try {
                result = nativeOpen.apply(this, args)
            } catch (error) {
                removeOpenTransaction(state, transaction)
                throw error
            }
            commitOpenTransaction(state, transaction)
            if (!state.usesNativeEventTarget) {
                setNativeReadyStateChange(this, state.nativeReadyStateChange)
            }
            return result
        }

        send(...args) {
            const state = requireState(this)
            const generation = state.generation
            if (readNativeProperty(this, 'readyState') === 1) {
                const url = state.container.__url
                const host = new URL(url, document.location.href).hostname
                if (noReferrerHostArray.includes(host)) {
                    setReferrer('no-referrer')
                } else {
                    setReferrer('no-referrer-when-downgrade')
                }
            }

            // Hold a synchronous DONE event while the native implementation
            // validates its internal send flag. Only a successful native send
            // is allowed to start proxy work.
            const previousBlock = captureContainerFlag(state.container, '__block_response')
            state.container.__block_response = true
            let result
            try {
                result = nativeSend.apply(this, args)
            } catch (error) {
                if (state.generation === generation) {
                    restoreContainerFlag(state.container, '__block_response', previousBlock)
                }
                throw error
            }
            if (state.generation !== generation) return result

            let requestResult
            try {
                /// {@macro xhr_transform_request}
                requestResult = transformRequest({
                    url: state.container.__url,
                    container: state.container,
                })
            } catch (error) {
                restoreContainerFlag(state.container, '__block_response', previousBlock)
                if (!state.container.__block_response && state.hasNativeFallback) {
                    processCapturedNativeCompletion(this, state)
                }
                util_debug('XHR transformRequest failed; using native request', error)
                return result
            }

            if (requestResult != null) {
                const inspected = inspectThenable(requestResult)
                const promise = inspected.isThenable
                    ? inspected.promise
                    : NativePromise.resolve(requestResult)
                dispatchAsyncResult(this, state, promise)
            } else {
                restoreContainerFlag(state.container, '__block_response', previousBlock)
                if (!state.container.__block_response && state.hasNativeFallback) {
                    processCapturedNativeCompletion(this, state)
                }
            }
            return result
        }

        abort(...args) {
            const state = requireState(this)
            resetRequestState(state)
            const generation = state.generation
            state.aborting = true
            try {
                return nativeAbort.apply(this, args)
            } finally {
                if (state.generation === generation) {
                    state.aborting = false
                }
            }
        }
    }

    // Put a transparent layer before the native prototype so `onloadend in xhr`
    // stays false without wrapping the XHR instance itself. The public object is
    // therefore the real native instance used by WebIDL and external subclasses.
    Object.setPrototypeOf(InjectedXMLHttpRequest.prototype, nativePrototypeFacade)
    window.XMLHttpRequest = InjectedXMLHttpRequest

    function initializeInstance(instance) {
        const usesNativeEventTarget = (
            typeof nativeAddEventListener === 'function'
            && typeof nativeRemoveEventListener === 'function'
            && typeof nativeDispatchEvent === 'function'
        )
        const state = {
            container: {},
            generation: 0,
            aborting: false,
            asyncOutcome: 'idle',
            asyncResponse: undefined,
            hasNativeFallback: false,
            nativeFallbackEvent: undefined,
            nativeCompletionDelivered: false,
            openTransactions: [],
            originalPrototype: Object.getPrototypeOf(instance),
            nativeReadyStateChange: undefined,
            nativeValues: pendingNativeValues.get(instance) ?? {},
            publicReadyStateChange: pendingNativeReadyStateChanges.get(instance) ?? null,
            readyStateChangeListeners: [],
            syntheticDelivery: false,
            usesNativeEventTarget,
            wrappedReadyStateChange: undefined,
        }
        pendingNativeValues.delete(instance)
        pendingNativeReadyStateChanges.delete(instance)
        state.nativeReadyStateChange = event => handleNativeReadyStateChange(instance, state, event)
        states.set(instance, state)
        if (usesNativeEventTarget) {
            // Construction installs this before page code can register listeners,
            // so target-ordering is sufficient and preserves currentTarget in
            // runtimes whose EventTarget capture implementation is incomplete.
            nativeAddEventListener.call(instance, 'readystatechange', state.nativeReadyStateChange)
            if (typeof state.publicReadyStateChange === 'function') {
                state.wrappedReadyStateChange = wrapReadyStateChangeCallback(state.publicReadyStateChange)
                setNativeReadyStateChange(instance, state.wrappedReadyStateChange)
            }
        } else {
            setNativeReadyStateChange(instance, state.nativeReadyStateChange)
        }
        for (const prop of ['response', 'responseText', 'readyState']) {
            Object.defineProperty(instance, prop, {
                configurable: true,
                get: function () {
                    if (Object.prototype.hasOwnProperty.call(state.container, prop)) {
                        return state.container[prop]
                    }
                    return Reflect.get(state.originalPrototype, prop, instance)
                },
                set: function (value) {
                    state.nativeValues[prop] = value
                },
            })
        }
    }

    function requireState(instance) {
        const state = states.get(instance)
        if (!state) throw new TypeError('Illegal XMLHttpRequest invocation')
        return state
    }

    function readNativeProperty(instance, prop) {
        const descriptor = findPropertyDescriptor(nativePrototype, prop)
        if (!descriptor?.get) {
            const state = states.get(instance)
            const nativeValues = state?.nativeValues ?? pendingNativeValues.get(instance)
            if (nativeValues && Object.prototype.hasOwnProperty.call(nativeValues, prop)) {
                return nativeValues[prop]
            }
        }
        return Reflect.get(nativePrototype, prop, instance)
    }

    function writeNativeProperty(instance, prop, value) {
        const state = states.get(instance)
        if (state) {
            state.nativeValues[prop] = value
            return
        }
        let nativeValues = pendingNativeValues.get(instance)
        if (!nativeValues) {
            nativeValues = {}
            pendingNativeValues.set(instance, nativeValues)
        }
        nativeValues[prop] = value
    }

    function setNativeReadyStateChange(instance, value) {
        if (nativeReadyStateChangeDescriptor?.set) {
            nativeReadyStateChangeDescriptor.set.call(instance, value)
            return
        }
        pendingNativeReadyStateChanges.set(instance, value)
    }

    function resetRequestState(state) {
        state.generation += 1
        state.aborting = false
        state.asyncOutcome = 'idle'
        state.asyncResponse = undefined
        state.hasNativeFallback = false
        state.nativeFallbackEvent = undefined
        state.nativeCompletionDelivered = false
        state.syntheticDelivery = false
        for (const prop of [
            '__block_response',
            '__has_replacement',
            '__redirect',
            '__response',
            'readyState',
            'response',
            'responseText',
        ]) {
            delete state.container[prop]
        }
    }

    function commitOpenTransaction(state, transaction) {
        if (transaction.committed) return
        transaction.committed = true
        removeOpenTransaction(state, transaction)
        resetRequestState(state)
        state.container.__method = transaction.args[0]
        state.container.__url = transaction.args[1]
    }

    function removeOpenTransaction(state, transaction) {
        const index = state.openTransactions.lastIndexOf(transaction)
        if (index >= 0) {
            state.openTransactions.splice(index, 1)
        }
    }

    function setContainerResponse(container, response: any) {
        container.__has_replacement = true
        container.response = response
        if (typeof response === 'string') {
            container.responseText = response
        } else if (response instanceof ArrayBuffer || ArrayBuffer.isView(response) || response instanceof Blob) {
            delete container.responseText
        } else {
            container.responseText = JSON.stringify(response)
        }
    }

    function dispatchAsyncResult(instance, state, promise) {
        const generation = state.generation
        state.asyncOutcome = 'pending'
        state.asyncResponse = undefined
        state.container.__block_response = true
        promise.then(
            response => {
                if (state.generation !== generation) return
                state.asyncOutcome = 'success'
                state.asyncResponse = response
                if (state.hasNativeFallback && !state.nativeCompletionDelivered) {
                    deliverCapturedAsyncSuccess(instance, state)
                }
            },
            () => {
                if (state.generation !== generation) return
                state.asyncOutcome = 'failure'
                state.container.__block_response = false
                if (!state.hasNativeFallback) return
                releaseCapturedNativeFallback(instance, state)
            },
        )
    }

    function handleNativeReadyStateChange(instance, state, event) {
        if (state.syntheticDelivery || state.aborting) return
        const openTransaction = state.openTransactions[state.openTransactions.length - 1]
        if (
            openTransaction
            && event?.isTrusted === true
            && readNativeProperty(instance, 'readyState') === 1
        ) {
            // Only a trusted native OPENED event proves that this transaction
            // passed validation. Converter-dispatched or old-request events do not.
            commitOpenTransaction(state, openTransaction)
        }
        if (readNativeProperty(instance, 'readyState') === 4) {
            if (state.nativeCompletionDelivered) {
                suppressNativeEvent(event)
                return
            }
            if (state.container.__block_response) {
                if (state.asyncOutcome === 'success') {
                    setContainerResponse(state.container, state.asyncResponse)
                    state.nativeCompletionDelivered = true
                    clearNativeFallback(state)
                    return
                }
                captureNativeFallback(state, event)
                return
            }
            /// {@macro xhr_transform_response}
            const transformed = invokeTransformResponse(instance, state)
            if (!transformed.ok) {
                state.nativeCompletionDelivered = true
                if (!state.usesNativeEventTarget) {
                    dispatchFallbackReadyStateChange(instance, state, event)
                }
                return
            }
            const response = transformed.response
            if (response != null) {
                const inspected = inspectThenable(response)
                if (inspected.isThenable) {
                    captureNativeFallback(state, event)
                    dispatchAsyncResult(instance, state, inspected.promise)
                    return
                } else {
                    setContainerResponse(state.container, response)
                }
            }
            state.nativeCompletionDelivered = true
        }
        if (!state.usesNativeEventTarget) {
            dispatchFallbackReadyStateChange(instance, state, event)
        }
    }

    function processCapturedNativeCompletion(instance, state) {
        const event = state.nativeFallbackEvent
        clearNativeFallback(state)
        /// {@macro xhr_transform_response}
        const transformed = invokeTransformResponse(instance, state)
        if (!transformed.ok) {
            state.nativeCompletionDelivered = true
            dispatchSyntheticReadyStateChange(instance, state, event)
            return
        }
        const response = transformed.response
        if (response != null) {
            const inspected = inspectThenable(response)
            if (inspected.isThenable) {
                state.hasNativeFallback = true
                state.nativeFallbackEvent = event
                dispatchAsyncResult(instance, state, inspected.promise)
                return
            }
            setContainerResponse(state.container, response)
        }
        state.nativeCompletionDelivered = true
        dispatchSyntheticReadyStateChange(instance, state, event)
    }

    function deliverCapturedAsyncSuccess(instance, state) {
        const event = state.nativeFallbackEvent
        setContainerResponse(state.container, state.asyncResponse)
        state.nativeCompletionDelivered = true
        clearNativeFallback(state)
        dispatchSyntheticReadyStateChange(instance, state, event)
    }

    function releaseCapturedNativeFallback(instance, state) {
        const event = state.nativeFallbackEvent
        state.nativeCompletionDelivered = true
        clearNativeFallback(state)
        dispatchSyntheticReadyStateChange(instance, state, event)
    }

    function captureNativeFallback(state, event) {
        state.hasNativeFallback = true
        state.nativeFallbackEvent = event
        suppressNativeEvent(event)
    }

    function clearNativeFallback(state) {
        state.hasNativeFallback = false
        state.nativeFallbackEvent = undefined
    }

    function suppressNativeEvent(event) {
        if (typeof event?.stopImmediatePropagation === 'function') {
            event.stopImmediatePropagation()
        }
    }

    function dispatchFallbackReadyStateChange(instance, state, event) {
        const callback = state.publicReadyStateChange
        if (typeof callback === 'function') {
            invokeReadyStateChangeCallback(callback, instance, event)
        }
    }

    function dispatchSyntheticReadyStateChange(instance, state, fallbackEvent) {
        if (!state.usesNativeEventTarget || typeof EventConstructor !== 'function') {
            dispatchFallbackReadyStateChange(instance, state, fallbackEvent)
            return
        }
        state.syntheticDelivery = true
        try {
            nativeDispatchEvent.call(instance, new EventConstructor('readystatechange'))
        } finally {
            state.syntheticDelivery = false
        }
    }

    function wrapReadyStateChangeCallback(callback) {
        return function (event) {
            invokeReadyStateChangeCallback(callback, this, event)
        }
    }

    function wrapReadyStateChangeListener(listener) {
        return function (event) {
            if (typeof listener === 'function') {
                invokeReadyStateChangeCallback(listener, this, event)
                return
            }
            const callback = listener?.handleEvent
            if (typeof callback === 'function') {
                invokeReadyStateChangeCallback(callback, listener, event)
            }
        }
    }

    function invokeReadyStateChangeCallback(callback, receiver, event) {
        try {
            callback.call(receiver, event)
        } catch (error) {
            reportCallbackError(error)
        }
    }

    function invokeTransformResponse(instance, state) {
        try {
            return {
                ok: true,
                response: transformResponse({
                    url: instance.responseURL,
                    response: instance.response,
                    xhr: instance,
                    container: state.container,
                }),
            }
        } catch (error) {
            util_debug('XHR transformResponse failed; using native response', error)
            return { ok: false, response: null }
        }
    }

    function reportCallbackError(error) {
        const reportError = (globalThis as any).reportError
        if (typeof reportError === 'function') {
            reportError(error)
        } else {
            setTimeout(() => { throw error }, 0)
        }
    }

    function getEventListenerCapture(options) {
        if (typeof options === 'boolean') return options
        return Boolean(options?.capture)
    }

    function inspectThenable(value) {
        if ((typeof value !== 'object' || value === null) && typeof value !== 'function') {
            return { isThenable: false, promise: undefined }
        }
        let then
        try {
            then = value.then
        } catch (error) {
            return { isThenable: true, promise: NativePromise.reject(error) }
        }
        if (typeof then !== 'function') {
            return { isThenable: false, promise: undefined }
        }
        return {
            isThenable: true,
            promise: new NativePromise((resolve, reject) => {
                then.call(value, resolve, reject)
            }),
        }
    }

    function captureContainerFlag(container, prop) {
        return {
            exists: Object.prototype.hasOwnProperty.call(container, prop),
            value: container[prop],
        }
    }

    function restoreContainerFlag(container, prop, captured) {
        if (captured.exists) {
            container[prop] = captured.value
        } else {
            delete container[prop]
        }
    }

    function findPropertyDescriptor(value, prop) {
        while (value) {
            const descriptor = Object.getOwnPropertyDescriptor(value, prop)
            if (descriptor) return descriptor
            value = Object.getPrototypeOf(value)
        }
        return undefined
    }
}

let referrerEle: HTMLMetaElement | null = null

/**
 * XHR请求不能修改referer头, 目前通过修改网页的meta标签实现, 当前只对脚本重建的`bangumi-play-page-template.html`网页生效
 * 
 * @see https://stackoverflow.com/questions/27218525/set-referer-for-xmlhttprequest
 */
function setReferrer(referrer: 'no-referrer-when-downgrade' | 'no-referrer') {
    referrerEle ??= window.document.getElementById('referrerMark')
    if (referrerEle) {
        referrerEle.content = referrer
    }
}

export function addNoRefererHost(url: string) {
    if (url) {
        const host = new URL(url).hostname
        if (noReferrerHostArray.indexOf(host) < 0) {
            noReferrerHostArray.push(host)
        }
    }
}
