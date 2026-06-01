#!/usr/bin/env node
import * as esbuild from 'esbuild'
import { watchFile } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const entryPoint = path.join(rootDir, 'packages/unblock-area-limit/src/main.ts')
const templatePath = path.join(rootDir, 'packages/unblock-area-limit/src/main.user.js')
const outDir = path.join(rootDir, 'dist')
const userScriptPath = path.join(outDir, 'unblock-area-limit.user.js')
const metaPath = path.join(outDir, 'unblock-area-limit.meta.js')

const args = process.argv.slice(2)
const watch = args.includes('--watch')
const version = readOption('--version') || process.env.BUILD_VERSION
const explicitBuildId = readOption('--build-id') || process.env.BUILD_ID

if (version && !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid release version: ${version}`)
}

function readOption(name) {
    const inline = args.find((arg) => arg.startsWith(`${name}=`))
    if (inline) {
        return inline.slice(name.length + 1)
    }
    const index = args.indexOf(name)
    if (index === -1) {
        return undefined
    }
    const value = args[index + 1]
    if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${name}`)
    }
    return value
}

function createBuildId() {
    return new Date().toISOString().replace(/[-:.]/g, '')
}

function indent(code, prefix) {
    return code
        .replace(/\s+$/, '')
        .split('\n')
        .map((line) => line ? `${prefix}${line}` : line)
        .join('\n')
}

async function renderUserscript(bundleCode) {
    const buildId = explicitBuildId || createBuildId()
    let template = await readFile(templatePath, 'utf8')
    if (version) {
        template = template.replace(/^\/\/ @version\s+.+$/m, `// @version      ${version}`)
    }

    const placeholder = template.match(/\r?\n([ \t]*)\/\/.*@template-content.*(\r?\n)/)
    if (!placeholder || placeholder.index == null) {
        throw new Error(`Template placeholder not found in ${templatePath}`)
    }

    const insertAt = placeholder.index + placeholder[0].length
    const rendered = [
        template.slice(0, insertAt),
        indent(`const __BALH_BUILD_VERSION__ = ${JSON.stringify(buildId)};\n${bundleCode}`, placeholder[1]),
        placeholder[2],
        template.slice(insertAt),
    ].join('')

    const meta = rendered.match(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\r?\n?/)
    if (!meta) {
        throw new Error('Userscript metadata block not found in rendered output')
    }

    await mkdir(outDir, { recursive: true })
    await writeFile(userScriptPath, rendered)
    await writeFile(metaPath, meta[0])
    return buildId
}

const options = {
    entryPoints: [entryPoint],
    outfile: path.join(outDir, '.bundle.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    charset: 'utf8',
    write: false,
    sourcemap: false,
    legalComments: 'eof',
    loader: {
        '.css': 'text',
        '.html': 'text',
    },
}

if (watch) {
    const context = await esbuild.context({
        ...options,
        plugins: [{
            name: 'userscript-renderer',
            setup(build) {
                build.onEnd(async (result) => {
                    if (result.errors.length > 0) {
                        return
                    }
                    const bundle = result.outputFiles?.find((file) => file.path.endsWith('.bundle.js'))
                    if (!bundle) {
                        throw new Error('esbuild did not return the expected bundle output')
                    }
                    const buildId = await renderUserscript(bundle.text)
                    console.log(`built ${path.relative(rootDir, userScriptPath)} (${buildId})`)
                })
            },
        }],
    })
    await context.watch()
    let templateRebuild = Promise.resolve()
    watchFile(templatePath, { persistent: true, interval: 250 }, () => {
        templateRebuild = templateRebuild
            .then(() => context.rebuild())
            .catch((error) => {
                console.error(error)
            })
    })
    console.log('watching packages/unblock-area-limit/src')
} else {
    const result = await esbuild.build(options)
    const bundle = result.outputFiles.find((file) => file.path.endsWith('.bundle.js'))
    if (!bundle) {
        throw new Error('esbuild did not return the expected bundle output')
    }
    const buildId = await renderUserscript(bundle.text)
    console.log(`built ${path.relative(rootDir, userScriptPath)} (${buildId})`)
}
