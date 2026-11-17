/**
 * Development runner: builds the server once, then watches server sources,
 * restarts the Node process on change, and starts the Vite dev server.
 */
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const children = []

function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  })
  child.on('exit', code => {
    if (code && code !== 0) console.error(`[dev:web] ${command} exited with ${code}`)
  })
  children.push(child)
  return child
}

const initialBuild = spawnSync('node', ['scripts/build-web-server.mjs'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})
if (initialBuild.status !== 0) process.exit(initialBuild.status ?? 1)

run('node', ['scripts/build-web-server.mjs', '--watch'])
run('node', ['--watch', 'dist-server/server.mjs'])
run('node', ['node_modules/vite/bin/vite.js', '--config', 'vite.web.config.ts'])

const shutdown = () => {
  for (const child of children) child.kill()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
