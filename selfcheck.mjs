/**
 * scripts/selfcheck.mjs —— 不启动 DSH 也能跑：把判定引擎的每条规则各测一遍。
 *   node scripts/selfcheck.mjs
 * 退出码 0 = 全过。
 */
import assert from 'node:assert/strict'
import {
  checkScript, checkRole, checkScene, checkClip, checkVideo, checkGenerateWindow,
  buildShotPrompt, collectEntities, mentionToken, auditPrompt, auditUploads,
} from '../lib/rules.mjs'

let passed = 0
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`) } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`)
    process.exitCode = 1
  }
}

/** 一份合规样本：2 段 / 每段 3 分镜 / 12 字段齐全 */
const shot = (over = {}) => ({
  景别: '中景',
  运镜: '固定',
  主角: '李观棋',
  动作: '他划火石点燃蜡烛，烛火跳动，映出台边的骨灰坛',
  台词: '李观棋：钱我都要回来了，给娘治病',
  旁白: '无',
  内心旁白: '不能让娘担心',
  表情细节: '肩膀控制不住地微微发抖，幅度很小藏在阴影里',
  感情细节: '所有情绪都背对着母亲，只把安稳递过去',
  音效: '火石摩擦声，蜡烛燃烧的噼啪声',
  光影: '暖黄烛火只照亮屋子中间一圈，四周浓重的阴影',
  场景: '土屋',
  ...over,
})
const script = () => ({
  segments: [
    { index: 1, durationSeconds: 10, styleRef: 'SL-1', shots: [shot(), shot({ 景别: '近景', 动作: '他把冻馒头递向炕边，转身要走' }), shot({ 景别: '特写', 动作: '烛火里骨灰坛的轮廓慢慢亮起来' })] },
    { index: 2, durationSeconds: 10, styleRef: 'SL-1', shots: [shot({ 动作: '他推开门走进雪地，脚印一路拖到院门口' }), shot({ 动作: '风卷起雪粒打在门框上' }), shot({ 动作: '远处赵府的灯笼晃了一下' })] },
  ],
})

const opts = { segmentSeconds: 10, minShotsPerSegment: 3, styleLockId: 'SL-1' }

console.log('G1 脚本')
test('合规脚本通过', () => {
  const r = checkScript(script(), opts)
  assert.equal(r.ok, true, JSON.stringify(r.violations))
  assert.equal(r.counts.segments, 2)
  assert.equal(r.counts.shots, 6)
})
test('段时长超过 30 秒 → 拒', () => {
  const s = script(); s.segments[0].durationSeconds = 40
  assert.ok(checkScript(s, opts).violations.some((v) => v.code === 'E_SEGMENT_DURATION'))
})
test('段时长 20 秒 → 合法（区间内）', () => {
  const s = script(); s.segments[0].durationSeconds = 20
  assert.equal(checkScript(s, opts).ok, true)
})
test('段时长低于 5 秒 → 拒', () => {
  const s = script(); s.segments[0].durationSeconds = 3
  assert.ok(checkScript(s, opts).violations.some((v) => v.code === 'E_SEGMENT_DURATION'))
})
test('分镜不足 3 个 → 拒', () => {
  const s = script(); s.segments[0].shots.pop()
  assert.ok(checkScript(s, opts).violations.some((v) => v.code === 'E_TOO_FEW_SHOTS'))
})
test('缺字段 → 拒', () => {
  const s = script(); delete s.segments[0].shots[0]['音效']
  assert.ok(checkScript(s, opts).violations.some((v) => v.code === 'E_FIELD_MISSING'))
})
test('表情细节 = 感情细节 → 拒', () => {
  const s = script(); s.segments[0].shots[0]['感情细节'] = s.segments[0].shots[0]['表情细节']
  assert.ok(checkScript(s, opts).violations.some((v) => v.code === 'E_EMOTION_DUPLICATE'))
})
test('台词 + 旁白 同时存在 → 拒', () => {
  const s = script(); s.segments[0].shots[0]['旁白'] = '那一夜，他失去了姐姐'
  assert.ok(checkScript(s, opts).violations.some((v) => v.code === 'E_PRIORITY_CONFLICT'))
})
test('模板占位「例如」→ 拒', () => {
  const s = script(); s.segments[0].shots[0]['动作'] = '例如：他划火石点燃蜡烛'
  assert.ok(checkScript(s, opts).violations.some((v) => v.code === 'E_PLACEHOLDER'))
})
test('场景名带景别 → 拒', () => {
  const s = script(); s.segments[0].shots[0]['场景'] = '土屋中景'
  assert.ok(checkScript(s, opts).violations.some((v) => v.code === 'E_SCENE_WITH_SHOT_SIZE'))
})
test('相邻段逐字重复 → 拒', () => {
  const s = script(); s.segments[1].shots[0] = { ...s.segments[0].shots[2] }
  assert.ok(checkScript(s, opts).violations.some((v) => v.code === 'E_SEGMENT_DUPLICATE'))
})
test('风格没引用锁定值 → 拒', () => {
  const s = script(); s.segments[0].styleRef = ''
  assert.ok(checkScript(s, opts).violations.some((v) => v.code === 'E_NO_STYLE_REF'))
})

console.log('G2 角色卡')
const goodRole = (over = {}) => ({
  name: '李观棋', kind: 'reference',
  cardImage: 'D:/p/李观棋-三视图.png',
  reference: 'D:/p/李观棋.png',
  source: 'https://www.doubao.com/chat/38450589868511234 10:04',
  appearance: '少年，黑发束起，眉骨高，颧骨瘦',
  outfit: '洗白的粗布短褐',
  ...over,
})
test('三视图 + 参考图 + 来源齐 → 过', () => {
  const r = checkRole(goodRole(), { scriptRoles: ['李观棋'] })
  assert.equal(r.ok, true, JSON.stringify(r.violations))
})
test('缺三视图 → 拒', () => {
  const r = checkRole(goodRole({ cardImage: '' }), { scriptRoles: ['李观棋'] })
  assert.ok(r.violations.some((v) => v.code === 'E_ROLE_NO_CARD'))
})
test('三视图与参考图是同一个文件 → 拒', () => {
  const r = checkRole(goodRole({ cardImage: 'D:/p/李观棋.png' }), { scriptRoles: ['李观棋'] })
  assert.ok(r.violations.some((v) => v.code === 'E_ROLE_SAME_FILE'))
})
test('没写来源 → 拒', () => {
  const r = checkRole(goodRole({ source: '' }), { scriptRoles: ['李观棋'] })
  assert.ok(r.violations.some((v) => v.code === 'E_ROLE_SOURCE'))
})
test('角色不在脚本里 → 拒', () => {
  const r = checkRole(goodRole({ name: '路人甲' }), { scriptRoles: ['李观棋'] })
  assert.ok(r.violations.some((v) => v.code === 'E_ROLE_NOT_IN_SCRIPT'))
})

console.log('G3 场景卡')
test('合规场景通过', () => {
  const r = checkScene({ name: '土屋', file: 'D:/p/土屋.png', characters: [], source: 'https://www.doubao.com/chat/38450589868511234 10:06' }, { scriptScenes: ['土屋'] })
  assert.equal(r.ok, true, JSON.stringify(r.violations))
})
test('场景没写来源 → 拒', () => {
  const r = checkScene({ name: '土屋', file: 'a.png', source: '' }, {})
  assert.ok(r.violations.some((v) => v.code === 'E_SCENE_SOURCE'))
})
test('场景名带景别 → 拒', () => {
  assert.ok(checkScene({ name: '土屋中景', file: 'a.png' }, {}).violations.some((v) => v.code === 'E_SCENE_WITH_SHOT_SIZE'))
})
test('场景里有人 → 拒', () => {
  assert.ok(checkScene({ name: '土屋', file: 'a.png', characters: ['李观棋'] }, {}).violations.some((v) => v.code === 'E_SCENE_HAS_CHARACTER'))
})

console.log('G4 生成前')
test('三件套齐 → 过', () => {
  const roles = new Map([['李观棋', { name: '李观棋', kind: 'reference', file: 'a.png', cardImage: 'card.png' }]])
  const scenes = new Map([['土屋', { name: '土屋', file: 'b.png' }]])
  const r = checkVideo(shot(), { styleLock: { id: 'SL-1' }, roles, scenes, clips: {}, segIndex: 1 })
  assert.equal(r.ok, true, JSON.stringify(r.violations))
})
test('第 2 段没有上一段尾帧 → 拒', () => {
  const roles = new Map([['李观棋', { name: '李观棋', kind: 'reference', file: 'a.png', cardImage: 'card.png' }]])
  const scenes = new Map([['土屋', { name: '土屋', file: 'b.png' }]])
  const r = checkVideo(shot(), { styleLock: { id: 'SL-1' }, roles, scenes, clips: {}, segIndex: 2 })
  assert.ok(r.violations.some((v) => v.code === 'E_NO_PREV_CLIP'))
})

console.log('G5 片段')
test('合规片段通过', () => {
  const r = checkClip({ segment: 1, file: 'D:/v/1.mp4', durationSeconds: 10, tailFrame: 'D:/v/1-tail.png', tailTimeSeconds: 10 }, { segmentSeconds: 10 })
  assert.equal(r.ok, true, JSON.stringify(r.violations))
})
test('尾帧取在 3 秒 → 拒', () => {
  const r = checkClip({ segment: 1, file: 'D:/v/1.mp4', durationSeconds: 10, tailFrame: 'D:/v/1-tail.png', tailTimeSeconds: 3 }, { segmentSeconds: 10 })
  assert.ok(r.violations.some((v) => v.code === 'E_TAIL_TIME'))
})

console.log('G5 生成耗时窗口（5–10 分钟）')
test('7 分钟 → 过，无提示', () => {
  const r = checkGenerateWindow(7, { minMinutes: 5, maxMinutes: 10 })
  assert.equal(r.ok, true)
  assert.equal(r.warnings.length, 0)
})
test('3 分钟 → 过但提示（怕拿旧片顶替）', () => {
  const r = checkGenerateWindow(3, { minMinutes: 5, maxMinutes: 10 })
  assert.equal(r.ok, true)
  assert.ok(r.warnings.some((w) => w.code === 'W_GEN_TOO_FAST'))
})
test('14 分钟 → 拒（超上限作废）', () => {
  const r = checkGenerateWindow(14, { minMinutes: 5, maxMinutes: 10 })
  assert.equal(r.ok, false)
  assert.ok(r.violations.some((v) => v.code === 'E_GEN_TOO_LONG'))
})
test('没有确认时间 → 拒', () => {
  const r = checkGenerateWindow(NaN, {})
  assert.ok(r.violations.some((v) => v.code === 'E_NO_START_TIME'))
})

console.log('G4.5 提示词审计')
test('带全 @ 的提示词 → 过', () => {
  const roles = new Map([['李观棋', { name: '李观棋', file: 'D:/素材/李观棋.png' }]])
  const scenes = new Map([['土屋', { name: '土屋', file: 'D:/素材/土屋.png' }]])
  const built = buildShotPrompt(shot(), { segIndex: 1, roles, scenes, clips: {} })
  const r = auditPrompt(shot(), built, { roles, scenes, clips: {}, segIndex: 1 })
  assert.equal(r.ok, true, JSON.stringify(r.violations))
})
test('漏掉 @场景 → 拒', () => {
  const roles = new Map([['李观棋', { name: '李观棋', file: 'D:/素材/李观棋.png' }]])
  const scenes = new Map([['土屋', { name: '土屋', file: 'D:/素材/土屋.png' }]])
  const built = buildShotPrompt(shot(), { segIndex: 1, roles, scenes, clips: {} })
  const r = auditPrompt(shot(), built.replace('@土屋=土屋（对应场景图片）', ''), { roles, scenes, clips: {}, segIndex: 1 })
  assert.ok(r.violations.some((v) => v.code === 'E_MISSING_SCENE_MENTION'))
})
test('漏掉 @角色 → 拒', () => {
  const roles = new Map([['李观棋', { name: '李观棋', file: 'D:/素材/李观棋.png' }]])
  const scenes = new Map([['土屋', { name: '土屋', file: 'D:/素材/土屋.png' }]])
  const built = buildShotPrompt(shot(), { segIndex: 1, roles, scenes, clips: {} })
  const r = auditPrompt(shot(), built.replace('@李观棋=李观棋（对应人物角色卡）', ''), { roles, scenes, clips: {}, segIndex: 1 })
  assert.ok(r.violations.some((v) => v.code === 'E_MISSING_ROLE_MENTION'))
})
test('字段被改写 → 拒（识破手搓）', () => {
  const roles = new Map([['李观棋', { name: '李观棋', file: 'D:/素材/李观棋.png' }]])
  const scenes = new Map([['土屋', { name: '土屋', file: 'D:/素材/土屋.png' }]])
  const built = buildShotPrompt(shot(), { segIndex: 1, roles, scenes, clips: {} })
  const r = auditPrompt(shot(), built.replace('暖黄烛火只照亮屋子中间一圈', '烛光很暖'), { roles, scenes, clips: {}, segIndex: 1 })
  assert.ok(r.violations.some((v) => v.code === 'E_FIELD_MISMATCH'))
})
test('上传清单缺文件 → 拒', () => {
  const r = auditUploads(['D:/素材/土屋.png', 'D:/素材/李观棋.png'], ['D:/素材/土屋.png'])
  assert.equal(r.ok, false)
  assert.ok(r.violations.some((v) => v.code === 'E_NOT_UPLOADED'))
})
test('上传清单齐全 → 过（按文件名比对，不挑路径写法）', () => {
  const r = auditUploads(['D:/素材/土屋.png'], ['土屋.png'])
  assert.equal(r.ok, true)
})

console.log('提示词组装')
test('@ 名 = 文件名去扩展名', () => {
  assert.equal(mentionToken('D:/素材/李观棋.png'), '李观棋')
})
test('第 2 段带首帧衔接块', () => {
  const roles = new Map([['李观棋', { name: '李观棋', file: 'D:/素材/李观棋.png' }]])
  const scenes = new Map([['土屋', { name: '土屋', file: 'D:/素材/土屋.png' }]])
  const clips = { 1: { segment: 1, tailFrame: 'D:/素材/seg1尾帧.png' } }
  const p = buildShotPrompt(shot(), { segIndex: 2, roles, scenes, clips })
  assert.match(p, /@土屋=土屋（对应场景图片）/)
  assert.match(p, /@李观棋=李观棋（对应人物角色卡）/)
  assert.match(p, /@seg1尾帧=参考图/)
  assert.match(p, /参考图是片段 1 的最后一帧/)
  assert.match(p, /景别：中景/)
  assert.match(p, /场景：土屋/)
  assert.doesNotMatch(p, /例如/)
})
test('实体收集', () => {
  const e = collectEntities(script())
  assert.deepEqual(e.roles, ['李观棋'])
  assert.deepEqual(e.scenes, ['土屋'])
})

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : '，全部通过'}`)
