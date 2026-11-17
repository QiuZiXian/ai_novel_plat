import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { closeProjectDatabase, createProjectDatabase, getCurrentProjectPath, getProjectDb, initProjectDatabase } from '../../database'
import { createCanonicalProjectManifest } from '../../../src/shared/project-format'
import { projectAccess, projectAccessFor } from '../project-access'
import { runWithUserId } from '../user-scope'

const roots: string[] = []
const BASE = path.resolve('.runtime/.cache/multi-user')

function makeProject(label: string): string {
  fs.mkdirSync(BASE, { recursive: true })
  const root = fs.mkdtempSync(path.join(BASE, `${label}-`))
  roots.push(root)
  const data = path.join(root, '.ai-novel')
  fs.mkdirSync(data)
  fs.writeFileSync(path.join(data, 'project.json'), JSON.stringify(
    createCanonicalProjectManifest({ projectId: randomUUID(), createdAt: new Date().toISOString() }),
  ))
  createProjectDatabase(root)
  return root
}

afterEach(() => {
  for (const userId of ['alice', 'bob']) {
    try { runWithUserId(userId, () => closeProjectDatabase()) } catch { /* already closed */ }
  }
  try { closeProjectDatabase() } catch { /* already closed */ }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('多用户项目隔离', () => {
  it('两个用户可以各自打开一个项目并保持各自的当前库', () => {
    const aliceProject = makeProject('alice')
    const bobProject = makeProject('bob')

    runWithUserId('alice', () => initProjectDatabase(aliceProject))
    runWithUserId('bob', () => initProjectDatabase(bobProject))

    expect(runWithUserId('alice', () => getCurrentProjectPath())).toBe(aliceProject)
    expect(runWithUserId('bob', () => getCurrentProjectPath())).toBe(bobProject)
    expect(runWithUserId('alice', () => getProjectDb())).not.toBeNull()
    expect(runWithUserId('bob', () => getProjectDb())).not.toBeNull()
    expect(runWithUserId('alice', () => getProjectDb())).not.toBe(runWithUserId('bob', () => getProjectDb()))

    // 关闭 Alice 的项目不影响 Bob 的句柄。
    runWithUserId('alice', () => closeProjectDatabase())
    expect(runWithUserId('alice', () => getCurrentProjectPath())).toBeNull()
    expect(runWithUserId('bob', () => getCurrentProjectPath())).toBe(bobProject)
    expect(runWithUserId('bob', () => getProjectDb())).not.toBeNull()
  })

  it('第二个用户打开同一本作品会被拒绝', () => {
    const shared = makeProject('shared')
    runWithUserId('alice', () => initProjectDatabase(shared))
    expect(() => runWithUserId('bob', () => initProjectDatabase(shared))).toThrow('PROJECT_IN_USE')
    expect(runWithUserId('bob', () => getCurrentProjectPath())).toBeNull()
  })

  it('项目租约按用户分开，互不覆盖', () => {
    expect(projectAccessFor('alice')).not.toBe(projectAccessFor('bob'))
    const aliceSession = projectAccessFor('alice').beginSession({
      kind: 'manifest', projectId: 'alice-project', rootPath: '/tmp/alice-book',
    })
    const bobSession = projectAccessFor('bob').beginSession({
      kind: 'manifest', projectId: 'bob-project', rootPath: '/tmp/bob-book',
    })

    expect(runWithUserId('alice', () => projectAccess.assertCurrentSession(aliceSession).rootPath)).toBe('/tmp/alice-book')
    expect(runWithUserId('bob', () => projectAccess.assertCurrentSession(bobSession).rootPath)).toBe('/tmp/bob-book')
    expect(runWithUserId('alice', () => projectAccess.captureCurrentSession()?.rootPath)).toBe('/tmp/alice-book')
    expect(runWithUserId('bob', () => projectAccess.captureCurrentSession()?.rootPath)).toBe('/tmp/bob-book')
  })
})
