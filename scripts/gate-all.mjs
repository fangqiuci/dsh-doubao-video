/**
 * scripts/gate-all.mjs —— 准入线一键跑
 *   node scripts/gate-all.mjs
 *
 * 编号（2026-10-31 助手 3 在 AUDIT 里指出本文件曾自相矛盾，现统一）：
 *   ① 语法全量（lib + scripts）       —— 必需
 *   ② monitor（乱码 + 语法 + 指纹）    —— 必需
 *   ③ selfcheck（36 项规则）           —— 必需
 *   ④ smoke（18 步 / 10 of 18 工具）   —— 必需（注意：10 是工具数，18 是步数）
 *   ⑤ ffmpeg-selftest（7 项）          —— 必需
 *   ⑥ audio-selftest（音频三件套）      —— 可选：文件不存在只打 ⏳，一出现自动生效
 *   ⑦ 浏览器真机（sim-run --live）      —— 不在本脚本内，发版前人工跑
 *
 * 为什么保留全量语法检查：monitor.mjs 至今只扫 `lib/`，`scripts/` 没人管；
 * 在它扩到 scripts/ 之前，这条不能撤（主作者在 ANSWER 第 4 条里也是这个意见）。
 *
 * 退出码：0 = 必需项全绿；1 = 有失败（按 RECOVERY 的回滚判据处理）
 */
import { spawnSync } from 'node:child_process'
import { readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/* ── 第 0 步：全量语法检查（lib + scripts）──────────────────────
 * 主作者第 4 条：monitor 只扫 lib/，直接删 node --check 会让 scripts/ 裸奔。
 * 所以这里补一条全量检查，覆盖两个目录下所有 .mjs。 */
function syntaxAll() {
  const dirs = [join(ROOT, 'lib'), join(ROOT, 'scripts')]
  const files = []
  for (const d of dirs) {
    for (const f of readdirSync(d)) if (f.endsWith('.mjs')) files.push(join(d, f))
  }
  const bad = []
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8', windowsHide: true })
    if (r.status !== 0) bad.push(f.replace(ROOT + '\\', ''))
  }
  return { ok: bad.length === 0, count: files.length, bad }
}

const syn = syntaxAll()
console.log(`${syn.ok ? '✅' : '❌'} 语法（lib + scripts 共 ${syn.count} 个 .mjs）${syn.ok ? '' : '：' + syn.bad.join(', ')}`)

const steps = [
  ['monitor（乱码 + 语法 + 指纹）', 'monitor.mjs', true],
  ['selfcheck（36 项规则）', 'selfcheck.mjs', true],
  ['smoke（18 步 / 10 of 18 工具，浏览器 5 个不覆盖）', 'smoke.mjs', true],
  ['ffmpeg-selftest（7 项，含越界不许假成功）', 'ffmpeg-selftest.mjs', true],
  // 第 6 条：音频流水线自测。主作者在 AUDIO-PLAN v2 里负责写它，P2 之后才就绪。
  // 文件不存在时**跳过不报错**（否则插件还没做音频就先红），存在就必须绿。
  ['audio-selftest（音频三件套）', 'audio-selftest.mjs', false],
]

let failed = syn.ok ? 0 : 1
const results = []
for (const [label, file, required] of steps) {
  if (!existsSync(join(ROOT, 'scripts', file))) {
    if (required) {
      failed += 1
      console.log(`❌ ${label} · 文件缺失（这条是必需项）`)
    } else {
      console.log(`⏳ ${label} · 尚未就绪（可选；写好之后自动进准入线）`)
    }
    continue
  }
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', file)], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 900000,
  })
  const out = `${r.stdout || ''}\n${r.stderr || ''}`.split('\n').map((s) => s.trim()).filter(Boolean)
  const last = out[out.length - 1] || ''
  const ok = r.status === 0
  if (!ok) failed += 1
  results.push({ label, ok, last })
  console.log(`${ok ? '✅' : '❌'} ${label} · ${last}`)
}

console.log('')
if (failed) {
  console.log(`❌ ${failed} 条准入线失败 —— 按回滚判据处理（见 RECOVERY-2026-10-31.md）`)
  process.exit(1)
}
console.log('✅ 离线准入线①-⑤全绿（⑥可选、⑦人工）')
console.log('   ①语法全量 ②monitor ③selfcheck ④smoke ⑤ffmpeg-selftest（⑥audio-selftest 就绪后自动加入）')
console.log('⚠️  ⑦ 浏览器层没有离线覆盖 —— 发版前必须人工跑一次：')
console.log('   node scripts/sim-run.mjs --live')
console.log('   跑完把「卡片数变化 / 出片耗时 / 下载第几次尝试」记进 RECOVERY-2026-10-31.md')
