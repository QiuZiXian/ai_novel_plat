/**
 * 本地 embedding mock：实现 OpenAI 兼容的 `POST /v1/embeddings`，返回 1536 维
 * 确定性归一化向量，用来在没有真实模型额度的情况下验证知识库 W6。
 *
 *   node scripts/probes/mocks/embed-mock.mjs     # 监听 127.0.0.1:11498
 *
 * 模型配置：`baseUrl` 填 `http://127.0.0.1:11498/v1`，`purposes: ['embedding']`。
 */
import http from 'node:http'

const PORT = Number(process.env.PAGEKIN_EMBED_PORT ?? 11498)
const HOST = process.env.PAGEKIN_EMBED_HOST ?? '127.0.0.1'
const DIMENSION = 1536

function vectorFor(text) {
  let seed = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    seed ^= text.charCodeAt(index)
    seed = Math.imul(seed, 16777619) >>> 0
  }
  const vector = new Array(DIMENSION)
  for (let index = 0; index < DIMENSION; index += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    vector[index] = (seed / 4294967295) * 2 - 1
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1
  return vector.map(value => Number((value / norm).toFixed(6)))
}

const server = http.createServer((request, response) => {
  const chunks = []
  request.on('data', chunk => chunks.push(chunk))
  request.on('end', () => {
    if (request.method !== 'POST' || !(request.url ?? '').includes('/embeddings')) {
      response.writeHead(404, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'not found' } }))
      return
    }
    let payload = {}
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { payload = {} }
    const inputs = Array.isArray(payload.input) ? payload.input : [String(payload.input ?? '')]
    const body = JSON.stringify({
      object: 'list',
      model: payload.model ?? 'embed-mock',
      data: inputs.map((text, index) => ({ object: 'embedding', index, embedding: vectorFor(String(text)) })),
      usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
    })
    console.log(`[embed-mock] ${inputs.length} input(s)`)
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(body)
  })
})

server.listen(PORT, HOST, () => console.log(`[embed-mock] listening on ${HOST}:${PORT}`))
