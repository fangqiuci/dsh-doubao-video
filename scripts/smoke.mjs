/**
 * scripts/smoke.mjs —— 端到端冒烟：不启动 DSH，直接给一个假的 ctx，把整条流水线跑一遍。
 *   node scripts/smoke.mjs
 * 覆盖：风格锁 → 脚本（含一次打回）→ 角色 → 场景 → 生成前检查 → 提示词审计 → 确认 → 片段登记 → 总览
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.mjs'

const home = mkdtempSync(join(tmpdir(), 'doubao-video-'))
// 素材体检要真文件；测试用最小 PNG 头（宽高读出来是 0，不会触发尺寸规则），
// 并把这轮的密度阈值关掉 —— 单测该测结构，不该被"图够不够清晰"卡住。
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)])
const asset = (n) => { const p = join(home, n); writeFileSync(p, png); return p }
const CARD = asset('李观棋-三视图.png')
const REF = asset('李观棋.png')
const SCENE = asset('土屋.png')

const tools = new Map()
const ctx = { tools: { register: (t) => { tools.set(t.name, t) } } }
apply(ctx, { home, project: 'smoke', strict: true, mediaMinSide: 1, mediaMinKBPerMP: 0 })

const call = async (name, args = {}) => {
  const t = tools.get(name)
  assert.ok(t, `工具没注册：${name}`)
  return t.execute(args)
}

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

const run = async () => {
  // 0. 未锁风格时先交脚本 → 必须被拒
  let r = await call('doubao_script_submit', {
    scriptJson: JSON.stringify({ segments: [{ index: 1, durationSeconds: 10, styleRef: 'SL-1', shots: [shot(), shot(), shot()] }] }),
  })
  assert.equal(r.ok, false, '没有风格锁时脚本不该通过')

  // 1. 锁风格
  r = await call('doubao_style_lock', {
    artStyle: '3D 动漫（非写实）', palette: '冷调冰雪质感，低饱和度',
    material: 'PBR 次世代材质', lens: '固定机位为主', forbidden: '真人质感,字幕水印',
  })
  assert.equal(r.ok, true, r.text)

  // 2. 提交有问题的脚本 → 打回
  r = await call('doubao_script_submit', {
    scriptJson: JSON.stringify({
      segments: [{
        index: 1, durationSeconds: 10, styleRef: 'SL-1',
        shots: [shot({ 动作: '例如：他划火石点燃蜡烛' }), shot(), shot()],
      }],
    }),
  })
  assert.equal(r.ok, false)
  assert.match(r.text, /E_PLACEHOLDER/)

  // 3. 提交合规脚本
  r = await call('doubao_script_submit', {
    scriptJson: JSON.stringify({
      segments: [
        { index: 1, durationSeconds: 10, styleRef: 'SL-1', shots: [shot(), shot({ 动作: '他把冻馒头递向炕边，转身要走' }), shot({ 景别: '特写', 动作: '烛火里骨灰坛的轮廓慢慢亮起来' })] },
        { index: 2, durationSeconds: 10, styleRef: 'SL-1', shots: [shot({ 动作: '他推开门走进雪地，脚印一路拖到院门口' }), shot({ 动作: '风卷起雪粒打在门框上' }), shot({ 动作: '远处赵府的灯笼晃了一下' })] },
      ],
    }),
  })
  assert.equal(r.ok, true, r.text)

  // 4. 缺三视图 → 拒
  r = await call('doubao_role_register', {
    name: '李观棋', reference: REF,
    appearance: '少年，黑发束起，眉骨高，颧骨瘦，身形单薄', outfit: '洗白的粗布短褐',
    source: 'https://www.doubao.com/chat/38450589868511234 10:04',
  })
  assert.equal(r.ok, false)
  assert.match(r.text, /E_ROLE_NO_CARD/)

  // 5. 三视图 + 参考图 + 来源齐 → 过
  r = await call('doubao_role_register', {
    name: '李观棋', cardImage: CARD, reference: REF,
    appearance: '少年，黑发束起，眉骨高，颧骨瘦，身形单薄', outfit: '洗白的粗布短褐',
    source: 'https://www.doubao.com/chat/38450589868511234 10:04',
  })
  assert.equal(r.ok, true, r.text)

  // 6. 场景
  r = await call('doubao_scene_register', { name: '土屋中景', file: SCENE, source: 'https://www.doubao.com/chat/38450589868511234 10:06' })
  assert.equal(r.ok, false)
  r = await call('doubao_scene_register', { name: '土屋', file: SCENE, source: 'https://www.doubao.com/chat/38450589868511234 10:06' })
  assert.equal(r.ok, true, r.text)

  // 7. 生成前检查 → 提示词 + 上传清单
  r = await call('doubao_shot_check', { segment: 1, shotIndex: 0 })
  assert.equal(r.ok, true, r.text)
  const prompt1 = r.prompt
  assert.match(prompt1, /@土屋=土屋（对应场景图片）/)
  assert.match(prompt1, /@李观棋=李观棋（对应人物角色卡）/)
  assert.match(r.text, /先上传这几张图/)
  assert.deepEqual(r.requiredUploads, [SCENE, REF])

  // 7.1 审计：漏 @ 的文本 → 拒
  r = await call('doubao_prompt_audit', {
    segment: 1, shotIndex: 0,
    promptText: '景别：中景\n运镜：固定',
    uploadedFiles: `${SCENE};${REF}`,
  })
  assert.equal(r.ok, false)
  assert.match(r.text, /E_MISSING_SCENE_MENTION|E_MISSING_ROLE_MENTION|E_FIELD_MISMATCH/)

  // 7.2 审计：图没上传 → 拒
  r = await call('doubao_prompt_audit', {
    segment: 1, shotIndex: 0,
    promptText: prompt1,
    uploadedFiles: SCENE,
  })
  assert.equal(r.ok, false)
  assert.match(r.text, /E_NOT_UPLOADED/)

  // 7.3 审计通过 → 拿 auditHash
  r = await call('doubao_prompt_audit', {
    segment: 1, shotIndex: 0,
    promptText: prompt1,
    uploadedFiles: `${SCENE};${REF}`,
  })
  assert.equal(r.ok, true, r.text)
  const hash = r.auditHash
  assert.ok(hash && hash.length === 16)

  // 8. 没确认就登记 → 拒
  r = await call('doubao_clip_register', { segment: 1, file: 'D:\\成片\\1.mp4', tailFrame: 'D:\\成片\\1尾.png' })
  assert.equal(r.ok, false)
  assert.match(r.text, /E_NOT_CONFIRMED/)

  // 9. 确认话没说对 → 拒
  r = await call('doubao_generate_confirm', { segment: 1, confirmText: '可以了，你继续', auditHash: hash })
  assert.equal(r.ok, false)
  assert.match(r.text, /不能生成/)

  // 9.1 确认时 auditHash 不对 → 拒
  r = await call('doubao_generate_confirm', { segment: 1, confirmText: '确定生成视频', auditHash: 'deadbeefdeadbeef' })
  assert.equal(r.ok, false)
  assert.match(r.text, /auditHash 对不上/)

  // 10. 正确确认 → 放行并开始计时
  r = await call('doubao_generate_confirm', { segment: 1, confirmText: '确定生成视频', auditHash: hash })
  assert.equal(r.ok, true, r.text)
  assert.match(r.text, /计时开始/)

  // 11. 尾帧取在 3 秒 → 拒
  r = await call('doubao_clip_register', { segment: 1, file: 'D:\\成片\\1.mp4', tailFrame: 'D:\\成片\\1尾.png', tailTimeSeconds: 3 })
  assert.equal(r.ok, false)
  assert.match(r.text, /E_TAIL_TIME/)

  // 11b. 自报耗时 14 分钟 → 超窗口
  r = await call('doubao_clip_register', { segment: 1, file: 'D:\\成片\\1.mp4', tailFrame: 'D:\\成片\\1尾.png', generateMinutes: 14 })
  assert.equal(r.ok, false)
  assert.match(r.text, /E_GEN_TOO_LONG/)

  // 12. 正常登记
  r = await call('doubao_clip_register', { segment: 1, file: 'D:\\成片\\1.mp4', tailFrame: 'D:\\成片\\1尾.png', generateMinutes: 7 })
  assert.equal(r.ok, true, r.text)
  assert.match(r.text, /剪辑顺序：1/)

  // 13. 第 2 段：带首帧衔接块
  r = await call('doubao_shot_check', { segment: 2, shotIndex: 0 })
  assert.equal(r.ok, true, r.text)
  assert.match(r.text, /参考图是片段 1 的最后一帧/)
  assert.match(r.text, /@1尾=参考图/)

  // 14. 总览
  r = await call('doubao_status')
  assert.match(r.text, /项目「smoke」/)
  assert.match(r.text, /片段：第1段/)

  // 15. 判定条件总表
  r = await call('doubao_gate_table')
  assert.match(r.text, /G4\.5 审计/)

  console.log('✓ 冒烟全过：18 步 / 10 个工具')
}

try {
  await run()
} finally {
  try { rmSync(home, { recursive: true, force: true }) } catch { /* 临时目录清不掉无所谓 */ }
}
