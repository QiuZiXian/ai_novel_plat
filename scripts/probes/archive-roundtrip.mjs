/**
 * 归档往返：新建项目 → 归档导出 → 下载 → 回传 → 恢复副本 → 打开副本。
 *
 *   node scripts/probes/archive-roundtrip.mjs
 *
 * 对应验证手册 §M3「项目归档导出 / 恢复副本」。含 lancedb 的项目在本机会因
 * 删除被拦截导致 `PORTABLE_KNOWLEDGE_INVALID`，所以这里总是新建干净项目。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { CID, download, invoke, report, run, upload } from './lib/harness.mjs'

run(async () => {
  const name = `探针归档${Date.now()}`
  const createGrant = await invoke('dialog:select-folder', ['project-create'])
  const created = await invoke('project:create', [
    { name, parentGrantId: createGrant.grantId, genre: '悬疑', targetAudience: '男频' },
    randomUUID(),
    null,
  ])
  report('project:create', created)
  if (!created?.success) throw new Error('新建项目失败')

  const openGrant = await invoke('dialog:select-folder', ['project-open'])
  const opened = await invoke('project:open', [openGrant, randomUUID(), null])
  if (!opened?.success) throw new Error(`打开项目失败: ${JSON.stringify(opened)}`)
  const projectSession = {
    projectId: opened.project.id,
    leaseId: opened.project.sessionLease,
    projectPath: opened.activeProjectPath,
  }
  report('project:open', opened.activeProjectPath)

  // 期望：success=true，receipt 带 sha256 与字节数，entryCount >= 3。
  const target = await invoke('dialog:select-project-archive-export', [name])
  const exported = await invoke('project:archive-export', [{ targetArchiveGrantId: target.grantId, projectSession }])
  report('project:archive-export', {
    success: exported?.success,
    errorCode: exported?.errorCode,
    byteSize: exported?.receipt?.targetByteSize,
    sha256: exported?.receipt?.targetSha256?.slice(0, 16),
    entryCount: exported?.receipt?.entryCount,
  })
  if (!exported?.success) throw new Error(`归档导出失败: ${exported?.errorCode}`)

  const downloadToken = await invoke('web:request-download', [target.grantId])
  const archiveBytes = await download(downloadToken.token)
  const archivePath = path.join(os.tmpdir(), `pagekin-probe-${Date.now()}.ainovel`)
  fs.writeFileSync(archivePath, archiveBytes)
  report('GET /api/download/:token', {
    name: downloadToken.name,
    bytes: archiveBytes.length,
    zipMagic: archiveBytes.subarray(0, 2).toString('hex'),
    savedTo: archivePath,
  })

  // 把刚下载的归档再传回去，恢复成新副本（目标名必须是不存在的子目录）。
  const uploaded = await upload('project-archive', downloadToken.name, archiveBytes)
  report('POST /api/upload?purpose=project-archive', uploaded)
  const archiveGrant = await invoke('dialog:select-project-archive')
  const restoreTarget = await invoke('dialog:select-project-restore-target', [`${name}-恢复`])
  report('grants', { archiveGrant: Boolean(archiveGrant?.grantId), restoreTarget: restoreTarget?.displayName })

  const restored = await invoke('project:archive-restore', [{
    archiveGrantId: archiveGrant.grantId,
    targetGrantId: restoreTarget.grantId,
  }])
  report('project:archive-restore', {
    success: restored?.success,
    errorCode: restored?.errorCode,
    targetProjectRoot: restored?.receipt?.targetProjectRoot,
    snapshotGeneration: restored?.receipt?.snapshotGeneration,
  })
  if (!restored?.success) throw new Error(`恢复副本失败: ${restored?.errorCode}`)

  console.log('[ok] 归档导出 → 下载 → 回传 → 恢复副本 全链路通过')
  console.log(`[note] 探针连接标识 ${CID}`)
})
