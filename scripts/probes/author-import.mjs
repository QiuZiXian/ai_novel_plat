/**
 * 作者原稿导入：上传 txt → 服务端检查（inspection）→ 作者原稿预览。
 *
 *   node scripts/probes/author-import.mjs
 *
 * 对应验证手册 §M3「txt / md / epub 导入」。参考资料拆解与作者原稿走同一条
 * inspection 管线，区别只在 `purpose`（`reference` / `author-manuscript`）与
 * 之后的分章预览通道。
 */
import { randomUUID } from 'node:crypto'
import { invoke, openLatestProject, readFixture, report, run, upload } from './lib/harness.mjs'

run(async () => {
  const { projectPath, session } = await openLatestProject()
  report('project', projectPath)

  // 同一个 runId 贯穿「上传 → 选择 → 检查」，服务端按 runId 归档本次导入。
  const runId = randomUUID()
  report('POST /api/upload', await upload('novel-files:author-manuscript', 'sample.txt', readFixture('sample.txt')))

  const selection = await invoke('dialog:select-novel-files', [{
    runId,
    purpose: 'author-manuscript',
    locale: 'zh-CN',
    expectedProjectPath: projectPath,
  }, session])
  report('dialog:select-novel-files', {
    success: selection?.success,
    error: selection?.error,
    inspectionId: selection?.inspection?.inspectionId,
    files: selection?.inspection?.files?.length,
  })
  if (!selection?.success) throw new Error(`导入检查失败: ${JSON.stringify(selection?.error)}`)

  const preview = await invoke('db:import-run-author-preview', [
    selection.inspection.inspectionId,
    projectPath,
    session,
  ])
  report('db:import-run-author-preview', preview)
  console.log('[ok] 上传 → 检查 → 作者原稿预览 通过')
})
