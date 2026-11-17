/**
 * Web 版人工/自动化验证探针的公共工具。
 *
 * 探针直接打 HTTP 网关（`POST /api/invoke/:channel`），绕过界面但走与渲染层
 * 完全相同的通道、会话校验与文件授权，因此可以在没有浏览器的情况下核对
 * M2/M3 的业务链路。每个探针都是一个独立可执行脚本：
 *
 *   node scripts/probes/<name>.mjs
 *
 * 环境变量：
 *   PAGEKIN_BASE  网关地址，默认 http://127.0.0.1:5190
 *   PAGEKIN_CID   连接标识，默认按脚本名生成
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

export const REPO_ROOT = path.resolve(here, '..', '..', '..')
export const FIXTURES = path.join(REPO_ROOT, 'scripts', 'probes', 'fixtures')
export const BASE = (process.env.PAGEKIN_BASE ?? 'http://127.0.0.1:5190').replace(/\/$/u, '')
export const CID = process.env.PAGEKIN_CID ?? `pagekin-probe-${process.pid}`

/** 调用一个 IPC 通道；`error` 字段存在时抛错，与渲染层 `invoke` 的失败语义一致。 */
export async function invoke(channel, args = []) {
  const response = await fetch(`${BASE}/api/invoke/${channel}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Connection-Id': CID },
    body: JSON.stringify({ args }),
  })
  const json = await response.json()
  if (json.error) throw new Error(`${channel}: ${JSON.stringify(json.error)}`)
  return json.value
}

/** 上传一个文件到暂存区；之后由对应的 `dialog:select-*` 通道发授权。 */
export async function upload(purpose, fileName, bytes) {
  const response = await fetch(`${BASE}/api/upload?purpose=${encodeURIComponent(purpose)}`, {
    method: 'POST',
    headers: { 'X-Connection-Id': CID, 'X-File-Name': encodeURIComponent(fileName) },
    body: bytes,
  })
  return response.json()
}

/** 用 `web:request-download` 签发的一次性令牌取回导出内容。 */
export async function download(token) {
  const response = await fetch(`${BASE}/api/download/${encodeURIComponent(token)}`)
  if (!response.ok) throw new Error(`download ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

export function fixture(name) {
  return path.join(FIXTURES, name)
}

export function readFixture(name) {
  return fs.readFileSync(fixture(name))
}

/**
 * 打开「最近修改的项目」——与 Web 版 `dialog:select-folder('project-open')`
 * 一致：它总是返回 projects/ 下最新的目录，不能指定具体项目。
 */
export async function openLatestProject() {
  const grant = await invoke('dialog:select-folder', ['project-open'])
  if (!grant) throw new Error('没有可打开的项目')
  const opened = await invoke('project:open', [grant, `probe-open-${Date.now()}`, null])
  if (!opened?.success) throw new Error(`project:open 失败: ${JSON.stringify(opened)}`)
  const projectPath = opened.activeProjectPath
  return {
    projectPath,
    project: opened.project,
    session: { projectId: opened.project.id, leaseId: opened.project.sessionLease, projectPath },
  }
}

/** 统一输出格式，便于人工对照验证手册里的预期结果。 */
export function report(label, value) {
  console.log(`[${label}] ${typeof value === 'string' ? value : JSON.stringify(value)}`)
}

/** 探针统一入口：捕获异常并以非零码退出，方便 CI 或手工判断。 */
export function run(main) {
  main().catch(error => {
    console.error(error)
    process.exit(1)
  })
}
