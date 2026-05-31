import MagicString from 'magic-string'
import { readFileSync } from 'fs'

/**
 * @param options {{path: string, contentTag: string}}
 */
export default function ({ filePath, contentTag = 'template-content' } = {}) {
    return {
        name: 'output-template',
        buildStart() {
            this.addWatchFile(filePath)
        },
        renderChunk(code, renderedChunk, outputOptions) {
            const magicString = new MagicString(code)
            const template = readFileSync(filePath, { encoding: 'utf8' })
            // Match the line that contains the template placeholder.
            const group = template.match(new RegExp(`[\\r\\n]+(\\s*)\\/\\/.*@${contentTag}.*([\\r\\n]+)`))
            if (group) {
                const lastIndex = group.index + group[0].length
                magicString.indent(group[1])
                    .prepend(template.substring(0, lastIndex))
                    .append(group[2])
                    .append(template.substring(lastIndex))
            } else {
                magicString.prepend(template)
            }

            const result = { code: magicString.toString() }
            if (outputOptions.sourcemap !== false) {
                result.map = magicString.generateMap({ hires: true })
            }
            return result
        },
    }
}
