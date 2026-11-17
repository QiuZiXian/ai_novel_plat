import { ipc } from './ipc-client'

/**
 * Web 构建没有“导出目录”：产物写在服务端，导出完成后把授权换一次性下载令牌，
 * 再交给浏览器保存。桌面构建直接返回 false，调用方保持原有落盘逻辑。
 */
export async function downloadWebGrant(grantId: string): Promise<boolean> {
  if (!ipc.isWeb) return false
  const result = await ipc.invoke('web:request-download', grantId)
  if (!result.success) throw new Error(result.error)
  const anchor = document.createElement('a')
  anchor.href = `/api/download/${encodeURIComponent(result.token)}`
  anchor.download = result.name
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  return true
}
