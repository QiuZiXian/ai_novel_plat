/**
 * Web-only replacements for surfaces that cannot exist on a server:
 * native folder/file pickers, the desktop updater, MCP stdio and startup trust checks.
 * Registered after the shared controllers so they override the desktop paths.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { ipcMain, webDataRoot, type WebInvokeEvent } from '../shims/electron'
import { externalFileGrants } from '../../electron/services/external-file-grant-service'
import { importInspectionStore } from '../../electron/services/import-inspection-store'
import { createNovelImportInspector } from '../../electron/controllers/import-controller'
import { takeUploads, registerDownload, uploadBatchRoot, type StoredUpload } from './uploads'
import { workspaceFor } from './workspace'
import { writeDirectoryZip } from './zip-store-only'
import type { ExternalFileGrant, ProjectSessionContext } from '../../src/shared/ipc-channels'
import type { ImportNovelFileSelectionRequest, ImportPurpose } from '../../src/shared/import-run'
import type { StartupState } from '../../src/shared/startup-contract'
import type { UpdateActionResponse, UpdateCheckResponse, UpdateState } from '../../src/shared/update-types'

export const WEB_GLOBAL_GENERATION = `web-${Date.now()}`

const SELECTION_GRANT_TTL_MS = 10 * 60 * 1_000
const EXPORT_GRANT_MAX_USES = 4096

/**
 * grantId → the folder/file this connection is allowed to download after the
 * export finished. Only grants minted by this module are registered, so the
 * recorded path is always server-controlled.
 */
const downloadTargets = new Map<string, { senderId: number; targetPath: string }>()

function rememberDownloadTarget(event: WebInvokeEvent, grantId: string, targetPath: string): void {
  downloadTargets.set(grantId, { senderId: event.sender.id, targetPath })
  event.sender.once('destroyed', () => downloadTargets.delete(grantId))
}

function revokeWhenSenderIsDestroyed(event: WebInvokeEvent, grantId: string): void {
  event.sender.once('destroyed', () => externalFileGrants.revoke(grantId))
}

function issueDirectoryGrant(
  event: WebInvokeEvent,
  directoryPath: string,
  operations: Array<'read' | 'list' | 'write' | 'create' | 'project-create' | 'project-open'>,
  maxUses?: number,
) {
  const grant = externalFileGrants.issueDirectory({
    webContentsId: event.sender.id,
    directoryPath,
    operations,
    ttlMs: SELECTION_GRANT_TTL_MS,
    maxUses,
  })
  revokeWhenSenderIsDestroyed(event, grant.grantId)
  return { grantId: grant.grantId, displayName: path.basename(directoryPath) }
}

function issueFileGrant(event: WebInvokeEvent, filePath: string): ExternalFileGrant {
  const grant = externalFileGrants.issueFile({
    webContentsId: event.sender.id,
    filePath,
    operations: ['read'],
    ttlMs: SELECTION_GRANT_TTL_MS,
    maxUses: 1,
  })
  revokeWhenSenderIsDestroyed(event, grant.grantId)
  return { grantId: grant.grantId, displayName: path.basename(filePath) }
}

function latestProjectDirectory(projectsRoot: string): string | null {
  try {
    const entries = fs.readdirSync(projectsRoot, { withFileTypes: true }).filter(entry => entry.isDirectory())
    const sorted = entries
      .map(entry => path.join(projectsRoot, entry.name))
      .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)
    return sorted[0] ?? null
  } catch {
    return null
  }
}

function safeSuggestedName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const safe = Array.from(value.trim(), character => (
    character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character) ? '-' : character
  )).join('')
    .replace(/[. ]+$/g, '')
    .slice(0, 80)
  return safe || fallback
}

function availableChild(parent: string, suggestedName: unknown, fallback: string, extension = ''): string {
  const base = path.join(parent, `${safeSuggestedName(suggestedName, fallback)}${extension}`)
  if (!fs.existsSync(base)) return base
  for (let suffix = 2; suffix <= 999; suffix += 1) {
    const candidate = `${base.slice(0, -extension.length || undefined)}-${suffix}${extension}`
    if (!fs.existsSync(candidate)) return candidate
  }
  throw new Error('WEB_TARGET_EXISTS')
}

function uploadsFor(event: WebInvokeEvent, purpose: string): StoredUpload[] {
  return takeUploads(event.sender.id, purpose)
}

export function registerWebDialogController(): void {
  ipcMain.handle('dialog:select-folder', async (event, purposeRaw) => {
    const workspace = workspaceFor()
    const purpose = purposeRaw
    if (purpose !== 'project-create' && purpose !== 'project-open') {
      throw new Error('PROJECT_DIRECTORY_GRANT_PURPOSE_INVALID')
    }
    if (purpose === 'project-create') {
      fs.mkdirSync(workspace.projectsRoot, { recursive: true })
      return issueDirectoryGrant(event, workspace.projectsRoot, [purpose])
    }
    const latest = latestProjectDirectory(workspace.projectsRoot)
    return latest ? issueDirectoryGrant(event, latest, [purpose]) : null
  })

  // Browser pickers cannot hand a server an arbitrary path, so the renderer
  // uploads the bytes first and these handlers grant access to the stored copy.
  ipcMain.handle('dialog:select-knowledge-files', async (event): Promise<ExternalFileGrant[] | null> => {
    const uploads = uploadsFor(event, 'knowledge-files')
    if (uploads.length === 0) return null
    return uploads.map(upload => issueFileGrant(event, upload.absolutePath))
  })

  ipcMain.handle('dialog:select-knowledge-folder', async (event) => {
    const uploads = uploadsFor(event, 'knowledge-folder')
    if (uploads.length === 0) return null
    const root = uploadBatchRoot(workspaceFor().uploadsRoot, event.sender.id, 'knowledge-folder')
    if (!fs.existsSync(root)) return null
    const grant = issueDirectoryGrant(event, root, ['read', 'list'], EXPORT_GRANT_MAX_USES)
    // 浏览器目录选择器会带上相对路径，首段就是用户选中的目录名。
    const topLevel = uploads[0]?.relativePath.split(path.sep).filter(Boolean)[0]
    return topLevel && topLevel !== path.basename(root)
      ? { ...grant, displayName: topLevel }
      : grant
  })

  ipcMain.handle('dialog:select-project-archive', async (event): Promise<ExternalFileGrant | null> => {
    const uploads = uploadsFor(event, 'project-archive')
    const archive = uploads.find(upload => upload.displayName.toLowerCase().endsWith('.ainovel'))
    return archive ? issueFileGrant(event, archive.absolutePath) : null
  })

  ipcMain.handle('dialog:select-project-archive-export', async (event, suggestedName): Promise<ExternalFileGrant | null> => {
    const workspace = workspaceFor()
    fs.mkdirSync(workspace.exportsRoot, { recursive: true })
    const target = availableChild(workspace.exportsRoot, suggestedName, 'project-backup', '.ainovel')
    const grant = externalFileGrants.issueNewChild({
      webContentsId: event.sender.id,
      filePath: target,
      operations: ['create'],
      ttlMs: SELECTION_GRANT_TTL_MS,
      maxUses: 1,
    })
    revokeWhenSenderIsDestroyed(event, grant.grantId)
    rememberDownloadTarget(event, grant.grantId, target)
    return { grantId: grant.grantId, displayName: path.basename(target) }
  })

  ipcMain.handle('dialog:select-project-restore-target', async (event, suggestedName): Promise<ExternalFileGrant | null> => {
    const workspace = workspaceFor()
    fs.mkdirSync(workspace.projectsRoot, { recursive: true })
    const target = availableChild(workspace.projectsRoot, suggestedName, 'restored-project')
    const grant = externalFileGrants.issueNewChild({
      webContentsId: event.sender.id,
      filePath: target,
      operations: ['create'],
      ttlMs: SELECTION_GRANT_TTL_MS,
      maxUses: 1,
    })
    revokeWhenSenderIsDestroyed(event, grant.grantId)
    return { grantId: grant.grantId, displayName: path.basename(target) }
  })

  ipcMain.handle('dialog:select-export-directory', async (event) => {
    const directory = path.join(workspaceFor().exportsRoot, randomUUID())
    fs.mkdirSync(directory, { recursive: true })
    const grant = issueDirectoryGrant(event, directory, ['write', 'create'], EXPORT_GRANT_MAX_USES)
    rememberDownloadTarget(event, grant.grantId, directory)
    return { ...grant, displayName: '导出' }
  })

  // Novel import: the browser uploads the picked files first, then the desktop
  // inspection pipeline runs against the stored copies.
  const novelImportInspector = createNovelImportInspector()
  ipcMain.handle('dialog:select-novel-files', async (event, request, projectSession) => {
    const structuredRequest = typeof request === 'object' && request !== null
      ? request as ImportNovelFileSelectionRequest
      : undefined
    const purpose: ImportPurpose = typeof request === 'string'
      ? request as ImportPurpose
      : (structuredRequest?.purpose ?? 'reference')
    event.sender.once('destroyed', () => {
      externalFileGrants.revokeWebContents(event.sender.id)
      importInspectionStore.revokeForWebContents(event.sender.id)
    })
    const uploads = takeUploads(event.sender.id, `novel-files:${purpose}`)
    if (uploads.length === 0) return null
    return novelImportInspector.inspect(
      event,
      uploads.map(upload => upload.absolutePath),
      request as ImportPurpose | ImportNovelFileSelectionRequest,
      projectSession as ProjectSessionContext | undefined,
    )
  })
  ipcMain.handle('dialog:select-legacy-project', async () => null)
}

/**
 * Turns an export grant into a `GET /api/download/:token` token.
 *
 * A single-file export downloads as-is. Directory exports stay a folder on the
 * server, so they are packed into a store-only ZIP on demand.
 */
export function registerWebDownloadController(): void {
  ipcMain.handle('web:request-download', async (event, grantId) => {
    const target = typeof grantId === 'string' ? downloadTargets.get(grantId) : undefined
    if (!target || target.senderId !== event.sender.id) {
      return { success: false as const, error: 'DOWNLOAD_GRANT_NOT_FOUND' }
    }
    try {
      const stat = fs.statSync(target.targetPath)
      if (stat.isFile()) {
        const token = registerDownload(target.targetPath, path.basename(target.targetPath))
        return { success: true as const, token, name: path.basename(target.targetPath) }
      }
      const children = fs.readdirSync(target.targetPath, { withFileTypes: true })
      const files = children.filter(entry => entry.isFile())
      const directories = children.filter(entry => entry.isDirectory())
      if (files.length === 1 && directories.length === 0) {
        const filePath = path.join(target.targetPath, files[0].name)
        const token = registerDownload(filePath, files[0].name)
        return { success: true as const, token, name: files[0].name }
      }
      const downloadRoot = workspaceFor().downloadsRoot
      fs.mkdirSync(downloadRoot, { recursive: true })
      const zipPath = path.join(downloadRoot, `${randomUUID()}.zip`)
      if (files.length === 0 && directories.length === 1) {
        const name = `${directories[0].name}.zip`
        writeDirectoryZip(path.join(target.targetPath, directories[0].name), zipPath, directories[0].name)
        const token = registerDownload(zipPath, name)
        return { success: true as const, token, name }
      }
      writeDirectoryZip(target.targetPath, zipPath)
      const token = registerDownload(zipPath, 'export.zip')
      return { success: true as const, token, name: 'export.zip' }
    } catch (error) {
      return { success: false as const, error: (error as Error).message }
    }
  })
}

export function registerWebStartupController(): void {
  ipcMain.handle('startup:get-state', (): StartupState => ({
    state: 'ready',
    globalGeneration: WEB_GLOBAL_GENERATION,
  }))
  ipcMain.handle('startup:appearance-ack', () => true)
}

/**
 * MCP servers are launched as local child processes on the desktop. A browser
 * session cannot spawn them, so the channels exist but report themselves off.
 */
export function registerWebMCPController(): void {
  const disabled = { success: false as const, error: 'MCP_DISABLED_IN_WEB' }
  ipcMain.handle('mcp:load-config', () => ({ success: true as const, status: 'missing' as const, servers: [] }))
  ipcMain.handle('mcp:connect', () => disabled)
  ipcMain.handle('mcp:disconnect', () => disabled)
  ipcMain.handle('mcp:disconnect-all', () => ({ success: true }))
  ipcMain.handle('mcp:list-tools', () => [])
  ipcMain.handle('mcp:list-resources', () => [])
  ipcMain.handle('mcp:call-tool', () => ({ ...disabled, content: '' }))
  ipcMain.handle('mcp:get-servers-status', () => [])
  ipcMain.handle('mcp:get-config-path', () => path.join(webDataRoot(), 'mcp_config.json'))
}

const updateState: UpdateState = {
  status: 'disabled',
  currentVersion: process.env.PAGEKIN_VERSION?.trim() || '1.4.0-web',
  isReminderDeferred: false,
}

export function registerWebUpdateController(): void {
  ipcMain.handle('update:get-state', (): UpdateState => updateState)
  ipcMain.handle('update:check', (): UpdateCheckResponse => ({
    success: false,
    checked: false,
    updateAvailable: false,
    state: updateState,
  }))
  ipcMain.handle('update:download', (): UpdateActionResponse => ({ success: false, state: updateState }))
  ipcMain.handle('update:open-release', (): UpdateActionResponse => ({ success: false, state: updateState }))
  ipcMain.handle('update:defer-reminder', (): UpdateActionResponse => ({ success: true, state: updateState }))
  ipcMain.handle('update:quit-and-install', (): UpdateActionResponse => ({ success: false, state: updateState }))
}
