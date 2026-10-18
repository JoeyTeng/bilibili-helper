const moduleSelector = '#comment-module'
const componentSelector = 'bili-comments'
const bangumiPath = /^\/bangumi\/play\/(?:ep|ss)\d+\/?$/
const commentsHiddenKey = 'balh_hide_comments'
export const commentsPreferenceEvent = 'balh-comments-preference-change'
let stopCurrent: (() => void) | undefined

export function readBangumiCommentsHidden(): boolean {
    try {
        return window.localStorage.getItem(commentsHiddenKey) === 'true'
    } catch {
        return false
    }
}

export function writeBangumiCommentsHidden(hidden: boolean): boolean {
    try {
        window.localStorage.setItem(commentsHiddenKey, String(hidden))
    } catch {
        return false
    }
    window.dispatchEvent(new CustomEvent(commentsPreferenceEvent, { detail: hidden }))
    return true
}

/** Restore only a hidden comments container with a valid native comments component.
 * Bilibili's native API still controls closed, login, and permission requirements.
 */
export function restoreBangumiComments(root: ParentNode = document): boolean {
    if (!isBangumiPage()) return false
    const module = root instanceof Element && root.matches(moduleSelector)
        ? root : root.querySelector<HTMLElement>(moduleSelector)
    if (!module) return false
    return hasValidComponent(module) && applyVisibility(module as HTMLElement)
}

export function startRestoreBangumiComments(enabled: boolean): () => void {
    if (stopCurrent) {
        if (enabled) return stopCurrent
        stopCurrent()
    }
    if (!enabled || !isBangumiPage() || typeof MutationObserver === 'undefined') return () => undefined

    let activeModule: Element | undefined
    let childObserver: MutationObserver | undefined
    let styleObserver: MutationObserver | undefined
    let stopped = false

    function detachModule() {
        childObserver?.disconnect()
        styleObserver?.disconnect()
        childObserver = undefined
        styleObserver = undefined
        activeModule = undefined
    }
    function containsValidComponent(node: Node): boolean {
        if (!(node instanceof Element)) return false
        return (node.matches(componentSelector) && validParams(node)) || hasValidComponent(node)
    }
    function watchModule(module: Element) {
        if (activeModule === module) return
        detachModule()
        activeModule = module
        if (hasValidComponent(module)) applyVisibility(module as HTMLElement)
        childObserver = new MutationObserver(records => {
            const addedValidComponent = records.some(record => Array.from(record.addedNodes).some(containsValidComponent))
            const updatedValidParams = records.some(record => record.type === 'attributes'
                && record.target instanceof Element
                && record.target.matches(componentSelector)
                && validParams(record.target))
            if ((addedValidComponent || updatedValidParams) && hasValidComponent(module)) {
                applyVisibility(module as HTMLElement)
            }
        })
        childObserver.observe(module, { childList: true, attributes: true, attributeFilter: ['data-params'], subtree: true })
        styleObserver = new MutationObserver(() => {
            if (hasValidComponent(module)) applyVisibility(module as HTMLElement)
        })
        styleObserver.observe(module, { attributes: true, attributeFilter: ['style'] })
    }
    function findModule(node: Node): Element | null {
        if (!(node instanceof Element)) return null
        return node.matches(moduleSelector) ? node : node.querySelector(moduleSelector)
    }

    const discover = new MutationObserver(records => {
        if (activeModule && !activeModule.isConnected) detachModule()
        if (activeModule) return
        for (const record of records) record.addedNodes.forEach(node => {
            const module = findModule(node)
            if (module?.isConnected) watchModule(module)
        })
    })
    discover.observe(document, { childList: true, subtree: true })
    const existing = document.querySelector(moduleSelector)
    if (existing) watchModule(existing)

    const onPreferenceChange = () => {
        if (activeModule && hasValidComponent(activeModule)) applyVisibility(activeModule as HTMLElement)
    }
    const onStorage = (event: StorageEvent) => {
        if (event.key !== commentsHiddenKey && event.key !== null) return
        onPreferenceChange()
    }
    const onPageShow = () => onPreferenceChange()
    window.addEventListener(commentsPreferenceEvent, onPreferenceChange)
    window.addEventListener('storage', onStorage)
    window.addEventListener('pageshow', onPageShow)

    const cleanup = () => {
        if (stopped) return
        stopped = true
        discover.disconnect()
        detachModule()
        window.removeEventListener('pagehide', onPageHide)
        window.removeEventListener(commentsPreferenceEvent, onPreferenceChange)
        window.removeEventListener('storage', onStorage)
        window.removeEventListener('pageshow', onPageShow)
        if (stopCurrent === cleanup) stopCurrent = undefined
    }
    const onPageHide = (event: PageTransitionEvent) => {
        if (!event.persisted) cleanup()
    }
    stopCurrent = cleanup
    window.addEventListener('pagehide', onPageHide)
    return cleanup
}

function isBangumiPage(): boolean {
    return location.hostname === 'www.bilibili.com' && bangumiPath.test(location.pathname)
}
function validParams(component: Element): boolean {
    const params = component.getAttribute('data-params')?.split(',')
    return !!params && params.length === 2 && params.every(value => /^[1-9]\d*$/.test(value))
}
function hasValidComponent(module: ParentNode): boolean {
    return Array.from(module.querySelectorAll<HTMLElement>(componentSelector)).some(validParams)
}
function applyVisibility(module: HTMLElement): boolean {
    if (readBangumiCommentsHidden()) {
        if (module.style.getPropertyValue('display') === 'none' && module.style.getPropertyPriority('display') === 'important') return false
        module.style.setProperty('display', 'none', 'important')
        return true
    }
    if (module.style.getPropertyValue('display') !== 'none') return false
    module.style.removeProperty('display')
    return true
}
