/**
 * Browser file transfers.
 *
 * Native pickers cannot exist on a server, so the renderer uploads the chosen
 * bytes and the corresponding dialog handler hands out short-lived grants for
 * the stored copy. The same mechanism serves downloads (exports, archives).
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export interface StoredUpload {
  absolutePath: string
  relativePath: string
  displayName: string
}

interface DownloadRecord {
  filePath: string
  name: string
  expiresAt: number
}

const DOWNLOAD_TTL_MS = 10 * 60 * 1_000
const downloadRecords = new Map<string, DownloadRecord>()

/** `${senderId}:${purpose}` → files uploaded by that connection. */
const pendingUploads = new Map<string, StoredUpload[]>()

function uploadKey(senderId: number, purpose: string): string {
  return `${senderId}:${purpose}`
}

function sanitizeSegment(raw: string, fallback: string): string {
  const cleaned = raw
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/^\.+$/, '')
    .trim()
  return cleaned.length > 0 ? cleaned.slice(0, 160) : fallback
}

function sanitizeRelativePath(raw: string | undefined, fallbackName: string): string {
  if (!raw) return fallbackName
  const segments = raw
    .split(/[\\/]+/)
    .filter(segment => segment.length > 0 && segment !== '.' && segment !== '..')
    .map(segment => sanitizeSegment(segment, 'file'))
  return segments.length > 0 ? segments.join(path.sep) : fallbackName
}

/** Root folder that holds every upload for one connection and purpose. */
export function uploadBatchRoot(uploadRoot: string, senderId: number, purpose: string): string {
  return path.join(uploadRoot, sanitizeSegment(purpose, 'misc'), String(senderId))
}

export function storeUpload(options: {
  uploadRoot: string
  senderId: number
  purpose: string
  name: string
  relativePath?: string
  bytes: Buffer
}): StoredUpload {
  const fallback = `upload-${Date.now()}`
  const safeName = sanitizeSegment(options.name, fallback)
  const relativePath = sanitizeRelativePath(options.relativePath, safeName)
  const batchRoot = uploadBatchRoot(options.uploadRoot, options.senderId, options.purpose)
  const target = path.resolve(batchRoot, relativePath)
  if (!target.startsWith(path.resolve(batchRoot) + path.sep)) {
    throw new Error('UPLOAD_PATH_INVALID')
  }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, options.bytes)
  const record: StoredUpload = {
    absolutePath: target,
    relativePath,
    displayName: path.basename(target),
  }
  const key = uploadKey(options.senderId, options.purpose)
  const list = pendingUploads.get(key) ?? []
  list.push(record)
  pendingUploads.set(key, list)
  return record
}

/** Consumes (and forgets) the uploads waiting for a dialog call. */
export function takeUploads(senderId: number, purpose: string): StoredUpload[] {
  const key = uploadKey(senderId, purpose)
  const list = pendingUploads.get(key) ?? []
  pendingUploads.delete(key)
  return list
}

export function registerDownload(filePath: string, name: string): string {
  const token = crypto.randomUUID()
  downloadRecords.set(token, { filePath, name, expiresAt: Date.now() + DOWNLOAD_TTL_MS })
  return token
}

export function resolveDownload(token: string): DownloadRecord | null {
  const record = downloadRecords.get(token)
  if (!record) return null
  if (record.expiresAt <= Date.now()) {
    downloadRecords.delete(token)
    return null
  }
  if (!fs.existsSync(record.filePath)) return null
  return record
}
