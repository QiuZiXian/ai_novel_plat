import { useEffect, useState } from 'react'
import type { ProjectDirectoryGrant } from '../../shared/ipc-channels'
import { useProjectStore } from '../../stores/project-store'
import { ipc } from '../../services/ipc-client'
import { useLocaleStore } from '../../stores/locale-store'
import { alertError } from '../ui/AlertDialog'

/** 新建作品：名称与保存位置，创建后其余设定在设定页填写。 */
export function useNewProjectForm(open: boolean, onClose: () => void) {
  const createProject = useProjectStore((s) => s.createProject)
  const locale = useLocaleStore(s => s.locale)
  const text = useLocaleStore(s => s.text)
  const [name, setName] = useState('')
  const [path, setPath] = useState<ProjectDirectoryGrant | null>(null)
  const [creating, setCreating] = useState(false)
  // 浏览器里没有本地目录可挑：位置固定是服务端作品库，打开对话框时就取好授权。
  const isWeb = ipc.isWeb

  const requestWebLocation = async (): Promise<ProjectDirectoryGrant | null> => {
    const selected = await ipc.invoke('dialog:select-folder', 'project-create')
    if (selected) setPath(selected)
    return selected
  }

  useEffect(() => {
    if (!open) return
    let mounted = true
    Promise.resolve().then(() => {
      if (mounted) { setName(''); setPath(null) }
    })
    if (isWeb) {
      void requestWebLocation().catch(() => {
        // 取不到时创建前会再试一次，这里不打断用户填名字。
      })
    }
    return () => { mounted = false }
  }, [isWeb, open])

  const selectFolder = async () => {
    const selected = await ipc.invoke('dialog:select-folder', 'project-create')
    if (selected) setPath(selected)
  }

  /** 类型与目标读者留空，在设定页填写。 */
  const create = async () => {
    if (!name.trim()) return
    setCreating(true)
    try {
      const target = path ?? (isWeb ? await requestWebLocation() : null)
      if (!target) {
        alertError(text('无法获取作品库保存位置，请重试。', 'Could not get a save location in the library. Try again.'))
        return
      }
      const success = await createProject({
        name: name.trim(),
        parentGrantId: target.grantId,
        genre: '',
        targetAudience: '',
        writingLanguage: locale,
      })
      setPath(null)
      if (success) onClose()
    } finally {
      setCreating(false)
    }
  }

  return {
    name,
    setName,
    path,
    selectFolder,
    creating,
    isWeb,
    canCreate: !creating && Boolean(name.trim()) && (isWeb || path !== null),
    create,
  }
}
