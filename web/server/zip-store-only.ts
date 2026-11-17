/**
 * Minimal store-only ZIP writer.
 *
 * Export results are directories on the server (split Markdown chapters, an
 * archive plus sidecars), but a browser can only download single files. Rather
 * than add a runtime dependency, this writes an uncompressed ZIP with the same
 * layout the EPUB fixtures use: local headers, central directory, EOCD.
 */
import fs from 'node:fs'
import path from 'node:path'

const MAX_ENTRIES = 4096
const MAX_TOTAL_BYTES = 512 * 1024 * 1024

interface ZipEntry {
  name: string
  content: Buffer
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function collect(directory: string, prefix: string, entries: ZipEntry[], budget: { bytes: number }): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entries.length >= MAX_ENTRIES) throw new Error('ZIP_ENTRY_LIMIT')
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      collect(absolute, `${prefix}${entry.name}/`, entries, budget)
      continue
    }
    if (!entry.isFile()) continue
    const content = fs.readFileSync(absolute)
    budget.bytes += content.length
    if (budget.bytes > MAX_TOTAL_BYTES) throw new Error('ZIP_SIZE_LIMIT')
    entries.push({ name: `${prefix}${entry.name}`, content })
  }
}

export function buildStoreZip(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0

  for (const { name: fileName, content } of entries) {
    const name = Buffer.from(fileName, 'utf8')
    const checksum = crc32(content)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(content.length, 18)
    local.writeUInt32LE(content.length, 22)
    local.writeUInt16LE(name.length, 26)
    localParts.push(local, name, content)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(content.length, 20)
    central.writeUInt32LE(content.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, name)

    offset += local.length + name.length + content.length
  }

  const centralDirectory = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, centralDirectory, end])
}

/** Zips `directory` into `targetFile`; `rootName` keeps a top-level folder. */
export function writeDirectoryZip(directory: string, targetFile: string, rootName?: string): void {
  const entries: ZipEntry[] = []
  const prefix = rootName ? `${rootName.replace(/[\\/]+$/u, '')}/` : ''
  collect(directory, prefix, entries, { bytes: 0 })
  if (entries.length === 0) throw new Error('ZIP_SOURCE_EMPTY')
  fs.writeFileSync(targetFile, buildStoreZip(entries))
}
