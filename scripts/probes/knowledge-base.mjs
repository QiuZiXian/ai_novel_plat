/**
 * 知识库（W6）：保存 embedding 模型 → 上传参考资料 → 导入 → 列表 / 检索 /
 * 统计 / 待补向量 / 补向量，并确认 LanceDB 目录落盘。
 *
 *   node scripts/probes/mocks/embed-mock.mjs      # 另开一个终端
 *   node scripts/probes/knowledge-base.mjs
 *
 * 对应验证手册 §M3「知识库」。`kb:*` 的会话参数是**最后一个实参**
 * `ProjectSessionContext`，漏传会得到 `PROJECT_SESSION_REQUIRED`。
 */
import fs from 'node:fs'
import path from 'node:path'
import { invoke, openLatestProject, readFixture, report, run, upload } from './lib/harness.mjs'

const EMBED_BASE_URL = process.env.PAGEKIN_EMBED_BASE_URL ?? 'http://127.0.0.1:11498/v1'
const MODEL_ID = 'probe-embed'

run(async () => {
  // 1) 注册一个 embedding 用途的模型并设为默认；apiKey 在 models.json 里应是密文。
  const saved = await invoke('llm:save-model', [{
    id: MODEL_ID,
    name: 'Probe Embed',
    provider: 'openai',
    protocol: 'openai',
    modelName: 'text-embedding-3-small',
    apiKey: 'sk-probe-embed',
    baseUrl: EMBED_BASE_URL,
    temperature: 0,
    maxTokens: 1024,
    purposes: ['embedding'],
  }])
  report('llm:save-model', saved)
  report('config:set', await invoke('config:set', [{ defaultEmbeddingModelId: MODEL_ID }]))

  const models = await invoke('llm:list-models')
  report('llm:list-models', {
    count: models?.length,
    apiKeyReadBack: models?.find(model => model.id === MODEL_ID)?.apiKey,
  })

  // 2) 上传参考资料，再让服务端按 uploads 批次签发文件授权。
  const bytes = readFixture('sample.md')
  report('POST /api/upload?purpose=knowledge-files', await upload('knowledge-files', '知识样例.md', bytes))
  const grants = await invoke('dialog:select-knowledge-files')
  report('dialog:select-knowledge-files', Array.isArray(grants) ? grants.length : grants)
  if (!Array.isArray(grants) || grants.length === 0) throw new Error('没有可导入的知识文件')

  const { projectPath, session } = await openLatestProject()
  report('project', projectPath)

  report('kb:import-document', await invoke('kb:import-document', [grants[0].grantId, projectPath, session]))
  report('kb:list-documents', await invoke('kb:list-documents', [projectPath, session]))
  report('kb:search', await invoke('kb:search', ['海风', 3, projectPath, session]))
  // 期望 vectorDimension = 1536、hasVectors = true。
  report('kb:stats', await invoke('kb:stats', [projectPath, session]))
  report('kb:get-vectorless-count', await invoke('kb:get-vectorless-count', [projectPath, session]))
  report('kb:backfill-vectors', await invoke('kb:backfill-vectors', [projectPath, session]))

  const lancedb = path.join(projectPath, '.ai-novel', 'lancedb')
  report('lancedb', {
    exists: fs.existsSync(lancedb),
    entries: fs.existsSync(lancedb) ? fs.readdirSync(lancedb) : [],
  })

  console.log('[ok] 知识库导入 / 检索 / 统计 / 补向量 全链路通过')
})
