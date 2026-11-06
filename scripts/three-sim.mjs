process.env.DOUBAO_SKIP_SCRIPT_REVIEW = '1'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.mjs'

const home = mkdtempSync(join(tmpdir(), 'three-'))
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)])
const mk = (n) => { const p = join(home, n); writeFileSync(p, png); return p }
const CARD = mk('辞辞-三视图.png'); const REF = mk('辞辞_参考图.png'); const SCENE = mk('书桌.png')
const VID = join(home, 'c1.mp4'); writeFileSync(VID, Buffer.alloc(4096, 3))
const SRC = 'https://www.doubao.com/chat/38450644545279746 · 2026-11-04'

const tools = new Map()
apply({ tools: { register: (x) => tools.set(x.name, x) } }, { home, project: 'three', strict: true, hasMembership: true, mediaMinSide: 1, mediaMinKBPerMP: 0 })
const call = (n, a = {}) => tools.get(n).execute(a)
let pass = 0, fail = 0
const t = (n, c, d = '') => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}  ${String(d).slice(0, 160)}`) } }

const shot = (v, who = '辞辞') => ({
  景别: '中景', 运镜: '固定', 主角: who,
  动作: `第${v}拍：趴在书桌前敲键盘，尾巴甩了${v}下`, 台词: (v % 3 === 0 ? `辞辞：第 ${v} 句` : '无'),
  旁白: '无', 内心旁白: '无', 表情细节: `第${v}拍：眼皮半垂`, 感情细节: `第${v}拍：不耐烦`,
  音效: `第${v}拍：键盘声`, 光影: '冷蓝环境光加台灯暖黄侧逆光', 场景: '书桌',
})
const seg = (i) => ({ index: i, durationSeconds: 5, styleRef: 'SL-1', shots: [shot(i * 3), shot(i * 3 + 1), shot(i * 3 + 2)] })

await call('doubao_style_lock', { project: 'three', artStyle: '3D 动漫', palette: '冷蓝', characterScale: '中景约 1/2 画面高' })
const sub = await call('doubao_script_submit', { project: 'three', scriptJson: JSON.stringify({ segments: [seg(1), seg(2), seg(3), seg(4), seg(5), seg(6)] }) })
t('6 段脚本通过', sub.ok === true, sub.text)
await call('doubao_role_register', { project: 'three', name: '辞辞', cardImage: CARD, reference: REF, source: SRC, appearance: 'Q 版三头身，蓝白渐变长发', outfit: '女仆裙' })
await call('doubao_scene_register', { project: 'three', file: SCENE, name: '书桌', source: SRC })

console.log('── ① 关键帧回拉 ──')
const s1 = await call('doubao_shot_check', { project: 'three', segment: 1, shotIndex: 0 })
t('第 1 段无回拉帧', !(s1.requiredUploads || []).some((u) => u.includes('t1')), JSON.stringify(s1.requiredUploads))

// 伪造第 1 段已登记（带尾帧）
const pf = join(home, 'projects', 'three.json')
let j = JSON.parse(readFileSync(pf, 'utf8'))
j.clips['1'] = { segment: 1, file: VID, durationSeconds: 5, tailFrame: mk('t1.png'), tailTimeSeconds: 5, hash: 'aaa', at: new Date().toISOString() }
for (const k of [2, 3, 4]) j.clips[String(k)] = { segment: k, file: VID, durationSeconds: 5, tailFrame: mk('t' + k + '.png'), tailTimeSeconds: 5, hash: 'h' + k, at: new Date().toISOString() }
writeFileSync(pf, JSON.stringify(j, null, 2))

const s4 = await call('doubao_shot_check', { project: 'three', segment: 4, shotIndex: 0 })
t('第 4 段仍不回拉（只在 5 段后）', !(s4.requiredUploads || []).some((u) => u.includes('t1.png')), JSON.stringify(s4.requiredUploads))

const s5 = await call('doubao_shot_check', { project: 'three', segment: 5, shotIndex: 0 })
t('第 5 段强制带回第 1 段尾帧', (s5.requiredUploads || []).some((u) => u.includes('t1.png')), JSON.stringify(s5.requiredUploads))

console.log('── ② 元数据 JSON ──')
j = JSON.parse(readFileSync(pf, 'utf8'))
for (const k of ['2', '3', '4', '5']) j.pending[k] = { segment: Number(k), auditHash: 'h', approvedAt: new Date().toISOString(), confirmedAt: new Date().toISOString(), requiredUploads: [SCENE, REF] }
writeFileSync(pf, JSON.stringify(j, null, 2))
const reg = await call('doubao_clip_register', { project: 'three', segment: 2, file: VID, durationSeconds: 5, tailFrame: mk('t2.png'), tailTimeSeconds: 5 })
t('第 2 段登记成功', reg.ok === true, reg.text)
const metaPath = VID.replace(/\.[^.]+$/, '.json')
t('同名 JSON 落盘', existsSync(metaPath), metaPath)
if (existsSync(metaPath)) {
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
  t('元数据含模型', meta.model === 'Seedance 2.0 Mini', meta.model)
  t('元数据含比例锁', meta.styleLock?.characterScale === '中景约 1/2 画面高')
  t('元数据含 hash', meta.hash === 'e4a1b2c3' || typeof meta.hash === 'string')
}

console.log('── ③ 断点指引 ──')
j = JSON.parse(readFileSync(pf, 'utf8'))
j.pending['3'] = { ...j.pending['3'], segment: 3, confirmedAt: new Date().toISOString() }  // 已发送未登记
writeFileSync(pf, JSON.stringify(j, null, 2))
const st = await call('doubao_status', { project: 'three' })
t('状态里有断点行', st.text.includes('断点：'), st.text.split('\n').filter((l) => l.includes('断点')).join('|'))
t('断点给了下一步', /capture/.test(st.text))

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
rmSync(home, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
