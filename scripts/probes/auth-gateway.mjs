/**
 * 网关鉴权（M4 步骤 1）：在开启 JWT 的服务上核对放行与拒绝的边界。
 *
 *   # 先停掉现有服务，再带密钥重启
 *   $env:PAGEKIN_JWT_SECRET='pagekin-local-verify-secret'
 *   node dist-server/server.mjs
 *
 *   $env:PAGEKIN_JWT_SECRET='pagekin-local-verify-secret'
 *   node scripts/probes/auth-gateway.mjs
 *
 * 对应验证手册 §M4「JWT 鉴权」。未设置密钥时脚本会提示并退出，因为此时整个
 * 网关是免登录的。
 */
import { createHmac } from 'node:crypto'
import { BASE, CID, report, run } from './lib/harness.mjs'

const SECRET = process.env.PAGEKIN_JWT_SECRET

const encode = value => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')

function sign(claims, header = { alg: 'HS256', typ: 'JWT' }) {
  const unsigned = `${encode(header)}.${encode(claims)}`
  return `${unsigned}.${createHmac('sha256', SECRET).update(unsigned).digest('base64url')}`
}

async function callInvoke(token, channel = 'startup:get-state') {
  const headers = { 'Content-Type': 'application/json', 'X-Connection-Id': CID }
  if (token) headers.authorization = `Bearer ${token}`
  const response = await fetch(`${BASE}/api/invoke/${channel}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ args: [] }),
  })
  return { status: response.status, body: await response.json() }
}

run(async () => {
  if (!SECRET) throw new Error('未设置 PAGEKIN_JWT_SECRET：网关当前免登录，无需验证鉴权')

  const now = Math.floor(Date.now() / 1000)
  const valid = sign({ sub: 'probe-user', exp: now + 600 })

  report('GET /api/health（公开）', (await fetch(`${BASE}/api/health`)).status)
  report('匿名 invoke（期望 401 AUTH_REQUIRED）', await callInvoke(null))
  report('有效令牌 invoke（期望 200）', await callInvoke(valid))
  report('过期令牌（期望 401 AUTH_EXPIRED）', await callInvoke(sign({ sub: 'probe-user', exp: now - 60 })))
  report('alg=none（期望 401 AUTH_INVALID）', await callInvoke(sign({ sub: 'probe-user', exp: now + 600 }, { alg: 'none' })))

  const cookie = await fetch(`${BASE}/api/invoke/startup:get-state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Connection-Id': CID, cookie: `pagekin_token=${valid}` },
    body: JSON.stringify({ args: [] }),
  })
  report('Cookie 令牌（期望 200）', cookie.status)

  const events = await fetch(`${BASE}/api/events?cid=${CID}&token=${encodeURIComponent(valid)}`, {
    headers: { accept: 'text/event-stream' },
  })
  report('事件流查询串令牌（期望 200）', events.status)
  await events.body?.cancel()

  report('匿名事件流（期望 401）', (await fetch(`${BASE}/api/events?cid=${CID}-anon`, { headers: { accept: 'text/event-stream' } })).status)
  report('匿名下载（期望 401）', (await fetch(`${BASE}/api/download/whatever`)).status)
})
