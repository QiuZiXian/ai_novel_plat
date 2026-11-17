/**
 * 本地 WebDAV mock：只实现云备份用到的 PROPFIND / MKCOL / PUT / GET / HEAD。
 *
 *   node scripts/probes/mocks/dav-mock.mjs        # 监听 127.0.0.1:11497
 *
 * 数据只存在内存里，进程退出即清空，适合验证「连接 → 绑定 → 备份 → 列表 →
 * 恢复副本 → 清凭据」全链路，不碰真实网盘。
 */
import { createServer } from 'node:http'

const PORT = Number(process.env.PAGEKIN_DAV_PORT ?? 11497)
const HOST = process.env.PAGEKIN_DAV_HOST ?? '127.0.0.1'

const files = new Map()
const collections = new Set(['/dav/'])

function escapeXml(value) {
  return value.replace(/[&<>"']/gu, char => `&#${char.charCodeAt(0)};`)
}

function encodeDavHref(value) {
  return value.split('/').map(segment => {
    try { return encodeURIComponent(decodeURIComponent(segment)) }
    catch { return encodeURIComponent(segment) }
  }).join('/')
}

function multistatus(root) {
  const normalized = root.endsWith('/') ? root : `${root}/`
  const children = [...collections]
    .filter(candidate => candidate.startsWith(normalized) && candidate !== normalized
      && !candidate.slice(normalized.length).replace(/\/$/u, '').includes('/'))
  return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${[normalized, ...children]
    .map(href => `<d:response><d:href>${escapeXml(encodeDavHref(href))}</d:href><d:status>HTTP/1.1 200 OK</d:status></d:response>`)
    .join('')}</d:multistatus>`
}

async function readBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}

const server = createServer(async (request, response) => {
  const method = request.method ?? ''
  const url = request.url ?? ''
  const authorization = String(request.headers.authorization ?? '')
  console.log(`[dav-mock] ${method} ${url} auth=${authorization ? 'yes' : 'no'} if-none-match=${request.headers['if-none-match'] ?? ''}`)
  try {
    if (method === 'MKCOL') {
      collections.add(url.endsWith('/') ? url : `${url}/`)
      response.writeHead(201).end()
      return
    }
    if (method === 'PUT') {
      const body = await readBody(request)
      files.set(url, body)
      response.writeHead(201).end()
      return
    }
    if (method === 'GET' || method === 'HEAD') {
      const body = files.get(url)
      if (!body) { response.writeHead(404).end(); return }
      response.writeHead(200, { 'content-length': body.length, 'content-type': 'application/octet-stream' })
      if (method === 'HEAD') { response.end(); return }
      response.end(body)
      return
    }
    if (method === 'PROPFIND') {
      const body = multistatus(url)
      response.writeHead(207, { 'content-type': 'application/xml', 'content-length': Buffer.byteLength(body) })
      response.end(body)
      return
    }
    response.writeHead(405).end()
  } catch (error) {
    console.error('[dav-mock] failure', error)
    response.writeHead(500).end()
  }
})

server.listen(PORT, HOST, () => console.log(`[dav-mock] listening on ${HOST}:${PORT}`))
