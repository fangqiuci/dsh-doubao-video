import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { concatCut } from '../lib/ffmpeg.mjs'
import { buildCues, burn } from '../lib/subtitle.mjs'

const home = mkdtempSync(join(tmpdir(), 'pixsim-'))
const mk = (f, s, c) => { spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', `color=c=${c}:s=640x360:d=${s}`, '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', String(s), f], { windowsHide: true }); return f }
const pix = (f) => spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=pix_fmt', '-of', 'csv=p=0', f], { encoding: 'utf8' }).stdout.trim()

let pass = 0, fail = 0
const t = (n, c, d = '') => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}  ${d}`) } }

const a = mk(join(home, 'a.mp4'), 3, '0x223344')
const b = mk(join(home, 'b.mp4'), 3, '0x442233')

console.log('── 转场拼接 ──')
const r1 = concatCut([a, b], join(home, 'fade.mp4'), { width: 1080, height: 1920, overlapMs: 0, transition: 'fade', transitionMs: 400 })
t('拼接成功', r1.ok === true, r1.error)
t('输出是 yuv420p（不是 4:4:4）', pix(join(home, 'fade.mp4')) === 'yuv420p', pix(join(home, 'fade.mp4')))

console.log('── 硬切拼接 ──')
const r2 = concatCut([a, b], join(home, 'hard.mp4'), { width: 1080, height: 1920, overlapMs: 40 })
t('拼接成功', r2.ok === true, r2.error)
t('输出是 yuv420p', pix(join(home, 'hard.mp4')) === 'yuv420p', pix(join(home, 'hard.mp4')))

console.log('── 字幕烧制 ──')
const cues = buildCues([{ index: 1, durationSeconds: 4, shots: [{ 台词: '辞辞：测试一句' }] }])
const r3 = burn({ video: join(home, 'hard.mp4'), cues, out: join(home, 'sub.mp4') })
t('烧字幕成功', r3.ok === true, r3.stderr)
t('输出是 yuv420p', pix(join(home, 'sub.mp4')) === 'yuv420p', pix(join(home, 'sub.mp4')))

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
rmSync(home, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
