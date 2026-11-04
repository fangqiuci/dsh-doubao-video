import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { timelineFromScript, mixDubbing, cuesToScript } from '../lib/dub.mjs'

const home = mkdtempSync(join(tmpdir(), 'dubsim-'))
const ff = (args) => spawnSync('ffmpeg', args, { windowsHide: true })
const mkv = (f, s) => { ff(['-y', '-f', 'lavfi', '-i', `color=c=0x223344:s=640x360:d=${s}`, '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', String(s), f]); return f }
const mka = (f, s) => { ff(['-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${s}`, '-c:a', 'libmp3lame', f]); return f }
const dur = (f) => Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', f], { encoding: 'utf8' }).stdout.trim())
const hasAudio = (f) => spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', f], { encoding: 'utf8' }).stdout.trim().length > 0

let pass = 0, fail = 0
const t = (n, c, d = '') => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}  ${String(d).slice(0, 160)}`) } }

console.log('── 时间轴 ──')
const segs = [
  { index: 1, durationSeconds: 10, shots: [{ 台词: '无', 旁白: '无', 内心旁白: '无' }, { 台词: '辞辞：就这点活', 旁白: '无' }, { 台词: '无' }] },
  { index: 2, durationSeconds: 6, shots: [{ 台词: '无' }, { 台词: '辞辞：再干五分钟' }] },
]
const cues = timelineFromScript(segs)
t('只给有词的镜头建条目', cues.length === 2, JSON.stringify(cues))
t('第 2 个镜头从 3.33s 起（10s 段 3 分镜）', Math.abs(cues[0].start - 3.333) < 0.01, cues[0].start)
t('台词优先于旁白', cues[0].text.includes('就这点活'))
t('第 2 段第 2 镜头起点 = 10 + 3 = 13s', Math.abs(cues[1].start - 13) < 0.01, cues[1].start)

console.log('── replace：配音铺到时间轴 ──')
const v = mkv(join(home, 'base.mp4'), 10)
const a1 = mka(join(home, 'l1.mp3'), 1)
const a2 = mka(join(home, 'l2.mp3'), 1)
const r1 = mixDubbing({ video: v, mode: 'replace', lines: [{ file: a1, start: 3.3 }, { file: a2, start: 7 }], out: join(home, 'o1.mp4') })
t('合成成功', r1.ok === true, r1.error)
t('时长保持 10 秒（不被配音拉长）', Math.abs(dur(join(home, 'o1.mp4')) - 10) < 0.4, dur(join(home, 'o1.mp4')))
t('有音轨', hasAudio(join(home, 'o1.mp4')))

console.log('── keep：保留原声 + BGM ──')
const bgm = mka(join(home, 'bgm.mp3'), 3)
const r2 = mixDubbing({ video: v, mode: 'keep', bgm, bgmDb: -18, out: join(home, 'o2.mp4') })
t('keep 模式成功', r2.ok === true, r2.error)
t('keep 时长 10 秒', Math.abs(dur(join(home, 'o2.mp4')) - 10) < 0.4, dur(join(home, 'o2.mp4')))

console.log('── 边界 ──')
const r3 = mixDubbing({ video: v, mode: 'keep', bgm: null, out: join(home, 'o3.mp4') })
t('keep 又没 BGM → 拒绝', r3.ok === false)
const r4 = mixDubbing({ video: v, mode: 'replace', lines: [], out: join(home, 'o4.mp4') })
t('replace 没配音 → 拒绝', r4.ok === false)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
rmSync(home, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
