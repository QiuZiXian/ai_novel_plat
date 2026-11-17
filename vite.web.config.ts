import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'))

/**
 * Renderer build for the web runtime. It is the desktop renderer bundle with the
 * Electron plugins removed; desktop↔web differences live in the server shim.
 */
export default defineConfig({
  base: '/',
  plugins: [tailwindcss(), react()],
  publicDir: 'public',
  server: {
    host: '127.0.0.1',
    port: 5181,
    strictPort: true,
    proxy: {
      // Keeps the browser same-origin so the bridge can use relative URLs and SSE.
      '/api': {
        target: process.env.PAGEKIN_API_TARGET?.trim() || 'http://127.0.0.1:5190',
        changeOrigin: false,
      },
    },
    watch: {
      ignored: ['**/docs/**'],
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: 'dist-web',
    emptyOutDir: true,
  },
})
