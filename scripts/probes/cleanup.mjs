/**
 * 清理探针留下的数据：删除 mock 模型、清空默认 embedding 模型。
 *
 *   node scripts/probes/cleanup.mjs
 *
 * 探针项目（`探针归档*` 等）不在这个脚本里删：它们位于 `.pagekin-web/projects/`，
 * 属于用户可见数据，需要人工确认后再删。
 */
import { invoke, report, run } from './lib/harness.mjs'

const MODEL_IDS = ['probe-embed', 'probe-chat']

run(async () => {
  const models = await invoke('llm:list-models')
  report('models-before', (models ?? []).map(model => ({ id: model.id, apiKey: model.apiKey })))

  try { report('llm:set-default-embedding-model(null)', await invoke('llm:set-default-embedding-model', [null])) }
  catch (error) { report('clear-default-embedding-failed', String(error).slice(0, 200)) }

  for (const id of MODEL_IDS) {
    try { report(`llm:delete-model(${id})`, await invoke('llm:delete-model', [id])) }
    catch (error) { report(`delete-failed(${id})`, String(error).slice(0, 200)) }
  }

  report('models-after', ((await invoke('llm:list-models')) ?? []).map(model => model.id))
  report('default-embedding', await invoke('llm:get-default-embedding-model'))
})
