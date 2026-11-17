/**
 * HTTP entry point for the web build.
 *
 *   POST /api/invoke/:channel   -> ipcMain handler invocation
 *   POST /api/upload?purpose=…   -> store a browser-picked file, return its server copy
 *   GET  /api/download/:token   -> stream a registered export file
 *   GET  /api/events?cid=...    -> SSE stream for webContents.send
 *   GET  /api/health            -> readiness probe
 *   GET  /*                     -> static SPA (dist-web)
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { authenticateRequest, webAuthEnabled } from './auth'
import { bootstrapWebRuntime } from './bootstrap'
import { describeFailure, dispatch } from './channel-router'
import { connectionCount, connectionOwner, connectionSender, openConnection } from './events'
import { resolveDownload, storeUpload } from './uploads'
import { workspaceFor } from './workspace'
import { LOCAL_USER_ID } from '../../electron/services/user-scope'
import { webRendererUrl } from '../shims/electron'

const MAX_BODY_BYTES = 64 * 1024 * 1024

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
}

function resolveDistRoot(): string {
  return path.resolve(process.env.PAGEKIN_WEB_DIST?.trim() || 'dist-web')
}

function requestLocale(request: http.IncomingMessage): string {
  const explicit = request.headers['x-pagekin-locale']
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim()
  const accepted = String(request.headers['accept-language'] ?? '').toLowerCase()
  return accepted.startsWith('en') ? 'en-US' : 'zh-CN'
}

function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('REQUEST_BODY_TOO_LARGE'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) { resolve({ args: [] }); return }
      try { resolve(JSON.parse(raw)) } catch { reject(new Error('REQUEST_BODY_INVALID_JSON')) }
    })
    request.on('error', reject)
  })
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  })
  response.end(payload)
}

function readRawBody(request: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('REQUEST_BODY_TOO_LARGE'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

async function handleUpload(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  purpose: string,
  userId: string,
): Promise<void> {
  const connectionId = String(request.headers['x-connection-id'] ?? '').trim() || null
  const owner = connectionId ? connectionOwner(connectionId) : null
  if (owner && owner !== userId) {
    sendJson(response, 403, { ok: false, error: { channel: 'auth', message: 'CONNECTION_FORBIDDEN' } })
    return
  }
  const sender = connectionSender(connectionId, userId)
  const rawName = String(request.headers['x-file-name'] ?? '').trim()
  const rawRelative = String(request.headers['x-file-relative-path'] ?? '').trim()
  const name = rawName ? decodeURIComponent(rawName) : ''
  const relativePath = rawRelative ? decodeURIComponent(rawRelative) : undefined
  if (!purpose) { sendJson(response, 400, { ok: false, error: 'UPLOAD_PURPOSE_REQUIRED' }); return }
  try {
    const bytes = await readRawBody(request)
    const stored = storeUpload({
      uploadRoot: workspaceFor(userId).uploadsRoot,
      senderId: sender.id,
      purpose,
      name,
      relativePath,
      bytes,
    })
    sendJson(response, 200, { ok: true, file: { name: stored.displayName, relativePath: stored.relativePath } })
  } catch (error) {
    console.error(`[web-upload] ${purpose} failed: ${(error as Error).message}`)
    sendJson(response, 400, { ok: false, error: (error as Error).message })
  }
}

function handleDownload(response: http.ServerResponse, token: string): void {
  const record = resolveDownload(token)
  if (!record) { sendJson(response, 404, { ok: false, error: 'DOWNLOAD_NOT_FOUND' }); return }
  response.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': fs.statSync(record.filePath).size,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(record.name)}`,
    'Cache-Control': 'no-store',
  })
  fs.createReadStream(record.filePath).pipe(response)
}

function serveStatic(request: http.IncomingMessage, response: http.ServerResponse, distRoot: string): void {
  const requested = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname)
  const relative = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '')
  const candidate = path.resolve(distRoot, relative)
  const insideDist = !path.relative(distRoot, candidate).startsWith('..')
  const file = insideDist && fs.existsSync(candidate) && fs.statSync(candidate).isFile()
    ? candidate
    : path.join(distRoot, 'index.html')

  if (!fs.existsSync(file)) {
    response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('Web build not found. Run `pnpm build:web` first.')
    return
  }
  const extension = path.extname(file).toLowerCase()
  response.writeHead(200, {
    'Content-Type': MIME[extension] ?? 'application/octet-stream',
    'Cache-Control': extension === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  })
  fs.createReadStream(file).pipe(response)
}

async function handleInvoke(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  channel: string,
  userId: string,
): Promise<void> {
  const connectionId = String(request.headers['x-connection-id'] ?? '').trim() || null
  const owner = connectionId ? connectionOwner(connectionId) : null
  if (owner && owner !== userId) {
    sendJson(response, 403, { ok: false, error: { channel: 'auth', message: 'CONNECTION_FORBIDDEN' } })
    return
  }
  const sender = connectionSender(connectionId, userId)
  try {
    const body = await readJsonBody(request)
    const args = Array.isArray((body as { args?: unknown }).args) ? (body as { args: unknown[] }).args : []
    const value = await dispatch(channel, args, sender, requestLocale(request), userId)
    sendJson(response, 200, { ok: true, value })
  } catch (error) {
    const failure = describeFailure(channel, error)
    console.error(`[web-ipc] ${channel} failed: ${failure.message}`)
    sendJson(response, 400, { ok: false, error: failure })
  }
}

export interface WebServerOptions {
  port?: number
  host?: string
}

export function createWebServer(options: WebServerOptions = {}): http.Server {
  const runtime = bootstrapWebRuntime()
  const distRoot = resolveDistRoot()

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    const method = request.method ?? 'GET'

    if (url.pathname === '/api/health') {
      sendJson(response, 200, {
        ok: true,
        connections: connectionCount(),
        dataRoot: runtime.dataRoot,
        renderer: webRendererUrl(),
      })
      return
    }

    // 除健康检查以外的 API 都要过网关鉴权：上传、下载、通道调用、事件流共用同一份令牌。
    let requestUserId = LOCAL_USER_ID
    if (url.pathname.startsWith('/api/')) {
      const auth = authenticateRequest(request, url)
      if (!auth.ok) {
        sendJson(response, 401, { ok: false, error: { channel: 'auth', message: auth.code } })
        return
      }
      requestUserId = auth.principal.userId
    }

    if (url.pathname === '/api/events' && method === 'GET') {
      const connectionId = url.searchParams.get('cid')?.trim()
      if (!connectionId) { sendJson(response, 400, { ok: false, error: 'CONNECTION_ID_REQUIRED' }); return }
      const owner = connectionOwner(connectionId)
      if (owner && owner !== requestUserId) {
        sendJson(response, 403, { ok: false, error: { channel: 'auth', message: 'CONNECTION_FORBIDDEN' } })
        return
      }
      openConnection(connectionId, response, requestUserId)
      return
    }

    if (url.pathname === '/api/upload' && method === 'POST') {
      void handleUpload(request, response, url.searchParams.get('purpose')?.trim() ?? '', requestUserId)
      return
    }

    if (url.pathname.startsWith('/api/download/') && method === 'GET') {
      handleDownload(response, decodeURIComponent(url.pathname.slice('/api/download/'.length)))
      return
    }

    if (url.pathname.startsWith('/api/invoke/') && method === 'POST') {
      void handleInvoke(request, response, decodeURIComponent(url.pathname.slice('/api/invoke/'.length)), requestUserId)
      return
    }

    if (url.pathname.startsWith('/api/')) {
      sendJson(response, 404, { ok: false, error: 'NOT_FOUND' })
      return
    }

    serveStatic(request, response, distRoot)
  })

  const host = options.host ?? process.env.PAGEKIN_HOST?.trim() ?? '127.0.0.1'
  const port = options.port ?? Number(process.env.PAGEKIN_PORT ?? 5190)
  server.listen(port, host, () => {
    console.log(`[pagekin-web] listening on http://${host}:${port}`)
    console.log(`[pagekin-web] data root: ${runtime.dataRoot}`)
    console.log(`[pagekin-web] auth: ${webAuthEnabled() ? 'jwt' : 'disabled (PAGEKIN_JWT_SECRET unset)'}`)
  })
  return server
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (invokedDirectly) createWebServer()
