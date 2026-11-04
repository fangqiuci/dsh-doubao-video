import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { concatCut, probe } from '../lib/ffmpeg.mjs'
import { styleBlock, buildShotPrompt } from '../lib/rules.mjs'
import { resolveWH } from '../lib/index.mjs'

const home = mkdtempSync(join(tmpdir(), 'cutsim-'))
const mk = (f, s) => { spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', `color=c=0x223344:s=640x360:d=${s}`, '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', String(s), f], { windowsHide: true }); return f }
const a = mk(join(home, 'a.mp4'), 5)
const b = mk(join(home, 'b.mp4'), 8)

let pass = 0, fail = 0
const t = (n, c, d = '') => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}  ${String(d).slice(0, 160)}`) } }

console.log('── 1. concatCut 去重叠 ──')
const r1 = concatCut([a, b], join(home, 'o1.mp4'), { width: 1080, height: 1920, overlapMs: 40 })
t('拼接成功', r1.ok === true, r1.error)
t('时长 = 13.00 - 0.04 ≈ 12.96', r1.ok && Math.abs(Number(r1.meta?.duration) - 12.96) < 0.15, `实际 ${r1.meta?.duration}`)
t('记录裁掉 40ms', r1.ok && Math.round(r1.trimmedMs) === 40)

const r0 = concatCut([a, b], join(home, 'o0.mp4'), { overlapMs: 0 })
t('overlapMs=0 → 13.0 秒（不裁）', r0.ok && Math.abs(Number(r0.meta?.duration) - 13) < 0.15, `实际 ${r0.meta?.duration}`)

console.log('── 2. 粗剪 cuts ──')
const r2 = concatCut([a, b], join(home, 'o2.mp4'), { overlapMs: 0, cuts: [{ segment: 1, start: 1, trimEnd: 1 }, { segment: 2, trimEnd: 2 }] })
t('剪头尾成功', r2.ok === true, r2.error)
t('≈ 3 + 6 = 9 秒', r2.ok && Math.abs(Number(r2.meta?.duration) - 9) < 0.3, `实际 ${r2.meta?.duration}`)

console.log('── 3. 16:9 画幅 ──')
const wh = resolveWH('16:9')
t('16:9 → 1920x1080', wh.width === 1920 && wh.height === 1080)
t('9:16 → 1080x1920', resolveWH('9:16').width === 1080)
const r3 = concatCut([a, b], join(home, 'o3.mp4'), { width: 1920, height: 1080, overlapMs: 0 })
const m3 = probe(join(home, 'o3.mp4'))
t('成片真的是 1920x1080', m3?.width === 1920 && m3?.height === 1080, `${m3?.width}x${m3?.height}`)

console.log('── 4. 风格锁进提示词 ──')
const sb = styleBlock({ artStyle: 'Q版赛璐璐', palette: '冷蓝为主', material: 'PBR', lens: '固定机位', forbidden: '真人质感,字幕水印' })
t('styleBlock 有五行', sb.split('\n').length === 7, sb)
const prompt = buildShotPrompt({ 景别: '中景', 运镜: '固定', 主角: '辞辞', 动作: '敲键盘', 台词: '无', 旁白: '无', 内心旁白: '无', 表情细节: '垂眼', 感情细节: '不耐烦', 音效: '键盘声', 光影: '冷蓝', 场景: '书桌' }, {
  durationSeconds: 5, aspectRatio: '16:9', modelName: 'Seedance 2.0 Mini',
  styleLock: { artStyle: 'Q版赛璐璐', palette: '冷蓝为主', material: 'PBR', lens: '固定机位', forbidden: '真人质感' },
})
t('提示词带风格锁', prompt.includes('全片统一设定') && prompt.includes('美术风格：Q版赛璐璐'))
t('提示词带 16:9 画幅', prompt.includes('画幅：16:9'))
t('提示词无【】占位符', !/【|】/.test(prompt))

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
rmSync(home, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
