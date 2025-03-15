/**
 * 开发命令:
 * npx rollup --config rollup.config.js -w
 */
import path from 'path'
import typescript from '@rollup/plugin-typescript'
import html from 'rollup-plugin-html'
import terser from '@rollup/plugin-terser'

const userScriptMetaData = `
// ==UserScript==
// @name         Bilibili UGC
// @namespace    https://github.com/ipcjs
// @version      0.0.1
// @description  Bilibili UGC
// @author       ipcjs
// @match        https://www.bilibili.com/*
// @require      https://greasemonkey.github.io/gm4-polyfill/gm4-polyfill.js
// @run-at       document-start
// @grant        none
// ==/UserScript==
`.trim()

export default {
    input: path.resolve(__dirname, 'main.ts'),
    output: {
        banner: userScriptMetaData,
        file: path.resolve(__dirname, '../../scripts/bilibili_block_ugc.user.js'),
        format: 'esm',
    },
    plugins: [
        terser({
            output: {
                // 保留userScriptMetaData
                comments: /^ (@|==)/,
            }
        }),
        typescript({
            // 支持BigInt, async等
            target: 'ES2020',
        }),
        html({
            include: '**/*.html',
        }),
    ]
}
