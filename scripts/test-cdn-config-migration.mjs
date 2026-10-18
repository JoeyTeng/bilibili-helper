#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(rootDir, '.codex-tmp/tests')
const outFile = path.join(outDir, 'cdn-config-migration.mjs')

await mkdir(outDir, { recursive: true })
await build({
    entryPoints: [path.join(rootDir, 'packages/unblock-area-limit/src/feature/config.ts')],
    outfile: outFile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    plugins: [{
        name: 'cdn-config-test-stubs',
        setup(build) {
            const stubs = new Map([
                ['../util/log', 'export const log = () => {}'],
                ['./page', 'export const util_page = { new_bangumi: () => false }'],
                ['./r', `
                    export const TRUE = 'Y'
                    export const FALSE = ''
                    export const r = {
                        const: {
                            server: { CUSTOM: '__custom__', defaultServer: () => 'https://www.biliplus.com' },
                            mode: { DEFAULT: 'default', REPLACE: 'replace', REDIRECT: 'redirect' },
                        },
                        regex: { bilibili_api_proxy: { test: () => false } },
                    }
                `],
            ])
            build.onResolve({ filter: /^(\.\.\/util\/log|\.\/page|\.\/r)$/ }, (args) => ({
                path: args.path,
                namespace: 'cdn-config-test-stub',
            }))
            build.onLoad({ filter: /.*/, namespace: 'cdn-config-test-stub' }, (args) => ({
                contents: stubs.get(args.path),
                loader: 'js',
            }))
        },
    }],
})

const scenarios = [
    {
        name: 'missing mode defaults to safe',
        cookies: {},
        expectedMode: 'safe',
        expectedWrites: 1,
    },
    {
        name: 'missing mode migrates a legacy UPOS selection to manual',
        cookies: { balh_upos_server: 'ali', balh_upos_replace_akamai: 'Y' },
        expectedMode: 'manual',
        expectedWrites: 1,
    },
    {
        name: 'invalid mode defaults to safe',
        cookies: { balh_cdn_mode: 'unexpected' },
        expectedMode: 'safe',
        expectedWrites: 1,
    },
    {
        name: 'invalid mode migrates a legacy UPOS selection to manual',
        cookies: { balh_cdn_mode: 'unexpected', balh_upos_server: 'ks3', balh_upos_replace_akamai: 'Y' },
        expectedMode: 'manual',
        expectedWrites: 1,
    },
    {
        name: 'valid mode is preserved without a migration write',
        cookies: { balh_cdn_mode: 'auto', balh_upos_server: 'ali' },
        expectedMode: 'auto',
        expectedWrites: 0,
    },
]

for (const [index, scenario] of scenarios.entries()) {
    const cookieFixture = createCookieFixture(scenario.cookies)
    globalThis.document = cookieFixture.document
    globalThis.localStorage = {}

    const moduleUrl = `${pathToFileURL(outFile).href}?scenario=${index}-${Date.now()}`
    const { balh_config } = await import(moduleUrl)

    assert.equal(balh_config.cdn_mode, scenario.expectedMode, scenario.name)
    assert.equal(balh_config.cdn_mode, scenario.expectedMode, `${scenario.name} (cached read)`)
    assert.equal(cookieFixture.values.get('balh_cdn_mode'), scenario.expectedMode, `${scenario.name} (persisted value)`)
    assert.equal(cookieFixture.writes.length, scenario.expectedWrites, `${scenario.name} (total write count)`)
    assert.equal(
        cookieFixture.writes.filter((value) => value.startsWith('balh_cdn_mode=')).length,
        scenario.expectedWrites,
        `${scenario.name} (migration write count)`,
    )
    for (const key of ['balh_upos_server', 'balh_upos_replace_akamai']) {
        if (Object.hasOwn(scenario.cookies, key)) {
            assert.equal(cookieFixture.values.get(key), scenario.cookies[key], `${scenario.name} (${key} preserved)`)
        }
    }
}

console.log('cdn-config-migration tests passed')

function createCookieFixture(initialCookies) {
    const values = new Map(Object.entries(initialCookies))
    const writes = []
    const document = {}

    Object.defineProperty(document, 'cookie', {
        configurable: true,
        get() {
            return Array.from(values, ([key, value]) => `${key}=${value}`).join('; ')
        },
        set(serializedCookie) {
            writes.push(serializedCookie)
            const pair = serializedCookie.split(';', 1)[0]
            const separator = pair.indexOf('=')
            values.set(pair.slice(0, separator), pair.slice(separator + 1))
        },
    })

    return { document, values, writes }
}
