#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(rootDir, '.codex-tmp/tests')
const outFile = path.join(outDir, 'restore-comments.mjs')
await mkdir(outDir, { recursive: true })
await build({
    entryPoints: [path.join(rootDir, 'packages/unblock-area-limit/src/feature/bili/restore_comments.ts')],
    outfile: outFile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
})

async function main() {
    const environment = createDom()
    Object.assign(globalThis, { document: environment.document, location: environment.location, window: environment.window, CustomEvent: FakeCustomEvent })
    globalThis.Element = FakeElement
    globalThis.Node = FakeNode
    globalThis.MutationObserver = FakeMutationObserver
    const { commentsPreferenceEvent, isBangumiCommentsPreferenceAvailable, readBangumiCommentsHidden, restoreBangumiComments, startRestoreBangumiComments, writeBangumiCommentsHidden } = await import(`${pathToFileURL(outFile).href}?t=${Date.now()}`)

    const tick = () => new Promise(resolve => setTimeout(resolve, 0))
    const episode = () => {
        environment.location.hostname = 'www.bilibili.com'
        environment.location.pathname = '/bangumi/play/ep247270'
    }
    const make = (tag, attrs = {}) => {
        const element = new FakeElement(tag)
        for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value)
        return element
    }
    const commentModule = (style = 'display:none;color:green') => make('div', { id: 'comment-module', style })
    const comments = params => make('bili-comments', params === undefined ? {} : { 'data-params': params })

    environment.location.hostname = 'm.bilibili.com'
    assert.equal(isBangumiCommentsPreferenceAvailable(), false)
    environment.location.hostname = 'www.bilibili.com'
    environment.location.pathname = '/video/BV1xx'
    assert.equal(isBangumiCommentsPreferenceAvailable(), true, 'main-site settings remain available outside bangumi playback')

    assert.equal(readBangumiCommentsHidden(), false)
    environment.window.localStorage.throwOnGet = true
    assert.equal(readBangumiCommentsHidden(), false)
    environment.window.localStorage.throwOnGet = false
    environment.window.localStorage.throwOnSet = true
    assert.equal(writeBangumiCommentsHidden(true), false)
    assert.equal(readBangumiCommentsHidden(), false)
    environment.window.localStorage.throwOnSet = false

    // Disabled mode and non-PGC URLs leave an otherwise valid hidden container alone.
    episode()
    startRestoreBangumiComments(false)
    let module = commentModule()
    module.appendChild(comments('1,30638972'))
    environment.document.body.appendChild(module)
    await tick()
    assert.equal(module.style.getPropertyValue('display'), 'none')
    environment.document.body.removeChild(module)
    environment.location.pathname = '/video/BV1xx'
    const videoCleanup = startRestoreBangumiComments(true)
    module = commentModule()
    module.appendChild(comments('1,30638972'))
    environment.document.body.appendChild(module)
    await tick()
    assert.equal(module.style.getPropertyValue('display'), 'none')
    episode()
    environment.window.dispatchEvent({ type: 'popstate' })
    await tick()
    assert.equal(module.style.getPropertyValue('display'), '', 'startup on an ordinary video must discover and restore an existing module after entering bangumi')
    environment.location.pathname = '/video/BV1xx'
    environment.window.dispatchEvent({ type: 'popstate' })
    environment.document.body.removeChild(module)
    const lateModule = commentModule()
    lateModule.appendChild(comments('1,30638972'))
    environment.document.body.appendChild(lateModule)
    await tick()
    assert.equal(lateModule.style.getPropertyValue('display'), 'none')
    episode()
    environment.document.body.appendChild(make('aside'))
    await tick()
    assert.equal(lateModule.style.getPropertyValue('display'), '', 'pushState back to bangumi must rediscover a late module after unrelated DOM churn')
    videoCleanup()
    environment.document.body.removeChild(lateModule)

    episode()
    assert.equal(writeBangumiCommentsHidden(true), true)
    const cleanup = startRestoreBangumiComments(true)
    assert.equal(startRestoreBangumiComments(true), cleanup)

    // A late container is ignored until it has a component with valid positive decimal params.
    module = commentModule()
    module.appendChild(comments('1,0'))
    environment.document.body.appendChild(module)
    await tick()
    assert.equal(module.style.getPropertyValue('display'), 'none')
    assert.equal(module.style.getPropertyPriority('display'), '')
    const pending = comments()
    module.appendChild(pending)
    await tick()
    assert.equal(module.style.getPropertyValue('display'), 'none')
    assert.equal(module.style.getPropertyPriority('display'), '')
    pending.setAttribute('data-params', '1,30638972')
    await tick()
    assert.equal(module.style.getPropertyValue('display'), 'none')
    assert.equal(module.style.getPropertyPriority('display'), 'important')

    // Leaving bangumi restores the previous display state; returning can reattach the existing module.
    environment.location.pathname = '/video/BV1xx'
    environment.window.dispatchEvent({ type: 'popstate' })
    assert.equal(module.style.getPropertyValue('display'), 'none')
    assert.equal(module.style.getPropertyPriority('display'), '')
    episode()
    // Simulate pushState without a history event; unrelated body churn re-discovers the existing container.
    environment.document.body.appendChild(make('aside'))
    await tick()
    assert.equal(module.style.getPropertyPriority('display'), 'important')
    assert.equal(writeBangumiCommentsHidden(false), true)
    await tick()
    assert.equal(module.style.getPropertyValue('display'), '')
    assert.equal(module.style.getPropertyValue('color'), 'green')
    assert.equal(pending.getAttribute('data-params'), '1,30638972')

    // Repeat React's style reset; the module is restored while component attributes and hidden state remain untouched.
    const hiddenComponent = comments('2,42')
    hiddenComponent.setAttribute('hidden', '')
    hiddenComponent.setAttribute('aria-hidden', 'true')
    module.appendChild(hiddenComponent)
    module.style.setProperty('display', 'none')
    await tick()
    assert.equal(module.style.getPropertyValue('display'), '')
    assert.equal(hiddenComponent.hasAttribute('hidden'), true)
    assert.equal(hiddenComponent.getAttribute('aria-hidden'), 'true')

    // A replacement inserted while the old container is connected is found after its later removal.
    const replacement = commentModule('display:block;color:purple')
    replacement.appendChild(comments('3,99'))
    environment.document.body.appendChild(replacement)
    await tick()
    assert.equal(replacement.style.getPropertyValue('display'), 'block')
    environment.document.body.removeChild(module)
    await tick()
    assert.equal(replacement.style.getPropertyValue('display'), 'block')

    environment.window.localStorage.values.set('balh_hide_comments', 'true')
    environment.window.dispatchEvent(new FakeStorageEvent('storage', { key: 'balh_hide_comments', newValue: 'true' }))
    await tick()
    assert.equal(replacement.style.getPropertyValue('display'), 'none')
    assert.equal(replacement.style.getPropertyPriority('display'), 'important')
    environment.location.pathname = '/video/BV1xx'
    environment.window.dispatchEvent({ type: 'popstate' })
    assert.equal(replacement.style.getPropertyValue('display'), 'block', 'route suspension restores the pre-hide display value')
    episode()
    environment.window.dispatchEvent({ type: 'popstate' })
    await tick()
    assert.equal(replacement.style.getPropertyPriority('display'), 'important')
    replacement.style.setProperty('display', 'grid')
    await tick()
    assert.equal(replacement.style.getPropertyValue('display'), 'none', 'the controller should rehide after a site display rewrite')
    assert.equal(writeBangumiCommentsHidden(false), true)
    await tick()
    assert.equal(replacement.style.getPropertyValue('display'), 'grid', 'show restores the latest site display value')
    assert.equal(writeBangumiCommentsHidden(true), true)
    await tick()
    assert.equal(replacement.style.getPropertyPriority('display'), 'important')
    environment.location.pathname = '/video/BV1xx'
    environment.window.dispatchEvent({ type: 'popstate' })
    assert.equal(replacement.style.getPropertyValue('display'), 'grid', 'route leave restores the latest site display value')
    episode()
    environment.window.dispatchEvent({ type: 'popstate' })
    await tick()
    assert.equal(replacement.style.getPropertyPriority('display'), 'important')
    environment.window.localStorage.values.set('balh_hide_comments', 'false')
    environment.window.dispatchEvent(new FakeStorageEvent('storage', { key: 'balh_hide_comments', newValue: 'false' }))
    await tick()
    assert.equal(replacement.style.getPropertyValue('display'), 'grid')

    // BFCache pagehide keeps observation alive; a real pagehide disconnects it.
    environment.window.dispatchEvent({ type: 'pagehide', persisted: true })
    replacement.style.setProperty('display', 'none')
    await tick()
    assert.equal(replacement.style.getPropertyValue('display'), '')
    environment.window.dispatchEvent({ type: 'pagehide', persisted: false })
    replacement.style.setProperty('display', 'none')
    await tick()
    assert.equal(replacement.style.getPropertyValue('display'), 'none')
    cleanup()

    assert.equal(readBangumiCommentsHidden(), false)
    assert.equal(writeBangumiCommentsHidden(true), true)
    startRestoreBangumiComments(true)
    replacement.style.setProperty('display', 'none')
    await tick()
    assert.equal(replacement.style.getPropertyPriority('display'), 'important')
    startRestoreBangumiComments(false)
    assert.equal(writeBangumiCommentsHidden(false), true)

    // Keep the event name in the fixture to prove same-tab changes use a dedicated event.
    assert.equal(commentsPreferenceEvent, 'balh-comments-preference-change')

    // The standalone restore API applies the same page, container, and params gates.
    const invalid = commentModule()
    invalid.appendChild(comments('01,42'))
    assert.equal(restoreBangumiComments(invalid), false)
    assert.equal(invalid.style.getPropertyValue('display'), 'none')
    const valid = commentModule()
    valid.appendChild(comments('1,42'))
    assert.equal(restoreBangumiComments(valid), true)
    assert.equal(valid.style.getPropertyValue('display'), '')

    console.log('restore-comments tests passed (DOM mock)')
}

function createDom() {
    const location = { hostname: 'www.bilibili.com', pathname: '/' }
    const document = new FakeDocument()
    const window = new FakeWindow()
    document.appendChild(new FakeElement('html'))
    document.documentElement.appendChild(new FakeElement('body'))
    return { document, location, window }
}

class FakeNode {
    constructor() { this.parentNode = null; this.childNodes = [] }
    appendChild(node) {
        node.parentNode?.removeChild(node)
        this.childNodes.push(node)
        node.parentNode = this
        FakeMutationObserver.notify({ type: 'childList', target: this, addedNodes: [node], removedNodes: [] })
        return node
    }
    removeChild(node) {
        const index = this.childNodes.indexOf(node)
        if (index >= 0) {
            this.childNodes.splice(index, 1)
            node.parentNode = null
            FakeMutationObserver.notify({ type: 'childList', target: this, addedNodes: [], removedNodes: [node] })
        }
        return node
    }
    get isConnected() { return this instanceof FakeDocument || !!this.parentNode?.isConnected }
}

class FakeElement extends FakeNode {
    constructor(tagName) {
        super()
        this.tagName = tagName.toUpperCase()
        this.attributes = new Map()
        const element = this
        this.style = {
            getPropertyValue(name) { return (parseStyle(element.getAttribute('style')).get(name) ?? '').replace(/\s*!important$/, '') },
            getPropertyPriority(name) { return /\s*!important$/.test(parseStyle(element.getAttribute('style')).get(name) ?? '') ? 'important' : '' },
            removeProperty(name) {
                const styles = parseStyle(element.getAttribute('style'))
                const old = styles.get(name) ?? ''
                styles.delete(name)
                element.writeStyle(styles)
                return old
            },
            setProperty(name, value, priority = '') {
                const styles = parseStyle(element.getAttribute('style'))
                styles.set(name, priority === 'important' ? `${value} !important` : value)
                element.writeStyle(styles)
            },
        }
    }
    setAttribute(name, value) {
        this.attributes.set(name, String(value))
        FakeMutationObserver.notify({ type: 'attributes', target: this, attributeName: name, addedNodes: [], removedNodes: [] })
    }
    removeAttribute(name) {
        this.attributes.delete(name)
        FakeMutationObserver.notify({ type: 'attributes', target: this, attributeName: name, addedNodes: [], removedNodes: [] })
    }
    getAttribute(name) { return this.attributes.get(name) ?? null }
    hasAttribute(name) { return this.attributes.has(name) }
    matches(selector) {
        if (selector.startsWith('#')) return this.getAttribute('id') === selector.slice(1)
        return this.tagName.toLowerCase() === selector.toLowerCase()
    }
    querySelectorAll(selector) {
        const found = []
        const visit = node => node.childNodes.forEach(child => {
            if (child instanceof FakeElement && child.matches(selector)) found.push(child)
            visit(child)
        })
        visit(this)
        return found
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null }
    append(...nodes) { nodes.forEach(node => this.appendChild(node)) }
    writeStyle(styles) {
        if (styles.size) this.attributes.set('style', [...styles].map(([key, value]) => `${key}: ${value};`).join(' '))
        else this.attributes.delete('style')
        FakeMutationObserver.notify({ type: 'attributes', target: this, attributeName: 'style', addedNodes: [], removedNodes: [] })
    }
}

class FakeDocument extends FakeNode {
    appendChild(node) { super.appendChild(node); return node }
    get documentElement() { return this.childNodes[0] }
    get body() { return this.documentElement.childNodes[0] }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null }
    querySelectorAll(selector) { return this.documentElement?.querySelectorAll(selector) ?? [] }
}

class FakeMutationObserver {
    static observers = new Set()
    static notify(record) {
        for (const observer of this.observers) {
            const { target, options } = observer
            const within = record.target === target || (options.subtree && isDescendant(record.target, target))
            if (!within || (record.type === 'attributes' && !options.attributes) || (record.type === 'childList' && !options.childList)) continue
            if (record.type === 'attributes' && options.attributeFilter && !options.attributeFilter.includes(record.attributeName)) continue
            observer.records.push(record)
            if (!observer.queued) {
                observer.queued = true
                queueMicrotask(() => {
                    observer.queued = false
                    const records = observer.records.splice(0)
                    if (observer.active && records.length) observer.callback(records)
                })
            }
        }
    }
    constructor(callback) { this.callback = callback; this.records = []; this.active = false }
    observe(target, options) { this.target = target; this.options = options; this.active = true; FakeMutationObserver.observers.add(this) }
    disconnect() { this.active = false; FakeMutationObserver.observers.delete(this); this.records.length = 0 }
}

class FakeWindow {
    listeners = new Map()
    localStorage = new FakeStorage()
    addEventListener(type, listener) {
        const listeners = this.listeners.get(type) ?? new Set()
        listeners.add(listener)
        this.listeners.set(type, listeners)
    }
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener) }
    dispatchEvent(event) { this.listeners.get(event.type)?.forEach(listener => listener(event)) }
}

class FakeStorage {
    values = new Map()
    throwOnGet = false
    throwOnSet = false
    getItem(key) {
        if (this.throwOnGet) throw new Error('storage read blocked')
        return this.values.get(key) ?? null
    }
    setItem(key, value) {
        if (this.throwOnSet) throw new Error('storage write blocked')
        this.values.set(key, String(value))
    }
}

class FakeCustomEvent {
    constructor(type, init = {}) { this.type = type; this.detail = init.detail }
}

class FakeStorageEvent {
    constructor(type, init = {}) { this.type = type; this.key = init.key ?? null; this.newValue = init.newValue ?? null }
}

function parseStyle(value) {
    return new Map((value ?? '').split(';').map(part => part.trim()).filter(Boolean).map(part => {
        const separator = part.indexOf(':')
        return [part.slice(0, separator).trim(), part.slice(separator + 1).trim()]
    }))
}
function isDescendant(node, ancestor) {
    for (let current = node.parentNode; current; current = current.parentNode) if (current === ancestor) return true
    return false
}

main().catch(error => {
    console.error(error)
    process.exitCode = 1
})
