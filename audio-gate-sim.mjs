import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { apply } from '../lib/index.mjs'
import { timelineFromClips } from '../lib/dub.mjs'

const home = mkdtempSync(join(tmpdir(), 'audio-'))
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)])
const mk = (n) => { const p = join(home, n); writeFileSync(p, png); return p }
const CARD = mk('辞辞-三视图.png'); const REF = mk('辞辞_参考图.png'); const SCENE = mk('书桌.png')
const VID = join(home, 'c1.mp4')
spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=0x223344:s=320x240:d=6', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', '6', VID], { windowsHide: true })
const SRC = 'https://www.doubao.com/chat/1 · 2026-11-04'

const tools = new Map()
apply({ tools: { register: (x) => tools.set(x.name, x) } }, { home, project: 'au', strict: true, hasMembership: true, mediaMinSide: 1, mediaMinKBPerMP: 0 })
const call = (n, a = {}) => tools.get(n).execute(a)
let pass = 0, fail = 0
const t = (n, c, d = '') => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}  ${String(d).slice(0, 150)}`) } }

const shot = (v) => ({ 景别: '中景', 运镜: '固定', 主角: '辞辞', 动作: `第${v}拍：趴在书桌前敲键盘`, 台词: `辞辞：第 ${v} 句`, 旁白: '无', 内心旁白: '无', 表情细节: `第${v}拍：眼皮半垂`, 感情细节: `第${v}拍：不耐烦`, 音效: `第${v}拍：键盘连打声`, 光影: '冷蓝环境光加台灯暖黄侧逆光', 场景: '书桌' })
const seg = (i, d) => ({ index: i, durationSeconds: d, styleRef: 'SL-1', shots: [shot(i), shot(i + 1)] })

await call('doubao_style_lock', { project: 'au', artStyle: '3D 动漫', palette: '冷蓝低饱和', characterScale: '中景约 1/2 画面高' })
await call('doubao_script_submit', { project: 'au', scriptJson: JSON.stringify({ segments: [seg(1, 6), seg(2, 6)] }) })
await call('doubao_role_register', { project: 'au', name: '辞辞', cardImage: CARD, reference: REF, source: SRC, appearance: 'Q 版三头身，蓝白渐变长发', outfit: '女仆裙' })
await call('doubao_scene_register', { project: 'au', file: SCENE, name: '书桌', source: SRC })

console.log('── ① 声音方案闸 ──')
const bad1 = await call('doubao_audio_confirm', { project: 'au', mode: 'dub', confirmText: '用配音吧' })
t('没说「确定使用后期配音」→ 拒', bad1.ok === false)
const noConfirm = await call('doubao_asr_subtitle', { project: 'au', video: VID })
t('没确认方案就烧字幕 → 拒', noConfirm.ok === false && noConfirm.text.includes('doubao_audio_confirm'), noConfirm.text)
const dubNo = await call('doubao_dub', { project: 'au', video: VID })
t('没确认方案就配音 → 拒', dubNo.ok === false)

const okA = await call('doubao_audio_confirm', { project: 'au', mode: 'original', confirmText: '确定使用豆包原声' })
t('确认用豆包原声 → 通过', okA.ok === true, okA.text)
const dubWrong = await call('doubao_dub', { project: 'au', video: VID })
t('确认原声后再想重配 → 拒', dubWrong.ok === false && dubWrong.text.includes('豆包原声'), dubWrong.text)

console.log('── ② 时间轴按真实片段对齐 ──')
const segs = [{ index: 1, durationSeconds: 10, shots: [{ 台词: 'A' }, { 台词: 'B' }] }, { index: 2, durationSeconds: 10, shots: [{ 台词: 'C' }] }]
const planned = timelineFromClips(segs, {}, { overlapMs: 0 })
const real = timelineFromClips(segs, { 1: { durationSeconds: 8 }, 2: { durationSeconds: 9 } }, { overlapMs: 0 })
t('无真实时长 → 用计划值（标 estimated）', planned[0].estimated === true)
t('有真实时长 → 用真值', real[0].estimated === false)
t('真值更短，第 2 段起点前移（8 而非 10）', Math.abs(real[2].start - 8) < 0.01, String(real[2].start))
t('接缝扣 overlapMs', Math.abs(timelineFromClips(segs, { 1: { durationSeconds: 8 }, 2: { durationSeconds: 9 } }, { overlapMs: 40 })[2].start - 7.96) < 0.01)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
rmSync(home, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
