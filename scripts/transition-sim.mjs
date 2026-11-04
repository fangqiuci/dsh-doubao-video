import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { concatCut, probe } from '../lib/ffmpeg.mjs'

const home = mkdtempSync(join(tmpdir(), 'transim-'))
const mk = (f, s) => { spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', `color=c=0x223344:s=640x360:d=${s}`, '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', String(s), f], { windowsHide: true }); return f }
const a = mk(join(home, 'a.mp4'), 4)
const b = mk(join(home, 'b.mp4'), 4)
const c = mk(join(home, 'c.mp4'), 4)

let pass = 0, fail = 0
const t = (n, cond, d = '') => { if (cond) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}  ${String(d).slice(0, 200)}`) } }

console.log('── 无转场（基线） ──')
const r0 = concatCut([a, b], join(home, 'n.mp4'), { overlapMs: 0 })
t('硬切 8 秒', r0.ok && Math.abs(Number(r0.meta?.duration) - 8) < 0.2, r0.meta?.duration)
t('transition=null', r0.transition === null)

console.log('── fade 转场 ──')
const r1 = concatCut([a, b], join(home, 'f.mp4'), { overlapMs: 0, transition: 'fade', transitionMs: 500 })
t('拼接成功', r1.ok === true, r1.error)
t('时长 ≈ 4+4-0.5 = 7.5', r1.ok && Math.abs(Number(r1.meta?.duration) - 7.5) < 0.3, r1.meta?.duration)
t('返回值带转场信息', r1.transition?.type === 'fade' && r1.transition?.ms === 500, JSON.stringify(r1.transition))

console.log('── 三段链式转场 ──')
const r2 = concatCut([a, b, c], join(home, 'f3.mp4'), { overlapMs: 0, transition: 'fade', transitionMs: 500 })
t('三段拼接成功', r2.ok === true, r2.error)
t('时长 ≈ 12-1.0 = 11', r2.ok && Math.abs(Number(r2.meta?.duration) - 11) < 0.4, r2.meta?.duration)

console.log('── 转场 + 16:9 ──')
const r3 = concatCut([a, b], join(home, 'f16.mp4'), { width: 1920, height: 1080, overlapMs: 0, transition: 'fade', transitionMs: 400 })
const m3 = probe(join(home, 'f16.mp4'))
t('16:9 + 转场都生效', r3.ok && m3?.width === 1920 && m3?.height === 1080, `${m3?.width}x${m3?.height}`)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
rmSync(home, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
