# M3 实施计划：导入导出 + 配置密钥 + 知识库（W4 + W6）

## Context

M1（运行时骨架）与 M2（W3 文件域 / W5 桌面裁剪）已完成并验证。按 `docs/plans/web-migration.md` §4，M3 的验收标准是：

> txt/md/epub 导入、参考小说拆解、Markdown 导出、WebDAV 备份、项目归档导入导出

对照现有实现，M3 还缺四件事：

1. `dialog:select-novel-files` 在 Web 端仍返回 `null`（`web/server/web-controllers.ts` 的占位），导入链路完全不可用；
2. 导出/项目归档虽然能写到服务端 `exports/`，但渲染层拿不到文件，浏览器无法下载；
3. `models.json` 里的 `apiKey` 明文落盘，Web 部署必须加密；
4. 知识库（LanceDB + embedding）与 WebDAV 备份尚未在 Node 服务端实测。

目标：不改桌面行为，只新增 Web 专属编排，让上述五条验收全部在浏览器侧闭环。

## 关键约束（已确认）

- 构建：改 `electron/**` 或 `web/**` 后必须 `node scripts/build-web-server.mjs` 并重启 5190 服务端；`src/**` 走 Vite HMR 或 `pnpm build:web`。
- 通道：`src/shared/ipc-channels.ts` 是类型来源；`web/server` 的 `ipcMain.handle` 注册表就是通道路由，新增通道无需写 HTTP 路由。
- 会话：`dialog:select-*` 与 `fs:grant-*` 被 `src/services/ipc-client.ts` 判定为非项目会话通道，下载通道命名为 `web:*` 即可自动沿用该规则。
- 已有可复用件：`web/server/uploads.ts`（上传暂存 + 下载令牌）、`externalFileGrants`（授权签发/解析）、`importInspectionStore`、`windowsSafeFileSystem`（M2 已在 Node 上跑通）。

## 步骤 1 — W4：models.json 的 apiKey 加密

不触碰桌面行为：默认 no-op，只在 Web bootstrap 安装 codec。

1. `electron/utils/config-utils.ts`：新增可选编解码钩子
   - `export interface JsonFileCodec { encode(filePath: string, value: unknown): unknown; decode(filePath: string, value: unknown): unknown }`
   - `export function installJsonFileCodec(codec: JsonFileCodec | null)`
   - `tryReadJsonFile` 在 `JSON.parse` 之后调用 `codec.decode(filePath, parsed)`；
   - `writeJsonFile` 在 `JSON.stringify` 之前调用 `codec.encode(filePath, data)`。
   - 桌面不安装 → 行为不变；所有 models.json 读写（`llm-controller.ts` 46/50/66/359、`kb-controller.ts` 197/215）自动生效。
2. 新增 `web/server/secret-codec.ts`：
   - 仅处理 `MODELS_CONFIG_PATH`（`path.resolve` 比较）。
   - `encode`：数组里每个 `model.apiKey` 非空且不以 `web:v1:` 开头时，用 shim 的 `safeStorage.encryptString` 转成字符串；`decode` 反向，遇到非 `web:v1:` 的值原样返回（兼容旧明文）。
   - 主密钥沿用 shim 的 `PAGEKIN_MASTER_KEY` / `user-data/.pagekin-master-key`。
3. `web/server/bootstrap.ts`：`installGlobalDataLocator(...)` 之后调用 `installJsonFileCodec(createModelsSecretCodec())`。

验证：保存一个模型 → `cat .pagekin-web/app-data/ai-novel-writer/models.json` 中 `apiKey` 为 `web:v1:...`；`llm:list-models` 返回明文；重启服务端后仍能读回明文。

## 步骤 2 — 小说导入（txt/md/epub，reference 与 author-manuscript）

### 2.1 抽出可复用的检查函数

`electron/controllers/import-controller.ts`：

- 把 `dialog:select-novel-files` 处理器中“对话框之后”的全部逻辑（约 367–666 行： revoked、文件数上限、identity/size 预检、`beginParsing`、逐文件读取/EPUB 解压/拆章、`inspectionStore.create`）提取为导出函数：

```ts
export interface NovelImportInspectorDeps {
  limits: ImportResourceLimits
  fileSystem: WindowsSafeFileSystem
  fileIdentity: ImportFileIdentityProvider
  grantService: ExternalFileGrantService
  inspectionStore: ImportInspectionStore
  applicationSecret?: Buffer
}

export function createNovelImportInspector(
  deps?: Partial<NovelImportInspectorDeps>,
): (
  event: IpcMainInvokeEvent,
  filePaths: string[],
  request?: ImportPurpose | ImportNovelFileSelectionRequest,
  projectSession?: ProjectSessionContext,
) => Promise<ImportSelectionResult | null>
```

  - 函数内部保留现有 `frozenProject` / `assertFrozenProject` / `try/catch` 结构，只把“从对话框拿 `result.filePaths`”替换为入参 `filePaths`；空数组返回 `null`（等价取消）。
  - 默认依赖使用模块单例（`windowsSafeFileSystem`、`defaultFileIdentity`、`externalFileGrants`、`importInspectionStore`、`loadApplicationImportSourceSecret()`、`DEFAULT_IMPORT_RESOURCE_LIMITS`）。
- `registerImportController` 的 `dialog:select-novel-files` 处理器收缩为：保留 purpose/session 预校验与 `dialog.once('destroyed')` 清理 → `showOpenDialogInLastDirectory` → 取消返回 `null` → `return inspector(event, result.filePaths, request, projectSession)`。

### 2.2 Web 覆盖

`web/server/web-controllers.ts`：

- `registerWebDialogController` 中删除 `dialog:select-novel-files` 的 `null` 占位，改为：

```ts
const inspector = createNovelImportInspector()
ipcMain.handle('dialog:select-novel-files', async (event, request, projectSession) => {
  const purpose = typeof request === 'string' ? request : request?.purpose ?? 'reference'
  event.sender.once('destroyed', () => importInspectionStore.revokeForWebContents(event.sender.id))
  const uploads = takeUploads(event.sender.id, `novel-files:${purpose}`)
  if (uploads.length === 0) return null
  return inspector(event, uploads.map(upload => upload.absolutePath), request, projectSession)
})
```

- purpose 带上导入类型，避免参考小说与作者原稿两个上传批次串味。
- `dialog:select-legacy-project` 保持 `null`（M3 不涉及旧项目迁移）。

### 2.3 浏览器选择文件

`src/services/web-bridge.ts`：

- `UPLOAD_DIALOGS` 的值改为 `UploadPicker | ((args: unknown[]) => UploadPicker)`，`invoke` 里解析；
- 新增 `'dialog:select-novel-files'`：`accept: '.txt,.md,.markdown,.epub'`，`multiple: true`，purpose 按入参 `request.purpose` 动态生成 `novel-files:${purpose}`。

## 步骤 3 — 浏览器下载（Markdown 导出 / 项目归档）

### 3.1 服务端

- `src/shared/ipc-channels.ts` 的 `FileChannels` 末尾新增：

```ts
'web:request-download': {
  args: [grantId: string]
  return: { success: true; token: string; name: string } | { success: false; error: string }
}
```

- 新增 `web/server/zip-store-only.ts`：手写极小 ZIP 写入器（CRC32 + 本地头 + 中央目录 + EOCD，method 0/8 二选一），只依赖 `node:fs` / `node:zlib`，不新增依赖。
- `web/server/web-controllers.ts`：
  - 新增 `const downloadTargets = new Map<string, { senderId: number; path: string; isFile: boolean }>()`；
  - 在 `dialog:select-export-directory`、`dialog:select-project-archive-export` 签发授权时登记 `grantId → 目标路径`（这两个目标都由本文件创建，路径是可信的）；`event.sender.once('destroyed')` 时一并删除登记与授权。
  - 新增 `registerWebDownloadController()` 注册 `web:request-download`：
    - 校验登记存在且 `senderId === event.sender.id`；
    - 目标是文件 → `registerDownload(path, basename)`；
    - 目标目录只有一个文件 → 直接下载该文件；只有个子目录 → 打包该子目录并以其名命名 `.zip`；其余情况 → 打包目录内容为 `export.zip`；
    - 返回 `{ success: true, token, name }`，下载走已有 `GET /api/download/:token`。

### 3.2 渲染层

- 新增 `src/services/web-download.ts`：

```ts
export async function downloadWebGrant(grantId: string): Promise<boolean>
```

  桌面直接 `return false`；Web 下 `ipc.invoke('web:request-download', grantId)`，成功后创建临时 `<a href="/api/download/{token}" download>` 触发浏览器下载，返回 `true`。
- `src/components/dialogs/ExportDialog.tsx`：`res.success && res.path` 之后、设置 taskState 之前调用 `downloadWebGrant(destination.grantId)`（失败只记日志，不影响导出成功状态）。
- `src/components/backups/ProjectBackupPanel.tsx` 的 `exportLocal`：`project:archive-export` 成功后调用 `downloadWebGrant(target.grantId)`。

## 步骤 4 — 项目归档导入

无需新代码：`dialog:select-project-archive` 上传（M2 已通）+ `dialog:select-project-restore-target`（M2 在 `projects/` 下建子目录）+ `project:archive-restore`。M3 用步骤 3 导出的 `.ainovel` 走一遍：上传 → restore → `project:open` → 章节可读。

## 步骤 5 — W6：知识库与向量

预期无需改动（控制器、LanceDB 路径、embedding 读取都在 `electron/**` 内且已被 shim 适配）。本步骤以验证为主：

1. 启动本地 OpenAI 兼容 mock（`/v1/embeddings` 返回固定维度向量），在模型配置里加一个 `purposes: ['embedding']` 的模型并设为 `defaultEmbeddingModelId`。
2. 用 `dialog:select-knowledge-files` 上传 `.md` → `kb:import-document` → `kb:list-documents` → `kb:search` → `kb:stats` → `kb:backfill-vectors`。
3. 确认 `.pagekin-web/projects/<项目>/.../lancedb` 生成，且服务端进程未因原生模块崩溃。
4. 若 `@lancedb/lancedb` 在 Node 加载失败：记录真实错误，退化为“FTS 可用、向量关闭”的可运行状态，并把限制写进 §8.2（不在 M3 内引入替代向量库）。

## 步骤 6 — WebDAV 备份验证

预期无代码改动（`cloud-backup-controller` 用 `fs.mkdtempSync` + `exportPortableProject`，凭据走 shim 的 `safeStorage`）。

1. 参照 `electron/services/__tests__/webdav-backup-service.test.ts` 的 loopback fixture，在 `$env:TEMP` 下起一个最小 WebDAV mock（PROPFIND/MKCOL/PUT/GET/DELETE）。
2. `cloud-backup:connect` → `cloud-backup:confirm-binding` → `cloud-backup:backup` → `cloud-backup:list` → `cloud-backup:restore-copy`。
3. 校验凭据文件中的 secret 为密文（`safeStorage` 格式），`cloud-backup:clear-credential` 后移除。

## 步骤 7 — 文档与回归

- 在 `docs/plans/web-migration.md` 新增 `### 8.2 M3（W4 + W6）实施记录`：下载通道、ZIP 命名规则、`web:request-download` 语义、models.json 密文格式、导入 purpose 约定、知识库/WebDAV 实测结论与限制。
- 每步收尾：`node scripts/build-web-server.mjs` → 重启 5190 → `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`。

## 涉及文件

| 文件 | 动作 |
| --- | --- |
| `electron/utils/config-utils.ts` | 新增 codec 钩子（默认 no-op） |
| `web/server/secret-codec.ts` | 新增：models.json apiKey 加解密 |
| `web/server/bootstrap.ts` | 安装 codec、注册下载控制器 |
| `electron/controllers/import-controller.ts` | 抽出 `createNovelImportInspector`，处理器收缩 |
| `web/server/web-controllers.ts` | 导入覆盖、下载目标登记、`web:request-download` |
| `web/server/zip-store-only.ts` | 新增：无依赖 ZIP 写入 |
| `src/shared/ipc-channels.ts` | 新增 `web:request-download` 类型 |
| `src/services/web-bridge.ts` | `dialog:select-novel-files` 动态上传 purpose |
| `src/services/web-download.ts` | 新增：Web 下载触发 |
| `src/components/dialogs/ExportDialog.tsx` | 导出成功后触发下载 |
| `src/components/backups/ProjectBackupPanel.tsx` | 归档导出成功后触发下载 |
| `docs/plans/web-migration.md` | 追加 §8.2 |

## 验证清单

1. `tsc --noEmit` 通过；`build-web-server` 通过；服务端 `/api/health` 200。
2. W4：models.json 中 `apiKey` 为 `web:v1:` 前缀；`llm:list-models` 返回明文；重启后可读。
3. 导入：txt/md 各 1 个 + epub 1 个，`reference` 走拆章预览 → `db:import-run-*` → 定稿；`author-manuscript` 预览章节号正确；空文件/超限返回可读错误。
4. 导出：合并 md 单文件直接下载、分章 md 得到 zip、txt 下载成功；项目归档 `.ainovel` 下载后重新上传能 restore 成新副本并可打开。
5. 知识库：import/list/search/stats/backfill 全部成功，lancedb 目录生成。
6. WebDAV：connect/bind/backup/list/restore 成功，凭据密文。
7. 回归：M1 流式生成、M2 写作闭环不受影响（抽出的导入函数在桌面路径保持等价）。

## 风险

- 导入抽函数是 M3 唯一的桌面路径重构点：`import-controller.ts` 的既有单测必须保持通过；若结构不宜整体搬迁，则只抽“预检 + 逐文件检查”两段，对话框分支保持原样。
- `web:request-download` 依赖 `downloadTargets` 登记；刷新页面后旧 grantId 失效，属于预期（导出是一次性动作）。
- 目录下载的 ZIP 在服务端生成会占用磁盘，令牌 10 分钟过期后由后续清理（与 uploads 同策略，M3 不引入定时 GC）。
- 浏览器自动化子代理此前间歇报 “WebView not ready”；页面级验证失败时以 HTTP 探针 + 下载文件字节校验为准。
