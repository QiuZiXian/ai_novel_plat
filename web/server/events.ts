/**
 * Server-sent events replace Electron's `webContents.send`.
 * One browser connection = one WebContents so per-window subscribers keep working.
 *
 * Connections are owned by the user that opened them: another principal cannot
 * reuse the same `cid` to reach that sender or its uploads.
 */
import type { ServerResponse } from 'node:http'
import { LOCAL_USER_ID } from '../../electron/services/user-scope'
import { WebContents } from '../shims/electron'

interface Connection {
  sender: WebContents
  response: ServerResponse
  heartbeat: NodeJS.Timeout
  userId: string
}

const connections = new Map<string, Connection>()
/** Senders created before the event stream finished connecting (e.g. first invoke). */
const pendingSenders = new Map<string, { sender: WebContents; userId: string }>()

function writeEvent(response: ServerResponse, channel: string, args: unknown[]): void {
  response.write(`data: ${JSON.stringify({ channel, args })}\n\n`)
}

/** 返回连接（含待连接 sender）的归属用户；未知连接返回 null。 */
export function connectionOwner(connectionId: string): string | null {
  return connections.get(connectionId)?.userId ?? pendingSenders.get(connectionId)?.userId ?? null
}

export function openConnection(
  connectionId: string,
  response: ServerResponse,
  userId: string = LOCAL_USER_ID,
): WebContents {
  closeConnection(connectionId)

  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  response.write(': connected\n\n')

  const pending = pendingSenders.get(connectionId)
  const sender = pending?.sender ?? new WebContents()
  pendingSenders.delete(connectionId)
  sender.attach({
    send(channel, args) { writeEvent(response, channel, args) },
  })

  const heartbeat = setInterval(() => response.write(': ping\n\n'), 20_000)
  heartbeat.unref?.()

  const connection: Connection = { sender, response, heartbeat, userId }
  connections.set(connectionId, connection)

  const cleanup = () => {
    if (connections.get(connectionId) !== connection) return
    clearInterval(heartbeat)
    connections.delete(connectionId)
    sender.destroy()
  }
  response.on('close', cleanup)
  response.on('error', cleanup)
  return sender
}

export function closeConnection(connectionId: string): void {
  const connection = connections.get(connectionId)
  if (!connection) return
  connections.delete(connectionId)
  clearInterval(connection.heartbeat)
  connection.sender.destroy()
}

/** A request whose event stream has not opened yet keeps one stable sender. */
export function connectionSender(connectionId: string | null, userId: string = LOCAL_USER_ID): WebContents {
  if (connectionId) {
    const connection = connections.get(connectionId)
    if (connection && !connection.sender.isDestroyed()) return connection.sender
    const pending = pendingSenders.get(connectionId)
    if (pending) return pending.sender
    const created = new WebContents()
    pendingSenders.set(connectionId, { sender: created, userId })
    return created
  }
  return new WebContents()
}

export function connectionCount(): number {
  return connections.size
}
