import os from 'node:os'
import path from 'node:path'
import { STORAGE_ENVIRONMENT } from '../../src/shared/project-storage'
import { currentUserId, LOCAL_USER_ID } from './user-scope'

export interface GlobalDataRoots { legacySource: string; canonicalTarget: string; userData: string }
/**
 * 设置目录（Electron userData）。打包版一直按 package.json 的 name 落在这里，与 productName 无关；
 * 显式写死，免得以后改产品名或加 productName 时把老用户切到空目录（ADR-0022）。
 */
export function resolveDefaultUserData(appData: string): string {
  return path.join(appData, 'ai-novel-writer')
}
/** Resolving names never creates a directory or reads author configuration. */
export function resolveGlobalDataRoots(userData: string, appData: string | (() => string), env: Record<string, string | undefined> = process.env, home = os.homedir()): GlobalDataRoots {
  let canonicalTarget = env[STORAGE_ENVIRONMENT.canonicalTarget]?.trim()
  if (!canonicalTarget) {
    const resolvedAppData = typeof appData === 'function' ? appData() : appData
    if (!path.isAbsolute(resolvedAppData)) throw new Error('GLOBAL_APP_DATA_PATH_REQUIRED')
    canonicalTarget = path.join(resolvedAppData, 'ai-novel-writer')
    if (path.relative(userData, canonicalTarget) === '') canonicalTarget = path.join(resolvedAppData, 'ai-novel-writer-data')
  }
  return {
    legacySource: path.resolve(env[STORAGE_ENVIRONMENT.legacySource]?.trim() || env[STORAGE_ENVIRONMENT.legacySourceCompatibility]?.trim() || path.join(home, '.vela')),
    canonicalTarget: path.resolve(canonicalTarget),
    userData: path.resolve(userData),
  }
}
// No production default can be resolved before Electron supplies appData. A NUL
// sentinel also prevents an unguarded consumer from opening a pre-admission file.
const initial = {
  legacySource: path.resolve(process.env[STORAGE_ENVIRONMENT.legacySource]?.trim() || process.env[STORAGE_ENVIRONMENT.legacySourceCompatibility]?.trim() || path.join(os.homedir(), '.vela')),
  canonicalTarget: path.join(os.homedir(), '\0ai-novel-global-data-not-ready'),
}
/** Compatibility export names; live bindings switch only after verified cutover. */
export let VELA_HOME = initial.canonicalTarget
export let GLOBAL_CONFIG_PATH = path.join(VELA_HOME, 'config.json')
export let MODELS_CONFIG_PATH = path.join(VELA_HOME, 'models.json')
export let RECENT_PROJECTS_PATH = path.join(VELA_HOME, 'recent-projects.json')
let activeGeneration: string | null = null
let activeLegacySource = initial.legacySource
export function assertGlobalDataReady(): void {
  if (!activeGeneration) throw new Error('GLOBAL_DATA_NOT_READY')
}
export function getGlobalDataRoot(): string { assertGlobalDataReady(); return VELA_HOME }

function safeUserSegment(userId: string): string {
  const cleaned = userId.trim().replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96)
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'user'
}

/**
 * 最近项目按用户分开：桌面/本地用户仍是全局根下的一个文件，
 * Web 登录用户放在 `users/<id>/`，避免互相看到对方的书架。
 */
export function currentRecentProjectsPath(): string {
  assertGlobalDataReady()
  const userId = currentUserId()
  if (userId === LOCAL_USER_ID) return RECENT_PROJECTS_PATH
  return path.join(VELA_HOME, 'users', safeUserSegment(userId), 'recent-projects.json')
}
/** Called exclusively by the successful startup migration coordinator. */
export function installGlobalDataLocator(dataRoot: string, generation: string, legacySource: string): void {
  if (activeGeneration && (activeGeneration !== generation || VELA_HOME !== dataRoot)) throw new Error('GLOBAL_DATA_ALREADY_ACTIVE')
  VELA_HOME = dataRoot
  GLOBAL_CONFIG_PATH = path.join(dataRoot, 'config.json')
  MODELS_CONFIG_PATH = path.join(dataRoot, 'models.json')
  RECENT_PROJECTS_PATH = path.join(dataRoot, 'recent-projects.json')
  activeGeneration = generation
  activeLegacySource = path.resolve(legacySource)
}
export function assertGlobalPathAccess(filePath: string): void {
  const absolute = path.resolve(filePath)
  const inside = (root: string) => { const relative = path.relative(root, absolute); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)) }
  if (inside(initial.legacySource) || inside(activeLegacySource)) throw new Error('LEGACY_GLOBAL_SOURCE_READ_ONLY')
  if (inside(initial.canonicalTarget) || inside(VELA_HOME)) assertGlobalDataReady()
}
