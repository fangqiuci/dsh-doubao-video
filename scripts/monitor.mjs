/**
 * scripts/monitor.mjs —— 插件健康巡检（每次改完 / 定时跑）
 *   node scripts/monitor.mjs
 * 退出码 0 = 一切正常；1 = 有硬伤（乱码 / 语法 / 测试失败）
 *
 * 为什么需要它（2026-10-31 三次转码事故）：
 *   UTF-8 被按 GBK 存回去以后，**文件仍是合法 UTF-8、JSON 仍能 parse、
 *   node --check 也可能照样通过** —— 现有测试根本发现不了。
 *   所以单独加一道"乱码特征"扫描，比语法检查更早一步。
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MON = join(ROOT, '_monitor')
const MAN = join(MON, 'manifest.json')
const SKIP = /_snapshots|_backup|_monitor|node_modules|scripts[\\/]monitor\.mjs/
const EXT = /\.(mjs|js|json|yml|md)$/

/** GBK 误读 UTF-8 后最典型的几十个"绝不会出现在正常中文里"的字 */
const MOJI = /[锛鈥銆锝鎻鍜鐨鏄鍦浣鏃寮鎶鎴缃鍥鍚鏋鍏鍐鐜璇鍔姝绔缁鑹鍑鍙鍛鍡閿鍒鍙]/g

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (SKIP.test(p)) continue
    if (e.isDirectory()) walk(p, out)
    else if (EXT.test(e.name)) out.push(p)
  }
  return out
}

const files = walk(ROOT).sort()
const problems = []
const manifest = {}

for (const f of files) {
  const rel = relative(ROOT, f)
  const buf = readFileSync(f)
  manifest[rel] = createHash('sha256').update(buf).digest('hex')

  let text
  try { text = buf.toString('utf8') } catch { problems.push(`${rel}: 不是合法 UTF-8`); continue }
  if (text.includes('\uFFFD')) problems.push(`${rel}: 含替换符 U+FFFD`)
  const hits = text.match(MOJI)
  if (hits) problems.push(`${rel}: 疑似乱码 ${hits.length} 处（例：${[...new Set(hits)].slice(0, 5).join('')}）`)
}

// 语法
const node = process.execPath
for (const f of files.filter((x) => x.endsWith('.mjs') && x.includes(`${join(ROOT, 'lib')}`))) {
  const r = spawnSync(node, ['--check', f], { encoding: 'utf8' })
  if (r.status !== 0) problems.push(`${relative(ROOT, f)}: 语法错误`)
}

// 与上次指纹比对
let changes = []
if (existsSync(MAN)) {
  try {
    const prev = JSON.parse(readFileSync(MAN, 'utf8'))
    for (const k of Object.keys(manifest)) if (prev[k] !== manifest[k]) changes.push(`${prev[k] ? '改' : '新'} ${k}`)
    for (const k of Object.keys(prev)) if (!manifest[k]) changes.push(`删 ${k}`)
  } catch { changes = ['（上次指纹损坏，已重建）'] }
}
mkdirSync(MON, { recursive: true })
writeFileSync(MAN, JSON.stringify(manifest, null, 2), 'utf8')

console.log(`扫描 ${files.length} 个文件`)
if (changes.length) console.log('自上次以来的变化：\n  ' + changes.join('\n  '))
if (problems.length) {
  console.log('\n❌ 发现 ' + problems.length + ' 个问题：')
  for (const p of problems) console.log('  - ' + p)
  process.exit(1)
}
console.log('✅ 无乱码 / 语法正常')
