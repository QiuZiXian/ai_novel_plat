/** The single desktop bridge exposed by preload. Project authorization stays in main. */
export interface AiNovelAPI {
  /** Omitted by the Electron preload; `'web'` marks the browser bridge. */
  runtime?: 'web'
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  on: (channel: string, callback: (...args: unknown[]) => void) => () => void
  once: (channel: string, callback: (...args: unknown[]) => void) => void
  send: (channel: string, ...args: unknown[]) => void
  setZoomLevel: (level: number) => void
  setZoomFactor: (factor: number) => void
  getZoomLevel: () => number
}
