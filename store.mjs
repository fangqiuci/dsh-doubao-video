/**
 * lib/store.mjs —— 项目状态落盘（一个项目一个 json）
 * ============================================================================
 * 家目录：`$DSH_HOME/doubao-video/`（默认 `~/.dsh/doubao-video`，可用设置里的 home 覆盖）
 *   projects/<slug>.json   项目状态
 *   projects/<slug>.log    每次判定追加一行（谁没过、为什么、第几次）
 *
 * 为什么不用数据库：这个流程是**人 + 模型 + 网页操作**混合的，出错时用户只会打开 json
 * 看一眼。json 能直接看、能直接改、能 diff，比什么都强。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 默认家目录 */
export function defaultHome() {
  const base = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(base, 'doubao-video')
}

/** slug 只留安全字符，避免 ../ 之类把状态写到别处 */
export function safeSlug(raw) {
  const s = String(raw ?? '').trim().toLowerCase()
  const cleaned = s.replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, '-').replace(/^-+|-+$/g, '')
  return (cleaned || 'default').slice(0, 48)
}

export function projectFile(home, slug) {
  return join(home, 'projects', `${safeSlug(slug)}.json`)
}

export function emptyProject(slug) {
  const now = new Date().toISOString()
  return {
    slug: safeSlug(slug),
    version: 1,
    createdAt: now,
    updatedAt: now,
    /** 风格锁（第 0 节 / 原第 6 节） */
    styleLock: null,
    /** 已通过的脚本（第 1 节） */
    script: null,
    /** 角色登记：name -> { name, kind, file, appearance, outfit, at } */
    roles: {},
    /** 场景登记：name -> { name, file, characters, at } */
    scenes: {},
    /** 片段登记：段号 -> { segment, file, durationSeconds, tailFrame, tailTimeSeconds, at } */
    clips: {},
    /** 待生成：段号 -> { segment, shotIndex, startedAt, confirmedAt }（本人确认「确定生成视频」后才填 confirmedAt） */
    pending: {},
    /** 每道闸门失败了几次：gateId -> n */
    attempts: {},
    /** 最近 200 条判定记录 */
    history: [],
  }
}

export function loadProject(home, slug) {
  const file = projectFile(home, slug)
  if (!existsSync(file)) return emptyProject(slug)
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    // 老文件缺字段时补齐，别让一个 undefined 把整条流程打断
    const base = emptyProject(slug)
    return {
      ...base,
      ...data,
      roles: data.roles && typeof data.roles === 'object' ? data.roles : {},
      scenes: data.scenes && typeof data.scenes === 'object' ? data.scenes : {},
      clips: data.clips && typeof data.clips === 'object' ? data.clips : {},
      pending: data.pending && typeof data.pending === 'object' ? data.pending : {},
      attempts: data.attempts && typeof data.attempts === 'object' ? data.attempts : {},
      history: Array.isArray(data.history) ? data.history : [],
    }
  } catch {
    // 文件坏了不要静默重置成空项目 —— 备份一份，让人还能捞回来
    try { renameSync(file, `${file}.broken-${Date.now()}`) } catch { /* 备份失败就继续 */ }
    return emptyProject(slug)
  }
}

export function saveProject(home, slug, project) {
  const file = projectFile(home, slug)
  mkdirSync(join(home, 'projects'), { recursive: true })
  const next = { ...project, updatedAt: new Date().toISOString() }
  // 先写临时文件再 rename：写到一半断电也不会留下半个 json
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
  renameSync(tmp, file)
  return next
}

/** 记一条判定历史（同时写 log，方便事后追责/调参） */
export function recordHistory(home, slug, entry) {
  const line = `[${new Date().toISOString()}] ${entry.gate} ${entry.ok ? 'PASS' : 'FAIL'} ${entry.summary || ''}`.trim()
  try {
    mkdirSync(join(home, 'projects'), { recursive: true })
    appendFileSync(join(home, 'projects', `${safeSlug(slug)}.log`), `${line}\n`, 'utf8')
  } catch { /* 日志写不进去不该挡住主流程 */ }
}

/** 失败计数 +1，返回新值 */
export function bumpAttempt(project, gateId) {
  const n = Number(project.attempts?.[gateId] || 0) + 1
  project.attempts = { ...(project.attempts || {}), [gateId]: n }
  return n
}

/** 通过后把这个闸门的失败计数清零 */
export function resetAttempt(project, gateId) {
  if (project.attempts && project.attempts[gateId]) {
    project.attempts = { ...project.attempts, [gateId]: 0 }
  }
}

/** Map 化，供 rules 用 */
export function toMap(obj) {
  return new Map(Object.entries(obj || {}))
}
