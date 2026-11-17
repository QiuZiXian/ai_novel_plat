/**
 * Per-user folders on the server.
 *
 * `local` keeps the historic single-root layout so desktop and single-user web
 * deployments see exactly the same files as before. Authenticated users get
 * their own subtree, created on first use.
 */
import fs from 'node:fs'
import path from 'node:path'
import { currentUserId, LOCAL_USER_ID } from '../../electron/services/user-scope'
import { webDataRoot } from '../shims/electron'

export interface UserWorkspace {
  userId: string
  /** Root of everything this user owns. */
  dataRoot: string
  userDataRoot: string
  appDataRoot: string
  projectsRoot: string
  exportsRoot: string
  scratchRoot: string
  uploadsRoot: string
  downloadsRoot: string
}

const workspaceCache = new Map<string, UserWorkspace>()

function safeUserSegment(userId: string): string {
  const cleaned = userId.trim().replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96)
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'user'
}

export function workspaceFor(userId: string = currentUserId()): UserWorkspace {
  const cached = workspaceCache.get(userId)
  if (cached) return cached

  const serverRoot = path.resolve(webDataRoot())
  const dataRoot = userId === LOCAL_USER_ID ? serverRoot : path.join(serverRoot, 'users', safeUserSegment(userId))
  const workspace: UserWorkspace = {
    userId,
    dataRoot,
    userDataRoot: path.join(dataRoot, 'user-data'),
    appDataRoot: path.join(dataRoot, 'app-data'),
    projectsRoot: path.join(dataRoot, 'projects'),
    exportsRoot: path.join(dataRoot, 'exports'),
    scratchRoot: path.join(dataRoot, 'local-appdata'),
    uploadsRoot: path.join(dataRoot, 'uploads'),
    downloadsRoot: path.join(dataRoot, 'downloads'),
  }
  for (const directory of [
    workspace.userDataRoot,
    workspace.appDataRoot,
    workspace.projectsRoot,
    workspace.exportsRoot,
    workspace.scratchRoot,
    workspace.uploadsRoot,
    workspace.downloadsRoot,
  ]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  }
  workspaceCache.set(userId, workspace)
  return workspace
}
