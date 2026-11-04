/**
 * scripts/mock-guard-sim.mjs —— mock 收口验证（2026-11-04）
 * 目的：确保 mock 不可能"伪装成真成功"。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { provider, resetProviders, providerKind } from '../lib/providers/index.mjs'

const home = mkdtempSync(join(tmpdir(), 'mockguard-'))
let pass = 0, fail = 0
const t = (n, c, d = '') => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}  ${String(d).slice(0, 160)}`) } }

console.log('── 默认后端 ──')
delete process.env.DOUBAO_PROVIDER
t('默认是 web（不是 mock）', providerKind() === 'web', providerKind())

console.log('── mock 必须留痕 ──')
resetProviders()
const mk = await provider({ kind: 'mock' })
t('显式 kind=mock 能拿到', mk.name === 'mock')

const st = await mk.status()
t('status 带 mock:true', st.mock === true)

await mk.stage({ uploads: ['a.png'], promptText: '测试' })
const sub = await mk.submit()
t('submit 成功但带 mock:true', sub.ok === true && sub.mock === true, JSON.stringify(sub))
t('submit 文本有 [MOCK] 前缀（若有 text）', !sub.text || sub.text.startsWith('[MOCK]'), sub.text)
t('submit 带 confirmSent（与 web 契约一致）', 'confirmSent' in sub, JSON.stringify(Object.keys(sub)))
t('submit 带 generating', 'generating' in sub)

const cap = await mk.fetchClip({ segment: 1, savePath: join(home, 'x.mp4') })
t('fetchClip 带 mock:true', cap.mock === true, JSON.stringify(cap).slice(0, 120))

console.log('── 生产环境禁 mock ──')
resetProviders()
const oldEnv = process.env.NODE_ENV
process.env.NODE_ENV = 'production'
delete process.env.DOUBAO_ALLOW_MOCK
let threw = null
try { await provider({ kind: 'mock' }) } catch (e) { threw = e }
t('NODE_ENV=production 下拒绝 mock', !!threw, threw?.message)
process.env.DOUBAO_ALLOW_MOCK = '1'
resetProviders()
let okWithFlag = false
try { const p = await provider({ kind: 'mock' }); okWithFlag = p.name === 'mock' } catch { /* 失败 */ }
t('显式 DOUBAO_ALLOW_MOCK=1 才放行', okWithFlag)

process.env.NODE_ENV = oldEnv || ''
delete process.env.DOUBAO_ALLOW_MOCK
resetProviders()

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
rmSync(home, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
