/**
 * scripts/args-sim.mjs —— 参数类型回归（2026-11-04 事故后加的）
 * 事故：工具参数用 type:'array' 后，整个插件的 24 个工具都挂不进宿主 schema。
 * 现在所有列表参数都改成字符串，这里锁死解析行为。
 */
import { parseList } from '../lib/index.mjs'

let pass = 0, fail = 0
const t = (n, c, d = '') => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}  ${String(d).slice(0, 140)}`) } }

console.log('── parseList ──')
t('JSON 数组', JSON.stringify(parseList('["雨夜天台","书桌前"]')) === '["雨夜天台","书桌前"]')
t('换行分隔', JSON.stringify(parseList('雨夜天台\n书桌前\n\n')) === '["雨夜天台","书桌前"]')
t('单个字符串', JSON.stringify(parseList('雨夜天台')) === '["雨夜天台"]')
t('空 → 空数组', parseList('').length === 0 && parseList(null).length === 0)
t('坏 JSON → 空（不抛）', parseList('[不是json').length === 0)
t('数组原样透传', parseList([1, 2]).length === 2)

console.log('── cuts 用法 ──')
const cuts = parseList('[{"segment":1,"start":0.2,"trimEnd":0.3}]')
t('cuts JSON 能解析出 segment', cuts[0]?.segment === 1 && cuts[0]?.trimEnd === 0.3, JSON.stringify(cuts))

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
