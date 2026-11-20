/**
 * scripts/sim-run-017.mjs —— 0.1.7 全链路模拟（mock 后端，不连浏览器、不花额度）
 * 覆盖 0.1.7 新增：节拍检测 / 手法库 / 素材模板 / 功能自检 / 失败日志 / 视线约束 / 对话双人校验
 */
import { apply } from '../lib/index.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

process.env.DOUBAO_PROVIDER = 'mock'
// 让 defaultHome() 指向临时目录，否则失败日志会写到真实状态目录

delete process.env.DOUBAO_SKIP_SCRIPT_REVIEW

const HOME = mkdtempSync(join(tmpdir(), 'sim017-'))
process.env.DOUBAO_HOME = HOME
const tools = new Map()
apply(
  { tools: { register: (t) => { tools.set(t.name, t); return t } }, get: () => undefined, effect: () => {} },
  { home: HOME, project: 'p17', strict: true, dailyCallLimit: 99, minGapSec: 0, maxGapSec: 0, profile: 'general' },
)
const call = (n, a = {}) => tools.get(n).execute(a)

let pass = 0, fail = 0
const t = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}  ${String(detail).slice(0, 200)}`) }
}

// 假素材
const A = join(HOME, 'assets'); mkdirSync(A, { recursive: true })
const png = (n) => {
  const p = join(A, n)
  spawnSync('ffmpeg', ['-y','-loglevel','error','-f','lavfi','-i','testsrc=s=800x1200:d=1,noise=alls=60:allf=t+u','-frames:v','1', p], { windowsHide: true })
  return p
}
const sheet = png('三合_三视图.png'); const ref = png('三合_参考图.png'); const scene = png('街道.png')

// 120BPM 测试音频
const beatFile = join(HOME, 'beat120.mp4')
spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=6',
  '-f', 'lavfi', '-i', 'aevalsrc=0.6*sin(2*PI*80*t)*exp(-40*mod(t\\,0.5)):s=8000:d=6', '-shortest',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', beatFile], { windowsHide: true })

console.log('── 0.1.8 三条硬断言 ──')
const { isThumbSrc } = await import('../lib/images.mjs')
t('isThumbSrc 是函数（防"not defined"复发）', typeof isThumbSrc === 'function', typeof isThumbSrc)
t('缩略图识别正确', isThumbSrc('https://x/a~tplv-1-cthumb.png') === true && isThumbSrc('https://x/a~tplv-1-cgen.png') === false, '')

console.log('── ① 功能自检 ──')
const sc = await call('doubao_selfcheck', {})
t('selfcheck 返回', sc.ok !== undefined && Array.isArray(sc.rows), JSON.stringify(sc).slice(0, 120))
t('含 ffmpeg 一行', (sc.rows || []).some((r) => r.name === 'ffmpeg'), '')
t('含浏览器一行', (sc.rows || []).some((r) => r.name === '浏览器连通'), '')

console.log('── ② 素材提示词模板 ──')
const role = await call('doubao_asset_prompt', { kind: 'role', name: '三合', appearance: '22岁男性，短寸头，窄长眼', outfit: '深蓝工装' })
t('三视图 prompt ≥ 300 字', String(role.prompt || '').length >= 300, String(role.prompt || '').length)
t('含禁止项', /禁止/.test(String(role.prompt)), '')
t('含三视图要求', String(role.prompt).includes('正侧面'), '')
const scr = await call('doubao_asset_prompt', { kind: 'scene', name: '黄昏街道', timeOfDay: '傍晚' })
t('场景 prompt 要求无人', /没有任何人物/.test(String(scr.prompt)), '')

console.log('── ③ 节拍检测 + 卡点 ──')
const bg = await call('doubao_beat_grid', { video: beatFile })
t('识别出 BPM', bg.bpm === 120, String(bg.bpm) + ' ' + (bg.text || '').slice(0, 80))
t('可信', bg.confident === true)
t('节拍 ≥ 10', (bg.beats || []).length >= 10, String((bg.beats || []).length))
const bg2 = await call('doubao_beat_grid', { video: beatFile, cuts: '0.5,1.0,1.52,2.0', snap: true })
t('带 cuts 出评分', bg2.score && bg2.score.ok === true, JSON.stringify(bg2.score))
t('吸附后切点在节拍上', (bg2.snapped || []).every((x) => Math.abs(x * 2 - Math.round(x * 2)) < 0.01), JSON.stringify(bg2.snapped))

console.log('── ④ 手法库 ──')
const list = await call('doubao_clip_recipe', {})
t('12 个手法', (list.techniques || []).length === 12, String((list.techniques || []).length))
const one = await call('doubao_clip_recipe', { name: '卡点' })
t('卡点模板有参数', /参数/.test(one.text) && /bpm/.test(one.text), one.text.slice(0, 100))

console.log('── ⑤ 失败也写日志 ──')
const bad = await call('doubao_role_register', { project: 'p17', name: '坏角色', cardImage: sheet, reference: ref, source: '随手写的一句话', appearance: '三十岁男性，短寸头，宽肩', outfit: '灰色夹克' })
t('source 不合规 → 拒', bad.ok === false, String(bad.text).slice(0, 100))
const logPath = join(HOME, 'projects', 'p17.log')
const logged = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
t('失败写进了日志', /FAIL/.test(logged), logged.split('\n').filter(Boolean).slice(-2).join(' | '))

console.log('── ⑥ 视线约束 + 对话双人校验 ──')
await call('doubao_style_lock', { project: 'p17', artStyle: '3D 动漫', palette: '晨光暖白', material: 'PBR', lens: '固定', forbidden: '真人', profile: 'general' })
const base = (o = {}) => ({
  景别: '中景', 运镜: '固定机位', 主角: '三合', 动作: '他站在街边抬头看路灯，手插在外套口袋里',
  台词: '无', 旁白: '无', 内心旁白: '无', 表情细节: '眼皮半垂，嘴角绷紧一点', 感情细节: '像在忍着什么',
  音效: '街道远处车流', 光影: '黄昏侧逆光有明确方向', 场景: '黄昏街道', ...o,
})
const script = { segments: [{
  index: 1, durationSeconds: 10, styleRef: 'SL-1',
  shots: [base({ 主角: '老道、三合', 台词: '老道：施主，请留步' }), base({ 主角: '三合' }), base({ 主角: '三合' })],
}] }
await call('doubao_role_register', { project: 'p17', name: '老道', cardImage: png('老道_三视图.png'), reference: png('老道_参考图.png'), source: 'https://www.doubao.com/chat/38451372221860866', appearance: '七十岁男性，白须，瘦高，蓝袍', outfit: '深蓝道袍' })
const reg3 = await call('doubao_role_register', { project: 'p17', name: '三合', cardImage: png('三合_三视图.png'), reference: png('三合_参考图.png'), source: 'https://www.doubao.com/chat/38451372221860866', appearance: '二十二岁男性，短寸头，窄长眼，肩背挺直', outfit: '深蓝工装外套' })
await call('doubao_scene_register', { project: 'p17', name: '黄昏街道', file: scene, source: 'https://www.doubao.com/chat/38451372221860866' })
const sub = await call('doubao_script_submit', { project: 'p17', scriptJson: JSON.stringify(script) })
t('脚本提交通过', sub.ok === true, String(sub.text).slice(0, 100))
// 0.1.8：对话单角色已从"警告"升级为"拒绝" —— 用一份坏脚本单独验，再换回好脚本
const badScript = { segments: [{ index: 1, durationSeconds: 10, styleRef: 'SL-1',
  shots: [base({ 主角: '老道', 台词: '老道：施主，请留步' }), base({ 主角: '三合' }), base({ 主角: '三合' })] }] }
const subBad = await call('doubao_script_submit', { project: 'p17', scriptJson: JSON.stringify(badScript), replace: true })
t('对话单角色 → 拒绝（0.1.8）', subBad.ok === false && /E_DIALOGUE_MISSING_LISTENER|必须改/.test(JSON.stringify(subBad)), String(subBad.text).slice(0, 120))
const sub2 = await call('doubao_script_submit', { project: 'p17', scriptJson: JSON.stringify(script), replace: true })
t('换回双人脚本 → 通过', sub2.ok === true, String(sub2.text).slice(0, 100))

const rv0 = await call('doubao_script_review', { project: 'p17', confirmText: '看过，可以' })
t('无确认码 → 不放行', rv0.approved !== true, JSON.stringify(rv0.reviewCode))
const rv = await call('doubao_script_review', { project: 'p17', confirmText: '看过 ' + (rv0.reviewCode || 'XXXX') })
t('脚本确认放行', rv.ok === true && rv.approved === true, String(rv.text).slice(0, 80))
const chk = await call('doubao_shot_check', { project: 'p17', segment: 1, shotIndex: 1 })
t('shot_check 通过', chk.ok === true, String(chk.text).slice(0, 100))
const p0 = String(chk.promptText || chk.text || '')
t('提示词含视线/旁观约束', /不要直视镜头|第三方旁观/.test(p0), p0.slice(-160))

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
rmSync(HOME, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
