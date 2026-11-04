/**
 * lib/bgm.mjs —— BGM 归档
 * ============================================================================
 * 使用路径（本人 2026-11-04 定）：
 *   用户在 QQ 里把音频甩给辞辞 → 桥接把它落到本机 → 辞辞调 doubao_bgm（add）
 *   → 统一收进 <状态目录>/bgm/ → doubao_dub 只要说名字就行。
 *
 * 为什么不让用户自己放文件夹：
 *   装机用户根本不知道该放哪，放错地方又报"找不到文件"。
 *   收进一个固定目录、按名字引用，才是能远程帮他完成的方式。
 * ============================================================================
 */

import { existsSync, mkdirSync, copyFileSync, readdirSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'

export const AUDIO_EXT = ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus']

export function bgmDir(home) {
  const d = join(home, 'bgm')
  mkdirSync(d, { recursive: true })
  return d
}

/** 列出已归档的 BGM（名字 + 大小） */
export function listBgm(home) {
  const d = bgmDir(home)
  return readdirSync(d)
    .filter((f) => AUDIO_EXT.includes(extname(f).toLowerCase()))
    .map((f) => ({ name: basename(f, extname(f)), file: join(d, f), bytes: statSync(join(d, f)).size }))
}

/**
 * 把 BGM 收进归档目录。三种来源：
 *   · 本机已有文件（桥接下载好的）→ 复制
 *   · http(s) 链接 → 下载
 *   · 已经在归档目录里 → 直接返回
 */
export async function addBgm(home, { file, url, name, fetchImpl = fetch }) {
  const d = bgmDir(home)
  const stem = String(name || '').trim() || (file ? basename(file, extname(file)) : `bgm-${Date.now()}`)

  let srcPath = file ? String(file).trim() : ''
  if (url) {
    const r = await fetchImpl(String(url))
    if (!r.ok) return { ok: false, error: `下载失败 HTTP ${r.status}` }
    const buf = Buffer.from(await r.arrayBuffer())
    if (buf.length < 20 * 1024) return { ok: false, error: `文件只有 ${buf.length} 字节，不像音频` }
    const ext = extname(new URL(url).pathname) || '.mp3'
    srcPath = join(d, `${stem}${ext}`)
    ;(await import('node:fs')).writeFileSync(srcPath, buf)
    return { ok: true, name: stem, file: srcPath, bytes: buf.length, via: 'url' }
  }

  if (!srcPath) return { ok: false, error: '要么给 file（本机文件），要么给 url' }
  if (!existsSync(srcPath)) return { ok: false, error: `文件不存在：${srcPath}` }
  const ext = extname(srcPath).toLowerCase()
  if (!AUDIO_EXT.includes(ext)) return { ok: false, error: `不是音频：${ext || '(无扩展名)'}` }
  const bytes = statSync(srcPath).size
  if (bytes < 20 * 1024) return { ok: false, error: `只有 ${bytes} 字节，基本是空文件` }

  // 已经在归档目录里就不用复制
  if (dirnameOf(srcPath) === d) return { ok: true, name: stem, file: srcPath, bytes, via: 'already' }

  const dst = join(d, `${stem}${ext}`)
  copyFileSync(srcPath, dst)
  return { ok: true, name: stem, file: dst, bytes, via: 'copy' }
}

function dirnameOf(p) {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return i >= 0 ? p.slice(0, i) : ''
}

/** 把用户给的名字/路径解析成真实文件：先按名字在归档里找，再当路径试 */
export function resolveBgm(home, ref) {
  const raw = String(ref || '').trim()
  if (!raw) return null
  if (existsSync(raw)) return raw
  const stem = raw.replace(/\.(mp3|wav|m4a|aac|flac|ogg|opus)$/i, '').toLowerCase()
  const hit = listBgm(home).find((x) => x.name.toLowerCase() === stem)
  return hit ? hit.file : null
}
