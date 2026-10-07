import { existsSync, readFileSync } from 'node:fs'
import ts from 'typescript'

// The web application emits browser assets only. This test loader preserves
// source module boundaries while allowing Node to render React components.
export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const candidate = new URL(specifier, context.parentURL)
    if (!existsSync(candidate)) {
      for (const suffix of ['.ts', '.tsx']) {
        const typed = new URL(candidate.href + suffix)
        if (existsSync(typed)) return nextResolve(typed.href, context)
      }
    }
  }
  return nextResolve(specifier, context)
}

export function load(url, context, nextLoad) {
  if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: 'export default {}' }
  if (url.startsWith('file:') && /\.tsx?$/.test(url)) {
    // No environment files or backend are read in these rendering tests.
    const source = readFileSync(new URL(url), 'utf8').replaceAll('import.meta.env', '({})')
    return {
      format: 'module', shortCircuit: true,
      source: ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
      }).outputText,
    }
  }
  return nextLoad(url, context)
}
