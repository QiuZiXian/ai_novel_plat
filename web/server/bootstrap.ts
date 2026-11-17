/**
 * Web runtime bootstrap: data roots, then the same controller graph the desktop
 * main process registers. Only window/update/MCP/updater surfaces are swapped.
 */
import fs from 'node:fs'
import { installGlobalDataLocator, resolveGlobalDataRoots } from '../../electron/services/app-data-locator'
import { LOCAL_USER_ID } from '../../electron/services/user-scope'
import { registerIPCHandlers } from '../../electron/ipc-handlers'
import { installJsonFileCodec } from '../../electron/utils/config-utils'
import { createModelsSecretCodec } from './secret-codec'
import { workspaceFor } from './workspace'
import {
  registerWebDialogController,
  registerWebDownloadController,
  registerWebMCPController,
  registerWebStartupController,
  registerWebUpdateController,
} from './web-controllers'

export interface WebRuntime {
  dataRoot: string
  userDataRoot: string
  projectsRoot: string
  exportsRoot: string
  globalDataRoot: string
}

let runtime: WebRuntime | null = null

export function bootstrapWebRuntime(): WebRuntime {
  if (runtime) return runtime

  // 服务级根目录沿用本地用户工作区；登录用户的目录在首次请求时按需创建。
  const workspace = workspaceFor(LOCAL_USER_ID)
  const { dataRoot, userDataRoot, projectsRoot, exportsRoot } = workspace
  const appDataRoot = workspace.appDataRoot

  // The desktop build derives its SQLite snapshot scratch directory from
  // LOCALAPPDATA. A server must keep every write inside its data root.
  process.env.LOCALAPPDATA = workspace.scratchRoot

  const roots = resolveGlobalDataRoots(userDataRoot, appDataRoot)
  fs.mkdirSync(roots.canonicalTarget, { recursive: true, mode: 0o700 })
  installGlobalDataLocator(roots.canonicalTarget, `web-${Date.now()}`, roots.legacySource)
  installJsonFileCodec(createModelsSecretCodec())

  registerIPCHandlers()

  // Registered after the shared controllers so these override the desktop paths.
  registerWebStartupController()
  registerWebUpdateController()
  registerWebMCPController()
  registerWebDialogController()
  registerWebDownloadController()

  runtime = { dataRoot, userDataRoot, projectsRoot, exportsRoot, globalDataRoot: roots.canonicalTarget }
  return runtime
}
