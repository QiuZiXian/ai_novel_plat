/**
 * models.json secret codec for the web runtime.
 *
 * The desktop build writes provider API keys as plaintext because the file sits
 * inside the user's OS profile. A server must not keep them readable, so the web
 * bootstrap installs this codec: keys are encrypted with the same master key the
 * safeStorage shim uses, and decrypted again on read so every controller keeps
 * working with plaintext profiles in memory.
 */
import path from 'node:path'
import { safeStorage } from '../shims/electron'
import { MODELS_CONFIG_PATH, type JsonFileCodec } from '../../electron/utils/config-utils'

const ENCRYPTED_PREFIX = 'web:v1:'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function transformModels(value: unknown, transform: (model: Record<string, unknown>) => Record<string, unknown>): unknown {
  if (!Array.isArray(value)) return value
  return value.map(entry => (isRecord(entry) ? transform(entry) : entry))
}

export function createModelsSecretCodec(): JsonFileCodec {
  const isModelsFile = (filePath: string) => path.resolve(filePath) === path.resolve(MODELS_CONFIG_PATH)
  return {
    encode(filePath, value) {
      if (!isModelsFile(filePath)) return value
      return transformModels(value, model => {
        const apiKey = model.apiKey
        if (typeof apiKey !== 'string' || apiKey.length === 0 || apiKey.startsWith(ENCRYPTED_PREFIX)) return model
        return { ...model, apiKey: safeStorage.encryptString(apiKey).toString('utf8') }
      })
    },
    decode(filePath, value) {
      if (!isModelsFile(filePath)) return value
      return transformModels(value, model => {
        const apiKey = model.apiKey
        if (typeof apiKey !== 'string' || !apiKey.startsWith(ENCRYPTED_PREFIX)) return model
        try {
          return { ...model, apiKey: safeStorage.decryptString(Buffer.from(apiKey, 'utf8')) }
        } catch (error) {
          console.warn('[pagekin-web] models.json 密钥解密失败，按空密钥读取:', error)
          return { ...model, apiKey: '' }
        }
      })
    },
  }
}
