/**
 * scripts/make-manifest.mjs —— 打一份"有凭证的备份"
 *   node scripts/make-manifest.mjs
 *
 * 2026-10-31 主作者指出：`_backup` 里三份文件只有文件名说"健康版"，
 * 没有哈希、没有当时的测试输出 —— 真出事时凭什么信？
 * 所以这个脚本做三件事：
 *   1. 把 lib/*.mjs 复制到 _backup/<名字>-<时间戳>.mjs
 *   2. 算 sha256
 *   3. 现场跑四条准入线，把退出码和最后一行一起写进 _backup/MANIFEST.json
 */
import { readFileSync, writeFileSync, copyFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const LIB = join(ROOT, 'lib')
const BK = join(ROOT, '_backup')
mkdirSync(BK, { recursive: true })

const stamp = (() => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
})()

// lib/ 和 scripts/ 都要覆盖：主作者在 AUDIO-PLAN v2 里明确要求「_backup 覆盖新文件」，
// 而新文件会出现两个地方 —— lib/tts.mjs（适配器）和 scripts/audio-selftest.mjs（验收）。
const targets = [
  { dir: LIB, prefix: 'lib' },
  { dir: join(ROOT, 'scripts'), prefix: 'scripts' },
]
const entries = []
for (const { dir, prefix } of targets) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort()
  for (const f of files) {
    const src = join(dir, f)
    const dst = join(BK, `${prefix}-${basename(f, '.mjs')}-${stamp}.mjs`)
    copyFileSync(src, dst)
    const buf = readFileSync(src)
    entries.push({
      file: `${prefix}/${f}`,
      backup: `_backup/${basename(dst)}`,
      bytes: buf.length,
      sha256: createHash('sha256').update(buf).digest('hex'),
    })
    console.log(`📦 ${prefix}/${f} → _backup/${basename(dst)}`)
  }
}

/** 跑一条准入线，取退出码 + 最后一行有内容的输出 */
function gate(script, args = []) {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', script), ...args], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 600000,
  })
  const lines = `${r.stdout || ''}\n${r.stderr || ''}`.split('\n').map((s) => s.trim()).filter(Boolean)
  return { exit: r.status, last: lines[lines.length - 1] || '' }
}

const tests = {
  syntax: gate('monitor.mjs'),      // monitor 里含 lib/*.mjs 的 node --check
  monitor: gate('monitor.mjs'),
  selfcheck: gate('selfcheck.mjs'),
  smoke: gate('smoke.mjs'),
  ffmpegSelftest: gate('ffmpeg-selftest.mjs'),
}
for (const [k, v] of Object.entries(tests)) console.log(`${v.exit === 0 ? '✅' : '❌'} ${k} (exit ${v.exit}) · ${v.last}`)

const manifestPath = join(BK, 'MANIFEST.json')
let manifest = { schema: 1, snapshots: [] }
if (existsSync(manifestPath)) {
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch { /* 重建 */ }
}
manifest.snapshots = manifest.snapshots || []
manifest.snapshots.push({
  stamp,
  createdAt: new Date().toISOString(),
  node: process.version,
  files: entries,
  tests,
  note: '生成方式：node scripts/make-manifest.mjs（只有四条准入线全绿时才值得当基线）',
})
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
console.log(`\n凭证写入 ${manifestPath}（共 ${manifest.snapshots.length} 份快照）`)

const bad = Object.values(tests).filter((t) => t.exit !== 0).length
process.exit(bad ? 1 : 0)
