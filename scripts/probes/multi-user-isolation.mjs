/**
 * 双用户隔离探针：两个 JWT 用户各自新建作品，验证工作区、项目会话、
 * 数据库句柄与连接归属互不影响。
 *
 * 需要服务端以 PAGEKIN_JWT_SECRET=probe-secret 启动：
 *   $env:PAGEKIN_PORT='5191'; $env:PAGEKIN_DATA_ROOT='.runtime/multi-user-probe'
 *   $env:PAGEKIN_JWT_SECRET='probe-secret'
 *   node dist-server/server.mjs
 */
import { createHmac } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const BASE = process.env.PAGEKIN_BASE ?? 'http://127.0.0.1:5191'
const SECRET = process.env.PAGEKIN_JWT_SECRET ?? 'probe-secret'
const DATA_ROOT = path.resolve(process.env.PAGEKIN_DATA_ROOT ?? '.runtime/multi-user-probe')

const base64url = value => Buffer.from(JSON.stringify(value)).toString('base64url')
function token(sub) {
  const header = base64url({ alg: 'HS256', typ: 'JWT' })
  const payload = base64url({ sub, exp: Math.floor(Date.now() / 1000) + 3600 })
  const signature = createHmac('sha256', SECRET).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${signature}`
}

const users = { alice: token('alice'), bob: token('bob') }
const cids = { alice: 'probe-alice', bob: 'probe-bob' }

async function invoke(user, channel, args = [], cid = cids[user]) {
  const response = await fetch(`${BASE}/api/invoke/${encodeURIComponent(channel)}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-connection-id': cid,
      'x-locale': 'zh-CN',
      authorization: `Bearer ${users[user]}`,
    },
    body: JSON.stringify({ args }),
  })
  const body = await response.json().catch(() => null)
  return { status: response.status, body }
}

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

async function createBook(user, name) {
  const grant = await invoke(user, 'dialog:select-folder', ['project-create'])
  if (grant.status !== 200 || !grant.body?.value?.grantId) {
    throw new Error(`${user} 取保存位置失败: ${grant.status} ${JSON.stringify(grant.body)}`)
  }
  const created = await invoke(user, 'project:create', [{
    name,
    parentGrantId: grant.body.value.grantId,
    genre: '',
    targetAudience: '',
    writingLanguage: 'zh-CN',
  }, `probe-${user}-${Date.now()}`])
  if (created.status !== 200 || !created.body?.value?.success) {
    throw new Error(`${user} 新建作品失败: ${created.status} ${JSON.stringify(created.body)}`)
  }
  return created.body.value
}

async function openBook(user) {
  const grant = await invoke(user, 'dialog:select-folder', ['project-open'])
  if (grant.status !== 200 || !grant.body?.value?.grantId) {
    throw new Error(`${user} 取打开授权失败: ${grant.status} ${JSON.stringify(grant.body)}`)
  }
  const opened = await invoke(user, 'project:open', [
    { grantId: grant.body.value.grantId },
    `probe-${user}-open-${Date.now()}`,
  ])
  if (opened.status !== 200 || !opened.body?.value?.success) {
    throw new Error(`${user} 打开作品失败: ${opened.status} ${JSON.stringify(opened.body)}`)
  }
  return opened.body.value.project
}

function sessionOf(project) {
  return { projectId: project.id, leaseId: project.sessionLease, projectPath: project.path }
}

async function scopedRead(user, project) {
  return invoke(user, 'db:import-run-list-resumable', [project.path, sessionOf(project)])
}

async function main() {
  const health = await fetch(`${BASE}/api/health`).then(r => r.json())
  check('服务端健康检查', health?.ok === true)

  const aliceCreated = await createBook('alice', 'A1')
  const bobCreated = await createBook('bob', 'B1')

  const aliceRoot = path.join(DATA_ROOT, 'users', 'alice', 'projects')
  const bobRoot = path.join(DATA_ROOT, 'users', 'bob', 'projects')
  check('Alice 的作品落在自己的目录', path.resolve(aliceCreated.projectPath).startsWith(path.resolve(aliceRoot)), aliceCreated.projectPath)
  check('Bob 的作品落在自己的目录', path.resolve(bobCreated.projectPath).startsWith(path.resolve(bobRoot)), bobCreated.projectPath)
  check('两个用户目录不同', path.resolve(aliceCreated.projectPath) !== path.resolve(bobCreated.projectPath))
  const localProjects = path.join(DATA_ROOT, 'projects')
  check('本地用户目录未被越权写入', !fs.existsSync(localProjects)
    || !fs.readdirSync(localProjects).some(name => name.includes('Alice') || name.includes('Bob')))

  const alice = await openBook('alice')
  const bob = await openBook('bob')

  const aliceRead = await scopedRead('alice', alice)
  check('Bob 打开作品后 Alice 的会话仍有效', aliceRead.status === 200 && Array.isArray(aliceRead.body?.value), `${aliceRead.status}`)
  const bobRead = await scopedRead('bob', bob)
  check('Alice 打开作品后 Bob 的会话仍有效', bobRead.status === 200, `${bobRead.status}`)

  const aliceAgain = await scopedRead('alice', alice)
  check('Alice 连续调用不报 PROJECT_SESSION_STALE', aliceAgain.status === 200, `${aliceAgain.status}`)

  const stolen = await invoke('bob', 'db:import-run-list-resumable', [alice.path, sessionOf(alice)], cids.alice)
  check('跨用户复用连接号被拒绝', stolen.status === 403 && stolen.body?.error?.message === 'CONNECTION_FORBIDDEN', `${stolen.status} ${stolen.body?.error?.message ?? ''}`)

  const aliceRecent = await invoke('alice', 'project:recent-list')
  check('最近项目按用户隔离', aliceRecent.status === 200
    && aliceRecent.body.value.every(item => !String(item.path).includes(`${path.sep}bob${path.sep}`)),
  JSON.stringify(aliceRecent.body?.value?.map?.(item => item.path)))

  const failed = checks.filter(item => !item.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} 通过`)
  if (failed.length > 0) process.exitCode = 1
}

main().catch(error => {
  console.error('探针失败:', error)
  process.exitCode = 1
})
