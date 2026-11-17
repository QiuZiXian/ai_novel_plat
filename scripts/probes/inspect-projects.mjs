/**
 * 只读巡检：列出 `.pagekin-web/projects/` 下每个项目的章节 / 草稿 / 定稿数量，
 * 用来在验收前挑选目标项目（例如「有没有定稿章节可以导出 Markdown」）。
 *
 *   node scripts/probes/inspect-projects.mjs
 *
 * 直接用 better-sqlite3 只读打开项目库，不经过网关，不需要服务在运行。
 */
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { REPO_ROOT, report, run } from './lib/harness.mjs'

const PROJECTS_ROOT = path.join(REPO_ROOT, '.pagekin-web', 'projects')
const TABLES = ['chapters', 'drafts', 'drafts_all', 'finalized_chapters', 'chapter_publications']

run(async () => {
  if (!fs.existsSync(PROJECTS_ROOT)) throw new Error(`未找到 ${PROJECTS_ROOT}`)

  for (const directory of fs.readdirSync(PROJECTS_ROOT)) {
    const databasePath = path.join(PROJECTS_ROOT, directory, '.ai-novel', 'project.db')
    if (!fs.existsSync(databasePath)) {
      report(directory, 'no project.db')
      continue
    }
    const database = new Database(databasePath, { readonly: true, fileMustExist: true })
    try {
      const existing = new Set(database
        .prepare("select name from sqlite_master where type = 'table'")
        .all()
        .map(row => row.name))
      const counts = {}
      for (const table of TABLES) {
        if (!existing.has(table)) continue
        counts[table] = database.prepare(`select count(*) as count from "${table}"`).get().count
      }
      report(directory, counts)
    } finally {
      database.close()
    }
  }
})
