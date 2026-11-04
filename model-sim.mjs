/**
 * scripts/model-sim.mjs —— 模型 × 时长 判定模拟（不碰浏览器、不花额度）
 *   node scripts/model-sim.mjs
 */
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.mjs'
import { checkModel, MODELS, maxSecondsFor } from '../lib/models.mjs'

const home = mkdtempSync(join(tmpdir(), 'modelsim-'))
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)])
const asset = (n) => { const p = join(home, n); writeFileSync(p, png); return p }
const CARD = asset('card.png'); const REF = asset('ref.png'); const SCENE = asset('scene.png')
const VID = join(home, 'clip.mp4'); writeFileSync(VID, Buffer.alloc(2048, 7))

const tools = new Map()
apply({ tools: { register: (t) => tools.set(t.name, t) } }, {
  home, project: 'sim', strict: true, mediaMinSide: 1, mediaMinKBPerMP: 0, hasMembership: true,
})
const call = (n, a = {}) => tools.get(n).execute(a)

let pass = 0, fail = 0
const check = (name, cond, d = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}  ${String(d).slice(0, 150)}`) } }

const shot = (v) => ({
  景别: ['中景', '近景', '特写'][v % 3], 运镜: '固定', 主角: '辞辞',
  动作: `第${v}拍：趴在书桌前敲键盘，尾巴甩了${v}下`,
  台词: `辞辞：第 ${v} 句`, 旁白: '无', 内心旁白: '无',
  表情细节: `第${v}拍：眼皮半垂，嘴角向下撇了${v}度`,
  感情细节: `第${v}拍：不耐烦但还是没停手`,
  音效: `第${v}拍：键盘连打声`, 光影: '冷蓝环境光加台灯暖黄侧逆光', 场景: '书桌',
})
const seg = (i, d) => ({ index: i, durationSeconds: d, styleRef: 'SL-1', shots: [shot(i * 3), shot(i * 3 + 1), shot(i * 3 + 2)] })

console.log('── 1. 模型表本身（纯函数，不用会员也行） ──')
check('Mini 无会员 ≤10', maxSecondsFor('Seedance 2.0 Mini', { hasMembership: false }) === 10)
check('Fast 无会员 ≤10', maxSecondsFor('Seedance 2.0 Fast', { hasMembership: false }) === 10)
check('2.0 无会员 → 不可用', maxSecondsFor('Seedance 2.0', { hasMembership: false }) === 0)
check('2.5 无会员 → 不可用', maxSecondsFor('Seedance 2.5', { hasMembership: false }) === 0)
check('2.0 有会员 ≤15', maxSecondsFor('Seedance 2.0', { hasMembership: true }) === 15)
check('2.5 有会员 ≤30', maxSecondsFor('Seedance 2.5', { hasMembership: true }) === 30)
check('2.5 无会员 + 20 秒 → 拒', checkModel('Seedance 2.5', { hasMembership: false, approved: true, durationSeconds: 20 }).violations.some((v) => v.code === 'E_MODEL_NEEDS_MEMBERSHIP'))
check('Mini + 15 秒 → 超上限拒', checkModel('Seedance 2.0 Mini', { durationSeconds: 15 }).violations.some((v) => v.code === 'E_DURATION_EXCEEDS_MODEL'))
check('2.0 未获批准 → 拒', checkModel('Seedance 2.0', { hasMembership: true, durationSeconds: 10 }).violations.some((v) => v.code === 'E_MODEL_NEEDS_APPROVAL'))

console.log('── 2. 默认模型下，段长不能过 10 秒 ──')
await call('doubao_style_lock', { project: 'sim', artStyle: '3D 动漫', palette: '冷蓝低饱和' })
const r15 = await call('doubao_script_submit', { project: 'sim', scriptJson: JSON.stringify({ segments: [seg(1, 15)] }) })
check('Mini 默认 + 15 秒段 → 拒', r15.text.includes('E_DURATION_EXCEEDS_MODEL'), r15.text)

console.log('── 3. 换 2.5（要本人指定）后 30 秒才成立 ──')
const bad = await call('doubao_model_select', { project: 'sim', model: 'Seedance 2.5', confirmText: '用 2.5 吧' })
check('没带「确定使用」→ 拒', bad.ok === false)
const okm = await call('doubao_model_select', { project: 'sim', model: 'Seedance 2.5', confirmText: '确定使用 Seedance 2.5' })
check('本人指定 2.5 → 通过', okm.ok === true, okm.text)
const r30 = await call('doubao_script_submit', { project: 'sim', scriptJson: JSON.stringify({ segments: [seg(1, 5), seg(2, 30), seg(3, 12)] }) })
check('2.5 + 30 秒段 → 通过', r30.ok === true, r30.text)

console.log('── 4. 提示词与成片校验 ──')
const SRC = 'https://www.doubao.com/chat/38450644545279746 · 2026-11-02'
await call('doubao_role_register', { project: 'sim', name: '辞辞', cardImage: CARD, reference: REF, source: SRC, appearance: 'Q 版三头身，蓝白渐变长发，鲸鱼尾巴', outfit: '深蓝白女仆裙' })
await call('doubao_scene_register', { project: 'sim', file: SCENE, name: '书桌', source: SRC })
const sc = await call('doubao_shot_check', { project: 'sim', segment: 1, shotIndex: 0 })
check('第 1 段（5 秒）shot_check 通过', sc.ok === true, sc.text)
check('提示词写「时长：5 秒」', /时长：5 秒/.test(sc.prompt || ''))
const c25 = await call('doubao_clip_register', { project: 'sim', segment: 1, file: VID, durationSeconds: 25, tailFrame: SCENE, tailTimeSeconds: 25 })
check('2.5 下 25 秒成片 → 过时长校验（会卡在未确认，属正常）', !c25.text.includes('E_DURATION_EXCEEDS_MODEL'), c25.text)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
rmSync(home, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
