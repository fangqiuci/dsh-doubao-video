/**
 * scripts/sim-run-016.mjs —— 0.1.6 全链路模拟（mock 后端，不连浏览器、不花额度）
 *
 * 走一遍真实顺序，重点验证今天新加的 6 个工具与闸门：
 *   idea_submit → mode_authorize → script_submit → shot_check(被拒)
 *   → script_review(不带版本,被拒) → script_review(带版本,通过)
 *   → shot_check(通过) → batch_authorize → send(批量免确认)
 *   → halt → resume → reuse_assets
 */
import { apply } from '../lib/index.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DOUBAO_PROVIDER = 'mock'
delete process.env.DOUBAO_SKIP_SCRIPT_REVIEW

const HOME = mkdtempSync(join(tmpdir(), 'sim016-'))
const tools = new Map()
apply(
  { tools: { register: (t) => { tools.set(t.name, t); return t } }, get: () => undefined, effect: () => {} },
  { home: HOME, project: 'p16', strict: true, dailyCallLimit: 99, minGapSec: 0, maxGapSec: 0, batchMaxSegments: 3, profile: 'dance' },
)
const call = (n, a = {}) => tools.get(n).execute(a)

let pass = 0, fail = 0
const t = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}  ${String(detail).slice(0, 220)}`) }
}

// 假素材（provider 是 mock，只要文件存在）
const A = join(HOME, 'assets'); mkdirSync(A, { recursive: true })
const png = (n) => { const p = join(A, n); writeFileSync(p, Buffer.alloc(60000, 7)); return p }
const cardImg = png('阿墨_三视图.png'); const cardRef = png('阿墨_参考图.png'); const scene = png('雨夜天台.png')

const shot = (o = {}) => ({
  景别: '中景', 运镜: '跟拍，人物从画面左走到右，不停顿', 主角: '阿墨',
  动作: '右臂划弧收到左肩，重心上移，左脚前掌落地接半圈转体，全程不停顿',
  台词: '无', 旁白: '无', 内心旁白: '无',
  表情细节: '眼皮半垂，嘴角绷紧一点', 感情细节: '像在忍着一口气',
  音效: '雨打铁皮和鞋底摩擦', 光影: '冷蓝环境光加霓虹橙边缘光', 场景: '雨夜天台', ...o,
})
const script = { segments: [
  { index: 1, durationSeconds: 10, styleRef: 'SL-1', shots: [shot()] },
  { index: 2, durationSeconds: 10, styleRef: 'SL-1', shots: [shot({ 动作: '她猛地回头，伞沿的水甩成半圈，视线钉在巷口', 动作延续: '接上段：手臂停在左肩，重心不换' })] },
] }

console.log('── ① 风格锁（含 16:9 画幅）──')
const lock = await call('doubao_style_lock', { project: 'p16', artStyle: '3D 动漫（非写实）', palette: '雨夜冷蓝', material: 'PBR 哑光', lens: '跟拍为主', forbidden: '真人质感,字幕水印', aspectRatio: '16:9' })
t('style_lock 成功', lock.ok === true, lock.text)
t('锁里存了 16:9', /16:9/.test(String(lock.text)), lock.text)

console.log('── ② 创意闸（600 字 + 差异 ≤10%）──')
const short = await call('doubao_idea_submit', { project: 'p16', humanSaid: '一个女孩在雨夜天台上等一个人。' })
t('太短 → 拒', short.ok === false && /600/.test(short.text), short.text)
const long = '阿墨在雨夜天台水塔下面等那一班不会来的末班车。'.repeat(40)
const idea = await call('doubao_idea_submit', { project: 'p16', humanSaid: long })
t('≥600 字 → 过', idea.ok === true, idea.text)
const rewrite = await call('doubao_idea_submit', { project: 'p16', humanSaid: long, final: '完全不同的另一段创意内容，讲的是外星人和机器人打架的故事，跟原文毫无关系。' })
t('代写（差异大）→ 拒', rewrite.ok === false && /代写|10%/.test(rewrite.text), rewrite.text)

console.log('── ③ 意图模式 ──')
const c1 = await call('doubao_mode_authorize', { project: 'p16', mode: 'C', confirmText: '就按这个来吧' })
t('C 没授权词 → 拒', c1.ok === false, c1.text)
const a1 = await call('doubao_mode_authorize', { project: 'p16', mode: 'A', confirmText: '我来定创意' })
t('A 设置成功', a1.ok === true, a1.text)

console.log('── ④ 角色/场景登记（cardImage + cardRef）──')
const role = await call('doubao_role_register', { project: 'p16', name: '阿墨', cardImage: cardImg, reference: cardRef, cardRef, source: 'https://www.doubao.com/chat/38451372221860866', appearance: 'Q 版三头身，猫耳，短发', outfit: '橙黑工装' })
t('角色登记成功', role.ok === true, role.text)
const sc = await call('doubao_scene_register', { project: 'p16', name: '雨夜天台', file: scene, source: 'mock 对话 https://www.doubao.com/chat/1' })
t('场景登记成功', sc.ok === true, sc.text)

console.log('── ⑤ 脚本提交 + 可见闸 ──')
const sub = await call('doubao_script_submit', { project: 'p16', scriptJson: JSON.stringify(script) })
t('脚本提交成功', sub.ok === true, sub.text)
const blocked = await call('doubao_shot_check', { project: 'p16', segment: 1, shotIndex: 0 })
t('没看过脚本 → shot_check 被拒', blocked.ok === false && /看过/.test(blocked.text), blocked.text)

const rv0 = await call('doubao_script_review', { project: 'p16', confirmText: '可以' })
t('只说「可以」→ 不放行', rv0.ok === true && rv0.awaitingApproval === true, rv0.text)
t('review 输出脚本原文', /第 1 段/.test(rv0.text), rv0.text.slice(0, 120))

// 0.1.6 收紧后：必须引用脚本里的原句（这里引第一段的动作描述）
const rv1 = await call('doubao_script_review', { project: 'p16', confirmText: '看过，可以。' + shot().动作 })
t('引用原句 → 放行', rv1.ok === true && rv1.approved === true, rv1.text)
t('review 给出可抄的 @ 行', /@/.test(rv1.text), rv1.text.slice(0, 160))

console.log('── ⑥ shot_check（dance 预设 + 连续运动）──')
const chk = await call('doubao_shot_check', { project: 'p16', segment: 1, shotIndex: 0 })
t('shot_check 通过', chk.ok === true, chk.text)
t('提示词含「运动要求」', /运动要求/.test(String(chk.promptText || chk.text || '')), String(chk.promptText || chk.text).slice(-200))
t('提示词含 16:9 横屏', /16:9.*横屏/.test(String(chk.promptText || chk.text || '')), '')
// 动作延续要在「有上一段尾帧」后才进提示词，真机验；这里只验规则文件里有这条

console.log('── ⑦ 批量授权 + 发送免逐段确认 ──')
const audit = await call('doubao_prompt_audit', { project: 'p16', segment: 1, promptText: chk.promptText || chk.text, uploadedFiles: [scene, cardRef].join('\n') })
t('审计通过', audit.ok === true, audit.text)
const bt = await call('doubao_batch_authorize', { project: 'p16', maxSegments: 2, confirmText: '确定连续生成 2 段' })
t('批量授权成功', bt.ok === true, bt.text)
await call('doubao_browser_stage', { project: 'p16', segment: 1, promptText: chk.promptText || chk.text })
const s1 = await call('doubao_browser_send', { project: 'p16', segment: 1, auditHash: audit.auditHash })
t('批量授权下不用再说「确定生成视频」', s1.ok === true, s1.text)

console.log('── ⑧ 异常即停 ──')
const st = await call('doubao_status', { project: 'p16' })
t('status 可读', st.ok === true)
const res = await call('doubao_resume', { project: 'p16', confirmText: '先看看' })
t('resume 不带「继续」→ 只报告不恢复', res.ok === true && !res.resumed, res.text)
const res2 = await call('doubao_resume', { project: 'p16', confirmText: '继续' })
t('说「继续」→ 恢复', res2.ok === true && res2.resumed === true, res2.text)

console.log('── ⑨ 跨集复用 ──')
await call('doubao_style_lock', { project: 'p16b', artStyle: '3D 动漫', palette: '冷蓝', material: 'PBR', lens: '固定', forbidden: '真人' })
const reuse = await call('doubao_reuse_assets', { project: 'p16b', fromProject: 'p16' })
t('复用成功', reuse.ok === true, reuse.text)
t('复用带回角色 1 个', /角色 1 个/.test(reuse.text), reuse.text)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
rmSync(HOME, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
