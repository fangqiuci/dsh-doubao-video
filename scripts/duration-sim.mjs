/**
 * scripts/duration-sim.mjs —— 时长区间（5–30s）+ 最近三次修复的内部模拟
 *   node scripts/duration-sim.mjs
 * 负向用例放独立项目，避免把同一个闸门的重试次数耗光。
 */
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.mjs'

const home = mkdtempSync(join(tmpdir(), 'dursim-'))
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)])
const asset = (n) => { const p = join(home, n); writeFileSync(p, png); return p }
const CARD = asset('card.png'); const REF = asset('ref.png'); const SCENE = asset('scene.png')
const VID = join(home, 'clip.mp4'); writeFileSync(VID, Buffer.alloc(2048, 7))
const VID2 = join(home, 'clip2.mp4'); writeFileSync(VID2, Buffer.alloc(4096, 9))

const tools = new Map()
apply({ tools: { register: (t) => tools.set(t.name, t) } }, {
  home, project: 'sim', strict: true, mediaMinSide: 1, mediaMinKBPerMP: 0,
})
const call = (n, a = {}) => { const t = tools.get(n); if (!t) throw new Error('no tool ' + n); return t.execute(a) }

// 每段内容必须不同，否则会被 E_SEGMENT_DUPLICATE 拦（这条规则本来就在）
const shot = (v) => ({
  景别: ['中景', '近景', '特写'][v % 3], 运镜: '固定', 主角: '辞辞',
  动作: `第${v}拍：趴在书桌前敲键盘，尾巴甩了${v}下又停住`,
  台词: `辞辞：这是第 ${v} 句台词`,
  旁白: '无', 内心旁白: '无',
  表情细节: `第${v}拍：眼皮半垂，嘴角向下撇了${v}度`,
  感情细节: `第${v}拍：不耐烦但还是没停手，心里数着秒`,
  音效: `第${v}拍：键盘连打声、台灯轻嗡`,
  光影: '冷蓝环境光加台灯暖黄侧逆光',
  场景: '书桌',
})
const seg = (idx, dur) => ({ index: idx, durationSeconds: dur, styleRef: 'SL-1', shots: [shot(idx * 3), shot(idx * 3 + 1), shot(idx * 3 + 2)] })

let pass = 0, fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}  ${String(detail).slice(0, 160)}`) }
}

console.log('── 1. 时长区间（独立项目，不消耗主线重试） ──')
await call('doubao_style_lock', { project: 'neg', artStyle: '3D 动漫', palette: '冷蓝低饱和' })
const r4 = await call('doubao_script_submit', { project: 'neg', scriptJson: JSON.stringify({ segments: [seg(1, 4)] }) })
check('4 秒 → 拒（E_SEGMENT_DURATION）', r4.text.includes('E_SEGMENT_DURATION'))
const r31 = await call('doubao_script_submit', { project: 'neg', scriptJson: JSON.stringify({ segments: [seg(1, 31)] }) })
check('31 秒 → 拒（E_SEGMENT_DURATION）', r31.text.includes('E_SEGMENT_DURATION'))

console.log('── 2. 合法混合时长 ──')
await call('doubao_style_lock', { project: 'sim', artStyle: '3D 动漫', palette: '冷蓝低饱和' })
const ok = await call('doubao_script_submit', { project: 'sim', scriptJson: JSON.stringify({ segments: [seg(1, 30), seg(2, 5), seg(3, 12)] }) })
check('5 / 30 / 12 秒混合 → 通过', ok.ok === true, ok.text)

console.log('── 3. 素材登记 ──')
const SRC = 'https://www.doubao.com/chat/38450644545279746 · 2026-11-02'
check('角色登记', (await call('doubao_role_register', { project: 'sim', name: '辞辞', cardImage: CARD, reference: REF, source: SRC, appearance: 'Q 版三头身，蓝白渐变长发，鲸鱼尾巴', outfit: '深蓝白女仆裙' })).ok)
check('场景登记', (await call('doubao_scene_register', { project: 'sim', file: SCENE, name: '书桌', source: SRC })).ok)

console.log('── 4. 30 秒段的提示词 ──')
const sc = await call('doubao_shot_check', { project: 'sim', segment: 1, shotIndex: 0 })
check('shot_check 通过', sc.ok === true, sc.text)
check('提示词写着「时长：30 秒」', /时长：30 秒/.test(sc.prompt || ''))
const au = await call('doubao_prompt_audit', { project: 'sim', segment: 1, shotIndex: 0, promptText: sc.prompt, uploadedFiles: `${SCENE};${REF}` })
check('审计通过', au.ok === true, au.text)

console.log('── 5. 确认 ≠ 已发送 ──')
const cf = await call('doubao_generate_confirm', { project: 'sim', segment: 1, confirmText: '确定生成视频', auditHash: au.auditHash })
const st = await call('doubao_status', { project: 'sim' }); void ( '| [status]', st.text.replace(/\n/g,' / ').slice(0,320))
check('状态显示「已确认待发送」', /已确认待发送/.test(st.text), (st.text.match(/第 2 段：.*/) || [''])[0])
check('状态有环境自检行', /环境：/.test(st.text))

console.log('── 6. 片段时长 / 尾帧基准 ──')
const c31 = await call('doubao_clip_register', { project: 'sim', segment: 1, file: VID, durationSeconds: 31, tailFrame: SCENE, tailTimeSeconds: 31 })
check('31 秒成片 → 拒（E_CLIP_DURATION）', c31.text.includes('E_CLIP_DURATION'))
const cbad = await call('doubao_clip_register', { project: 'sim', segment: 1, file: VID, durationSeconds: 30, tailFrame: SCENE, tailTimeSeconds: 10 })
check('30 秒段、尾帧取 10 秒 → 拒（E_TAIL_TIME）', cbad.text.includes('E_TAIL_TIME'))

console.log('── 7. 片段去重 ──')
const pf = join(home, 'projects', 'sim.json')
const stj = JSON.parse(readFileSync(pf, 'utf8'))
stj.pending['1'].confirmedAt = new Date().toISOString()
stj.pending['3'] = { segment: 3, auditHash: 'x', approvedAt: new Date().toISOString(), confirmedAt: new Date().toISOString(), requiredUploads: [SCENE, REF] }
writeFileSync(pf, JSON.stringify(stj, null, 2), 'utf8')

const c30 = await call('doubao_clip_register', { project: 'sim', segment: 1, file: VID, durationSeconds: 30, tailFrame: SCENE, tailTimeSeconds: 30 })
check('30 秒 + 尾帧 30s → 通过', c30.ok === true, c30.text)
 const dup = await call('doubao_clip_register', { project: 'sim', segment: 3, file: VID, durationSeconds: 12, tailFrame: SCENE, tailTimeSeconds: 12 })
check('同文件重复登记 → E_CLIP_DUPLICATE', dup.text.includes('E_CLIP_DUPLICATE'), dup.text)
const uniq = await call('doubao_clip_register', { project: 'sim', segment: 3, file: VID2, durationSeconds: 12, tailFrame: SCENE, tailTimeSeconds: 12 })
check('换一个文件登记 → 通过', uniq.ok === true, uniq.text)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
rmSync(home, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
