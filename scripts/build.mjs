import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import ts from 'typescript'
import postcss from 'postcss'
import tailwind from '@tailwindcss/postcss'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const lib = path.join(root, 'lib')
if (path.dirname(lib) !== root || path.basename(lib) !== 'lib') throw new Error('Unsafe generated output directory')
try { if ((await fs.lstat(lib)).isSymbolicLink()) throw new Error('Generated output cannot be a symlink') } catch (error) {
  if (error.code !== 'ENOENT') throw error
}
await fs.rm(lib, { recursive: true, force: true })
await fs.mkdir(lib, { recursive: true })
const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile)
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
const sourceFiles = parsed.fileNames.filter(file => !file.includes('/client/') && !file.includes('/onebot/'))
const program = ts.createProgram(sourceFiles, { ...parsed.options, noEmit: false, declaration: true,
  emitDeclarationOnly: true, rootDir: path.join(root, 'src'), outDir: path.join(lib, 'declarations') })
const result = program.emit()
const errors = [...ts.getPreEmitDiagnostics(program), ...result.diagnostics].filter(item => item.category === ts.DiagnosticCategory.Error)
if (errors.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(errors, { getCanonicalFileName: file => file,
    getCurrentDirectory: () => root, getNewLine: () => '\n' }))
  process.exit(1)
}
// JSON re-exports also belong to the declaration graph (notably the face dictionary).
for (const relative of await fs.readdir(path.join(lib, 'declarations'), { recursive: true })) {
  if (!relative.endsWith('.d.ts')) continue
  const declaration = path.join(lib, 'declarations', relative)
  const code = await fs.readFile(declaration, 'utf8')
  for (const match of code.matchAll(/from\s*['"](\.[^'"]+\.json)['"]/g)) {
    const dest = path.resolve(path.dirname(declaration), match[1])
    if (!dest.startsWith(path.join(lib, 'declarations') + path.sep)) throw new Error('JSON type import escaped declarations')
    const source = path.join(root, 'src', path.relative(path.join(lib, 'declarations'), dest))
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.copyFile(source, dest)
  }
}
const entryPoints = { index: 'src/index.ts', api: 'src/api.ts', types: 'src/types.ts', contracts: 'src/contracts.ts' }
try { await fs.access(path.join(root, 'src/onebot.ts')); entryPoints.onebot = 'src/onebot.ts' } catch {}
const backend = await build({ absWorkingDir: root, entryPoints, outdir: lib, bundle: true, splitting: true,
  format: 'esm', platform: 'node', target: 'node22', packages: 'external', sourcemap: true, metafile: true,
  define: { 'import.meta.env': '{}' } })
for (const input of Object.keys(backend.metafile.inputs)) {
  const absolute = path.resolve(root, input)
  if (!absolute.startsWith(root + path.sep)) throw new Error('Build imported a source outside the plugin: ' + input)
}
// A changed module graph gets new chunk hashes; do not publish obsolete chunks from earlier builds.
const currentOutputs = new Set(Object.keys(backend.metafile.outputs).map(file => path.resolve(root, file)))
for (const entry of await fs.readdir(lib, { withFileTypes: true })) {
  if (!entry.isFile() || !/^chunk-[\w-]+\.js(?:\.map)?$/.test(entry.name)) continue
  const file = path.join(lib, entry.name)
  if (!currentOutputs.has(file)) await fs.unlink(file)
}
// Read only the side-effect-free action registry: this does not load a native module or create a session.
const { initActionMap, internalMethodName } = await import(pathToFileURL(path.join(lib, 'onebot.js')).href)
const actions = [...initActionMap({ ctx: {} }).keys()].sort()
await fs.writeFile(path.join(lib, 'onebot-actions.json'), JSON.stringify(actions, null, 2) + '\n')
const internalMethods = Object.fromEntries(actions.flatMap(action => {
  const method = internalMethodName(action)
  return method ? [[method, action]] : []
}))
await fs.writeFile(path.join(lib, 'onebot-internal.json'), JSON.stringify(internalMethods, null, 2) + '\n')
await fs.mkdir(path.join(lib, 'client'), { recursive: true })
await build({ absWorkingDir: root, entryPoints: ['src/client/index.tsx'], outfile: path.join(lib, 'client/module.js'),
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, jsx: 'automatic',
  external: ['react', 'react/*', 'react-dom', 'react-dom/*', '@luckylillia/plugin-sdk/webui'] })
const require = createRequire(import.meta.url)
const tailwindDir = path.dirname(require.resolve('tailwindcss/package.json')).split(path.sep).join('/')
const css = '@import "' + tailwindDir + '/theme.css" layer(theme);\n'
  + '@import "' + tailwindDir + '/utilities.css" layer(utilities) source(none);\n'
  + '@source "' + path.join(root, 'src/client').split(path.sep).join('/') + '";\n'
  + '@custom-variant dark (&:where(.dark, .dark *));\n'
const styled = await postcss([tailwind({ base: root, optimize: true })]).process(css, { from: path.join(root, 'client.css') })
await fs.writeFile(path.join(lib, 'client/style.css'), styled.css)
await fs.writeFile(path.join(lib, 'client/index.js'), [
  'import apply from "./module.js"',
  'export default function(ctx) {',
  `  if (ctx.style) { ctx.style('utilities', ${JSON.stringify(styled.css)}, { scope: 'plugin', when: 'loaded' }); return apply(ctx) }`,
  '  const style = document.createElement("link")',
  '  style.rel = "stylesheet"',
  '  style.href = new URL("./style.css", import.meta.url).href',
  '  document.head.append(style)',
  '  try { const stop = apply(ctx); return () => { if (typeof stop === "function") stop(); style.remove() } }',
  '  catch (error) { style.remove(); throw error }',
  '}', '',
].join('\n'))
const nativeRoot = path.join(root, 'native/production')
const native = require(path.join(nativeRoot, 'loader.cjs')).inspectBundle(nativeRoot, { allTargets: true })
if (native.manifest.variant !== 'production') throw new Error('Only production native artifacts may be published')
console.log('Built NTQQ protocol, public APIs, WebUI and validated native artifacts')
