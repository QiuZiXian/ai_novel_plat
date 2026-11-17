# 书童 Pagekin Web 化改造方案

> 状态：已评审，M1 已完成，M2 实施中
> 目标形态：Web 优先、桌面冻结；先平移功能，后续由 smart-admin 接管账号与权限
> 基准：`src` 488 个非测试文件 / 约 8.1 万行；`electron` 178 个非测试文件 / 约 4.6 万行

## 1. 背景与结论

桌面版是 Electron 应用：渲染层（`src/`）负责全部界面与写作流程，主进程（`electron/`）负责
SQLite、LanceDB 向量库、模型调用、文件系统、对话框和更新。

盘点后的关键事实决定了改造策略：

| 事实 | 数值 | 含义 |
| --- | --- | --- |
| IPC 通道总数 | 220（db 103、llm 20、kb 17、project 15、chapter 12、fs 10、mcp 9、dialog 9、update 7、skills 6、window 5 等） | 通道全部集中在 `src/shared/ipc-channels.ts` |
| `ipcMain.handle` 注册点 | 207 | 形态统一：`(event, ...args) => value` |
| `webContents.send` 推送点 | 5（llm-controller 4、window-controller 1、main.ts 1） | 事件面极小，改造代价低 |
| 渲染层直连桌面 API | 146 处调用 / 23 个文件，全部经由 `src/services/ipc-client.ts` | 换传输只需改一个点 |
| repositories 依赖 electron | 0 | 数据层可在 Node 上原样运行 |
| `import ... from 'electron'` 的文件 | 27 | shim 的精确爆炸半径 |
| `getCurrentProjectPath()` 调用点 | 159 | 用 AsyncLocalStorage 承载，避免逐个改 |

结论：Web 化是“换壳 + 换传输 + 换文件语义”，不是重写。渲染层约 98% 复用，仓储层与 LLM/向量层 100% 复用。

## 2. 目标架构

```
浏览器 SPA（现有 src/，React 19 + Vite）
    │  POST /api/invoke/:channel  { args: unknown[] }
    │  GET  /api/events           （SSE，对应 ipc.on）
    │  POST /api/upload           （替代 dialog 选择本地文件）
    │  GET  /api/download/:token  （替代写本地路径）
    ▼
Node 服务（复用 electron/ 业务层）
    ├─ web/shims/electron.ts     （ipcMain / BrowserWindow / app / dialog / shell / safeStorage / nativeImage）
    ├─ web/server/channel-router （220 通道自动映射，不逐个写路由）
    ├─ web/server/session-context（AsyncLocalStorage：userId → 项目 → 数据库句柄）
    └─ 存储：better-sqlite3 + LanceDB + 项目工作区目录
    ▲
    │ 后续：smart-admin 签发 JWT，网关校验后把 userId 写入上下文
```

### 2.1 运行时 shim 替换

`web/shims/electron.ts` 提供与 Electron 同名的运行时对象：

- `ipcMain.handle(channel, handler)` → 写入 `Map<string, handler>`；
- `BrowserWindow` → 伪造窗口对象，`webContents.send(channel, payload)` 写入当前 SSE 连接；
- `app` → `getPath('userData')` 指向服务端数据根，`getLocale()` 由请求头推导，`quit/on` 为 no-op；
- `dialog` → 抛 `WEB_DIALOG_REQUIRES_UPLOAD`，由 W3 换成上传/下载；
- `safeStorage` → AES-256-GCM，主密钥来自环境变量；
- `nativeImage` → W5 用 `sharp` 替换。

构建期通过 alias 把 `'electron'` 指向该 shim，`electron/controllers/*` 与
`electron/services/*` 无需改动。

### 2.2 会话上下文

`web/server/session-context.ts` 使用 `AsyncLocalStorage` 保存 `{ userId, projectPath, leaseId, locale }`。
`electron/database.ts` 的 `getCurrentProjectPath()` 改为“先读上下文，再回退进程变量”。
这样 159 个调用点不改，单用户立即可用，多用户接入 smart-admin 时只需让网关写入 `userId`。

### 2.3 文件语义

| 桌面行为 | Web 行为 |
| --- | --- |
| `dialog:select-folder` 选项目目录 | 项目建在服务端工作区，前端只选“新建/打开哪个项目” |
| `dialog:select-*-files` 选导入文件 | 浏览器 `<input type="file">` → `POST /api/upload` → 返回服务端临时路径 |
| 导出/备份写到用户选择的目录 | 服务端生成 → `GET /api/download/:token` |
| `fs:grant-*` 能力令牌（路径授权） | 上传令牌替代；工作区根目录约束保留 |
| `security/windows-safe-file-system.ts`（ACL） | Web 构建不加载 |

项目归档格式不变（`.ai-novel` + `project.db`），桌面项目可直接导入，复用
`portable-project-archive.ts` / `project-archive-service.ts` / `project-restore-service.ts`。

## 3. 工作包

| # | 工作包 | 内容 | 人日 |
| --- | --- | --- | --- |
| W1 | 运行时骨架 | `web/shims`、`web/server`（HTTP + SSE + 通道路由）、`src/services/web-bridge.ts`、`vite.web.config.ts`、esbuild 服务端打包脚本 | 5–7 |
| W2 | 身份与数据根 | `app-data-locator` 按 userId 解析、AsyncLocalStorage 上下文、JWT 中间件占位 | 2–3 |
| W3 | 文件/对话框域 | 上传、下载、项目工作区、裁掉 ACL 与外部文件授权 | 4–6 |
| W4 | 配置与密钥 | `config.json` / `models.json` / `recent-projects.json` 落服务端、模型 Key 加密 | 2–3 |
| W5 | 桌面功能裁剪 | update、window 按钮、MCP stdio、单实例、nativeImage | 2–3 |
| W6 | 知识库/向量 | LanceDB + embedding 原样运行，处理镜像内原生依赖 | 1–2 |
| W7 | 构建/测试/部署 | `dev:web`、`build:web`、Dockerfile、63 个 mock electron 的测试改指 shim | 3–5 |

合计：**19–29 人日**。

## 4. 里程碑与验收

| 里程碑 | 范围 | 验收标准 |
| --- | --- | --- |
| **M1 风险出清** | W1 + W2 | 浏览器打开项目 → 书架/章节可见 → 单章 AI 生成流式返回；刷新后状态一致 |
| M2 写作闭环 | W3 + W5 | 架构、蓝图、草稿、审稿、定稿、回收站全流程可用 |
| M3 导入导出 | W4 + W6 | txt/md/epub 导入、参考小说拆解、Markdown 导出、WebDAV 备份、项目归档导入导出 |
| M4 权限接入 | W2 收尾 | smart-admin JWT 鉴权，`userId` 数据隔离，多实例部署 |
| **M4 步骤 2** | 用户级数据隔离（§9.2） | 两个用户同时使用互不可见：各自 `projects/exports/recent-projects`、各自项目会话、各自数据库句柄；A 打开作品不影响 B |
| **M4 步骤 3** | 连接归属（§9.3） | SSE 连接绑定 `userId`，跨用户复用 `X-Connection-Id` 被拒；事件只回到所属连接 |
| **M5 并行配额** | 任务并行（§9.4，暂缓） | 默认 1 条运行中任务；配额内可并行多条；超额排队，不串项目、不串用户 |

## 5. 改造点文件清单

### 5.1 新增

| 文件 | 作用 |
| --- | --- |
| `web/shims/electron.ts` | Electron 运行时 shim（ipcMain / BrowserWindow / app / dialog / shell / safeStorage / nativeImage），并把通道注册表暴露给网关 |
| `web/server/index.ts` | HTTP 入口：静态资源、`/api/invoke`、`/api/events`、`/api/health` |
| `web/server/channel-router.ts` | 通道调用分发、会话上下文注入、错误序列化 |
| `web/server/events.ts` | SSE 连接管理与 `webContents.send` 替代（一个连接对应一个 WebContents） |
| `web/server/bootstrap.ts` | 数据根初始化、全局数据定位器安装、controller 注册 |
| `web/server/web-controllers.ts` | Web 专属覆盖：启动状态、更新通道降级、目录选择改为工作区授权 |
| `scripts/build-web-server.mjs` | esbuild 打包服务端（alias `electron` → shim，原生模块 external） |
| `scripts/dev-web.mjs` | 一条命令起「服务端 watch + Node 重启 + Vite」 |
| `vite.web.config.ts` | Web 版渲染层构建（不加载 electron 插件，`/api` 走代理） |
| `src/services/web-bridge.ts` | 浏览器端实现 `window.aiNovelAPI`（fetch + EventSource） |

### 5.2 修改

| 文件 | 动作 |
| --- | --- |
| `src/main.tsx` | 入口先安装 web bridge（`window.aiNovelAPI` 不存在时） |
| `src/services/ipc-client.ts` | 不改传输，仅放宽“桌面接口未就绪”的报错（浏览器调试用） |
| `src/App.tsx` | Web 下不渲染 `UpdateNotifier`；关闭守卫改为页面离开提示 |
| `src/components/stage/StageTopBar.tsx` | 隐藏最小化/最大化/关闭按钮 |
| `src/components/startup/RendererStartup.tsx` | `window:close` 改为无操作提示 |
| `src/services/export-service.ts` | 写目录改为下载令牌（W3） |
| `src/services/knowledge-service.ts` | 选择文件改为上传（W3） |
| `src/stores/project-store.ts` | 项目路径展示改为虚拟路径（W3） |
| `src/stores/llm-store.ts` | 配置读写走服务端存储（W4） |
| `electron/database.ts` | `getCurrentProjectPath` 优先读会话上下文（W2） |
| `electron/ipc-handlers.ts` | 拆出可复用注册函数，Web 侧跳过 window/update/mcp（W1） |
| `electron/controllers/llm-controller.ts` | `webContents.send` 改经 shim（W1） |
| `electron/controllers/generation-controller.ts` | 同上（W1） |
| `electron/services/app-data-locator.ts` | 数据根按 userId 解析（W2） |
| `electron/utils/config-utils.ts` | 保持路径接口，改为上下文感知（W2） |
| `electron/controllers/project-controller.ts` | 新建项目不再调用目录对话框（W3） |
| `electron/controllers/import-controller.ts` | 导入来源改为上传令牌（W3） |
| `electron/controllers/fs-controller.ts` | 仅保留工作区内的读写（W3） |
| `electron/controllers/external-file-grant-controller.ts` | Web 下不注册（W3） |
| `electron/services/cloud-credential-store.ts` | `safeStorage` 改注入 Web 实现（W4） |
| `electron/services/avatar-image.ts` | `nativeImage` 换 `sharp`（W5） |
| `package.json` | 新增 `dev:web` / `build:web` / `start:web` |
| `index.html` | 保留；Web 构建同源输出 |

### 5.3 废弃 / Web 构建不加载（桌面源码保留）

| 文件 | 原因 |
| --- | --- |
| `electron/main.ts` | 被 `web/server/index.ts` 替代 |
| `electron/preload.ts` | 被 `src/services/web-bridge.ts` 替代 |
| `electron/controllers/update-controller.ts` | 更新机制不适用 |
| `electron/services/update-service.ts`、`update-runtime.ts`、`update-startup.ts`、`update-preferences-store.ts` | 同上 |
| `electron/services/electron-updater-adapter.ts`、`github-release-update-backend.ts` | 同上 |
| `electron/services/single-instance-runtime.ts` | 服务端多实例由网关处理 |
| `electron/services/release-vector-smoke.ts`、`release-official-homepage-smoke.ts` | 安装包资格校验专用 |
| `electron/controllers/window-controller.ts` | Web 下窗口控制无意义 |
| `electron/mcp/mcp-ipc-bridge.ts`、`mcp-manager.ts`（stdio 分支） | 浏览器不能拉起本地进程，仅保留 SSE |
| `electron/security/windows-safe-file-system.ts`、`file-capability.ts` | ACL 能力在服务端不适用 |
| `electron/utils/remembered-dialog.ts` | 记忆对话框路径，改为记住上传目标 |
| `src/components/updates/*` | 不渲染 |
| `src/components/layout/use-window-close-guard.ts` | 改为页面级离开提示 |

### 5.4 完全不动（复用的主体）

| 范围 | 说明 |
| --- | --- |
| `electron/repositories/**`（29 个文件） | 纯 SQL，0 处 electron 依赖 |
| `electron/migrations/**` | 数据库结构与迁移 |
| `electron/llm/**` | OpenAI / Gemini / Anthropic 供应商实现与流式解析 |
| `electron/services/**`（除上表） | 生成流程、审稿、定稿、导入、归档、WebDAV 备份 |
| `src/shared/**`（99 个文件） | 领域合同、通道类型、提示词 |
| `src/components/stage/**`、`src/stores/**`、`src/i18n/**` | 界面与状态，除上表列出的少数文件 |
| 约 380 个纯逻辑测试 | 不依赖 electron |

## 6. 风险与取舍

1. **本机模型不可达**：服务端在云端时无法访问用户的 `127.0.0.1:11434`。保留“自定义 OpenAI 兼容地址”，本地模型能力放到 M4 之后用本地桥补。
2. **必须常驻 Node 进程**：better-sqlite3 与 LanceDB 是原生模块，不能跑 Serverless，部署形态为 Docker。
3. **单进程单"当前项目"**：M1–M3 一个部署服务一个数据根；M4 引入 `userId` 后由上下文隔离。
4. **密钥安全**：桌面版把模型 Key 明文写在 `models.json`；Web 版必须加密落盘并限制目录权限。
5. **路径语义**：多处界面展示绝对路径，需统一改为虚拟路径，避免暴露服务器目录结构。
6. **桌面冻结**：`electron/` 源码与构建脚本保留但不再发版，避免双端分叉。

## 7. M1 实施范围

已落地：

- `web/shims/electron.ts`、`web/server/*`、`src/services/web-bridge.ts`、`vite.web.config.ts`、`scripts/build-web-server.mjs`、`scripts/dev-web.mjs`
- `electron/ipc-handlers.ts` 原样复用：Web 端注册同一套 controller，再由 `web/server/web-controllers.ts` 覆盖启动状态、更新通道与目录选择
- `src/main.tsx` 在渲染前安装 bridge
- 验收命令：`pnpm dev:web`（服务端 5190 + Vite 5181），浏览器完成“打开项目 → 看章节 → 流式生成一章”

尚未覆盖（W3 起）：上传/下载、项目导入归档、知识库文件选择、云端备份、MCP。

## 8. 实施备注

- **运行环境**：服务端 bundle 位于 `dist-server/server.mjs`，渲染层产物 `dist-web/`，两者不要同目录（`vite build` 会清空输出目录）。
- **Windows 安全文件系统助手**：`electron/security/windows-safe-file-system.ps1` 在源码树内可被 Web 服务直接调用；Linux 部署会触发 `SECURE_FS_UNSUPPORTED_PLATFORM`，需要在 W3 补 Linux 实现或降级策略。
- **卷序列号兜底**：部分 Node 版本（本机 22.14）在 Windows 上 `statSync(..., {bigint:true}).dev` 恒为 `0n`，而助手用 `GetFileInformationByHandle` 校验真实卷序列号，会导致所有文件操作报 `SECURE_FS_ROOT_CHANGED`。`captureSecureRootIdentity` 现在对 `dev === 0n` 的盘符执行一次 `cmd.exe /d /c vol <盘符>`（注意不能带尾部反斜杠）解析 `XXXX-XXXX` 并按盘符缓存。
- **数据目录**：默认 `./.pagekin-web`（`PAGEKIN_DATA_ROOT` 可覆盖），内含 `user-data/`、`app-data/`、`projects/`、`local-appdata/`。`bootstrap` 会把 `LOCALAPPDATA` 固定到 `local-appdata/`，因为 SQLite 迁移的临时快照目录取自该变量，必须留在数据根内。
- **主密钥**：优先 `PAGEKIN_MASTER_KEY`，否则在 `user-data/.pagekin-master-key` 生成 32 字节密钥（0600）。
- **SSE 帧格式**：`data: {"channel":"llm:stream-chunk","args":[{requestId,chunk}]}`，无 `event:` 字段，浏览器用默认 `onmessage` 接收；心跳为 `: ping`。同一 `cid` 的 invoke 与事件流共用同一个伪 `WebContents`，因此目录授权（`event.sender.id`）在两次请求间保持一致。
- **流式链路已验证**：用本地 OpenAI 兼容 mock（`/v1/chat/completions` SSE）保存模型后调用 `llm:generate-stream`，服务端发出 6 个 `llm:stream-chunk` + 1 个 `llm:stream-done`（`finishReason: stop`），浏览器侧经 SSE 全部收到；验证完成后已删除该 mock 模型配置。
- **测试环境**：依赖用 `pnpm install --ignore-scripts` 安装，未下载 Electron 二进制，`vitest` 会报 `Electron failed to install correctly`；跑 `electron/**` 单测前需先 `pnpm rebuild electron`（或允许安装脚本联网）。

### 8.1 M2（W3 + W5）实施记录

- **运行时判定**：`AiNovelAPI.runtime` 新增可选值 `'web'`，由 `src/services/web-bridge.ts` 写入；`ipc-client` 提供 `isWeb` / `isDesktop`。桌面 preload 不设置该字段，按 `runtime !== 'web'` 判定为桌面。
- **桌面功能裁剪**：
  - `StageTopBar` 的窗口按钮（最小化/最大化/关闭）在 Web 下不渲染；
  - `App` 不渲染 `UpdateNotifier`，烟测打开（`project:smoke-open-request`）只在桌面执行；
  - `RendererStartup` 不再订阅 `window:close-requested`，启动失败页的「关闭应用」在 Web 下改为「重新加载页面」；
  - `useWindowCloseGuard` 在 Web 下改用 `beforeunload`：有未保存编辑器内容或当前项目有活跃工作流时阻止直接离开；
  - MCP 子进程无法在浏览器拉起，`mcp:*` 在 Web 下覆盖为空实现（`load-config` 返回 `status: 'missing'`，`connect` 返回 `MCP_DISABLED_IN_WEB`）。
- **上传**：`POST /api/upload?purpose=…`（原始字节；请求头 `X-Connection-Id` / `X-File-Name` / 可选 `X-File-Relative-Path`），文件落到 `<dataRoot>/uploads/<purpose>/<senderId>/…`。`web-bridge` 的 `UPLOAD_DIALOGS` 负责弹浏览器选择框、上传，再调用原通道；服务端 `dialog:select-knowledge-files` / `select-knowledge-folder` / `select-project-archive` 消费待用上传并签发短期授权（文件 read / 目录 read+list）。知识库目录授权的 `displayName` 取相对路径首段（用户选中的目录名）。
- **下载与导出目标**：`GET /api/download/:token` 已就绪（`registerDownload` 生成 10 分钟一次性令牌）。`dialog:select-export-directory` 改为 `<dataRoot>/exports/<uuid>` 的写授权；`select-project-archive-export` 与 `select-project-restore-target` 改为在 `exports/`、`projects/` 下创建新子路径并签发 `create` 授权。导出产物尚未自动注册下载令牌，等 M3 的导出 UI 接上。
- **仍返回 null 的选择器**：`dialog:select-novel-files`（需要复用桌面版的导入检查管线）与 `dialog:select-legacy-project`（整目录上传），留到 M3。
- **M2 流程实测（HTTP 直连）**：`db:project-core-update` → `db:blueprint-upsert` / `get-all` → `db:draft-create` / `get-full` → `db:review-create` / `get-latest` → `finalization:commit`（`publicationStatus: published`）→ `chapter:delete-finalized` → `chapter:confirm-legacy-knowledge-absent` → `chapter:trash-list` → `chapter:trash-restore` → 再删除 → `chapter:trash-purge`，全部成功。
- **删除的额外确认**：已定稿章节首次删除会返回 `CHAPTER_DELETE_LEGACY_KNOWLEDGE_CHECK_REQUIRED` 与一条 `authorization_required` 操作，需要 `chapter:confirm-legacy-knowledge-absent` 后才继续清理实体稿，这是桌面版既有流程。
- **服务端重启副作用**：退出旧进程时 `recent-projects.json` 与 SQLite 快照会走桌面版的安全删除（进回收站），随后启动会重建/恢复，功能不受影响。
- **浏览器验收限制**：本轮浏览器自动化环境反复报未就绪，UI 侧只做了 HTTP 级确认（Vite 正常返回含 `isWeb/isDesktop`、`UPLOAD_DIALOGS` 的新模块）；M2 页面级点击待浏览器工具恢复后补验。

### 8.2 M3（W4 + W6）实施记录

- **下载通道**：`dialog:select-export-directory`、`dialog:select-project-archive-export` 成功后由 `rememberDownloadTarget(grantId → {senderId, targetPath})` 登记；渲染层调用 `web:request-download(grantId)`，服务端校验 sender 后 `registerDownload` 签发 10 分钟一次性令牌，返回 `{token, name}`，前端用 `<a download>` 触发 `GET /api/download/:token`。文件直接下载；目录仅一个子目录时以其名打包 `<目录名>.zip`，否则 `export.zip`；ZIP 由 `web/server/zip-store-only.ts` 手写（store 方法、UTF-8 标志 `0x0800`、CRC32、中央目录 + EOCD），限制 4096 条目 / 512MB。
- **models.json 密文**：`electron/utils/config-utils.ts` 新增 `installJsonFileCodec`，桌面默认 no-op；Web 端 `web/server/secret-codec.ts` 只对 `MODELS_CONFIG_PATH` 生效，写入 `web:v1:` + base64（AES-256-GCM，12 字节 IV + 16 字节 tag，主密钥来自 `PAGEKIN_MASTER_KEY` 或 `user-data/.pagekin-master-key`）。读取失败回退空串并 warn。`llm:list-models` 仍返回明文，重启后可正常解密。
- **导入 purpose 约定**：`novel-files:reference`（参考资料拆解）与 `novel-files:author-manuscript`（作者原稿）；服务端 `dialog:select-novel-files` 按请求里的 `purpose`（字符串或 `{purpose}`）取对应批次的 uploads，再交给 `createNovelImportInspector()` 复用桌面预检/解析管线。导入验收边界为「选择 → 检查（`inspection`）→ 准备（`preparation`）→ 作者原稿 `db:import-run-author-preview`」；后续 `db:import-run-*` 批次编排由 `src/services/workflows/import-workflow.ts` 驱动，逻辑与桌面共用，本轮未另建 HTTP 级编排探针。
- **归档身份校验的 `dev === 0n` 容错**：本机卷上 `lstatSync(..., {bigint:true}).dev` 恒为 `0n`，而 `fstatSync` 的 `dev` 是真实卷号，导致 fstat 与 lstat 比较必然失败。`portable-project-archive.ts`（`sameDevice`）、`project-restore-service.ts`（`same`）、`portable-runtime-freeze.ts` 与 `portable-current-authority.ts`（`sameFile`）统一改为「`dev` 相等或任一侧为 `0n`，且 `ino` 相等」。`project-archive-service.ts` 的 `sameObject` 两侧都来自 `lstatSync`，无需改动。
- **恢复目标语义**：`dialog:select-project-restore-target` 只返回 `projects/` 下**不存在**的新子路径（与桌面 `availableRestoreTarget` 一致），不要预先 `mkdir`，否则会命中 `PORTABLE_RESTORE_TARGET_EXISTS`。`physicalDirectory()` 只校验父目录链的 realpath，本机已验证该链无符号链接/大小写偏差。
- **install 不再用硬链接**：原实现 `copyFile → linkSync(tmp, target) → unlink(tmp)` 依赖「删除后 nlink 回落 1」，在删除被拦截（进回收站）的环境里 nlink 会永久停在 2，导致随后 `regularFile`/`assertPhysicalTree` 拒绝。现改为 `copyFileSync(..., COPYFILE_EXCL)` 独占创建目标文件，再 `fsync` + sha256 比对 + `nlink === 1n` 校验，语义不变且不产生第二个链接。
- **恢复实测**：`project:archive-restore` 返回 `success: true`（`M3恢复副本4`，672210 字节归档），`receipt.targetProjectRoot` 指向 `projects/M3恢复副本4`，`project:open` 可打开，项目名与原项目一致；archive export 的 `entryCount: 4`。
- **W6 知识库实测**：用本地 OpenAI 兼容 `/v1/embeddings` mock（1536 维确定性向量）保存 `purposes: ['embedding']` 的模型并设 `defaultEmbeddingModelId`；`kb:import-document` → 1 文档 / 1 块，`kb:list-documents`、`kb:search`、`kb:stats`（`vectorDimension: 1536`）、`kb:get-vectorless-count`（0）、`kb:backfill-vectors`（0 待补）全部成功，LanceDB 原生模块在 Node 22 下可加载，数据落在 `<project>/.ai-novel/lancedb/{chunks,chunks__space_1,documents}.lance`。`kb:*` 的会话参数是**最后一个实参** `ProjectSessionContext`（`{projectId, leaseId, projectPath}`），HTTP 探针必须显式传入。
- **知识库 × 归档的环境限制**：含 `lancedb` 的项目在**本机**执行 `project:archive-export` / 云端备份会返回 `PORTABLE_KNOWLEDGE_INVALID`——LanceDB 写 `_versions/1.manifest` 时用「临时文件 → 硬链接 → 删临时」的原子写，而本机对服务端进程的删除会进回收站，临时名字未真正消失，manifest 的 `nlink` 停在 2，被 `assertPhysicalTree` 的 `nlink === 1n` 拒绝。该文件确在磁盘上且内容不变，普通前台进程的删除可回落 1；因此判定为运行环境（删除拦截）导致，未放宽该安全校验。验收用的 WebDAV 备份因此选在无 `lancedb` 的项目上完成。
- **WebDAV 实测**：本地 mock（`PROPFIND`/`MKCOL`/`PUT`/`GET`/`HEAD`，Basic Auth）下依次验证 `cloud-backup:view`（unconfigured）→ `connect`（返回 `accountId`，`persistence: os-backed`）→ `confirm-binding`（`revision` 递增）→ `backup`（`state: backup-complete`，归档 672210 字节、`archiveSha256` 有值）→ `list`（1 个代）→ `restore-copy`（`state: restore-complete`，落到 `projects/云备份副本`，`project:open` 成功）→ `clear-credential`（`affectedBindings: 2`，账号从存储移除）。凭据文件 `app-data/ai-novel-writer/cloud-backup-credentials.json` 中 `encryptedSecretBase64` 解码后以 `web:v1:` 开头，无明文密钥。`restore-copy` 的目标必须来自 `dialog:select-project-restore-target` 的 `create` 授权。
- **重启副作用**：退出服务端时 `models.json`、`config.json`、`recent-projects.json`、`cloud-backup-*.json`、`exports/.pe-*` 等会被环境移入回收站，随后按需重建；探针在重启后需重新写入模型与 `defaultEmbeddingModelId`。
- **M3 页面级验收（浏览器）**：首页书架、打开作品、写作舞台均正常渲染，顶部栏不出现最小化/最大化/关闭，也不出现更新提示；舞台菜单「导出…」能打开导出对话框，无定稿章节时提示「无可导出的章节（无定稿章节）」；直接访问 `/settings` 进入「项目备份」时显示「请先打开一个项目」分支（`currentProject` 为空），属预期。浏览器自动化本轮持续返回 `iCube command error 超时`，实际点击下载未能完成，改用 HTTP 直连验证 UI 的三步链路：`dialog:select-project-archive-export` → `project:archive-export`（`byteSize: 672210`、`entryCount: 4`）→ `web:request-download`（36 字符令牌）→ `GET /api/download/:token` 返回 200（`application/octet-stream`、`attachment; filename*=UTF-8''project-backup-5.ainovel`、ZIP 魔数 `504b`）；空导出目录请求下载返回 `ZIP_SOURCE_EMPTY`，符合预期。浏览器里的真实点击（含 WebDAV 面板连接/备份）留待工具恢复后补验。

### 8.3 M4（W2 收尾）实施记录

- **JWT 鉴权中间件（步骤 1）**：新增 `web/server/auth.ts`，用 `node:crypto` 校验 HS256 JWT（无新增依赖）。令牌来源优先级 `Authorization: Bearer` → Cookie `pagekin_token` → `?token=`（仅 `/api/events`，因为 `EventSource` 不能自定义请求头）。校验项：`alg === 'HS256'`（拒绝 `none`/RS256）、HMAC 常数时间比对、必需 `exp`、可选 `nbf`、可选 `PAGEKIN_JWT_ISSUER` 与 `PAGEKIN_JWT_AUDIENCE`、`sub`/`userId` 非空。失败统一返回 401 `{ok:false, error:{channel:'auth', message:'AUTH_REQUIRED'|'AUTH_INVALID'|'AUTH_EXPIRED'}}`。
- **默认不启用**：未设置 `PAGEKIN_JWT_SECRET` 时中间件放行（`principal.userId === 'local'`），桌面与本地 Web 调试行为不变；网关多实例部署必须显式设置，启动日志会打印 `auth: jwt` 或 `auth: disabled`。`index.ts` 在 `/api/health` 之后统一拦截 `/api/*`，健康检查与静态资源保持开放。
- **验证**：`web/server/__tests__/auth.test.ts` 覆盖免登录、Bearer/Cookie/事件流查询串取令牌、篡改签名、`alg=none`、过期、缺 `exp`/`sub`、issuer/audience，10 例通过；`tsc --noEmit` 通过。带 `PAGEKIN_JWT_SECRET` 实测：health 200、匿名 invoke 401 `AUTH_REQUIRED`、有效令牌 200、过期 401 `AUTH_EXPIRED`、`alg=none` 401 `AUTH_INVALID`、Cookie 200、`/api/events?token=` 200、匿名事件流与匿名下载 401；去掉密钥重启后匿名 invoke 恢复 200。
- **未做（步骤 2/3）**：`principal.userId` 尚未参与数据根派生与 SSE 连接归属，`dataRoot` 仍是全局单例（`bootstrap.ts`），跨用户隔离与多实例需要后续步骤。

### 8.4 Web 保存位置修复

- **问题**：Web 版「新建作品」与「小说拆解与仿写 → 新建项目」仍走桌面目录选择器：`dialog:select-folder('project-create')` 虽然由 `web-controllers.ts` 直接签发 `projects` 目录授权，但界面要求用户先点「选择」才能创建；未点就选小说文件会报「请先填写新项目名称和保存位置」。
- **修复**：Web 运行时不再让用户挑本地目录。
  - `use-new-project-form.ts`：打开对话框即自动取 `dialog:select-folder('project-create')` 授权；`canCreate` 在 Web 下只要求作品名；创建时若授权缺失会重取，仍失败则弹错误，不再静默无反应。
  - `NewWorkDialog.tsx`：保存位置只读显示「作品库」，隐藏「选择」按钮，并给出「无需选择文件夹」提示。
  - `ImportNovelDialog.tsx`：同样在打开且目标为新项目时预取授权；保存位置只读显示「作品库」、隐藏目录按钮；提交前的校验拆成「缺名称」与「缺位置」两条。
  - 桌面（Electron）分支不变，仍用系统目录选择器。
- **验证**：`tsc --noEmit` 与 `pnpm build:web` 通过；浏览器实测「新建作品」与「小说拆解与仿写」两个弹窗的保存位置均自动显示「作品库」且无目录选择按钮。

### 8.5 M4 步骤 2/3 实施记录

- **用户作用域**：新增 `electron/services/user-scope.ts`（`AsyncLocalStorage`），`runWithSender` 增加 `userId` 参数；`web/server/channel-router.dispatch` 与 `/api/invoke`、`/api/upload`、`/api/events` 全部传入 `principal.userId`。无作用域时回落 `local`，桌面行为不变。
- **用户工作区**：新增 `web/server/workspace.ts`，`local` 保持原布局；登录用户使用 `<dataRoot>/users/<safeId>/{projects,exports,uploads,downloads,...}`，按需创建。`web-controllers` 的目录授权、上传批次、归档导出/恢复目标、导出目录、下载根全部改为按当前用户解析。
- **会话隔离**：`project-access.ts` 的 `ProjectAccessService` 改为按 `userId` 注册表，导出同名门面 `projectAccess` 按作用域转发，调用点无需改造。
- **数据库隔离**：`database.ts` 的单一 `projectDb`/`currentProjectPath` 改为 `Map<canonicalPath, {database, owner}>` + `activeProjectByUser`。`initProjectDatabase` 不再关闭其他用户的库；同一 canonical 路径已被他人持有时报 `PROJECT_IN_USE`；`closeProjectDatabase` 只关当前用户的活动库。后台任务继承请求的 ALS 作用域，仓库层调用点无需改动。
- **最近项目**：`currentRecentProjectsPath()` 按用户返回 `app-data/ai-novel-writer/users/<id>/recent-projects.json`；`config.json`/`models.json` 仍为服务端统一配置。
- **连接归属**：`events.ts` 记录连接与待连接 sender 的 `userId`；跨用户在 `/api/invoke`、`/api/upload`、`/api/events` 复用 `X-Connection-Id` 返回 403 `CONNECTION_FORBIDDEN`。
- **验证**：
  - `tsc --noEmit`、`build:web`、`build-web-server` 通过。
  - `scripts/probes/multi-user-isolation.mjs` 10/10：双用户目录、双会话互不覆盖、最近项目隔离、跨用户连接号 403。
  - 本地模式回归：`inspect-projects.mjs`、`archive-roundtrip.mjs`（新建 → 导出 → 下载 → 回传 → 恢复）通过。
  - 新增单测 `electron/services/__tests__/multi-user-isolation.test.ts`（本机缺 Electron 二进制未执行）。
- **已知限制**：项目路径上限 85 字符，登录用户多两层目录，部署时 `PAGEKIN_DATA_ROOT` 要浅；`config.json`/`models.json` 未按用户拆分；单实例部署，多实例需要按用户粘性会话。


## 9. 多用户与并行里程碑（M4 步骤 2/3、M5）

### 9.1 现状约束

Web 端目前只是把 Electron 的传输层换成 HTTP + SSE，业务层仍是「一个进程 = 一个用户 = 一个项目」：

1. **数据根全局单例**：`bootstrapWebRuntime()` 用 `PAGEKIN_DATA_ROOT`（默认 `.pagekin-web`）固定一套 `app-data / user-data / projects / exports`，所有连接共享。
2. **项目会话只有一份**：`ProjectAccessService.activeSession` 是单值，`beginSession` 直接覆盖；第二个用户打开作品后，第一个用户的请求会报 `PROJECT_SESSION_STALE` / `PROJECT_SESSION_DATABASE_MISMATCH`。
3. **数据库句柄全局单例**：`electron/database.ts` 只有一个 `projectDb` + `currentProjectPath`，`getProjectDb()` / `getCurrentProjectPath()` 被 `db`、`generation`、`finalization`、`import-run`、各 repository 直接调用，没有按连接或用户寻址。

已具备、可复用：SSE 按连接回推（`web/server/events.ts`）；`BrowserWindow.fromWebContents` 包装同一个 sender，生成流不会串标签页；JWT 已能解析 `principal.userId`；每个项目自带 SQLite 与租约 epoch，同项目单写者的约束是现成的。

### 9.2 M4 步骤 2：用户级数据隔离

**目标**：两个用户同时登录、各开一本作品，互不可见、互不打断。同一用户仍只有一个活动项目（保持现有渲染层模型）。

| 子步骤 | 内容 | 关键改动 |
| --- | --- | --- |
| 2.1 用户工作区 | `local` 沿用现有根目录（兼容桌面与单机调试）；JWT 用户使用 `<dataRoot>/users/<safeUserId>/{app-data,user-data,projects,exports,local-appdata}`，按需创建并缓存 | 新增 `web/server/workspace.ts`；`web-controllers.ts` 的 `dialog:select-*`、restore/export 目录、上传/下载根改用 `workspaceFor(currentUserId())` |
| 2.2 请求级用户作用域 | 用 `AsyncLocalStorage` 传递 `userId`（默认 `local`），`runWithSender` 内同时建立用户作用域；后台工作流继承该作用域 | 新增 `electron/services/user-scope.ts`；`channel-router.dispatch` 接收 `userId`，`index.ts` 把 `principal.userId` 传入 |
| 2.3 会话按用户寻址 | `projectAccess` 改为按 `userId` 维护 `ProjectAccessService` 实例的注册表；同名方法按当前作用域转发 | `electron/services/project-access.ts` 增加注册表与门面；`assertCurrentProjectContext` 增加用户维度 |
| 2.4 数据库句柄按项目 | `projectDb` → `Map<canonicalProjectPath, Database>`；`lastProjectByUser` 记录每个用户的活动项目；`getProjectDb()` / `getCurrentProjectPath()` 先查当前用户的活动项目 | `electron/database.ts`；`initProjectDatabase` 不再关闭其他用户的库；`closeProjectDatabase` 只关当前用户的库 |
| 2.5 同项目互斥 | 同一 canonical root 同时只允许一个用户/会话持有写句柄，第二个打开者报 `PROJECT_IN_USE`（避免两个用户写同一本） | `database.ts` 的句柄表 + `project-access.ts` |
| 2.6 全局配置归属 | 模型与 API Key（`app-data/ai-novel-writer/config.json|models.json`）仍按服务端统一配置；`recent-projects.json` 跟随用户工作区 | `bootstrap.ts` 只初始化服务级 locator；最近项目读写改走用户工作区 |

验收：两个不同令牌的会话各自 `project:create` + `project:open` + 单章生成，双方列表、章节、流式事件互不串；A 打开第二本时 B 不报 `PROJECT_SESSION_STALE`；重启后数据仍在各自目录。

### 9.3 M4 步骤 3：连接归属

| 子步骤 | 内容 |
| --- | --- |
| 3.1 连接绑定用户 | `openConnection(connectionId, response, userId)` 记录归属；`pendingSenders` 同样记录创建者 |
| 3.2 连接复用校验 | `/api/invoke`、`/api/upload` 若携带的 `X-Connection-Id` 属于其他用户，返回 403 `CONNECTION_FORBIDDEN` |
| 3.3 事件归属 | 广播类事件按 `userId` 过滤；连接断开时清理该用户的事件订阅 |

验收：用户 A 的 `cid` 被 B 复用调用 invoke/upload 返回 403；A 的生成流不会出现在 B 的页面上；同一用户多标签各自 cid 仍互不干扰。

### 9.4 M5 并行配额（暂缓）

前置：§9.2 与 §9.3 完成。**本轮不改**。

- 默认配额 1：同一用户同时只运行 1 个创作任务，其余进入队列，界面显示排队位次。
- 配额来源：账户积分兑换额外并行位（`parallelSlots`），上限由配置控制。
- 调度：按 `userId` 分队列，项目内任务仍串行（同项目单写者），跨项目可并行；任务结束/取消/失败后推进队列。
- 数据：`run` 表增加 `queue_state`、`enqueued_at`；配额与积分流水放服务端账户表，不落项目库。
- 验收：默认账户第二个任务显示排队；兑换后同时运行；取消第一个任务后第二个自动开始；跨用户互不影响。

### 9.5 实施顺序

1. 2.1 → 2.2（作用域先通，后续都依赖它）
2. 2.3 → 2.4 → 2.5（会话与数据库）
3. 2.6（配置边界）
4. 3.1 → 3.2 → 3.3
5. M5 单独立项

## 10. 本地开发与生产部署

### 10.1 前置

**工作目录**：下面所有命令都在**仓库根**执行，即 `package.json` 所在的 `Pagekin` 目录。脚本里的相对路径、`.pagekin-web` 数据根、`dist-web/`、`dist-server/` 都按这个根解析；在别的目录执行会报「系统找不到指定的路径」或找不到 `package.json`。

```powershell
cd E:\e\project\shida\2026\claude-group\Pagekin
```

- **Node ≥ 22.14.0**（`package.json` 的 `engines`）。系统默认 Node 16 会在地理定位/加密初始化时报 `DOMException is not defined`；先 `nvm use 22.14.0`，或用绝对路径调用（本机 `C:\Users\dell\AppData\Roaming\nvm\v22.14.0\node64.exe`）。
- pnpm 11（`packageManager` 字段）。若 `pnpm` 启动即报 `Failed to switch pnpm to v11.11.0`，见 §10.6 的离线替代命令。
- `pnpm install`；无网络时可用 `pnpm install --ignore-scripts`，代价是 Electron 二进制不下载（`electron/**` 单测跑不了），Web 端本身不需要。
- 原生模块 `better-sqlite3`、`@lancedb/lancedb` 由 `createRequire` 在**运行目录**解析，`node_modules` 必须与 `dist-server/` 同级可寻址。

### 10.2 本地开发

一条命令启动全部（`scripts/dev-web.mjs`），在仓库根执行：

```powershell
pnpm dev:web
# pnpm 不可用时等价于：
node scripts/dev-web.mjs
```

它依次做四件事：

1. 先跑一次 `build-web-server.mjs`，失败直接退出；
2. esbuild `--watch` 监听 `web/**` 与 `electron/**`；
3. `node --watch dist-server/server.mjs`，服务端源码改动后自动重启；
4. 启动 Vite（`vite.web.config.ts`，5181，`/api` 代理到 5190）。

- 浏览器入口：<http://127.0.0.1:5181/>
- 健康检查：`curl.exe -s http://127.0.0.1:5190/api/health`

> 开发时不要直接访问 5190：它服务的是 `dist-web/` 静态产物，未构建时返回 503「Web build not found. Run `pnpm build:web` first.」

分开跑（多终端或只想重启其中一部分）：

| 命令 | 作用 |
| --- | --- |
| `pnpm dev:web:server` | 构建一次 + 前台跑网关（改服务端后需手动重启） |
| `pnpm dev:web:client` | 只起 Vite（前端热更新） |
| `pnpm build:web:server` | 只重打服务端 bundle |
| `pnpm typecheck` / `pnpm test` / `pnpm check:i18n` | 类型、单测、文案覆盖校验 |

### 10.3 生产构建

```powershell
pnpm build:web:all
```

等价于 `pnpm build:web && pnpm build:web:server`，产物两份、互不同目录：

| 产物 | 内容 |
| --- | --- |
| `dist-web/` | SPA（`vite build --config vite.web.config.ts`，`base: '/'`） |
| `dist-server/server.mjs` | 服务端单文件 bundle（esbuild，`electron` → shim，原生模块 external，附 `.map`） |

`build:web` 会 `emptyOutDir`，所以不要把它们指向同一目录。

### 10.4 生产启动

环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PAGEKIN_HOST` | `127.0.0.1` | 容器或反代前置时设 `0.0.0.0` |
| `PAGEKIN_PORT` | `5190` | 监听端口 |
| `PAGEKIN_DATA_ROOT` | `<cwd>/.pagekin-web` | 数据根，必须是持久卷；**路径要短**（项目完整路径上限 85 字符，登录用户还多 `users/<id>/projects` 两层） |
| `PAGEKIN_WEB_DIST` | `dist-web` | SPA 产物目录（相对或绝对） |
| `PAGEKIN_JWT_SECRET` | 未设 = 免登录 | 设置后 `/api/*` 全部要求 JWT（HS256），`userId` 取 `sub`/`userId` |
| `PAGEKIN_JWT_ISSUER` / `PAGEKIN_JWT_AUDIENCE` | 未设 | 可选校验，需与签发方一致 |
| `PAGEKIN_MASTER_KEY` | 自动生成 | 模型 Key 加密主密钥（任意字符串，SHA-256 派生）。**必须固定**，否则已落盘的 `models.json` 密文无法解密 |
| `PAGEKIN_RENDERER_URL` | `http://127.0.0.1:5181/` | 仅回显在 `/api/health` 与伪 `WebContents.mainFrame.url` |
| `PAGEKIN_LOCALE` | `zh-CN` | 无请求头时的默认语言 |
| `PAGEKIN_VERSION` | `1.4.0-web` | 界面显示版本号 |

PowerShell：

```powershell
$env:NODE_ENV='production'
$env:PAGEKIN_HOST='0.0.0.0'
$env:PAGEKIN_PORT='5190'
$env:PAGEKIN_DATA_ROOT='D:\pagekin-data'
$env:PAGEKIN_WEB_DIST='dist-web'
$env:PAGEKIN_JWT_SECRET='<与网关一致的 HS256 密钥>'
$env:PAGEKIN_JWT_ISSUER='smart-admin'
$env:PAGEKIN_JWT_AUDIENCE='pagekin'
$env:PAGEKIN_MASTER_KEY='<固定长随机串>'
node dist-server/server.mjs   # 或 pnpm start:web
```

Linux / 容器：

```bash
NODE_ENV=production \
PAGEKIN_HOST=0.0.0.0 PAGEKIN_PORT=5190 \
PAGEKIN_DATA_ROOT=/data PAGEKIN_WEB_DIST=/app/dist-web \
PAGEKIN_JWT_SECRET='<secret>' PAGEKIN_MASTER_KEY='<fixed-secret>' \
node dist-server/server.mjs
```

启动日志应包含：

```
[pagekin-web] listening on http://0.0.0.0:5190
[pagekin-web] data root: D:\pagekin-data
[pagekin-web] auth: jwt
```

未设 `PAGEKIN_JWT_SECRET` 时第三行为 `auth: disabled (PAGEKIN_JWT_SECRET unset)`，适合内网单机。

### 10.5 部署清单

1. **必须常驻进程**：`better-sqlite3` + LanceDB 原生模块，不能 Serverless；镜像架构需与依赖一致（`@lancedb/lancedb-win32-x64-msvc` 或对应 Linux 包）。
2. **单实例**：SQLite 写句柄、SSE 连接、项目会话都在进程内存。多实例需按 `userId` 粘性会话，且共享数据根会撞 `PROJECT_IN_USE`。
3. **反向代理**：`/api/events` 是 SSE，需关闭缓冲（Nginx `proxy_buffering off`）、`proxy_read_timeout` 大于心跳间隔、走 HTTP/1.1；`/api/download` 不要设置过小的超时。
4. **持久化**：备份整个 `PAGEKIN_DATA_ROOT`（`app-data/` 配置与密钥、`user-data/` 主密钥、`projects/` 作品、`users/<id>/` 登录用户工作区）。
5. **权限**：数据根建议 `0700`，服务进程不要用 root。
6. **升级**：替换 `dist-server/server.mjs` 与 `dist-web/` 后重启即可；不要删 `PAGEKIN_DATA_ROOT` 下的 `user-data/.pagekin-master-key`。
7. **重启副作用**：Windows 本机运行环境会把 `config.json`、`models.json`、`recent-projects.json` 等移入回收站后重建，导致重启后模型列表为空；生产 Linux 无此行为。

### 10.6 pnpm 版本切换失败时怎么办

现象（在仓库根执行）：

```
ERROR Failed to switch pnpm to v11.11.0. Looks like pnpm CLI is missing at
"C:\Users\dell\AppData\Local\pnpm\.tools\@pnpm+win-x64\11.11.0\bin"
spawnSync ... pnpm ENOENT
```

原因：`package.json` 声明了 `"packageManager": "pnpm@11.11.0"`，pnpm 10+ 启动时会尝试把自身切换/下载到该版本；离线或该 `.tools` 目录被清理时，切换失败，任何 `pnpm <script>` 都跑不起来。仓库的构建与启动脚本本身不依赖 pnpm，可直接用 Node 调用。

| pnpm 脚本 | 等价命令（仓库根执行，Node 22） |
| --- | --- |
| `pnpm dev:web` | `node scripts/dev-web.mjs` |
| `pnpm dev:web:server` | `node scripts/build-web-server.mjs` 然后 `node dist-server/server.mjs` |
| `pnpm dev:web:client` | `node node_modules/vite/bin/vite.js --config vite.web.config.ts` |
| `pnpm build:web` | `node node_modules/vite/bin/vite.js build --config vite.web.config.ts` |
| `pnpm build:web:server` | `node scripts/build-web-server.mjs` |
| `pnpm build:web:all` | 上面两条依次执行 |
| `pnpm start:web` | `node dist-server/server.mjs` |
| `pnpm typecheck` | `node node_modules/typescript/bin/tsc --noEmit` |
| `pnpm test` | `node node_modules/vitest/vitest.mjs run` |
| `pnpm check:i18n` | `node scripts/check-i18n-coverage.mjs` |

想恢复 `pnpm` 本身，任选其一（都需要能联网）：

```powershell
npm install -g pnpm@11.11.0          # 或 corepack enable; corepack prepare pnpm@11.11.0 --activate
$env:npm_config_manage_package_manager_versions='false'   # 临时不自动切版，用本机已装版本
```



