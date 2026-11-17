/**
 * Request-scoped user identity.
 *
 * Desktop runs as a single local user. The web server sets the JWT subject for
 * each request so project leases, database handles and workspace folders can be
 * resolved per user without threading `userId` through every controller.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

export const LOCAL_USER_ID = 'local'

const storage = new AsyncLocalStorage<string>()

/** 当前请求（或由它派生的后台任务）所属用户。 */
export function currentUserId(): string {
  return storage.getStore() ?? LOCAL_USER_ID
}

/** 在指定用户作用域内执行；本地用户不额外建立作用域，保持桌面行为不变。 */
export function runWithUserId<T>(userId: string | null | undefined, callback: () => T): T {
  const resolved = userId?.trim()
  if (!resolved || resolved === LOCAL_USER_ID) return callback()
  return storage.run(resolved, callback)
}
