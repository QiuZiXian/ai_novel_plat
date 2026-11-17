import { createHmac } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authenticateRequest } from '../auth'

const SECRET = 'test-secret-please-rotate'
const envKeys = ['PAGEKIN_JWT_SECRET', 'PAGEKIN_JWT_ISSUER', 'PAGEKIN_JWT_AUDIENCE'] as const
let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
  for (const key of envKeys) delete process.env[key]
})

afterEach(() => {
  for (const key of envKeys) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function sign(claims: Record<string, unknown>, secret = SECRET, header: Record<string, unknown> = { alg: 'HS256', typ: 'JWT' }): string {
  const unsigned = `${encode(header)}.${encode(claims)}`
  const signature = createHmac('sha256', secret).update(unsigned).digest('base64url')
  return `${unsigned}.${signature}`
}

function futureClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 600, ...overrides }
}

function request(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as unknown as IncomingMessage
}

const url = (pathname = '/api/invoke/startup:get-state') => new URL(`http://localhost${pathname}`)

describe('authenticateRequest', () => {
  it('未配置密钥时保持免登录', () => {
    expect(authenticateRequest(request(), url())).toEqual({ ok: true, principal: { userId: 'local', claims: {} } })
  })

  it('接受 Authorization 头里的有效令牌', () => {
    process.env.PAGEKIN_JWT_SECRET = SECRET
    const result = authenticateRequest(request({ authorization: `Bearer ${sign(futureClaims())}` }), url())
    expect(result.ok && result.principal.userId).toBe('user-1')
  })

  it('接受 Cookie 里的令牌', () => {
    process.env.PAGEKIN_JWT_SECRET = SECRET
    const result = authenticateRequest(request({ cookie: `theme=dark; pagekin_token=${sign(futureClaims())}` }), url())
    expect(result.ok && result.principal.userId).toBe('user-1')
  })

  it('只允许事件流从查询串取令牌', () => {
    process.env.PAGEKIN_JWT_SECRET = SECRET
    const token = sign(futureClaims())
    const events = authenticateRequest(request(), url(`/api/events?cid=abc&token=${encodeURIComponent(token)}`))
    const invoke = authenticateRequest(request(), url(`/api/invoke/db:list?token=${encodeURIComponent(token)}`))
    expect(events.ok).toBe(true)
    expect(invoke).toEqual({ ok: false, code: 'AUTH_REQUIRED' })
  })

  it('缺少令牌时报 AUTH_REQUIRED', () => {
    process.env.PAGEKIN_JWT_SECRET = SECRET
    expect(authenticateRequest(request(), url())).toEqual({ ok: false, code: 'AUTH_REQUIRED' })
  })

  it('签名被篡改时报 AUTH_INVALID', () => {
    process.env.PAGEKIN_JWT_SECRET = SECRET
    const token = sign(futureClaims())
    expect(authenticateRequest(request({ authorization: `Bearer ${token}x` }), url())).toEqual({ ok: false, code: 'AUTH_INVALID' })
  })

  it('拒绝 alg=none', () => {
    process.env.PAGEKIN_JWT_SECRET = SECRET
    const token = sign(futureClaims(), SECRET, { alg: 'none' })
    expect(authenticateRequest(request({ authorization: `Bearer ${token}` }), url())).toEqual({ ok: false, code: 'AUTH_INVALID' })
  })

  it('过期令牌报 AUTH_EXPIRED', () => {
    process.env.PAGEKIN_JWT_SECRET = SECRET
    const token = sign(futureClaims({ exp: Math.floor(Date.now() / 1000) - 5 }))
    expect(authenticateRequest(request({ authorization: `Bearer ${token}` }), url())).toEqual({ ok: false, code: 'AUTH_EXPIRED' })
  })

  it('缺少 exp 或 sub 时报 AUTH_INVALID', () => {
    process.env.PAGEKIN_JWT_SECRET = SECRET
    const noExp = sign({ sub: 'user-1' })
    const noSub = sign({ exp: Math.floor(Date.now() / 1000) + 600 })
    expect(authenticateRequest(request({ authorization: `Bearer ${noExp}` }), url())).toEqual({ ok: false, code: 'AUTH_INVALID' })
    expect(authenticateRequest(request({ authorization: `Bearer ${noSub}` }), url())).toEqual({ ok: false, code: 'AUTH_INVALID' })
  })

  it('配置了签发方或受众时逐项校验', () => {
    process.env.PAGEKIN_JWT_SECRET = SECRET
    process.env.PAGEKIN_JWT_ISSUER = 'smart-admin'
    process.env.PAGEKIN_JWT_AUDIENCE = 'pagekin'
    const good = sign(futureClaims({ iss: 'smart-admin', aud: ['pagekin', 'other'] }))
    const badIssuer = sign(futureClaims({ iss: 'other', aud: 'pagekin' }))
    const badAudience = sign(futureClaims({ iss: 'smart-admin', aud: 'other' }))
    expect(authenticateRequest(request({ authorization: `Bearer ${good}` }), url()).ok).toBe(true)
    expect(authenticateRequest(request({ authorization: `Bearer ${badIssuer}` }), url())).toEqual({ ok: false, code: 'AUTH_INVALID' })
    expect(authenticateRequest(request({ authorization: `Bearer ${badAudience}` }), url())).toEqual({ ok: false, code: 'AUTH_INVALID' })
  })
})
