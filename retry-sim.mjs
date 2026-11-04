import { checkScript } from '../lib/rules.mjs'
let pass = 0, fail = 0
const t = (n, c, d = '') => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}  ${d}`) } }

// 复刻发送闸的判定逻辑（与 index.mjs 内一致）
function retryGate({ sentAt, retries, maxAutoRetries = 1, confirmText = '' }) {
  if (!sentAt) return { ok: true, reason: '首次发送' }
  if (retries <= maxAutoRetries) return { ok: true, reason: '自动重试配额内' }
  if (/确定重试/.test(confirmText)) return { ok: true, reason: '本人确认重试' }
  return { ok: false, reason: '需人工确认' }
}

console.log('── 重试闸 ──')
t('首次发送 → 放行', retryGate({ sentAt: null, retries: 0 }).ok === true)
t('发过 1 次、自动配额 1 → 放行（自动重试）', retryGate({ sentAt: 'x', retries: 1, maxAutoRetries: 1 }).ok === true)
t('发过 1 次、配额用完 → 拒', retryGate({ sentAt: 'x', retries: 1, maxAutoRetries: 0 }).ok === false)
t('配额用完但本人说「确定重试」→ 放行', retryGate({ sentAt: 'x', retries: 2, confirmText: '确定重试' }).ok === true)
t('配额用完、没说 → 拒', retryGate({ sentAt: 'x', retries: 2 }).ok === false)
t('只写「重试」不够（必须完整四个字）', retryGate({ sentAt: 'x', retries: 2, confirmText: '重试吧' }).ok === false)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
