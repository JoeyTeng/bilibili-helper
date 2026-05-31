import path from 'path'
import scss from 'rollup-plugin-scss'
import { nodeResolve } from '@rollup/plugin-node-resolve'
import typescriptTranspile from './tools/typescript-transpile.js'
import template from './tools/output-template.js'
import html from 'rollup-plugin-html'
import commonjs from '@rollup/plugin-commonjs';

export default {
    input: path.resolve(__dirname, 'src/main.ts'),
    output: {
        file: path.resolve(__dirname, '../../dist/unblock-area-limit.user.js'),
        format: 'es',
    },
    plugins: [
        scss({
            output: false
        }),
        nodeResolve({
            extensions: ['.mjs', '.js', '.json', '.node', '.ts'],
        }),
        typescriptTranspile({
            target: 'ES2020',
        }),
        template({
            filePath: path.resolve(__dirname, 'src/main.user.js'),
        }),
        html({
            include: '**/*.html',
        }),
        commonjs(),
    ]
}
