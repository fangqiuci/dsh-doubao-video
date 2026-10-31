/**
 * lib/hostdeps.mjs —— 从**宿主那棵树**里取 `@deepseek-ai/*`（取不到就降级）
 * ============================================================================
 * 为什么不能直接 `import '@deepseek-ai/schemastery'`：
 *   插件是以 `link:` 装进 profile 的，Node 默认解析真实路径 ⇒ 从
 *   `~/.dsh/plugins/<插件>/lib/` 往上找 node_modules，**永远进不到 profile 的树**
 *   （profile 的 node_modules 在 `~/.dsh/profiles/<name>/node_modules`，不是它的祖先）。
 *   实测：直接 import 会静默失败 ⇒ `Config` 变 undefined ⇒ 设置页没有这个命名空间。
 *
 * 顺序：① 直接 import（插件自己带了依赖时）→ ② 宿主 profile 树 → ③ null（降级）
 * ============================================================================
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** 可能藏着 @deepseek-ai 的目录，按可能性排序 */
export function candidateRoots() {
  const roots = []
  const push = (p) => { if (p && !roots.includes(p)) roots.push(p) }

  if (process.env.DSH_HOST_MODULES) push(process.env.DSH_HOST_MODULES)

  try {
    for (const profile of readdirSync(join(dshHome(), 'profiles'))) {
      push(join(dshHome(), 'profiles', profile, 'node_modules', '@deepseek-ai'))
    }
  } catch { /* 没有 profiles 就算了 */ }

  push(join(dshHome(), 'node_modules', '@deepseek-ai'))
  return roots
}

/** 按包的 exports['.'] 找入口，返回 file:// URL */
function entryUrlFor(root, name) {
  try {
    const dir = join(root, name)
    const pkgFile = join(dir, 'package.json')
    if (!existsSync(pkgFile)) return null
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
    const dot = pkg.exports?.['.']
    const rel = typeof dot === 'string' ? dot : (dot?.import || dot?.default || pkg.module || pkg.main)
    if (!rel) return null
    const file = join(dir, String(rel).replace(/^\.\//, ''))
    return existsSync(file) ? pathToFileURL(file).href : null
  } catch { return null }
}

/**
 * 取一个 @deepseek-ai 包。
 * @param {string} name 例如 'schemastery' / 'dsh-tools'
 * @returns {Promise<any|null>}
 */
export async function loadHostPackage(name) {
  // ① 自己的依赖（插件自带了就用自己的，最省事）
  try {
    return await import(`@deepseek-ai/${name}`)
  } catch { /* 继续往下找 */ }

  // ② 宿主 profile 树
  for (const root of candidateRoots()) {
    const url = entryUrlFor(root, name)
    if (!url) continue
    try { return await import(url) } catch { /* 换下一个 */ }
  }

  // ③ 放弃：调用方负责降级
  return null
}

/**
 * 取一个**普通**包（不带 @deepseek-ai 前缀），例如 playwright。
 *
 * 为什么不能靠 Node 向上查找：插件装在 `~/.dsh/plugins/<插件>`，
 * 而 profile 的 node_modules 在 `~/.dsh/profiles/<name>/node_modules`，
 * 两者不是祖先关系 —— 裸 import 一定失败（实测过）。
 */
export async function loadFromProfile(name) {
  try { return await import(name) } catch { /* 继续 */ }

  const tryDir = (base) => {
    const dir = join(base, name)
    const pkgFile = join(dir, 'package.json')
    if (!existsSync(pkgFile)) return null
    try {
      const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
      const dot = pkg.exports?.['.']
      const rel = typeof dot === 'string' ? dot : (dot?.import || dot?.default || pkg.module || pkg.main)
      const file = join(dir, String(rel || 'index.js').replace(/^\.\//, ''))
      return existsSync(file) ? pathToFileURL(file).href : null
    } catch { return null }
  }

  // candidateRoots 给的是 `.../node_modules/@deepseek-ai`，退回到 node_modules
  for (const root of candidateRoots()) {
    const url = tryDir(root.replace(/[\\/]@deepseek-ai$/, ''))
    if (url) { try { return await import(url) } catch { /* 换下一个 */ } }
  }

  // 兜底：DSH_HOME 下所有 profiles
  try {
    for (const profile of readdirSync(join(dshHome(), 'profiles'))) {
      const url = tryDir(join(dshHome(), 'profiles', profile, 'node_modules'))
      if (url) { try { return await import(url) } catch { /* 换下一个 */ } }
    }
  } catch { /* 没有就算了 */ }

  return null
}
