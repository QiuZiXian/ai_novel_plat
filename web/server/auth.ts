/**
 * Web 网关鉴权：校验 smart-admin 签发的 HS256 JWT。
 *
 * 未配置 `PAGEKIN_JWT_SECRET` 时不启用鉴权，本地开发保持免登录；配置后
 * `/api/invoke`、`/api/upload`、`/api/download`、`/api/events` 都必须带令牌，
 * `/api/health` 与静态资源保持开放，供负载均衡与登录页探活。
 *
 * 令牌来源优先级：`Authorization: Bearer` → Cookie `pagekin_token` → SSE 的
 * `?token=`（EventSource 不能自定义请求头，只能走查询串）。
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

export interface WebPrincipal {
  userId: string
  claims: Record<string, unknown>
}

export type WebAuthFailureCode = 'AUTH_REQUIRED' | 'AUTH_INVALID' | 'AUTH_EXPIRED'

export type WebAuthResult =
  | { ok: true; principal: WebPrincipal }
  | { ok: false; code: WebAuthFailureCode }

/** 未配置主密钥即视为免登录；多实例部署必须显式设置，否则服务是开放的。 */
export function webAuthEnabled(): boolean {
  return Boolean(process.env.PAGEKIN_JWT_SECRET?.trim())
}

function readToken(request: IncomingMessage, url: URL): string | null {
  const authorization = request.headers.authorization
  if (typeof authorization === 'string') {
    const match = /^Bearer\s+(.+)$/iu.exec(authorization.trim())
    if (match?.[1]) return match[1].trim()
  }
  const cookie = request.headers.cookie
  if (typeof cookie === 'string') {
    for (const entry of cookie.split(';')) {
      const [name, ...rest] = entry.trim().split('=')
      if (name === 'pagekin_token' && rest.length > 0) {
        const value = rest.join('=').trim()
        if (value) return decodeURIComponent(value)
      }
    }
  }
  // 只允许事件流从查询串取令牌，避免令牌出现在其余请求的访问日志与 Referer 里。
  if (url.pathname === '/api/events') {
    const query = url.searchParams.get('token')?.trim()
    if (query) return query
  }
  return null
}

function parseSegment(segment: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function verifySignature(token: string, secret: string): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [headerPart, payloadPart, signaturePart] = parts
  if (!headerPart || !payloadPart || !signaturePart) return null

  const header = parseSegment(headerPart)
  // 只接受 HS256：`alg: none` 与 RS256 都必须被拒绝，否则任意令牌都能通过。
  if (header?.alg !== 'HS256') return null

  const expected = createHmac('sha256', secret).update(`${headerPart}.${payloadPart}`).digest()
  const actual = Buffer.from(signaturePart, 'base64url')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null

  return parseSegment(payloadPart)
}

function claimsFailure(claims: Record<string, unknown>): WebAuthFailureCode | null {
  const now = Math.floor(Date.now() / 1000)
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) return 'AUTH_INVALID'
  if (now >= claims.exp) return 'AUTH_EXPIRED'
  if (typeof claims.nbf === 'number' && now < claims.nbf) return 'AUTH_INVALID'

  const issuer = process.env.PAGEKIN_JWT_ISSUER?.trim()
  if (issuer && claims.iss !== issuer) return 'AUTH_INVALID'
  const audience = process.env.PAGEKIN_JWT_AUDIENCE?.trim()
  if (audience) {
    const values = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (!values.includes(audience)) return 'AUTH_INVALID'
  }
  if (principalUserId(claims) === '') return 'AUTH_INVALID'
  return null
}

function principalUserId(claims: Record<string, unknown>): string {
  for (const candidate of [claims.sub, claims.userId]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return ''
}

export function authenticateRequest(request: IncomingMessage, url: URL): WebAuthResult {
  const secret = process.env.PAGEKIN_JWT_SECRET?.trim()
  if (!secret) return { ok: true, principal: { userId: 'local', claims: {} } }

  const token = readToken(request, url)
  if (!token) return { ok: false, code: 'AUTH_REQUIRED' }

  const claims = verifySignature(token, secret)
  if (!claims) return { ok: false, code: 'AUTH_INVALID' }

  const failure = claimsFailure(claims)
  if (failure) return { ok: false, code: failure }

  return { ok: true, principal: { userId: principalUserId(claims), claims } }
}
