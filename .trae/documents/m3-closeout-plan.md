# M3 收尾计划：归档恢复闭环 + 知识库/WebDAV 验证 + 文档

## 摘要

M3 主体（W4 密钥加密、导入链路、浏览器下载、项目归档导出）已完成并逐项验证。剩余四项：

1. **项目归档 restore 仍返回 `PORTABLE_RESTORE_UNSAFE_TARGET`** —— 已定位为「bundle 落后于源码」，需要重建复测；
2. **W6 知识库**（embedding + LanceDB）尚未在 Web 服务端实测；
3. **WebDAV 云备份**尚未在 Web 服务端实测；
4. **`docs/plans/web-migration.md` 缺 §8.2 M3 实施记录**，以及收尾的全量回归。

本计划只做这四件事，不改动已完成部分的行为，也不引入新依赖。

## 现状分析（已核对的事实）

- `dist-server/server.mjs` 构建于 **18:05:34**，`electron/services/project-restore-service.ts` 修改于 **18:06:46** → 当前 bundle **不含** `same()` 的 `dev === 0n` 容错。`PORTABLE_RESTORE_UNSAFE_TARGET` 来自 `readPhysicalFile`（L145-164）/ `reservationOwned`（L418-426）：`fstatSync` 的 `dev` 是真实卷号（70655968），`lstatSync` 的 `dev` 是 `0n`，旧比较必然失败。与 `portable-project-archive.ts` 的 `sameDevice` 是同源问题，后者已在上一轮修复并进入 bundle。
- 只读脚本已逐段校验 `projectsRoot`、`uploads` 到盘根的 `realpathSync.native` 与 `path.resolve` 归一化后一致 → [project-restore-service.ts](file:///e:/e/project/shida/2026/claude-group/Pagekin/electron/services/project-restore-service.ts#L115-L125) 的 `physicalDirectory(targetParent)` **不是**失败点。
- **不要**在 `dialog:select-project-restore-target` 里预先 `mkdir` 目标：目标已存在且无 install journal 时，restore 会走到 `fail('PORTABLE_RESTORE_TARGET_EXISTS')`（L818-836），反而必然失败。桌面端 `availableRestoreTarget` 同样只返回不存在的路径，语义必须保持。
- 服务端当前以后台进程运行在 5190；`.pagekin-web/projects/` 下已有 `M3归档验证`、`潮汐图书馆(2)`，`uploads/project-archive/2/project-backup.ainovel`（672210 字节）与 `exports/project-backup.ainovel` 均在，可直接复用探针。

## 步骤 1 — 重建并复测归档恢复（核心）

1. `node scripts/build-web-server.mjs`（Node 22：`C:\Users\dell\AppData\Roaming\nvm\v22.14.0\node64.exe`）。
2. 停掉 5190：`Get-NetTCPConnection -LocalPort 5190 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`。
3. 后台启动：`& 'C:\Users\dell\AppData\Roaming\nvm\v22.14.0\node64.exe' dist-server/server.mjs *> "$env:TEMP\pagekin-m3\server.log"`
4. `curl.exe -s http://127.0.0.1:5190/api/health` 返回 200。
5. 用 Node 22 跑 `%TEMP%\pagekin-m3\probe-restore.js`（已存在，含上传 → 取两个 grant → `project:archive-restore` → `project:open`）。

**期望**：`restored.success === true`，`receipt.targetProjectRoot` 为 `.pagekin-web/projects/M3恢复副本`；`reopened.success === true` 且 `project.name` 可读；`project.json`/`project.db` 落在 `.ai-novel/` 下。

**若已存在同名目录**（上次残留），先确认它是否为空/半成品：若目录存在且 restore 返回 `PORTABLE_RESTORE_TARGET_EXISTS`，说明是上一轮失败留下的空目录，删除该目录后重跑（`M3恢复副本` 属于本探针产物，可安全删除）。

## 步骤 2 — 仅在步骤 1 仍失败时执行：栈定位

在 [project-archive-controller.ts](file:///e:/e/project/shida/2026/claude-group/Pagekin/electron/controllers/project-archive-controller.ts#L58-L70) 的 `failure()` 内临时加 `console.error('[restore-debug]', error)`（只保留到定位完成，随后删除），重建、重启、重跑探针，按栈判定：

| 栈中最后出现的函数 | 修法 |
| --- | --- |
| `physicalDirectory` | 在 `web/server/web-controllers.ts` 的 `select-project-restore-target` 中先 `fs.realpathSync.native(workspace.projectsRoot)` 再拼目标路径（只归一化父目录，不创建目标） |
| `readPhysicalFile` / `reservationOwned` | 确认 `same()` 的 dev 容错已在 bundle 中（`grep "恒为 0n" dist-server/server.mjs`）；若没有，重建 |
| `captureAttempt` / `exactOwned` | 记录实际 `ino/nlink/realpath`；若是解压目录被外部安全删除工具替换，按环境限制写入 §8.2，不再改代码 |
| `extractPortableProjectArchive` | 不属于该错误码，按返回的真实错误码单独处理并记录 |

硬约束：不降低 realpath/身份校验强度，不为 Web 单开「跳过校验」分支，不改桌面端 dialog 语义。

## 步骤 3 — W6 知识库验证

无需改代码（`kb-controller`、LanceDB 路径、embedding 模型解析都在 `electron/**`，已被 shim 适配；`node_modules/@lancedb/lancedb-win32-x64-msvc` 原生包在位）。

1. 起 embedding mock（新增 `%TEMP%\pagekin-m3\embed-mock.js`，端口 11498，Node 22）：`POST /v1/embeddings` 返回 `{ data: [{ embedding: <1536 个确定性浮点> , index: 0 }], model, usage }`；请求体按 `input` 拆分逐条返回。
2. 建模型：`llm:save-model`，参数 `{ id: 'm3-embed', name: 'M3 Embed', modelName: 'text-embedding-3-small', apiKey: 'sk-mock', baseUrl: 'http://127.0.0.1:11498/v1', provider: 'openai', protocol: 'openai', purposes: ['embedding'] }`。
3. `config:set` → `{ defaultEmbeddingModelId: 'm3-embed' }`；用 `llm:list-models` 确认 apiKey 回读为明文。
4. 打开项目（`dialog:select-folder('project-open')` → `project:open`），上传 `知识样例.md`（purpose `knowledge-files`）→ `dialog:select-knowledge-files` → `kb:import-document(grantId, projectPath)`。
5. 依次调用 `kb:list-documents`、`kb:search`、`kb:stats`（记录 `vectorDimension`）、`kb:get-vectorless-count`、`kb:backfill-vectors`。
6. 断言：`.pagekin-web/projects/<项目>/.ai-novel/lancedb` 目录生成；服务端进程存活（`/api/health` 仍 200）。
7. 若原生模块加载失败：记录真实报错到 §8.2，明确「FTS 可用、向量关闭」的降级状态；**不**在 M3 引入替代向量库。

## 步骤 4 — WebDAV 云备份验证

无需改代码（`cloud-backup-controller` 用 `fs.mkdtempSync` + `exportPortableProject`，凭据走 shim `safeStorage`）。

1. 从 [webdav-backup-service.test.ts](file:///e:/e/project/shida/2026/claude-group/Pagekin/electron/services/__tests__/webdav-backup-service.test.ts#L47-L140) 的 `DavFixture` 提取为 `%TEMP%\pagekin-m3\dav-mock.js`（内存 `Map`，端口 11497，Basic Auth 校验）：`PROPFIND`（Depth 0/1，返回 multistatus XML）、`MKCOL`（201/405）、`PUT`（`If-None-Match: *` → 201/412）、`GET`/`HEAD`（200/404）。
2. 调用顺序（同一 `cid`，避免 grant 跨连接失效）：
   - `cloud-backup:connect` `{ endpoint: 'http://127.0.0.1:11497/dav/', username: 'probe', secret: 'probe-secret' }`
   - `cloud-backup:view` → `unconfigured`
   - `cloud-backup:confirm-binding` `{ projectSession, localEndpointAccountId, lastSelectedParentGenerationIds: [], expectedRevision: null }`
   - `cloud-backup:backup` `{ operationId, projectSession, disclosureConfirmed: true }`
   - `cloud-backup:list` `{ localEndpointAccountId, cloudBookId }` → 取 `generationId`
   - `dialog:select-project-restore-target(['云备份副本'])` → `cloud-backup:restore-copy` `{ operationId, localEndpointAccountId, cloudBookId, generationId, targetGrantId }`
3. 断言：`restore-copy` 返回 `state: 'restore-complete'`；`.pagekin-web/app-data/ai-novel-writer/cloud-backup-credentials.json` 中该账号 `secret` 以 `web:v1:` 开头（shim `encryptString` 格式）；`cloud-backup:clear-credential` 后文件内该账号消失。
4. 该步骤依赖步骤 1 的 restore 修复，必须在其之后执行。

## 步骤 5 — 文档 §8.2

在 `docs/plans/web-migration.md` 的 §8.1 之后追加 `### 8.2 M3（W4 + W6）实施记录`，内容条目固定为：

- 下载通道：`web:request-download` 语义、`downloadTargets` 登记与 sender 校验、10 分钟一次性令牌；目录型导出的 ZIP 命名规则（单文件直接下、单子目录以其名打包、其余 `export.zip`），`zip-store-only` 手写 ZIP（0x0800 标志、store 方法）。
- models.json 密文：`web:v1:` 前缀（AES-256-GCM，12 字节 IV + 16 字节 tag），仅对 `MODELS_CONFIG_PATH` 生效，解密失败回退空串并 warn；桌面 codec 为 no-op。
- 导入 purpose 约定：`novel-files:reference` / `novel-files:author-manuscript`，服务端 `dialog:select-novel-files` 读哪个批次的 uploads 由 purpose 决定。
- 归档：`dev === 0n` 容错的根因（lstat vs fstat）与影响面（`portable-project-archive.sameDevice`、`project-restore-service.same`）；restore 目标必须是不存在的路径（预创建会触发 `PORTABLE_RESTORE_TARGET_EXISTS`）。
- 知识库：实测维度、lancedb 目录位置、原生模块结论（或降级限制）。
- WebDAV：mock 覆盖的 DAV 方法、凭据密文格式、`restore-copy` 需要 `dialog:select-project-restore-target` 授权的约束。
- 导入验收边界：Web 侧验证到「选择 → 检查 → 准备 → 作者预览」，后续 `db:import-run-*` 批次编排由 `src/services/workflows/import-workflow.ts` 驱动（逻辑与桌面共用），本轮未重建 HTTP 级编排探针。

## 步骤 6 — 最终回归

1. `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` 通过。
2. `node scripts/build-web-server.mjs` 通过；停/启 5190；`/api/health` 200。
3. 复跑既有探针，确认无回归：`probe-author.js`（作者原稿 inspection + preview）、`probe-download.js`（Markdown 下载与 ZIP magic）、W4 加密回读（`llm:list-models` 明文 + 落盘 `web:v1:`）、`probe-restore.js`（本轮成功）。
4. 清理临时探针产生的模型配置（`llm:delete-model('m3-embed')`、`config:set` 还原 `defaultEmbeddingModelId`），保留 `M3恢复副本` 供人工查看。

## 涉及文件

| 文件 | 动作 |
| --- | --- |
| `dist-server/server.mjs` | 重建（步骤 1、6） |
| `electron/controllers/project-archive-controller.ts` | 仅步骤 2 触发时临时加 `console.error` 并移除 |
| `web/server/web-controllers.ts` | 仅步骤 2 判定为 `physicalDirectory` 时归一化父目录 |
| `docs/plans/web-migration.md` | 追加 §8.2 |

## 验证清单

1. `probe-restore.js` → `success: true`，恢复副本可被 `project:open` 打开。
2. 知识库 import/list/search/stats/backfill 全部成功，`lancedb` 目录存在，服务端不崩溃。
3. WebDAV connect/bind/backup/list/restore-copy 成功，凭据密文，clear-credential 生效。
4. `tsc --noEmit` 与 `build-web-server` 通过，`/api/health` 200，既有探针无回归。
5. §8.2 覆盖上述全部结论与限制。

## 风险与取舍

- 步骤 1 有较大概率直接解决 restore；若仍失败，步骤 2 的临时日志是本轮唯一允许的诊断性改动，定位后必须移除。
- WebDAV mock 只实现服务实际使用的方法；`DavFixture` 中与本轮无关的故障注入（drop/corrupt/redirect/slow）不移植。
- 知识库若因原生模块在 Node 22 下不可用，M3 以「降级可运行 + 文档记录」收尾，不扩大改动面。
- 服务端退出时环境会把 `recent-projects.json`、`sqlite-read-*`、`exports/.pe-*` 移入回收站，属既有行为，不作为失败判据。
