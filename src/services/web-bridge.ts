/**
 * Browser implementation of the desktop bridge (`window.aiNovelAPI`).
 *
 * The renderer is written against a single Electron preload object. In the web
 * build this object is produced from HTTP + SSE, so no component or store needs
 * to know which runtime it runs in.
 */
import type { AiNovelAPI } from '../shared/desktop-api'

const CONNECTION_STORAGE_KEY = 'pagekin.web.connectionId'
const ZOOM_STORAGE_KEY = 'pagekin.web.zoomFactor'
const BASE_FONT_SIZE = 14

type EventListener = (...args: unknown[]) => void

interface ServerMessage {
  channel: string
  args: unknown[]
}

interface UploadPicker {
  purpose: string
  accept: string
  multiple: boolean
  directory?: boolean
}

/**
 * Native pickers become browser pickers plus an upload. The server stores the
 * bytes and the dialog handler grants access to that copy, so the rest of the
 * renderer keeps calling the same channels.
 */
const UPLOAD_DIALOGS: Record<string, UploadPicker | ((args: unknown[]) => UploadPicker)> = {
  'dialog:select-knowledge-files': { purpose: 'knowledge-files', accept: '.txt,.md,.markdown', multiple: true },
  'dialog:select-knowledge-folder': { purpose: 'knowledge-folder', accept: '', multiple: true, directory: true },
  'dialog:select-project-archive': { purpose: 'project-archive', accept: '.ainovel', multiple: false },
  // Novel import splits the pending uploads by purpose so a reference selection
  // never leaks into an author-manuscript run.
  'dialog:select-novel-files': (args) => {
    const request = args[0]
    const purpose = typeof request === 'string'
      ? request
      : (request && typeof request === 'object' && typeof (request as { purpose?: unknown }).purpose === 'string'
        ? (request as { purpose: string }).purpose
        : 'reference')
    return { purpose: `novel-files:${purpose}`, accept: '.txt,.md,.markdown,.epub', multiple: true }
  },
}

function resolveUploadPicker(channel: string, args: unknown[]): UploadPicker | null {
  const entry = UPLOAD_DIALOGS[channel]
  if (!entry) return null
  return typeof entry === 'function' ? entry(args) : entry
}

function pickFiles(picker: UploadPicker): Promise<File[]> {
  return new Promise(resolve => {
    const input = document.createElement('input')
    input.type = 'file'
    if (picker.accept) input.accept = picker.accept
    input.multiple = picker.multiple
    if (picker.directory) {
      input.setAttribute('webkitdirectory', '')
      input.setAttribute('directory', '')
    }
    input.style.display = 'none'
    document.body.appendChild(input)
    const finish = (files: File[]) => {
      input.remove()
      resolve(files)
    }
    input.addEventListener('change', () => finish(Array.from(input.files ?? [])))
    input.addEventListener('cancel', () => finish([]))
    input.click()
  })
}

async function uploadFile(file: File, picker: UploadPicker, id: string): Promise<void> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    'X-Connection-Id': id,
    'X-File-Name': encodeURIComponent(file.name),
  }
  if (file.webkitRelativePath) headers['X-File-Relative-Path'] = encodeURIComponent(file.webkitRelativePath)
  const response = await fetch(`/api/upload?purpose=${encodeURIComponent(picker.purpose)}`, {
    method: 'POST',
    headers,
    body: file,
  })
  if (!response.ok) throw new Error(`UPLOAD_FAILED ${response.status}`)
}

function connectionId(): string {
  const existing = sessionStorage.getItem(CONNECTION_STORAGE_KEY)
  if (existing) return existing
  const created = crypto.randomUUID()
  sessionStorage.setItem(CONNECTION_STORAGE_KEY, created)
  return created
}

/** Installs the bridge once; an existing Electron preload always wins. */
export function installWebBridge(): void {
  if (typeof window === 'undefined' || window.aiNovelAPI) return

  const id = connectionId()
  const listeners = new Map<string, Set<EventListener>>()
  let stream: EventSource | null = null

  const emit = (message: ServerMessage) => {
    for (const listener of listeners.get(message.channel) ?? []) {
      try { listener(...message.args) } catch (error) { console.error('[web-bridge] listener failed', message.channel, error) }
    }
  }

  const connect = () => {
    if (stream) return
    stream = new EventSource(`/api/events?cid=${encodeURIComponent(id)}`)
    stream.onmessage = (event: MessageEvent<string>) => {
      try { emit(JSON.parse(event.data) as ServerMessage) } catch { /* ignore malformed frames */ }
    }
    stream.onerror = () => {
      // EventSource retries on its own; keep the reference so we do not stack streams.
      if (stream?.readyState === EventSource.CLOSED) {
        stream = null
        window.setTimeout(connect, 1_000)
      }
    }
  }
  connect()

  const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
    const picker = resolveUploadPicker(channel, args)
    if (picker) {
      const files = await pickFiles(picker)
      if (files.length === 0) return null
      for (const file of files) await uploadFile(file, picker, id)
    }
    const response = await fetch(`/api/invoke/${encodeURIComponent(channel)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Connection-Id': id,
      },
      body: JSON.stringify({ args }),
    })
    const body = await response.json().catch(() => null) as
      | { ok: true; value: unknown }
      | { ok: false; error?: { message?: string } }
      | null
    if (!body) throw new Error(`IPC ${channel} failed with status ${response.status}`)
    if (body.ok) return body.value
    throw new Error(body.error?.message ?? `IPC ${channel} failed with status ${response.status}`)
  }

  const on = (channel: string, listener: EventListener): (() => void) => {
    const bucket = listeners.get(channel) ?? new Set<EventListener>()
    bucket.add(listener)
    listeners.set(channel, bucket)
    return () => {
      const current = listeners.get(channel)
      if (!current) return
      current.delete(listener)
      if (current.size === 0) listeners.delete(channel)
    }
  }

  const applyZoom = (factor: number) => {
    document.documentElement.style.fontSize = `${(BASE_FONT_SIZE * factor).toFixed(2)}px`
    try { localStorage.setItem(ZOOM_STORAGE_KEY, String(factor)) } catch { /* zoom is a preference */ }
  }

  const readZoom = (): number => {
    const stored = Number(localStorage.getItem(ZOOM_STORAGE_KEY))
    return Number.isFinite(stored) && stored > 0 ? stored : 1
  }

  const api: AiNovelAPI = {
    runtime: 'web',
    invoke,
    on,
    once: (channel, listener) => {
      const off = on(channel, (...args) => { off(); listener(...args) })
    },
    send: (channel, ...args) => {
      void invoke(channel, ...args).catch(error => console.warn('[web-bridge] send failed', channel, error))
    },
    setZoomLevel: () => undefined,
    setZoomFactor: applyZoom,
    getZoomLevel: () => 0,
  }

  window.aiNovelAPI = api
  applyZoom(readZoom())
}
