#!/usr/bin/env node
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const port = Number(readOption('--port') || process.env.BALH_DEV_SERVER_PORT || 48711)
const host = readOption('--host') || process.env.BALH_DEV_SERVER_HOST || '127.0.0.1'
const userscriptPath = path.join(rootDir, 'dist/unblock-area-limit.user.js')
const loaderPath = path.join(rootDir, 'scripts/unblock-area-limit.dev-loader.user.js')
const devServerHeaders = {
    'access-control-allow-headers': 'Content-Type',
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-origin': '*',
    'access-control-allow-private-network': 'true',
    'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
}

function readOption(name) {
    const inline = args.find((arg) => arg.startsWith(`${name}=`))
    if (inline) return inline.slice(name.length + 1)
    const index = args.indexOf(name)
    if (index === -1) return undefined
    const value = args[index + 1]
    if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${name}`)
    }
    return value
}

function escapeJsSingleQuotedString(value) {
    return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

async function serveFile(response, filePath, contentType) {
    try {
        const body = await readFile(filePath)
        response.writeHead(200, {
            ...devServerHeaders,
            'content-type': contentType,
        })
        response.end(body)
    } catch (error) {
        response.writeHead(500, {
            ...devServerHeaders,
            'content-type': 'text/plain; charset=utf-8',
        })
        response.end(String(error?.stack || error))
    }
}

async function serveLoader(request, response) {
    const hostHeader = request.headers.host || `${host}:${port}`
    const scriptUrl = `http://${hostHeader}/unblock-area-limit.user.js`
    try {
        const body = await readFile(loaderPath, 'utf8')
        response.writeHead(200, {
            ...devServerHeaders,
            'content-type': 'application/javascript; charset=utf-8',
        })
        response.end(body.replace('__BALH_DEV_SCRIPT_URL__', escapeJsSingleQuotedString(scriptUrl)))
    } catch (error) {
        response.writeHead(500, {
            ...devServerHeaders,
            'content-type': 'text/plain; charset=utf-8',
        })
        response.end(String(error?.stack || error))
    }
}

const server = http.createServer((request, response) => {
    if (request.method === 'OPTIONS') {
        response.writeHead(204, devServerHeaders)
        response.end()
        return
    }
    if (request.url?.startsWith('/unblock-area-limit.user.js')) {
        serveFile(response, userscriptPath, 'application/javascript; charset=utf-8')
        return
    }
    if (request.url?.startsWith('/unblock-area-limit.dev-loader.user.js')) {
        serveLoader(request, response)
        return
    }
    response.writeHead(200, {
        ...devServerHeaders,
        'content-type': 'text/html; charset=utf-8',
    })
    response.end(`<!doctype html>
<meta charset="utf-8">
<title>BALH dev userscript server</title>
<ul>
  <li><a href="/unblock-area-limit.dev-loader.user.js">Install dev loader userscript</a></li>
  <li><a href="/unblock-area-limit.user.js">Current built userscript</a></li>
</ul>
`)
})

server.listen(port, host, () => {
    console.log(`serving BALH userscripts at http://${host}:${port}/`)
    console.log(`loader: http://${host}:${port}/unblock-area-limit.dev-loader.user.js`)
    console.log(`script: http://${host}:${port}/unblock-area-limit.user.js`)
})
