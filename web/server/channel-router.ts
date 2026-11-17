/**
 * The 220 renderer channels are all registered through `ipcMain.handle`.
 * This router turns an HTTP request into the exact same `(event, ...args)` call
 * Electron would have made, so controllers stay transport-agnostic.
 */
import { LOCAL_USER_ID } from '../../electron/services/user-scope'
import { invokeChannel, registeredChannels, runWithSender, type WebContents } from '../shims/electron'

export interface ChannelFailure {
  message: string
  channel: string
}

export function isRegistered(channel: string): boolean {
  return registeredChannels().includes(channel)
}

export async function dispatch(
  channel: string,
  args: unknown[],
  sender: WebContents,
  locale: string,
  userId: string = LOCAL_USER_ID,
): Promise<unknown> {
  if (!isRegistered(channel)) throw new Error(`IPC channel not registered: ${channel}`)
  return runWithSender(sender, locale, () => invokeChannel(channel, args, sender), userId)
}

export function describeFailure(channel: string, error: unknown): ChannelFailure {
  const message = error instanceof Error ? error.message : String(error)
  return { channel, message }
}
