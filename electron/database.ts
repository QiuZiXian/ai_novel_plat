/**
 * Vela SQLite 数据库服务 — 主进程使用
 *
 * 负责 SQLite 实例的连接、生命周期与建表。
 * 具体业务逻辑由 /repositories 提供。
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { initializeLegacyBaselineSchema } from './migrations/baseline-schema'
import { CURRENT_DESKTOP_SCHEMA_VERSION, getDesktopMigrationRegistry } from './migrations/desktop-registry'
import { SchemaMigrationError } from './migrations/registry'
import { migrateSchema } from './migrations/runner'
import { SqliteSchemaAdapter } from './migrations/sqlite-schema-adapter'
import { openCanonicalProjectData, deactivateProjectData, getNewProjectDatabasePath, getProjectDatabasePath } from './services/project-data-locator'
import { readSqliteContentIdentity } from './services/sqlite-project-migration'
import { currentUserId } from './services/user-scope'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')
import type BetterSqlite3 from 'better-sqlite3'

interface OpenProjectDatabase {
  projectPath: string
  database: BetterSqlite3.Database
  /** 持有写句柄的用户；同一项目同时只允许一个。 */
  owner: string
}

/** 每个项目一个写句柄：多用户各开一本时互不覆盖。 */
const openDatabases = new Map<string, OpenProjectDatabase>()
/** 每个用户当前活动的项目（桌面即 `local`）。 */
const activeProjectByUser = new Map<string, string>()

function projectDatabaseKey(projectPath: string): string {
  const resolved = path.resolve(projectPath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** 初始化项目数据库（打开项目时调用） */
export function createProjectDatabase(projectPath: string, importSourceSecret?: Buffer): void {
  const file = getNewProjectDatabasePath(projectPath)
  const fd = fs.openSync(file, 'wx', 0o600); fs.closeSync(fd)
  const database = new Database(file, { fileMustExist: true })
  try {
    database.pragma('foreign_keys = ON')
    database.transaction(() => initializeLegacyBaselineSchema(database, importSourceSecret))()
    migrateSchema(new SqliteSchemaAdapter(database), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION)
  } finally { database.close() }
}

/** Existing projects are verified before acquiring a writable handle or fencing. */
export function initProjectDatabase(projectPath: string): void {
  const userId = currentUserId()
  const key = projectDatabaseKey(projectPath)
  const existing = openDatabases.get(key)
  if (existing) {
    // 同一项目已有写句柄：只有持有者能重新激活，别人打开会被拒绝。
    if (existing.owner !== userId) throw new Error('PROJECT_IN_USE')
    activeProjectByUser.set(userId, existing.projectPath)
    return
  }
  // 同一用户切换项目时先关掉自己的旧句柄；其他用户的项目不受影响。
  closeProjectDatabase()
  let database: BetterSqlite3.Database | undefined
  try {
    const verified = openCanonicalProjectData(projectPath)
    const databasePath = getProjectDatabasePath(projectPath)
    database = new Database(databasePath, { fileMustExist: true })
    // Compare before any statement: an unused handle has not opened the WAL, so closing it on refusal cannot checkpoint.
    const content = readSqliteContentIdentity(databasePath)
    if (content.database !== verified.database || content.wal !== verified.wal) {
      throw new SchemaMigrationError('SOURCE_CHANGED_SINCE_PROBE')
    }
    database.pragma('journal_mode = WAL')
    database.pragma('foreign_keys = ON')
    fenceProjectSession(database)
    openDatabases.set(key, { projectPath, database: database!, owner: userId })
    activeProjectByUser.set(userId, projectPath)
  } catch (error) {
    database?.close(); deactivateProjectData(projectPath); throw error
  }
}

export interface ProjectDatabaseBeforeCloseContext { projectPath: string; database: BetterSqlite3.Database }
const beforeCloseListeners = new Set<(context: ProjectDatabaseBeforeCloseContext) => void>()
let notifyingBeforeClose = false
/** Main owners must synchronously persist pause/cancel and stop new dispatch.
 * Async work must be awaited by their own outer lifecycle before asking to close.
 */
export function onProjectDatabaseBeforeClose(listener: (context: ProjectDatabaseBeforeCloseContext) => void): () => void {
  beforeCloseListeners.add(listener)
  return () => { beforeCloseListeners.delete(listener) }
}

/** 关闭当前用户的项目数据库；其他用户打开的项目保持不动。 */
export function closeProjectDatabase(): void {
  if (notifyingBeforeClose) throw new Error('PROJECT_DATABASE_CLOSE_REENTRANT')
  const userId = currentUserId()
  const activePath = activeProjectByUser.get(userId)
  if (!activePath) return
  activeProjectByUser.delete(userId)
  const key = projectDatabaseKey(activePath)
  const closing = openDatabases.get(key)
  if (!closing) return
  notifyingBeforeClose = true
  try {
    for (const listener of beforeCloseListeners) {
      const result: unknown = listener({ projectPath: closing.projectPath, database: closing.database })
      if (result && typeof (result as { then?: unknown }).then === 'function') {
        void Promise.resolve(result).catch(() => {})
        throw new Error('PROJECT_DATABASE_BEFORE_CLOSE_MUST_BE_SYNCHRONOUS')
      }
    }
  } finally { notifyingBeforeClose = false }
  // Fail closed: forget the handle before closing so a throwing close cannot
  // leave a half-closed database registered as active.
  openDatabases.delete(key)
  deactivateProjectData(closing.projectPath)
  closing.database.close()
}

/** 获取当前用户的活动数据库实例 */
export function getProjectDb(): BetterSqlite3.Database | null {
  const activePath = activeProjectByUser.get(currentUserId())
  if (!activePath) return null
  return openDatabases.get(projectDatabaseKey(activePath))?.database ?? null
}

/** 获取当前用户的活动项目路径 */
export function getCurrentProjectPath(): string | null {
  return activeProjectByUser.get(currentUserId()) ?? null
}

/** 项目是否已被其他用户持有写句柄。 */
export function isProjectHeldByAnotherUser(projectPath: string): boolean {
  const entry = openDatabases.get(projectDatabaseKey(projectPath))
  return Boolean(entry && entry.owner !== currentUserId())
}

/** Session ownership changes are separate from schema migration. */
export function fenceProjectSession(db: BetterSqlite3.Database): void {
  db.exec(`
    UPDATE import_runs
    SET execution_owner = '', execution_epoch = execution_epoch + 1, lease_expires_at = 0,
        updated_at = datetime('now')
    WHERE status = 'running' AND (execution_owner <> '' OR lease_expires_at <> 0)
  `)

}
