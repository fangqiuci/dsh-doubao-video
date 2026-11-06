/**
 * scripts/lines-loudness-sim.mjs —— 台词容量硬约束 + 响度平衡（2026-11-04）
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { checkScript } from '../lib/rules.mjs'
import { balanceAudio, measureLoudness } from '../lib/audio.mjs'

const home = mkdtempSync(join(tmpdir(), 'lines-'))
let pass = 0, fail = 0
const t = (n, c, d = '') => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}  ${String(d).slice(0, 160)}`) } }

const shot = (line) => ({ 景别: '中景', 运镜: '固定', 主角: '阿墨', 动作: '站在雨里等', 台词: line, 旁白: '无', 内心旁白: '无', 表情细节: '抬眼看天', 感情细节: '疲惫又倔', 音效: '雨打铁皮', 光影: '冷蓝环境光加台灯暖黄侧逆光', 场景: '雨夜天台' })
const seg = (i, dur, lines) => ({ index: i, durationSeconds: dur, styleRef: 'SL-1', shots: [shot(lines[0] || '无'), shot(lines[1] || '无'), shot(lines[2] || '无')] })
const opts = { segmentSeconds: 8, minSegmentSeconds: 5, maxSegmentSeconds: 30, minShotsPerSegment: 3, secondsPerLine: 2.5, usableRatio: 0.8 }

console.log('── 台词容量：8 秒最多几句 ──')
const one = checkScript({ segments: [seg(1, 8, ['阿墨：这雨没完了'])] }, opts)
t('1 句 → 通过', one.ok === true, JSON.stringify(one.violations))

const two = checkScript({ segments: [seg(1, 8, ['阿墨：这雨没完了', '阿墨：这是什么'])] }, opts)
t('2 句 → 通过但带 W_MULTI_LINES', two.ok === true && two.warnings.some((w) => w.code === 'W_ONLY_FIRST_SPOKEN'), JSON.stringify(two.warnings.map((w) => w.code)))

const three = checkScript({ segments: [seg(1, 8, ['阿墨：这雨没完了', '阿墨：这是什么', '阿墨：还挺可爱'])] }, opts)
t('3 句 / 8 秒 → 通过（物理装得下）+ 提醒只念第一句', three.ok === true && three.warnings.some((w) => w.code === 'W_ONLY_FIRST_SPOKEN'), JSON.stringify(three.warnings.map((w) => w.code)))
t('提醒里写清「只念 shot 0 的第一句」', /只念 shot 0 的第一句/.test(JSON.stringify(three.warnings)), JSON.stringify(three.warnings).slice(0, 200))

const long = checkScript({ segments: [seg(1, 20, ['A：一', 'B：二', 'C：三'])] }, opts)
t('20 秒 3 句 → 通过（塞得下）', long.ok === true, JSON.stringify(long.violations))

console.log('── 响度平衡 ──')
const src = join(home, 'loud.mp4')
// 造一条"很响"的素材：正弦 + 满音量
spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x223344:s=320x240:d=3',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-shortest',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-af', 'volume=8dB', src], { windowsHide: true })

const before = measureLoudness(src)
t('能量测改前响度', Number.isFinite(before.inputI), JSON.stringify(before))

const out = join(home, 'bal.mp4')
const r = balanceAudio({ video: src, out, mode: 'voice', targetLufs: -16 })
t('平衡成功', r.ok === true, r.error)
t('输出文件存在', r.ok && existsSync(out))

const after = measureLoudness(out)
t('改后响度更接近 -16', Number.isFinite(after.inputI) && Math.abs(after.inputI + 16) < Math.abs((before.inputI ?? 0) + 16), `before=${before.inputI} after=${after.inputI}`)

const mixOut = join(home, 'mix.mp4')
const r2 = balanceAudio({ video: src, out: mixOut, mode: 'mix' })
t('mix 模式也能跑', r2.ok === true, r2.error)
t('mix 不加人声滤镜（没有 equalizer）', !r2.filters.includes('equalizer'), r2.filters)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
rmSync(home, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
