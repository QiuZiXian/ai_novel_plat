# Web 版业务验证手册

面向人工验收，覆盖已完成的 **M1 运行时骨架 / M2 写作闭环 / M3 导入导出 / M4 鉴权**。
每条按「入口路径 → 操作步骤 → 预期结果 → 当前验证状态」组织。

- 验证状态三种：**浏览器已验**（真实点击过）、**探针已验**（HTTP 直连过，界面未点）、**未验证**。
- 探针脚本在 `scripts/probes/`，与界面走同一套通道、会话校验和文件授权，用来在没有浏览器或没有模型额度时兜底。
- 实施细节与根因记录见 [web-migration.md](./web-migration.md) §8.1–8.3。

---

## 0. 前置条件

### 0.1 启动（必须用 Node 22）

先在**仓库根**执行（`package.json` 所在目录，脚本相对路径都按它解析）：

```powershell
cd E:\e\project\shida\2026\claude-group\Pagekin
nvm use 22.14.0
```

系统默认 `node` 是 v16，会报 `DOMException is not defined`。若 `pnpm` 报 `Failed to switch pnpm to v11.11.0`，直接改用下面的 Node 命令（不依赖 pnpm，见 [web-migration.md](./web-migration.md) §10.6）。

**日常开发**（服务端 watch + 自动重启 + Vite 热更新，一条命令）：

```powershell
pnpm dev:web
# 或
node scripts/dev-web.mjs
```

浏览器入口 <http://127.0.0.1:5181/>（`/api` 由 Vite 代理到 5190）。

**只跑网关 / 验收构建产物**：

```powershell
node scripts/build-web-server.mjs     # 改过服务端源码必须先重建，否则跑的是旧 bundle
node node_modules/vite/bin/vite.js build --config vite.web.config.ts   # 需要 5190 直接提供页面时
node dist-server/server.mjs           # = pnpm start:web
```

健康检查：`curl.exe -s http://127.0.0.1:5190/api/health` → `{"ok":true,...}`。

完整的环境变量、生产构建与部署清单见 [web-migration.md](./web-migration.md) §10。

### 0.2 数据目录

| 内容 | 位置 |
| --- | --- |
| 全局配置 / 模型 | `.pagekin-web/app-data/ai-novel-writer/`（服务端统一） |
| 最近项目（本地用户） | `.pagekin-web/app-data/ai-novel-writer/recent-projects.json` |
| 项目（本地用户） | `.pagekin-web/projects/<项目名>/` |
| 导出暂存（本地用户） | `.pagekin-web/exports/` |
| 登录用户 | `.pagekin-web/users/<userId>/{projects,exports,uploads,downloads}/`，最近项目在同目录 `app-data/ai-novel-writer/users/<userId>/recent-projects.json` |

> 服务端退出时，运行环境会把 `config.json`、`models.json`、`recent-projects.json`、`cloud-backup-*.json`、`exports/.pe-*` 移入回收站。**功能不受影响**，重启后会按需重建，但每次重启后模型列表会变空。

### 0.3 模型

`models.json` 当前为 `[]`。生成类流程（蓝图、草稿、审稿、定稿）需要先在 **设置 → 模型** 添加一个可用的 OpenAI 兼容模型；知识库还需要一个 `purposes: ['embedding']` 的模型。

没有真实额度时用本地 mock：

```powershell
node scripts/probes/mocks/embed-mock.mjs    # 127.0.0.1:11498，返回 1536 维确定性向量
```

模型填 `baseUrl: http://127.0.0.1:11498/v1`、`purposes: ['embedding']`。

### 0.4 打开哪个项目

Web 版没有原生目录选择器，`project:open` 由服务端决定目标：**`projects/` 下最近修改的那个目录**。想验证某个项目，先在界面上打开它，或先跑任意会写该项目文件的探针。

用 `node scripts/probes/inspect-projects.mjs` 可以只读查看每个项目有多少章节/草稿/定稿，用来挑目标。

---

## 1. 探针清单

全部为 ESM 脚本，用 **Node 22** 跑 `node scripts/probes/<name>.mjs`；失败时非零退出。
可用环境变量：`PAGEKIN_BASE`（网关地址，默认 `http://127.0.0.1:5190`）、`PAGEKIN_CID`（连接标识）。

| 脚本 | 覆盖范围 | 额外前置 |
| --- | --- | --- |
| `lib/harness.mjs` | 公共工具（invoke / upload / download / openLatestProject） | — |
| `mocks/dav-mock.mjs` | 本地 WebDAV（PROPFIND / MKCOL / PUT / GET / HEAD），内存存储 | 监听 11497 |
| `mocks/embed-mock.mjs` | 本地 OpenAI 兼容 `/v1/embeddings` | 监听 11498 |
| `fixtures/make-epub.mjs` | 重新生成 `fixtures/sample.epub` | — |
| `download-targets.mjs` | 单文件下载、目录 ZIP 下载、归档导出下载 | 闸道 |
| `archive-roundtrip.mjs` | 新建项目 → 归档导出 → 下载 → 回传 → 恢复副本 | 闸道 |
| `author-import.mjs` | 作者原稿上传 → 检查 → 分章预览 | 闸道 |
| `knowledge-base.mjs` | 知识库导入 / 列表 / 检索 / 统计 / 补向量 | 闸道 + embed mock |
| `webdav-backup.mjs` | 连接 / 绑定 / 备份 / 列表 / 恢复副本 / 凭据密文 / 清凭据 | 闸道 + dav mock |
| `auth-gateway.mjs` | JWT 放行与拒绝边界 | 闸道带 `PAGEKIN_JWT_SECRET` |
| `multi-user-isolation.mjs` | 双用户工作区 / 会话 / 最近项目 / 连接归属隔离 | 闸道带 `PAGEKIN_JWT_SECRET`，浅数据根 |
| `inspect-projects.mjs` | 只读统计各项目章节数 | 不需要闸道 |
| `cleanup.mjs` | 删除探针模型、清空默认 embedding 模型 | 闸道 |

---

## 2. M1 运行时骨架

### 2.1 应用加载

- **入口**：`http://127.0.0.1:5181/`
- **步骤**：直接访问。
- **预期**：出现「书童 Pagekin」工作台，标题「今天写哪一部？」，有「新建作品」「打开作品」「导入」入口；不出现错误页或长时间停在「正在检查现有配置」。
- **状态**：浏览器已验。

### 2.2 桌面能力裁剪

- **入口**：任意页面 / 作品内舞台顶部栏。
- **步骤**：进入作品，观察窗口右上角与顶部栏。
- **预期**：**没有**最小化 / 最大化 / 关闭按钮；**没有**「检查更新」提示或悬浮按钮；不出现 MCP、单实例相关报错。
- **状态**：浏览器已验。

### 2.3 断线恢复

- **入口**：任意已打开作品的页面。
- **步骤**：停掉 5190 服务端，等 5 秒，再重启。
- **预期**：页面提示连接中断；重启后自动重连并恢复可用（SSE 按 `X-Connection-Id` 重新挂载）。
- **状态**：未验证（建议人工补一次）。

---

## 3. M2 写作闭环

> 以下都需要先在 **设置 → 模型** 配好可用的生成模型。

### 3.1 新建 / 打开作品

- **入口**：首页「新建作品」「打开作品」。
- **步骤**：「新建作品」填名称 → 确认；再回首页「打开作品」。
- **预期**：保存位置只读显示「作品库」，无需点「选择」；新建后进入作品；首页最近项目出现该项；打开后左侧显示「创作流程」「作品资料」，右侧显示「章节规划」。
- **状态**：打开作品浏览器已验；新建弹窗的保存位置已验（显示「作品库」且无目录选择按钮），创建后的完整表单流程**未逐步验证**（自动化曾生成 `测试作品` 目录）。

### 3.1.1 小说拆解与仿写（新建项目）

- **入口**：首页「导入」→「小说拆解与仿写…」。
- **步骤**：目标选「新项目」，填「新项目名称」，直接点「选择小说文件」。
- **预期**：保存位置只读显示「作品库」，无需点目录「选择」；选文件后进入拆章预览，不再报「请先填写新项目名称和保存位置」。
- **状态**：弹窗保存位置已验（显示「作品库」、无目录选择按钮）；拆章与导入流程见 4.1。

### 3.2 蓝图

- **入口**：作品内主区域「蓝图」。
- **步骤**：点「AI 生成蓝图」，等待；成功后点「批量创作」或「写第 1 章」。
- **预期**：生成进度条 → 蓝图卡片列表；「写第 1 章」进入草稿编辑器。
- **状态**：界面渲染浏览器已验；生成流程未验证（无模型）。

### 3.3 草稿 → 审稿 → 定稿

- **入口**：作品内「创作流程」。
- **步骤**：写/生成第 1 章草稿 → 触发审稿 → 采纳 → 定稿。
- **预期**：定稿后「章节规划」出现「第 1 章 已定稿」；`inspect-projects.mjs` 对应项目的 `finalized_chapters` 计数 +1。
- **状态**：探针已验（`db:*` 通道级），界面未点。

### 3.4 章节回收站

- **入口**：作品内「章节规划」→ 删除 / 回收站。
- **步骤**：删除一个定稿章节 → 打开回收站 → 恢复 → 再次删除 → 彻底删除。
- **预期**：首次删除会弹「legacy knowledge」二次确认（桌面版既有流程，需先执行 `chapter:confirm-legacy-knowledge-absent`）；恢复后章节回到列表；彻底删除后不可恢复。
- **状态**：探针已验，界面未点。

### 3.5 章节重开

- **入口**：已定稿章节 → 重开。
- **步骤**：对定稿章节执行「重开」，修改后重新定稿。
- **预期**：重开后变成草稿，原定稿保留为可恢复状态；重新定稿生成替换记录。
- **状态**：未验证。

---

## 4. M3 导入导出

### 4.1 txt / md / epub 参考资料拆解

- **入口**：首页「导入」。
- **步骤**：选择 `scripts/probes/fixtures/sample.txt`（或 `sample.md` / `sample.epub`）→ 等待检查 → 选择拆解方式 → 确认。
- **预期**：出现文件检查结果与章节预览；确认后项目内新增拆解资料。
- **探针**：`node scripts/probes/author-import.mjs`
- **状态**：探针已验（`.txt` 3 章、`classification: ready`）；epub/md 的解析在临时探针里验过，**界面未点**。

### 4.2 作者原稿导入

- **入口**：首页「导入」→ 作者原稿。
- **步骤**：选择 `fixtures/sample.txt` → 预览 → 确认导入。
- **预期**：预览列出章节号、标题、字数、`disposition: new/duplicate/conflict`；确认后按定稿章节落库。
- **探针**：`node scripts/probes/author-import.mjs`（输出 `chapterCount: 3`、`targetStatus: finalized`）
- **状态**：探针已验，界面未点。

> 探针里直接调用 `db:draft-import-finalized-batch` 会被 `FINALIZED_IMPORT_CHAPTERS_INVALID` 拒绝，正式导入要走 `db:import-run-*` 编排（`src/services/workflows/import-workflow.ts`）。

### 4.3 Markdown 导出

- **入口**：作品内舞台顶部「《项目名》作品菜单」→「导出…」。
- **步骤**：选择「合并 Markdown」或「分章 Markdown」→ 点「选择目录并导出」。
- **预期**：提示导出成功；浏览器收到 `GET /api/download/:token` 200 并保存文件（单文件 `.md`，分章为 `<目录名>.zip`）。
- **前置**：项目内必须有**定稿章节**。当前 10 个项目的 `finalized_chapters` 均为空，界面会提示「无可导出的章节（无定稿章节）」——这是正确行为，不是缺陷。
- **探针**：`node scripts/probes/download-targets.mjs`
- **状态**：下载链路探针已验（单文件 32 B、目录 ZIP 300 B、ZIP 魔数 `PK`）；**界面点击未验**（受上述前置阻塞）。

### 4.4 项目归档导出

- **入口**：作品内「设置」→「项目备份」→「导出本地存档」。
- **步骤**：点击，等待完成。
- **预期**：提示已导出；`GET /api/download/:token` 200，文件为 `<项目名>.ainovel`；回执含 `targetSha256`、`targetByteSize`、`entryCount`。
- **探针**：`node scripts/probes/download-targets.mjs`（`672210 B`、`entryCount: 4`）
- **状态**：探针已验（含下载 200 与 ZIP 魔数 `504b`）；界面按钮已定位但未点通。

### 4.5 归档恢复副本

- **入口**：作品内「设置」→「项目备份」→「从本地存档恢复副本」。
- **步骤**：选择 `.ainovel` 归档 → 确认恢复目标名 → 等待。
- **预期**：`projects/` 下出现新副本目录；可被「打开作品」打开，项目名与原项目一致；回执含 `portableDatabaseSha256`。
- **探针**：`node scripts/probes/archive-roundtrip.mjs`
- **状态**：探针已验（归档导出 → 下载 → 回传 → 恢复 → 打开全通）。

### 4.6 WebDAV 云端备份

- **入口**：作品内「设置」→「项目备份」→ 云备份区。
- **步骤**（用本地 mock 代替真实网盘）：

  ```powershell
  node scripts/probes/mocks/dav-mock.mjs
  ```

  1. 填服务地址 `http://127.0.0.1:11497/dav/`、用户名 `probe`、口令 `probe-secret` → 连接
  2. 确认绑定（勾选披露确认）
  3. 点「立即备份」→ 打开代列表 → 选一代「恢复副本」→ 清除凭据

- **预期**：连接返回账号；绑定返回 `cloudBookId`；备份 `state: backup-complete`；列表出现 1 个代；恢复副本落到 `projects/<新目录>` 且可打开；清除凭据后 `cloud-backup:view` 回到 `unconfigured`。凭据文件 `app-data/ai-novel-writer/cloud-backup-credentials.json` 中只有 `web:v1:` 密文，无明文口令。
- **探针**：`node scripts/probes/webdav-backup.mjs`
- **状态**：探针已验全链路；**界面面板未点**。

### 4.7 知识库

- **入口**：作品内「设置」→「知识库」。
- **步骤**：先在 设置 → 模型 配好 embedding 模型（或指向 11498 mock）→ 添加参考资料 → 检索。
- **预期**：文档列表出现 1 条；检索返回命中的文本块与得分；统计显示 `vectorDimension: 1536`、`hasVectors: true`；`<项目>/.ai-novel/lancedb/` 下生成 `chunks.lance`、`chunks__space_1.lance`、`documents.lance`。
- **探针**：`node scripts/probes/knowledge-base.mjs`
- **状态**：探针已验（导入 / 列表 / 检索 / 统计 / 待补向量 0 / 补向量 0）；界面未点。

### 4.8 模型密钥加密落盘

- **入口**：设置 → 模型（任意页面，不需要项目）。
- **步骤**：保存一个模型 → 关闭服务端 → 查看 `app-data/ai-novel-writer/models.json` → 重启服务端 → 回界面确认模型仍可用、`llm:list-models` 返回明文 Key。
- **预期**：磁盘上 `apiKey` 为 `web:v1:<base64>`（AES-256-GCM，主密钥来自 `PAGEKIN_MASTER_KEY` 或 `app-data/.pagekin-master-key`）；重启后能解密回明文，界面无感知。
- **探针**：`node scripts/probes/knowledge-base.mjs` 的 `llm:list-models` 输出
- **状态**：已验证（密文 + 重启回读明文）。

---

## 5. M4 鉴权与多用户隔离（步骤 1–3）

### 5.1 默认免登录

- **步骤**：不带任何 `PAGEKIN_JWT_SECRET` 启动服务端。
- **预期**：启动日志 `auth: disabled (PAGEKIN_JWT_SECRET unset)`；匿名 `POST /api/invoke/*` 返回 200；`principal.userId` 视为 `local`。
- **状态**：已验证。

### 5.2 开启 JWT

- **步骤**：

  ```powershell
  $env:PAGEKIN_JWT_SECRET='pagekin-local-verify-secret'
  node dist-server/server.mjs
  ```

  然后：

  ```powershell
  $env:PAGEKIN_JWT_SECRET='pagekin-local-verify-secret'
  node scripts/probes/auth-gateway.mjs
  ```

- **预期**：
  | 请求 | 结果 |
  | --- | --- |
  | `GET /api/health` | 200（公开） |
  | 匿名 `/api/invoke/*` | 401 `AUTH_REQUIRED` |
  | `Authorization: Bearer <有效>` | 200 |
  | Cookie `pagekin_token=<有效>` | 200 |
  | `/api/events?token=<有效>` | 200（仅事件流允许查询串） |
  | 过期令牌 | 401 `AUTH_EXPIRED` |
  | `alg: none` / 篡改签名 / 缺 `exp` 或 `sub` | 401 `AUTH_INVALID` |
  | 匿名 `/api/events`、`/api/download/*` | 401 |

- **状态**：已验证（单测 `web/server/__tests__/auth.test.ts` 10 例 + 上述实测）。

### 5.3 多用户隔离（步骤 2/3）

- **前置**：服务端带 `PAGEKIN_JWT_SECRET` 启动，且 `PAGEKIN_DATA_ROOT` 指向**较浅**的目录（项目路径上限 85 字符，`users/<id>/projects/<书名>` 会额外占位）。
- **步骤**：

  ```powershell
  $env:PAGEKIN_JWT_SECRET='probe-secret'
  $env:PAGEKIN_DATA_ROOT="$env:TEMP\pk-probe"
  $env:PAGEKIN_PORT='5191'
  node dist-server/server.mjs
  ```

  另开一个终端：

  ```powershell
  $env:PAGEKIN_DATA_ROOT="$env:TEMP\pk-probe"
  node scripts/probes/multi-user-isolation.mjs
  ```

- **预期**：
  | 检查 | 结果 |
  | --- | --- |
  | alice / bob 各自 `project:create` | 落在 `<dataRoot>/users/<id>/projects/` |
  | 先 A 后 B 打开作品 | 双方后续 `db:*` 调用都返回 200，不出现 `PROJECT_SESSION_STALE` |
  | 最近项目 | 只含自己的作品 |
  | B 复用 A 的连接号 invoke | 403 `CONNECTION_FORBIDDEN` |
  | 第二个用户打开同一项目 | `PROJECT_IN_USE`（同一 canonical 路径只允许一个写句柄） |
- **状态**：探针已验（10/10 通过）；单测 `electron/services/__tests__/multi-user-isolation.test.ts` 覆盖句柄与会话分配（本机因缺少 Electron 二进制未执行）。
- **未做**：`config.json` / `models.json` 仍是服务端统一配置；任务并行配额见 M5。

### 5.4 多实例部署

- SSE 与原生 SQLite 写句柄都在进程内存，多个实例需要按用户做粘性会话；当前单实例。
- 部署方式、环境变量、反向代理与持久化要求见 [web-migration.md](./web-migration.md) §10。生产启动为 `pnpm build:web:all` 后 `pnpm start:web`。

---

## 6. 已知环境限制

1. **含 `lancedb` 的项目无法导出归档/云备份**：返回 `PORTABLE_KNOWLEDGE_INVALID`。原因是 LanceDB 写 `_versions/*.manifest` 用「临时文件 → 硬链接 → 删临时」，本机对服务端进程的删除被拦截，`nlink` 停在 2，被 `nlink === 1` 的安全校验拒绝。这是**运行环境**问题，不是代码缺陷，且未放宽校验。验证归档/备份请用无知识库的项目。
2. **恢复目标必须是新目录**：`dialog:select-project-restore-target` 只签发不存在的新子路径；已存在会得到 `PORTABLE_RESTORE_TARGET_EXISTS`。失败的恢复会留下目标目录，重试请换名字。
3. **浏览器自动化不稳定**：本轮多次出现 `iCube command error 超时`，与 M2 记录一致；界面点击类验证建议人工执行。
4. **`/settings` 直接访问**：未打开项目时「项目备份」显示「请先打开一个项目」分支，属预期。

---

## 7. 复位

验证后清理：

```powershell
node scripts/probes/cleanup.mjs          # 删除探针模型、清空默认 embedding 模型
```

探针产生的项目（`探针归档*`、`M3归档验证`、`M3恢复副本*`、`云备份副本`、`M3知识导出`、`测试作品`）在 `.pagekin-web/projects/` 下，属于用户可见数据，**需要人工确认后再删**。
`projects/` 根目录还会残留 `.portable-project-restore-*.json`（恢复 journal），是失败恢复的正常痕迹，不影响打开项目。
