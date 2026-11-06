process.env.DOUBAO_SKIP_SCRIPT_REVIEW = '1'
/**
 * scripts/flow-sim.mjs —— 全链路内部模拟（不碰豆包、不花额度）
 * 顺序严格照真实流水：每段必须「上一段登记完 → 才能 shot_check 下一段」。
 */
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { apply } from '../lib/index.mjs'
import { speak } from '../lib/tts.mjs'
import { buildCues as buildCuesLib, burn as burnLib } from '../lib/subtitle.mjs'

const home = mkdtempSync(join(tmpdir(), 'flowsim-'))
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)])
const mk = (n) => { const p = join(home, n); writeFileSync(p, png); return p }
const CARD = mk('辞辞-三视图.png'); const REF = mk('辞辞_参考图.png'); const SCENE = mk('书桌.png')
const SRC = 'https://www.doubao.com/chat/38450644545279746 · 2026-11-02'
const mkvid = (f, s, c) => { spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', `color=c=${c}:s=360x640:d=${s}`, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', String(s), f], { windowsHide: true }); return f }
const tail = (v, o) => { spawnSync('ffmpeg', ['-y', '-sseof', '-0.2', '-i', v, '-frames:v', '1', o], { windowsHide: true }); return o }

const tools = new Map()
apply({ tools: { register: (t) => tools.set(t.name, t) } }, {
  home, project: 'flow', strict: true, hasMembership: true, mediaMinSide: 1, mediaMinKBPerMP: 0,
})
const call = (n, a = {}) => tools.get(n).execute(a)
const pf = join(home, 'projects', 'flow.json')
const markSent = (seg) => {
  const j = JSON.parse(readFileSync(pf, 'utf8')); const now = new Date().toISOString()
  j.pending[String(seg)].confirmedAt = now; j.pending[String(seg)].sentAt = now
  writeFileSync(pf, JSON.stringify(j, null, 2), 'utf8')
}

let pass = 0, fail = 0
const t = (n, c, d = '') => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}  ${String(d).slice(0, 140)}`) } }
const shot = (v) => ({
  景别: ['中景', '近景', '特写'][v % 3], 运镜: '固定', 主角: '辞辞',
  动作: `第${v}拍：趴在书桌前敲键盘，尾巴甩了${v}下`,
  台词: (v % 3 === 0 ? `辞辞：第 ${v} 句台词` : '无'), 旁白: '无', 内心旁白: '无',
  表情细节: `第${v}拍：眼皮半垂，嘴角向下撇了${v}度`,
  感情细节: `第${v}拍：不耐烦但还是没停手`,
  音效: `第${v}拍：键盘连打声`, 光影: '冷蓝环境光加台灯暖黄侧逆光', 场景: '书桌',
})
const seg = (i, d) => ({ index: i, durationSeconds: d, styleRef: 'SL-1', shots: [shot(i * 3), shot(i * 3 + 1), shot(i * 3 + 2)] })

console.log('── 0. 环境 ──')
t('status 有环境自检', /环境：.*ffmpeg/.test((await call('doubao_status', { project: 'flow' })).text))

console.log('── 1. 风格锁 + 脚本（默认 Mini，2×8 秒） ──')
await call('doubao_style_lock', { project: 'flow', artStyle: '3D 动漫（非写实）', palette: '冷蓝低饱和' })
const sub = await call('doubao_script_submit', { project: 'flow', scriptJson: JSON.stringify({ segments: [seg(1, 8), seg(2, 8)] }) })
t('8 秒 ×2 段在 Mini 下通过', sub.ok === true, sub.text)

console.log('── 2. 素材 ──')
t('角色登记', (await call('doubao_role_register', { project: 'flow', name: '辞辞', cardImage: CARD, reference: REF, source: SRC, appearance: 'Q 版三头身，蓝白渐变长发，鲸鱼尾巴', outfit: '深蓝白女仆裙' })).ok)
t('场景登记', (await call('doubao_scene_register', { project: 'flow', file: SCENE, name: '书桌', source: SRC })).ok)

console.log('── 3. 第 1 段：完整闭环 ──')
const s1 = await call('doubao_shot_check', { project: 'flow', segment: 1, shotIndex: 0 })
t('shot_check 通过', s1.ok === true, s1.text)
t('提示词「时长：8 秒」', /时长：8 秒/.test(s1.prompt || ''))
t('提示词带 @ 两行', /@书桌/.test(s1.prompt || '') && /@辞辞/.test(s1.prompt || ''), (s1.prompt || '').slice(0, 60))
const a1 = await call('doubao_prompt_audit', { project: 'flow', segment: 1, shotIndex: 0, promptText: s1.prompt, uploadedFiles: `${SCENE};${REF}` })
t('审计通过', a1.ok === true, a1.text)
t('首次确认通过', (await call('doubao_generate_confirm', { project: 'flow', segment: 1, confirmText: '确定生成视频', auditHash: a1.auditHash })).ok === true)
t('状态显示已授权', /授权：已授权/.test((await call('doubao_status', { project: 'flow' })).text))
markSent(1)
const v1 = mkvid(join(home, 'c1.mp4'), 8, '0x223344')
const r1 = await call('doubao_clip_register', { project: 'flow', segment: 1, file: v1, durationSeconds: 8, tailFrame: tail(v1, join(home, 't1.png')), tailTimeSeconds: 8 })
t('第 1 段登记', r1.ok === true, r1.text)

console.log('── 4. 第 2 段：沿用授权，不再问本人 ──')
const s2 = await call('doubao_shot_check', { project: 'flow', segment: 2, shotIndex: 0 })
t('第 2 段 shot_check 通过（吃到第 1 段尾帧）', s2.ok === true, s2.text)
const a2 = await call('doubao_prompt_audit', { project: 'flow', segment: 2, shotIndex: 0, promptText: s2.prompt, uploadedFiles: `${SCENE};${REF};${join(home, 't1.png')}` })
t('第 2 段审计通过', a2.ok === true, a2.text)
const c2 = await call('doubao_generate_confirm', { project: 'flow', segment: 2, confirmText: '', auditHash: a2.auditHash })
t('第 2 段**不带确认语**也放行', c2.ok === true && /沿用首次授权/.test(c2.text), c2.text)
markSent(2)
const v2 = mkvid(join(home, 'c2.mp4'), 8, '0x442233')
t('第 2 段登记', (await call('doubao_clip_register', { project: 'flow', segment: 2, file: v2, durationSeconds: 8, tailFrame: tail(v2, join(home, 't2.png')), tailTimeSeconds: 8 })).ok === true)

console.log('── 5. 拼接 + 字幕 + 语音 ──')
// 2026-11-04 新增：烧字幕前必须先人工确认声音方案
const ac = await call('doubao_audio_confirm', { project: 'flow', mode: 'original', confirmText: '确定使用豆包原声' })
t('声音方案已确认（豆包原声）', ac.ok === true, ac.text)
const cat = await call('doubao_concat', { project: 'flow' })
t('拼接成功', cat.ok === true, cat.text)
// 2026-11-04：doubao_subtitle 已并入 doubao_asr_subtitle（ASR 方案，依赖 python）。
// flow-sim 不依赖 python，这里直接调 lib 验证烧制链路。
const _cues = buildCuesLib([{ index: 1, durationSeconds: 6, shots: [{ 台词: '辞辞：测试一句' }] }])
const sb = burnLib({ video: join(home, 'clips', '成片.mp4'), cues: _cues, out: join(home, 'subs.mp4') })
t('字幕烧制（不走 drawtext）', sb.ok === true, sb.stderr || '')
const sp = await speak({ text: '就这点活还想让我加班', outFile: join(home, 'v.mp3') })
t('语音合成（本地 TTS）', sp.ok === true, sp.hint || '')

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
rmSync(home, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
