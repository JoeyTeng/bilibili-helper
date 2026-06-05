import { Exception } from "./error";
import { util_debug } from "./log";
import { _ } from "./react";

// 在某些情况下, 页面中会修改window.Promise... 故我们要备份一下原始的Promise
const Promise = window.Promise
// 页面中倒是不会修改fetch, 但我们会修改(, 故也还是备份下
const fetch = window.fetch?.bind(window)
/**
* 模仿RxJava中的compose操作符
* @param transformer 转换函数, 传入Promise, 返回Promise; 若为空, 则啥也不做
*/
Promise.prototype.compose = function (transformer: any) {
    return transformer ? transformer(this) : this
}

namespace Async {
    export function timeout(timeout: number) {
        return new Promise((resolve, reject) => {
            setTimeout(resolve, timeout);
        })
    }
    class RetryUntilTimeoutException extends Exception { }

    // 直到满足condition()为止, 才执行promiseCreator(), 创建Promise
    // https://stackoverflow.com/questions/40328932/javascript-es6-promise-for-loop
    export function retryUntil<T>(
        condition: () => boolean,
        promiseCreator: () => Promise<T>,
        retryCount = Number.MAX_VALUE,
        interval = 1,
    ) {
        const loop = (time: number): Promise<T> => {
            if (!condition()) {
                if (time < retryCount) {
                    return timeout(interval).then(loop.bind(null, time + 1))
                } else {
                    return Promise.reject(new RetryUntilTimeoutException(`retryUntil timeout, condition: ${condition.toString()}`))
                }
            } else {
                return promiseCreator()
            }
        }
        return loop(0)
    }


    /**
    * @param promiseCreator  创建Promise的函数
    * @param resultTransformer 用于变换result的函数, 返回新的result或Promise
    * @param errorTransformer  用于变换error的函数, 返回新的error或Promise, 返回的Promise可以做状态恢复...
    */
    export function wrapper(promiseCreator: (...args: any) => Promise<any>, resultTransformer: (r: any) => any, errorTransformer: (e: any) => any) {
        return function (...args: any) {
            return new Promise((resolve, reject) => {
                // log(promiseCreator, ...args)
                promiseCreator(...args)
                    .then(r => resultTransformer ? resultTransformer(r) : r)
                    .then(r => resolve(r))
                    .catch(e => {
                        e = errorTransformer ? errorTransformer(e) : e
                        if (!(e instanceof Promise)) {
                            // 若返回值不是Promise, 则表示是一个error
                            e = Promise.reject(e)
                        }
                        (e as Promise<any>).then(r => resolve(r)).catch(e => reject(e))
                    })
            })
        }
    }

    function rewriteUrlAuth(url: string) {
        let authorization = ''
        // Move URL username/password into the Authorization header before sending the request.
        const originUrl = new URL(url, document.location.href)
        if (originUrl.username && originUrl.password) {
            authorization = "Basic " + btoa(`${originUrl.username}:${originUrl.password}`)
            originUrl.username = ''
            originUrl.password = ''
            url = originUrl.href
        }
        return { url, authorization }
    }

    function parseResponseText<T>(text: string, contentType = ''): T {
        contentType = contentType.toLowerCase()
        if (contentType.includes('xml')) {
            return new DOMParser().parseFromString(text, 'text/xml') as T
        }

        const shouldParseJson = contentType.includes('json') || /^[\s\r\n]*[\[{]/.test(text)
        if (shouldParseJson) {
            try {
                return JSON.parse(text) as T
            } catch (e) {
                if (contentType.includes('json')) {
                    throw e
                }
            }
        }
        return text as T
    }

    function parseFetchResponse<T>(response: Response): Promise<T> {
        return response.text().then(text => parseResponseText<T>(text, response.headers.get('content-type') || ''))
    }

    function xhrError(req: XMLHttpRequest) {
        return {
            readyState: req.status === 0 ? 0 : req.readyState,
            status: req.status,
            statusText: req.statusText || 'error',
            response: req.response,
            responseText: req.responseText,
            responseURL: req.responseURL,
        }
    }

    function requestByFetch<T>(url: string): Promise<T> {
        if (!fetch) {
            return Promise.reject(new Error('fetch is not available'))
        }

        const request = rewriteUrlAuth(url)
        const headers: Record<string, string> = {}
        if (request.authorization) {
            headers.Authorization = request.authorization
        }

        util_debug(`ajax(fetch): ${request.url}`)
        return fetch(request.url, {
            credentials: 'include',
            headers,
        }).then(response => {
            if (!response.ok) {
                return Promise.reject(response)
            }
            return parseFetchResponse<T>(response)
        })
    }

    function requestByXhr<T>(url: string): Promise<T> {
        return new Promise((resolve, reject) => {
            const req = new XMLHttpRequest()
            req.onreadystatechange = (event) => {
                if (req.readyState === 4) {
                    if (req.status === 200) {
                        try {
                            resolve(parseResponseText<T>(req.responseText, req.getResponseHeader('content-type') || ''))
                        } catch (e) {
                            reject(e)
                        }
                    } else {
                        reject(xhrError(req))
                    }
                }
            }
            req.withCredentials = true
            const request = rewriteUrlAuth(url)
            url = request.url
            const authorization = request.authorization
            req.open('GET', url)
            if (authorization) {
                req.setRequestHeader("Authorization", authorization);
            }
            req.send()
        });
    }

    export function ajax<T>(url: string): Promise<T> {
        return requestByFetch<T>(url)
            .catch(() => requestByXhr<T>(url))
    }

    export function ajaxByXhr<T>(url: string): Promise<T> {
        return requestByXhr<T>(url)
    }

    export function jsonp(url: string) {
        return new Promise<void>((resolve, reject) => {
            document.head.appendChild(_('script', {
                src: url,
                event: {
                    load: function () {
                        resolve()
                    },
                    error: function () {
                        reject()
                    }
                }
            }));
        })
    }
}
export { Promise, Async }
