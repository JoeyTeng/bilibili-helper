import ts from 'typescript'

export default function typescriptTranspile({ target = 'ES2020' } = {}) {
    return {
        name: 'typescript-transpile',
        transform(code, id) {
            if (!id.endsWith('.ts')) {
                return null
            }

            const result = ts.transpileModule(code, {
                fileName: id,
                compilerOptions: {
                    target: ts.ScriptTarget[target],
                    module: ts.ModuleKind.ESNext,
                    sourceMap: false,
                },
                reportDiagnostics: true,
            })
            const errors = (result.diagnostics || [])
                .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)

            if (errors.length > 0) {
                const message = errors
                    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
                    .join('\n')
                this.error(message)
            }

            return {
                code: result.outputText,
                map: { mappings: '' },
            }
        },
    }
}
