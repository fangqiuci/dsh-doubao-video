import { styleBlock } from '../lib/rules.mjs'
let pass = 0, fail = 0
const t = (n, c, d = '') => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}  ${d}`) } }

console.log('── 灵活度 ──')
t('风格锁为空 → 一个字都不加', styleBlock(null) === '' && styleBlock({}) === '')
t('mode=off → 整块不出现', styleBlock({ artStyle: 'Q版' }, { mode: 'off' }) === '')

const soft = styleBlock({ artStyle: 'Q版赛璐璐', palette: '冷蓝' })
t('soft 收尾是"保持一致"', soft.includes('保持一致') && !soft.includes('不得自行改变'))

const strict = styleBlock({ artStyle: 'Q版赛璐璐' }, { mode: 'strict' })
t('strict 收尾是"不得自行改变"', strict.includes('不得自行改变'))

console.log('── 自定义 ──')
const custom = styleBlock({ title: '本片视觉基调', artStyle: '国风水墨', extra: { 画风: '写意', 参考年代: '1980s' } })
t('自定义标题生效', custom.includes('—— 本片视觉基调 ——'), custom)
t('extra 字段自动带上', custom.includes('画风：写意') && custom.includes('参考年代：1980s'))
t('没填的字段自动跳过', !custom.includes('材质：'))

const free = styleBlock({ artStyle: '水墨', custom: '整体参考《千里江山图》的青绿山水。' })
t('custom 自由文本附在最后', free.trim().endsWith('青绿山水。'), free)

const arr = styleBlock({ forbidden: ['真人质感', '字幕水印'] })
t('数组型 forbidden 自动拼接', arr.includes('真人质感、字幕水印'), arr)

console.log('── 兼容审计 ──')
const all = [soft, strict, custom, free, arr].filter(Boolean)
t('都不含【】占位符（会撞审计）', all.every((x) => !/【|】/.test(x)), all.find((x) => /【|】/.test(x)))

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
