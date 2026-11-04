/**
 * scripts/guard-sim.mjs —— 风控自保 + 页面指纹（2026-11-04）
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkQuota, commitCall, readGuard, randomGapMs, dateKey } from '../lib/guard.mjs'
import { REQUIRED_FINGERPRINTS } from '../lib/browser.mjs'

const home = mkdtempSync(join(tmpdir(), 'guard-'))
let pass = 0, fail = 0
const t = (n, c, d = '') => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}  ${String(d).slice(0, 140)}`) } }

console.log('── 时区切日（修复同学 2026-11-04 抓的 bug）──')
// 北京 11-05 01:00 = UTC 11-04 17:00；按 UTC 切日会把这一小时算成 11-04
t('北京 01:00 算「新的一天」', dateKey(new Date('2026-11-04T17:00:00Z')) === '2026-11-05', dateKey(new Date('2026-11-04T17:00:00Z')))
t('北京 23:59 仍是当天', dateKey(new Date('2026-11-04T15:59:00Z')) === '2026-11-04', dateKey(new Date('2026-11-04T15:59:00Z')))
t('跨北京时间零点会换日', dateKey(new Date('2026-11-04T16:01:00Z')) === '2026-11-05', dateKey(new Date('2026-11-04T16:01:00Z')))
t('UTC 与北京不同（证明没用 UTC）', dateKey(new Date('2026-11-04T17:00:00Z')) !== new Date('2026-11-04T17:00:00Z').toISOString().slice(0, 10))

console.log('── 每日上限 ──')
t('初始 0 次', readGuard(home).count === 0)
for (let i = 0; i < 3; i += 1) commitCall(home)
t('发 3 次 → 计数 3', readGuard(home).count === 3)
const q3 = checkQuota(home, { dailyLimit: 3 })
t('上限 3、已发 3 → 拒', q3.ok === false && /上限 3/.test(q3.reason), q3.reason)
const q4 = checkQuota(home, { dailyLimit: 4 })
t('上限 4、已发 3 → 放行', q4.ok === true)

console.log('── 跨天清零 ──')
const p = join(home, 'guard.json')
const j = JSON.parse(readFileSync(p, 'utf8'))
j.date = '2000-01-01'
writeFileSync(p, JSON.stringify(j), 'utf8')
t('昨天的记录不算今天', readGuard(home).count === 0)

console.log('── 随机间隔 ──')
const gaps = Array.from({ length: 12 }, () => randomGapMs(60, 180))
t('都在 60–180 秒内', gaps.every((g) => g >= 60000 && g <= 180000), JSON.stringify(gaps))
t('不是固定值（随机）', new Set(gaps).size > 1)

const g1 = commitCall(home)
const qa = checkQuota(home, { dailyLimit: 99, minGapSec: 60, maxGapSec: 180 })
t('刚发完 → 需要等待', qa.waitMs > 0, String(qa.waitMs))
t('确认有 lastAt', !!g1.lastAt)

console.log('── 页面指纹清单 ──')
t('至少两项指纹', REQUIRED_FINGERPRINTS.length >= 2)
t('输入框在清单里', REQUIRED_FINGERPRINTS.some((r) => r.key === 'composer'))
t('文件输入口在清单里', REQUIRED_FINGERPRINTS.some((r) => r.key === 'fileInputs'))
t('每项都有 why（给人看的原因）', REQUIRED_FINGERPRINTS.every((r) => r.why && r.why.length > 4))

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
rmSync(home, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
