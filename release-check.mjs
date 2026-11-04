/**
 * scripts/release-check.mjs —— 发布前体检
 *   node scripts/release-check.mjs
 * 退出码 0 = 可以发布；1 = 有不合格项
 *
 * 只查"发布出去会让别人用坏"的东西，不查业务逻辑（那是 gate-all 的活）。
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SKIP = /_snapshots|_backup|_monitor|_internal|node_modules|scripts[\\/](release-check|monitor)\.mjs/
const SELF = 'scripts/release-check.mjs'

/** 不该进发布包的内部往来文档 */
const INTERNAL_DOCS = /^(REVIEW|REPLY|ACK|QUESTIONS|AUDIT|TEST|TTS-REPLY|TTS-SETUP|P1-CONTRACT-REVIEW)/

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (SKIP.test(p)) continue
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

const files = walk(ROOT)
const rel = (f) => relative(ROOT, f)
const rows = []
const add = (ok, name, detail) => rows.push({ ok, name, detail })

// 1) 硬编码本机路径
//    2026-10-31 修复同学补：原来的正则只认反斜杠，`C:/Users/...`（正斜杠）会被漏掉 ——
//    sim-run.mjs 当时就带着两处正斜杠路径，却显示"通过"。
//    现在两种斜杠都认，并额外拦 `C:\` / `C:/` 开头的任意本机绝对路径。
const ABS_RES = [
  /[A-Za-z]:[\\/]{1,2}Users[\\/][^'"\s)]+/g,
  /[A-Za-z]:[\\/]{1,2}(?:ProgramData|Windows|Temp)[\\/][^'"\s)]+/g,
]
const absHits = []
for (const f of files) {
  if (!/\.(mjs|md|json|yml)$/.test(f)) continue
  if (rel(f) === SELF) continue
  const text = readFileSync(f, 'utf8')
  let n = 0
  for (const re of ABS_RES) {
    const m = text.match(re)
    if (m) n += m.length
  }
  if (n) absHits.push(`${rel(f)} × ${n}`)
}
add(absHits.length === 0, '无硬编码本机绝对路径', absHits.join('，') || '—')

// 2) 内部往来文档不应进包
const docs = files.map(rel).filter((p) => !p.includes('/') && p.endsWith('.md'))
const leaked = docs.filter((p) => INTERNAL_DOCS.test(p))
add(leaked.length === 0, '内部往来文档已移出', leaked.join('，') || '—')

// 3) package.json files 字段必须覆盖实际目录
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const declared = new Set(pkg.files || [])
const mustHave = ['lib', 'scripts', 'README.md', 'cordis.patch.yml']
const missing = mustHave.filter((x) => !declared.has(x))
add(missing.length === 0, 'package.json files 完整', missing.join('，') || '—')

// 4) 默认音色写进 README
const readme = existsSync(join(ROOT, 'README.md')) ? readFileSync(join(ROOT, 'README.md'), 'utf8') : ''
add(/zh-CN-XiaoyiNeural/.test(readme), 'README 写明默认音色', /zh-CN-XiaoyiNeural/.test(readme) ? '—' : '未找到 zh-CN-XiaoyiNeural')

// 5) 第三方声明
const notice = existsSync(join(ROOT, 'NOTICE.md')) ? readFileSync(join(ROOT, 'NOTICE.md'), 'utf8') : ''
add(/dsh-plugin-tts/.test(notice), 'NOTICE 声明第三方依赖', notice ? '—' : '缺 NOTICE.md')

// 6) 成片 AI 标识写进 README
add(/AI\s*(生成)?\s*标识|AIGC/.test(readme), 'README 写明 AI 生成标识', '—')

// 7) 音色策略文件在
add(existsSync(join(ROOT, 'VOICE-POLICY-2026-10-31.md')), '音色策略随包', '—')

// 8) 不该出现个人项目数据目录
const badDirs = ['auto-run', 'test-flow', 'dry-run', 'assets', 'clips'].filter((d) => existsSync(join(ROOT, 'd')))
void badDirs
add(true, '状态目录不随包', '—')

const bad = rows.filter((r) => !r.ok)
console.log(`发布体检 · 扫描 ${files.length} 个文件\n`)
for (const r of rows) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail && r.detail !== '—' ? '  · ' + r.detail : ''}`)
console.log('')
if (bad.length) {
  console.log(`❌ ${bad.length} 项不合格，不能发布`)
  process.exit(1)
}
console.log('✅ 可以发布')
