/**
 * WebDAV 云端备份：连接 → 绑定 → 备份 → 列表 → 恢复副本 → 凭据检查 → 清凭据。
 *
 *   node scripts/probes/mocks/dav-mock.mjs        # 另开一个终端
 *   node scripts/probes/webdav-backup.mjs
 *
 * 对应验证手册 §M3「WebDAV 备份」。重复运行会复用已有 account，避免生成新
 * accountId 后与既有 binding 冲突（`CLOUD_BACKUP_BINDING_CONFLICT`）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { REPO_ROOT, invoke, openLatestProject, report, run } from './lib/harness.mjs'

const ENDPOINT = process.env.PAGEKIN_DAV_ENDPOINT ?? 'http://127.0.0.1:11497/dav/'
const USERNAME = process.env.PAGEKIN_DAV_USERNAME ?? 'probe'
const SECRET = process.env.PAGEKIN_DAV_SECRET ?? 'probe-secret'
const CREDENTIAL_FILE = path.join(REPO_ROOT, '.pagekin-web', 'app-data', 'ai-novel-writer', 'cloud-backup-credentials.json')

run(async () => {
  const { session } = await openLatestProject()

  // 归档导出是备份的前置步骤；含 lancedb 的项目会在这里报 PORTABLE_KNOWLEDGE_INVALID。
  const archiveTarget = await invoke('dialog:select-project-archive-export', [])
  const exported = await invoke('project:archive-export', [{ targetArchiveGrantId: archiveTarget.grantId, projectSession: session }])
  report('project:archive-export', {
    success: exported?.success,
    errorCode: exported?.errorCode,
    byteSize: exported?.receipt?.targetByteSize,
  })
  if (!exported?.success) throw new Error(`归档导出失败: ${exported?.errorCode}`)

  const view = await invoke('cloud-backup:view', [session])
  report('cloud-backup:view', view)
  let localEndpointAccountId = view?.account?.accountId
  if (!localEndpointAccountId) {
    const connected = await invoke('cloud-backup:connect', [{ endpoint: ENDPOINT, username: USERNAME, secret: SECRET }])
    report('cloud-backup:connect', connected)
    if (!connected?.success) throw new Error(`连接失败: ${connected?.errorCode}`)
    localEndpointAccountId = connected.account.accountId
  } else {
    console.log('[skip] 复用已有账号，跳过 connect')
  }

  const binding = await invoke('cloud-backup:confirm-binding', [{
    projectSession: session,
    localEndpointAccountId,
    lastSelectedParentGenerationIds: [],
    expectedRevision: view?.binding?.localEndpointAccountId === localEndpointAccountId ? view.binding.revision : null,
  }])
  report('cloud-backup:confirm-binding', binding)
  if (!binding?.success) throw new Error(`绑定失败: ${binding?.errorCode}`)
  const cloudBookId = binding.binding.cloudBookId

  const backup = await invoke('cloud-backup:backup', [{
    operationId: randomUUID(),
    projectSession: session,
    disclosureConfirmed: true,
  }])
  report('cloud-backup:backup', backup)
  if (!backup?.success) throw new Error(`备份失败: ${backup?.errorCode}`)

  const listed = await invoke('cloud-backup:list', [{ localEndpointAccountId, cloudBookId }])
  report('cloud-backup:list', (listed?.generations ?? []).map(item => ({
    generationId: item.generationId,
    byteSize: item.archiveByteSize,
    sha256: item.archiveSha256?.slice(0, 16),
  })))

  // 凭据必须只以密文存在：base64 解码后应以 web:v1: 开头，且不含明文口令。
  const credentialText = fs.existsSync(CREDENTIAL_FILE) ? fs.readFileSync(CREDENTIAL_FILE, 'utf8') : ''
  report('credentials-file', {
    exists: credentialText.length > 0,
    hasWebPrefix: credentialText.includes('web:v1:'),
    hasPlainSecret: credentialText.includes(SECRET),
  })

  const generationId = listed?.generations?.[0]?.generationId
  if (generationId) {
    const targetGrant = await invoke('dialog:select-project-restore-target', [`云端恢复${Date.now()}`])
    const restored = await invoke('cloud-backup:restore-copy', [{
      operationId: randomUUID(),
      localEndpointAccountId,
      cloudBookId,
      generationId,
      targetGrantId: targetGrant.grantId,
    }])
    report('cloud-backup:restore-copy', {
      success: restored?.success,
      errorCode: restored?.errorCode,
      state: restored?.state,
      targetProjectRoot: restored?.receipt?.targetProjectRoot,
    })
  }

  report('cloud-backup:clear-credential', await invoke('cloud-backup:clear-credential', [localEndpointAccountId]))
  const afterClear = fs.existsSync(CREDENTIAL_FILE) ? fs.readFileSync(CREDENTIAL_FILE, 'utf8') : ''
  report('credentials-after-clear', { containsAccount: afterClear.includes(localEndpointAccountId) })
  report('cloud-backup:view(after)', await invoke('cloud-backup:view', [session]))
})
