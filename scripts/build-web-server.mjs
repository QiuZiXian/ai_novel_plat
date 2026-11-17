/**
 * Bundles the web server (existing electron controllers + the Electron shim).
 * Native modules stay external: they are loaded with createRequire at runtime.
 */
import esbuild from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const watch = process.argv.includes('--watch')

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [path.join(root, 'web/server/index.ts')],
  outfile: path.join(root, 'dist-server/server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
  alias: {
    electron: path.join(root, 'web/shims/electron.ts'),
  },
  external: ['better-sqlite3', '@lancedb/lancedb', 'yauzl', 'electron-updater', 'sharp'],
  banner: {
    js: "import { createRequire as __pagekinCreateRequire } from 'node:module'; const require = __pagekinCreateRequire(import.meta.url);",
  },
}

if (watch) {
  const context = await esbuild.context(options)
  await context.watch()
  console.log('[pagekin-web] watching web server sources')
} else {
  await esbuild.build(options)
}
