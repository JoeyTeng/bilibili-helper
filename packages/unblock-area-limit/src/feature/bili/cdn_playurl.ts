import {
    applyCdnPolicy,
    beginFinalCdnDelivery,
    observeFinalCdnDelivery,
} from './cdn_runtime'

function isPlayUrlPayload(value: any) {
    return !!value && typeof value === 'object' && (!!value.dash || !!value.durl)
}

/**
 * Unwrap the response shapes used by Bilibili web, mobile, proxy, and hydration APIs.
 * The selector itself always receives the object that directly owns `dash` or `durl`.
 */
export function findPlayUrlPayload(value: any) {
    const candidates = [
        value?.result?.video_info,
        value?.data?.video_info,
        value?.video_info,
        value?.result,
        value?.data,
        value,
    ]
    return candidates.find(isPlayUrlPayload)
}

export function applyCdnPolicyToPlayUrlResponse<T>(value: T): T {
    const playUrl = findPlayUrlPayload(value)
    if (playUrl) {
        applyCdnPolicy(playUrl)
    }
    return value
}

/** Observe, but never mutate, the playurl payload finally delivered to page code. */
export function beginFinalCdnPlayUrlDelivery() {
    return beginFinalCdnDelivery()
}

export function observeFinalCdnPlayUrlResponse<T>(value: T, deliveryOrder?: number): T {
    const playUrl = findPlayUrlPayload(value)
    if (playUrl) {
        observeFinalCdnDelivery(playUrl, deliveryOrder)
    }
    return value
}
