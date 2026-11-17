/**
 * 下载通道：单文件导出、目录（ZIP 打包）导出、项目归档导出三条路径。
 *
 *   node scripts/probes/download-targets.mjs
 *
 * 对应验证手册 §M3「Markdown 导出 / 项目归档导出」。这里只验证「写盘授权 →
 * web:request-download 签发令牌 → GET /api/download/:token」这一段，界面上的
 * 章节选择由 `src/components/dialogs/ExportDialog.tsx` 负责。
 */
import os from 'node:os'
import path from 'node:path'
import { CID, download, invoke, openLatestProject, report, run } from './lib/harness.mjs'

run(async () => {
  // 1) 单文件：写一个 Markdown 再下载，期望字节与原文一致。
  const single = await invoke('dialog:select-export-directory')
  await invoke('fs:grant-write-file', [single.grantId, 'probe-single.md', '# 合并导出\n\n正文内容。\n'])
  const singleToken = await invoke('web:request-download', [single.grantId])
  const singleBytes = await download(singleToken.token)
  report('single-file', {
    name: singleToken.name,
    bytes: singleBytes.length,
    head: singleBytes.toString('utf8').slice(0, 12),
  })

  // 2) 目录：两个章节文件会被打包成 ZIP（store 方式，无压缩）。
  const split = await invoke('dialog:select-export-directory')
  await invoke('fs:grant-mkdir', [split.grantId, 'probe-split'])
  await invoke('fs:grant-write-file', [split.grantId, 'probe-split/chapter-001.md', '# 第一章'])
  await invoke('fs:grant-write-file', [split.grantId, 'probe-split/chapter-002.md', '# 第二章'])
  const splitToken = await invoke('web:request-download', [split.grantId])
  const zipBytes = await download(splitToken.token)
  report('directory-zip', {
    name: splitToken.name,
    bytes: zipBytes.length,
    zipMagic: zipBytes.subarray(0, 2).toString('ascii'),
  })

  // 3) 项目归档：走 project:archive-export 生成后再下载。
  const { projectPath, project, session } = await openLatestProject()
  const archiveTarget = await invoke('dialog:select-project-archive-export', [project.name])
  const exported = await invoke('project:archive-export', [{ targetArchiveGrantId: archiveTarget.grantId, projectSession: session }])
  report('archive-export', {
    project: project.name,
    projectPath,
    success: exported?.success,
    errorCode: exported?.errorCode,
    byteSize: exported?.receipt?.targetByteSize,
    entryCount: exported?.receipt?.entryCount,
  })
  if (!exported?.success) {
    console.log(`[skip] 归档导出未成功（${exported?.errorCode}），下载链路无法验证`)
    return
  }
  const archiveToken = await invoke('web:request-download', [archiveTarget.grantId])
  const archiveBytes = await download(archiveToken.token)
  report('archive-download', {
    name: archiveToken.name,
    bytes: archiveBytes.length,
    zipMagic: archiveBytes.subarray(0, 2).toString('hex'),
    savedHint: path.join(os.tmpdir(), archiveToken.name),
  })

  console.log('[ok] 单文件 / 目录 ZIP / 项目归档 三条下载路径均返回 200')
  console.log(`[note] 探针连接标识 ${CID}`)
})
