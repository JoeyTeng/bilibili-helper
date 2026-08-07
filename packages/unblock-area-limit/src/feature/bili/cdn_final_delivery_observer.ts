import {
    beginFinalCdnPlayUrlDelivery,
    observeFinalCdnPlayUrlResponse,
} from './cdn_playurl'
import { isSupportedCdnPlayUrlEndpoint } from './cdn_playurl_endpoint'

const REPAIR_DELAYS_MS = [0, 50, 250, 1_000] as const

const fetchObserverStates = new WeakMap<Function, { active: boolean }>()
const xhrObserverStates = new WeakMap<Function, { active: boolean }>()
const fetchSlotGetters = new WeakSet<Function>()
const xhrSlotGetters = new WeakSet<Function>()
let installed = false
let activeFetchObserver: Function | undefined
let activeXhrObserver: Function | undefined

/**
 * Keep one URL-transparent observer outside later Fetch/XHR response wrappers.
 * Assignments are composed as a new outer layer, so a downstream userscript can
 * still call the exact predecessor it captured without creating recursion.
 */
export function installCdnFinalDeliveryObservers() {
    if (installed) {
        repairObserverSlots()
        return
    }
    installed = true
    repairObserverSlots()

    for (const delayMs of REPAIR_DELAYS_MS) {
        try {
            window.setTimeout(repairObserverSlots, delayMs)
        } catch {
            // The assignment-aware slot remains active when host timers fail.
        }
    }
    try {
        window.document.addEventListener('DOMContentLoaded', repairObserverSlots, {
            capture: true,
            once: true,
        })
    } catch {
        // Final-delivery observation is optional and must remain fail-open.
    }
}

function repairObserverSlots() {
    if (!installed) return
    installFetchObserverSlot()
    installXhrObserverSlot()
}

function installFetchObserverSlot() {
    let current: typeof window.fetch
    let descriptor: PropertyDescriptor | undefined
    try {
        descriptor = Object.getOwnPropertyDescriptor(window, 'fetch')
        if (descriptor?.get && fetchSlotGetters.has(descriptor.get)) return
        current = window.fetch
    } catch {
        return
    }
    if (typeof current !== 'function') return

    if (descriptor && !('value' in descriptor)) {
        // Writing the getter result back through an unknown setter can create
        // wrapper -> observer -> wrapper recursion. Preserve that accessor.
        return
    }
    let exposed = exposeFetchObserver(current)
    if (descriptor && !descriptor.configurable) {
        try {
            window.fetch = exposed
        } catch {
            // A non-writable global hook is not safe to compose.
        }
        return
    }

    const getter = () => exposed
    const setter = (value: typeof window.fetch) => {
        if (value === exposed) return
        exposed = typeof value === 'function' ? exposeFetchObserver(value) : value
    }
    fetchSlotGetters.add(getter)
    try {
        Object.defineProperty(window, 'fetch', {
            configurable: true,
            enumerable: descriptor?.enumerable ?? true,
            get: getter,
            set: setter,
        })
    } catch {
        try {
            window.fetch = exposed
        } catch {
            // Recovery can continue without final-delivery observation.
        }
    }
}

function createFetchObserver(predecessor: typeof window.fetch): typeof window.fetch {
    const state = { active: false }
    const observer = async function finalCdnObservedFetch(
        this: any,
        input: RequestInfo | URL,
        init?: RequestInit,
    ) {
        let deliveryOrder: number | undefined
        const requestUrl = readFetchUrl(input)
        if (state.active && isObservedPlayUrl(requestUrl)) {
            try {
                deliveryOrder = beginFinalCdnPlayUrlDelivery()
            } catch {
                // Sequencing is optional; the predecessor remains authoritative.
            }
        }
        const response = await predecessor.call(this, input, init)
        if (deliveryOrder === undefined) return response
        try {
            observeFinalCdnPlayUrlResponse(await response.clone().json(), deliveryOrder)
        } catch {
            // Parsing or publication failure must preserve predecessor identity.
        }
        return response
    }
    fetchObserverStates.set(observer, state)
    return observer
}

function exposeFetchObserver(value: typeof window.fetch): typeof window.fetch {
    if (activeFetchObserver && activeFetchObserver !== value) {
        const previousState = fetchObserverStates.get(activeFetchObserver)
        if (previousState) previousState.active = false
    }
    const observer = fetchObserverStates.has(value) ? value : createFetchObserver(value)
    const state = fetchObserverStates.get(observer)
    if (state) state.active = true
    activeFetchObserver = observer
    return observer
}

function installXhrObserverSlot() {
    let current: typeof window.XMLHttpRequest
    let descriptor: PropertyDescriptor | undefined
    try {
        descriptor = Object.getOwnPropertyDescriptor(window, 'XMLHttpRequest')
        if (descriptor?.get && xhrSlotGetters.has(descriptor.get)) return
        current = window.XMLHttpRequest
    } catch {
        return
    }
    if (typeof current !== 'function') return

    if (descriptor && !('value' in descriptor)) {
        // Writing the getter result back through an unknown setter can create
        // constructor recursion. Preserve that accessor.
        return
    }
    let exposed = exposeXhrObserver(current)
    if (descriptor && !descriptor.configurable) {
        try {
            window.XMLHttpRequest = exposed
        } catch {
            // A non-writable global hook is not safe to compose.
        }
        return
    }

    const getter = () => exposed
    const setter = (value: typeof window.XMLHttpRequest) => {
        if (value === exposed) return
        exposed = typeof value === 'function' ? exposeXhrObserver(value) : value
    }
    xhrSlotGetters.add(getter)
    try {
        Object.defineProperty(window, 'XMLHttpRequest', {
            configurable: true,
            enumerable: descriptor?.enumerable ?? true,
            get: getter,
            set: setter,
        })
    } catch {
        try {
            window.XMLHttpRequest = exposed
        } catch {
            // Recovery can continue without final-delivery observation.
        }
    }
}

function createXhrObserver(
    predecessor: typeof window.XMLHttpRequest,
): typeof window.XMLHttpRequest {
    const state = { active: false }
    const requestStates = new WeakMap<object, {
        deliveryOrder?: number
        observedDone: boolean
    }>()
    let Observer: typeof window.XMLHttpRequest
    try {
        const predecessorOpen = predecessor.prototype.open
        Observer = class FinalCdnObservedXMLHttpRequest extends predecessor {
            constructor() {
                super()
                const requestState = { observedDone: false } as {
                    deliveryOrder?: number
                    observedDone: boolean
                }
                requestStates.set(this, requestState)
                try {
                    this.addEventListener('readystatechange', () => {
                        let readyState: number
                        try {
                            readyState = this.readyState
                        } catch {
                            return
                        }
                        if (readyState !== 4) {
                            if (readyState === 1) requestState.observedDone = false
                            return
                        }
                        if (requestState.observedDone) return
                        requestState.observedDone = true
                        if (requestState.deliveryOrder !== undefined) {
                            observeFinalXhrResponse(this, requestState.deliveryOrder)
                        }
                    })
                } catch {
                    // Construction and native XHR behavior remain authoritative.
                }

            }

            open(...args: any[]) {
                const requestState = requestStates.get(this)
                if (!requestState) return predecessorOpen.apply(this, args as any)
                const previousOrder = requestState.deliveryOrder
                const previousObservedDone = requestState.observedDone
                let nextOrder: number | undefined
                if (state.active && isObservedPlayUrl(readXhrOpenUrl(args[1]))) {
                    try {
                        nextOrder = beginFinalCdnPlayUrlDelivery()
                    } catch {
                        // Sequencing is optional; native open remains authoritative.
                    }
                }
                requestState.deliveryOrder = nextOrder
                requestState.observedDone = false
                try {
                    return predecessorOpen.apply(this, args as any)
                } catch (error) {
                    if (requestState.deliveryOrder === nextOrder) {
                        requestState.deliveryOrder = previousOrder
                        requestState.observedDone = previousObservedDone
                    }
                    throw error
                }
            }
        }
    } catch {
        return predecessor
    }
    xhrObserverStates.set(Observer, state)
    return Observer
}

function exposeXhrObserver(value: typeof window.XMLHttpRequest): typeof window.XMLHttpRequest {
    if (activeXhrObserver && activeXhrObserver !== value) {
        const previousState = xhrObserverStates.get(activeXhrObserver)
        if (previousState) previousState.active = false
    }
    const observer = xhrObserverStates.has(value) ? value : createXhrObserver(value)
    const state = xhrObserverStates.get(observer)
    if (state) state.active = true
    activeXhrObserver = observer
    return observer
}

function observeFinalXhrResponse(xhr: XMLHttpRequest, deliveryOrder: number) {
    let responseUrl: string
    try {
        responseUrl = xhr.responseURL
    } catch {
        return
    }
    if (!isObservedPlayUrl(responseUrl)) return

    try {
        const responseType = xhr.responseType
        if (responseType && responseType !== 'json' && responseType !== 'text') return
        const response = xhr.response
        if (isJsonCompatibleResponseObject(response)) {
            observeFinalCdnPlayUrlResponse(response, deliveryOrder)
            return
        }
        if (typeof response === 'string') {
            observeFinalCdnPlayUrlResponse(JSON.parse(response), deliveryOrder)
            return
        }
    } catch {
        // Fall through to responseText when the response getter is unavailable.
    }
    try {
        observeFinalCdnPlayUrlResponse(JSON.parse(xhr.responseText), deliveryOrder)
    } catch {
        // An unreadable final response must not affect native delivery.
    }
}

function isJsonCompatibleResponseObject(value: unknown): value is object {
    if (!value || typeof value !== 'object') return false
    if (Array.isArray(value)) return true
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

function readXhrOpenUrl(value: unknown) {
    try {
        if (typeof value === 'string') return value
        if (value instanceof URL) return value.href
    } catch {
        // Unsupported or hostile values remain unobserved.
    }
    return null
}

function readFetchUrl(input: RequestInfo | URL) {
    try {
        if (typeof input === 'string') return input
        if (input instanceof URL) return input.href
        if (input instanceof Request) return input.url
    } catch {
        // Unsupported or hostile inputs remain unobserved.
    }
    return null
}

function isObservedPlayUrl(rawUrl: string | null) {
    if (!rawUrl) return false
    try {
        const parsed = new URL(rawUrl, window.location.href)
        return parsed.protocol === 'https:'
            && isSupportedCdnPlayUrlEndpoint(parsed.hostname, parsed.pathname)
    } catch {
        return false
    }
}
