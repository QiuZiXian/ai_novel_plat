/**
 * Web runtime replacement for the Electron module.
 *
 * The bundler aliases `electron` to this file so that the existing controllers
 * and services (which were written against Electron) run unchanged on a Node
 * server. Only the runtime surface actually imported by `electron/**` is
 * implemented here; anything else fails loudly instead of silently degrading.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { LOCAL_USER_ID, runWithUserId } from '../../electron/services/user-scope'

export interface WebEventSink {
  send(channel: string, args: unknown[]): void
}

export interface WebRequestContext {
  sender: WebContents
  locale: string
  userId: string
}

const requestContext = new AsyncLocalStorage<WebRequestContext>()
let senderSequence = 0
const senders = new Map<number, WebContents>()

export function webDataRoot(): string {
  return process.env.PAGEKIN_DATA_ROOT?.trim() || path.join(process.cwd(), '.pagekin-web')
}

export function webRendererUrl(): string {
  return process.env.PAGEKIN_RENDERER_URL?.trim() || 'http://127.0.0.1:5181/'
}

export function runWithSender<T>(
  sender: WebContents,
  locale: string,
  callback: () => T,
  userId: string = LOCAL_USER_ID,
): T {
  return requestContext.run({ sender, locale, userId }, () => runWithUserId(userId, callback))
}

export function currentSender(): WebContents | null {
  return requestContext.getStore()?.sender ?? null
}

/** A renderer connection: one browser tab using the SSE stream. */
export class WebContents {
  readonly id: number
  readonly mainFrame = { url: webRendererUrl() }
  private sink: WebEventSink | null
  private destroyed = false
  private readonly destroyedListeners: Array<() => void> = []

  constructor(sink?: WebEventSink) {
    this.id = ++senderSequence
    this.sink = sink ?? null
    senders.set(this.id, this)
  }

  attach(sink: WebEventSink): void {
    this.sink = sink
  }

  send(channel: string, ...args: unknown[]): void {
    if (this.destroyed) return
    this.sink?.send(channel, args)
  }

  isDestroyed(): boolean { return this.destroyed }
  isLoadingMainFrame(): boolean { return false }
  isLoading(): boolean { return false }
  reload(): void {}
  focus(): void {}

  once(event: 'destroyed', listener: () => void): this {
    if (event === 'destroyed') this.destroyedListeners.push(listener)
    return this
  }

  on(_event: string, _listener: (...args: unknown[]) => void): this { return this }
  removeListener(): this { return this }
  removeAllListeners(): this { return this }
  setZoomFactor(): void {}
  getZoomFactor(): number { return 1 }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.sink = null
    senders.delete(this.id)
    for (const listener of this.destroyedListeners.splice(0)) {
      try { listener() } catch { /* A closed connection must not break teardown. */ }
    }
  }
}

export function createSender(): WebContents {
  return new WebContents()
}

/** Channels registered through ipcMain.handle, in registration order. */
const handlers = new Map<string, (event: WebInvokeEvent, ...args: unknown[]) => unknown>()
const listeners = new Map<string, Array<(event: WebInvokeEvent, ...args: unknown[]) => void>>()

export interface WebInvokeEvent {
  sender: WebContents
  senderFrame: { url: string }
}

export function invokeChannel(channel: string, args: unknown[], sender: WebContents): Promise<unknown> {
  const handler = handlers.get(channel)
  if (!handler) return Promise.reject(new Error(`IPC channel not registered: ${channel}`))
  const event: WebInvokeEvent = { sender, senderFrame: sender.mainFrame }
  return Promise.resolve().then(() => handler(event, ...args))
}

export function emitChannel(channel: string, args: unknown[], sender: WebContents): void {
  for (const listener of listeners.get(channel) ?? []) listener({ sender, senderFrame: sender.mainFrame }, ...args)
}

export function registeredChannels(): string[] {
  return [...handlers.keys()]
}

/**
 * Electron-shaped ipcMain. `handle` is what every controller uses; the channel
 * router reads the same registry so no controller needs to know about HTTP.
 */
export const ipcMain = {
  handle(channel: string, handler: (event: WebInvokeEvent, ...args: unknown[]) => unknown): void {
    handlers.set(channel, handler)
  },
  handleOnce(channel: string, handler: (event: WebInvokeEvent, ...args: unknown[]) => unknown): void {
    handlers.set(channel, (event, ...args) => {
      handlers.delete(channel)
      return handler(event, ...args)
    })
  },
  removeHandler(channel: string): void { handlers.delete(channel) },
  on(channel: string, listener: (event: WebInvokeEvent, ...args: unknown[]) => void): void {
    const list = listeners.get(channel) ?? []
    list.push(listener)
    listeners.set(channel, list)
  },
  once(channel: string, listener: (event: WebInvokeEvent, ...args: unknown[]) => void): void {
    const wrapped = (event: WebInvokeEvent, ...args: unknown[]) => {
      ipcMain.removeListener(channel, wrapped)
      listener(event, ...args)
    }
    ipcMain.on(channel, wrapped)
  },
  removeListener(channel: string, listener: (event: WebInvokeEvent, ...args: unknown[]) => void): void {
    listeners.set(channel, (listeners.get(channel) ?? []).filter(item => item !== listener))
  },
  removeAllListeners(channel?: string): void {
    if (channel) listeners.delete(channel)
    else listeners.clear()
  },
}

export class BrowserWindow {
  readonly id: number
  readonly webContents: WebContents

  constructor(contents?: WebContents) {
    this.webContents = contents ?? createSender()
    this.id = this.webContents.id
  }

  static fromWebContents(contents: WebContents | null | undefined): BrowserWindow | null {
    return contents ? new BrowserWindow(contents) : null
  }

  static fromId(id: number): BrowserWindow | null {
    const contents = senders.get(id)
    return contents ? new BrowserWindow(contents) : null
  }

  static getAllWindows(): BrowserWindow[] {
    return [...senders.values()].map(contents => new BrowserWindow(contents))
  }

  isDestroyed(): boolean { return this.webContents.isDestroyed() }
  isMaximized(): boolean { return false }
  isMinimized(): boolean { return false }
  isVisible(): boolean { return true }
  minimize(): void {}
  maximize(): void {}
  unmaximize(): void {}
  restore(): void {}
  close(): void {}
  destroy(): void { this.webContents.destroy() }
  show(): void {}
  focus(): void {}
  setMenuBarVisibility(): void {}
  on(_event: string, _listener: (...args: unknown[]) => void): this { return this }
  once(_event: string, _listener: (...args: unknown[]) => void): this { return this }
  removeListener(): this { return this }
}

const pathOverrides = new Map<string, string>()

function defaultAppPath(name: string): string {
  const root = webDataRoot()
  switch (name) {
    case 'userData': return path.join(root, 'user-data')
    case 'appData': return path.join(root, 'app-data')
    case 'logs': return path.join(root, 'logs')
    case 'temp': return os.tmpdir()
    case 'home': return os.homedir()
    case 'downloads': return path.join(root, 'downloads')
    case 'documents': return path.join(root, 'documents')
    case 'sessionData': return path.join(root, 'session-data')
    default: return path.join(root, name)
  }
}

const appLifecycle = new Map<string, Array<(...args: unknown[]) => void>>()

export const app = {
  getPath(name: string): string { return pathOverrides.get(name) ?? defaultAppPath(name) },
  setPath(name: string, value: string): void { pathOverrides.set(name, value) },
  getLocale(): string {
    return requestContext.getStore()?.locale ?? process.env.PAGEKIN_LOCALE?.trim() ?? 'zh-CN'
  },
  getVersion(): string { return process.env.PAGEKIN_VERSION?.trim() || '1.4.0-web' },
  getName(): string { return 'ai-novel-writer' },
  getAppPath(): string { return process.cwd() },
  isPackaged: false,
  isReady(): boolean { return true },
  whenReady(): Promise<void> { return Promise.resolve() },
  quit(): void { this.emit('before-quit') },
  exit(code = 0): void { this.emit('before-quit'); process.exitCode = code },
  focus(): void {},
  on(event: string, listener: (...args: unknown[]) => void): void {
    const list = appLifecycle.get(event) ?? []
    list.push(listener)
    appLifecycle.set(event, list)
  },
  once(event: string, listener: (...args: unknown[]) => void): void { this.on(event, listener) },
  off(event: string, listener: (...args: unknown[]) => void): void {
    appLifecycle.set(event, (appLifecycle.get(event) ?? []).filter(item => item !== listener))
  },
  removeAllListeners(event: string): void { appLifecycle.delete(event) },
  emit(event: string): void {
    for (const listener of appLifecycle.get(event) ?? []) listener()
  },
  requestSingleInstanceLock(): boolean { return true },
  releaseSingleInstanceLock(): void {},
  setAppUserModelId(): void {},
  disableHardwareAcceleration(): void {},
  commandLine: {
    appendSwitch(): void {},
    hasSwitch(): boolean { return false },
    getSwitchValue(): string { return '' },
  },
  dock: { setIcon(): void {}, hide(): void {}, show(): void {} },
}

/** Native pickers cannot exist on a server; channels are overridden by the web controller. */
export const dialog = {
  async showOpenDialog(): Promise<{ canceled: boolean; filePaths: string[] }> {
    return { canceled: true, filePaths: [] }
  },
  async showSaveDialog(): Promise<{ canceled: boolean; filePath?: string }> {
    return { canceled: true }
  },
  async showMessageBox(): Promise<{ response: number; checkboxChecked: boolean }> {
    return { response: 0, checkboxChecked: false }
  },
}

export const shell = {
  async openExternal(url: string): Promise<void> { console.log('[web] openExternal', url) },
  openPath(): Promise<string> { return Promise.resolve('') },
  showItemInFolder(): void {},
}

function masterKey(): Buffer {
  const configured = process.env.PAGEKIN_MASTER_KEY?.trim()
  if (configured) return crypto.createHash('sha256').update(configured).digest()
  const keyPath = path.join(app.getPath('userData'), '.pagekin-master-key')
  try {
    return Buffer.from(fs.readFileSync(keyPath, 'utf8').trim(), 'base64')
  } catch {
    fs.mkdirSync(path.dirname(keyPath), { recursive: true })
    const created = crypto.randomBytes(32)
    fs.writeFileSync(keyPath, created.toString('base64'), { mode: 0o600 })
    return created
  }
}

export const safeStorage = {
  isEncryptionAvailable(): boolean { return true },
  encryptString(plainText: string): Buffer {
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv)
    const data = Buffer.concat([iv, cipher.update(plainText, 'utf8'), cipher.final(), cipher.getAuthTag()])
    return Buffer.from(`web:v1:${data.toString('base64')}`, 'utf8')
  },
  decryptString(encrypted: Buffer): string {
    const raw = encrypted.toString('utf8')
    if (!raw.startsWith('web:v1:')) throw new Error('SAFE_STORAGE_DECRYPT_FAILED')
    const data = Buffer.from(raw.slice('web:v1:'.length), 'base64')
    const iv = data.subarray(0, 12)
    const tag = data.subarray(data.length - 16)
    const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey(), iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(data.subarray(12, data.length - 16)), decipher.final()]).toString('utf8')
  },
}

/** Images are passed through untouched: avatars stay valid, only uncompressed. */
export const nativeImage = {
  createFromBuffer(buffer: Buffer): {
    isEmpty(): boolean
    getSize(): { width: number; height: number }
    resize(): unknown
    toPNG(): Buffer
    toJPEG(): Buffer
  } {
    const image = {
      isEmpty: () => buffer.length === 0,
      getSize: () => ({ width: 0, height: 0 }),
      resize: () => image,
      toPNG: () => buffer,
      toJPEG: () => buffer,
    }
    return image
  },
}

export type IpcMainInvokeEvent = WebInvokeEvent
export type WebContentsType = WebContents
export type OpenDialogOptions = Record<string, unknown>
export type OpenDialogReturnValue = { canceled: boolean; filePaths: string[] }
export type SaveDialogOptions = Record<string, unknown>
export type SaveDialogReturnValue = { canceled: boolean; filePath?: string }
