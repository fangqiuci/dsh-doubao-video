/**
 * scripts/ffmpeg-selftest.mjs —— 后期底座自测（不需要 DSH、不需要外部素材）
 *   node scripts/ffmpeg-selftest.mjs
 *
 * 为什么自带素材（2026-10-31 主作者指出）：
 *   以前它依赖 clips/test10s.mp4 这种手工文件，素材一清就"零覆盖"——
 *   而 ffmpeg.mjs 恰恰是改过的高风险模块（尾帧静默失败那个 bug 就在这）。
 *   所以现在用 lavfi 现场造两条 10 秒片，跑完自动删。
 *
 * 覆盖：
 *   version → 造素材 → probe → tailFrame（默认口径）→ tailFrame（越界口径，验"不许假成功"）
 *   → concat → 清理
 * 退出码 0 = 全绿；1 = 有失败
 */
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { version, probe, tailFrame, concat, findFfmpeg } from '../lib/ffmpeg.mjs'

const dir = mkdtempSync(join(tmpdir(), 'dsh-ffmpeg-selftest-'))
const ff = findFfmpeg()
let failures = 0

const check = (name, ok, extra = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` · ${extra}` : ''}`)
  if (!ok) failures += 1
}

if (!ff) {
  console.log('❌ 找不到 ffmpeg')
  process.exit(1)
}

/** 造一条 10 秒、720×1280、带一条正弦音轨的测试片 */
function makeClip(out, color, freq) {
  const r = spawnSync(ff, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=c=${color}:s=720x1280:d=10:r=30`,
    '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=10`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast',
    '-c:a', 'aac', '-shortest',
    out,
  ], { encoding: 'utf8', windowsHide: true })
  return { ok: r.status === 0 && existsSync(out), err: (r.stderr || '').slice(0, 200) }
}

const a = join(dir, 'a.mp4')
const b = join(dir, 'b.mp4')
const out = join(dir, 'concat.mp4')

const v = version()
check('ffmpeg 可用', v.ok, v.ok ? v.version.split(' ').slice(0, 3).join(' ') : 'NOT FOUND')
if (!v.ok) process.exit(1)

const ma = makeClip(a, 'navy', 440)
check('造素材 A（10s / 720x1280 / 有声）', ma.ok, ma.ok ? '' : ma.err)
const mb = makeClip(b, 'darkgreen', 554)
check('造素材 B', mb.ok, mb.ok ? '' : mb.err)
if (!ma.ok || !mb.ok) { rmSync(dir, { recursive: true, force: true }); process.exit(1) }

const pa = probe(a)
check('probe 时长/分辨率/音轨',
  pa.ok && Math.abs(pa.duration - 10) < 0.3 && pa.width === 720 && pa.height === 1280 && pa.hasAudio,
  `dur=${Number(pa.duration || 0).toFixed(2)} ${pa.width}x${pa.height} audio=${pa.hasAudio}`)

// 默认口径：片尾前 0.05s —— 这就是曾经的 bug 点（ffmpeg 退出 0 但没写文件）
const t1 = join(dir, 'tail-default.png')
const r1 = tailFrame(a, t1, {})
const s1 = r1.ok && existsSync(t1) ? statSync(t1).size : 0
check('tailFrame 默认口径真的落盘', r1.ok && s1 > 0, `at=${Number(r1.at || 0).toFixed(2)}s size=${s1}`)

// 越界口径：给一个超过时长的时刻，**不允许**出现"报成功但文件不存在"
const t2 = join(dir, 'tail-oob.png')
const r2 = tailFrame(a, t2, { atSeconds: Number(pa.duration) + 0.5 })
const s2 = existsSync(t2) ? statSync(t2).size : 0
const honest = !(r2.ok && s2 === 0)
check('tailFrame 越界时不许假成功', honest, r2.ok ? `ok 且有文件（${s2} 字节）` : `干净失败：${String(r2.error).slice(0, 40)}`)

// 拼接
const c = concat([a, b], out, { width: 720, height: 1280 })
const pc = c.ok ? probe(out) : { ok: false, duration: 0 }
check('concat 输出真存在且时长≈20s', c.ok && existsSync(out) && Math.abs(Number(pc.duration) - 20) < 1.2,
  `dur=${Number(pc.duration || 0).toFixed(2)}`)

rmSync(dir, { recursive: true, force: true })
console.log(failures ? `\n❌ ${failures} 项失败` : '\n✅ 后期底座全部通过')
process.exit(failures ? 1 : 0)
