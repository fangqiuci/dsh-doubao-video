import { styleBlock, buildShotPrompt } from '../lib/rules.mjs'
let pass = 0, fail = 0
const t = (n, c, d = '') => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}  ${d}`) } }

const base = { artStyle: '3D 动漫（非写实）', palette: '冷蓝低饱和', material: 'PBR', lens: '固定机位' }

console.log('── 人物比例 ──')
const withScale = styleBlock({ ...base, characterScale: '全身约 90% 画面高，头顶留白 10%' })
t('带上人物比例行', withScale.includes('人物比例：全身约 90% 画面高，头顶留白 10%'), withScale)
t('自动追防变形约束', withScale.includes('不得横向拉伸或压缩') && withScale.includes('多指、断肢'), withScale)

const noScale = styleBlock({ ...base })
t('没设比例 → 不加防变形句', !noScale.includes('拉伸'), noScale)

const off = styleBlock({ ...base, characterScale: '50%', antiDeform: false })
t('antiDeform=false → 只留比例行', off.includes('人物比例：50%') && !off.includes('拉伸'))

console.log('── 构图 ──')
const framed = styleBlock({ ...base, framing: '人物居中偏左，视线朝右' })
t('构图字段生效', framed.includes('构图：人物居中偏左，视线朝右'))

console.log('── 进提示词 ──')
const shot = { 景别: '中景', 运镜: '固定', 主角: '辞辞', 动作: '敲键盘', 台词: '无', 旁白: '无', 内心旁白: '无', 表情细节: '垂眼', 感情细节: '不耐烦', 音效: '键盘声', 光影: '冷蓝', 场景: '书桌' }
const p = buildShotPrompt(shot, {
  durationSeconds: 5, aspectRatio: '16:9', modelName: 'Seedance 2.0 Mini',
  styleLock: { ...base, characterScale: '中景约 1/2 画面高' },
})
t('提示词里有人物比例', p.includes('人物比例：中景约 1/2 画面高'), p.slice(-300))
t('提示词里有防变形句', p.includes('不得横向拉伸或压缩'))
t('提示词无【】', !/【|】/.test(p))

console.log('── 灵活度未被破坏 ──')
t('不设风格锁 → 空', styleBlock(null) === '')
t('mode=off 仍有效', styleBlock({ characterScale: '50%' }, { mode: 'off' }) === '')

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
