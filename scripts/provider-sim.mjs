process.env.DOUBAO_SKIP_SCRIPT_REVIEW = '1'
/**
 * scripts/provider-sim.mjs —— provider 层回归（mock 后端；不连浏览器、不花额度）
 * ============================================================================
 * 这是这次重构真正的收益：浏览器那 5 个工具以前永远进不了自动化 ——
 * 要么真连豆包烧额度，要么人工点。现在换成 mock 后端，分支逻辑可以断言了。
 *
 * 断言（对应 REFACTOR-PLAN 第 4 节）：
 *   1. browser_stage → ok:true，attached 数量正确
 *   2. browser_send 在草稿没变空时 → ok:false（"没发出去就算失败"）
 *   3. browser_capture → 拿到预设路径，尾帧路径非空
 * 另外锁住后端契约（7 个方法 + 单例）和额度/超时两个分支。
 * ============================================================================
 */
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 必须赶在 provider() 之前设定：后端选择靠这个环境变量
const root = mkdtempSync(join(tmpdir(), 'provsim-'))
process.env.DOUBAO_PROVIDER = 'mock'
process.env.DSH_HOME = join(root, 'dsh-home')

const { apply } = await import('../lib/index.mjs')
const { provider, resetProviders, providerKind } = await import('../lib/providers/index.mjs')

const home = join(root, 'home')
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)])
const mk = (n) => { const p = join(root, n); writeFileSync(p, png); return p }
const CARD = mk('辞辞-三视图.png')
const REF = mk('辞辞_参考图.png')
const SCENE = mk('书桌.png')
const SRC = 'https://www.doubao.com/chat/38450644545279746 · 2026-11-02'

let pass = 0, fail = 0
const t = (n, c, d = '') => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}  ${String(d).slice(0, 160)}`) } }

const tools = new Map()
apply({ tools: { register: (x) => tools.set(x.name, x) } }, {
  home, project: 'prov', strict: true, hasMembership: true, mediaMinSide: 1, mediaMinKBPerMP: 0,
})
const call = (n, a = {}) => tools.get(n).execute(a)

const shot = (v) => ({
  景别: ['中景', '近景', '特写'][v % 3], 运镜: '固定', 主角: '辞辞',
  动作: `第${v}拍：趴在书桌前敲键盘，尾巴甩了${v}下`,
  台词: (v % 3 === 0 ? `辞辞：第 ${v} 句台词` : '无'), 旁白: '无', 内心旁白: '无',
  表情细节: `第${v}拍：眼皮半垂，嘴角向下撇了${v}度`,
  感情细节: `第${v}拍：不耐烦但还是没停手`,
  音效: `第${v}拍：键盘连打声`, 光影: '冷蓝环境光加台灯暖黄侧逆光', 场景: '书桌',
})
const seg = (i, d) => ({ index: i, durationSeconds: d, styleRef: 'SL-1', shots: [shot(i * 3), shot(i * 3 + 1), shot(i * 3 + 2)] })

console.log('── 0. 后端契约 ──')
t('DOUBAO_PROVIDER=mock 生效', providerKind() === 'mock', providerKind())
const g1 = await provider()
const g2 = await provider()
t('provider() 是单例', g1 === g2)
t('后端名叫 mock', g1.name === 'mock', g1.name)
const CONTRACT = ['status', 'stage', 'submit', 'fetchClip', 'clear', 'shot', 'close']
t('7 个契约方法都在', CONTRACT.every((k) => typeof g1[k] === 'function'),
  CONTRACT.filter((k) => typeof g1[k] !== 'function').join(','))
resetProviders()
t('resetProviders 后是新实例', (await provider()) !== g1)

console.log('── 1. 准备一个可生成的段（mock 不碰浏览器） ──')
await call('doubao_style_lock', { project: 'prov', artStyle: '3D 动漫（非写实）', palette: '冷蓝低饱和' })
const sub = await call('doubao_script_submit', { project: 'prov', scriptJson: JSON.stringify({ segments: [seg(1, 8), seg(2, 8)] }) })
t('脚本通过', sub.ok === true, sub.text)
t('角色登记', (await call('doubao_role_register', { project: 'prov', name: '辞辞', cardImage: CARD, reference: REF, source: SRC, appearance: 'Q 版三头身，蓝白渐变长发，鲸鱼尾巴', outfit: '深蓝白女仆裙' })).ok)
t('场景登记', (await call('doubao_scene_register', { project: 'prov', file: SCENE, name: '书桌', source: SRC })).ok)

const st0 = await call('doubao_browser_status', { project: 'prov' })
t('browser_status 走 mock 也返回页面状态', st0.ok === true && /mock 后端/.test(st0.text), st0.text)

const sc = await call('doubao_shot_check', { project: 'prov', segment: 1, shotIndex: 0 })
t('shot_check 通过', sc.ok === true, sc.text)
const uploads = sc.requiredUploads || []
t('上传清单里有场景 + 参考图', uploads.length >= 2 && uploads.includes(SCENE) && uploads.includes(REF), JSON.stringify(uploads))

console.log('── 2. stage：上传 + 写稿（不发送） ──')
const stg = await call('doubao_browser_stage', { project: 'prov', segment: 1, promptText: sc.prompt })
t('browser_stage → ok:true', stg.ok === true, stg.text)
t('attached 数量正确', stg.attached?.length === uploads.length, `${stg.attached?.length} vs ${uploads.length}`)
t('文案里写了"已上传 N 张"', new RegExp(`已上传 ${uploads.length} 张`).test(stg.text || ''), stg.text)
t('没有真的发送（mock 草稿还在）', (await provider()).state.draft.length > 0)

console.log('── 3. send：没审计/没确认/没发出去都不许成功 ──')
const noAudit = await call('doubao_browser_send', { project: 'prov', segment: 1, confirmText: '确定生成视频', auditHash: 'nope' })
t('没审计 → ok:false', noAudit.ok === false, noAudit.text)

const au = await call('doubao_prompt_audit', {
  project: 'prov', segment: 1, shotIndex: 0, promptText: sc.prompt, uploadedFiles: uploads.join(';'),
})
t('审计通过', au.ok === true, au.text)

// 草稿没变空 = 没发出去（2026-11-01 真事故的复现）
process.env.DOUBAO_MOCK_DRAFT_STUCK = '1'
const stuck = await call('doubao_browser_send', { project: 'prov', segment: 1, confirmText: '确定生成视频', auditHash: au.auditHash })
t('草稿没变空 → ok:false', stuck.ok === false, stuck.text)
t('失败时把剩余草稿带出来', (stuck.draftLeft || '').length > 0, String(stuck.draftLeft || '').slice(0, 60))
t('失败时点了发送键但没成功', stuck.clickedSendButton === true)
delete process.env.DOUBAO_MOCK_DRAFT_STUCK

const okSend = await call('doubao_browser_send', { project: 'prov', segment: 1, confirmText: '确定生成视频', auditHash: au.auditHash })
t('草稿清空了 → ok:true', okSend.ok === true, okSend.text)
t('发送后写了 confirmedAt', (() => {
  try {
    const j = JSON.parse(readFileSync(join(home, 'projects', 'prov.json'), 'utf8'))
    return !!j.pending?.['1']?.confirmedAt
  } catch { return false }
})())

console.log('── 4. capture：等片 → 下载 → 尾帧 ──')
const cap = await call('doubao_browser_capture', { project: 'prov', segment: 1 })
t('browser_capture → ok:true', cap.ok === true, cap.text)
t('成片路径是预设的那条', /-seg1\.mp4$/.test(String(cap.video || '')), cap.video)
t('成片文件真的落盘了', !!cap.video && existsSync(cap.video), cap.video)
t('尾帧路径非空', !!cap.tailFrame, cap.tailFrame)
t('尾帧文件真的落盘了', !!cap.tailFrame && existsSync(cap.tailFrame), cap.tailFrame)

console.log('── 5. 额度 / 超时两个失败分支 ──')
const savePath = join(root, 'x-seg1.mp4')
process.env.DOUBAO_MOCK_QUOTA = '1'
const q = await (await provider()).fetchClip({ segment: 1, savePath, waitSeconds: 5 })
t('额度拦截 → phase=quota-before', q.ok === false && q.phase === 'quota-before', JSON.stringify(q).slice(0, 120))
delete process.env.DOUBAO_MOCK_QUOTA
process.env.DOUBAO_MOCK_TIMEOUT = '1'
const to = await (await provider()).fetchClip({ segment: 1, savePath, waitSeconds: 5 })
t('超时 → phase=timeout', to.ok === false && to.phase === 'timeout', JSON.stringify(to).slice(0, 120))
delete process.env.DOUBAO_MOCK_TIMEOUT

console.log('── 6. clear ──')
await (await provider()).stage({ uploads, promptText: '留着没用的草稿' })
const cl = await call('doubao_browser_clear', { project: 'prov' })
t('browser_clear → ok:true', cl.ok === true, cl.text)
t('清完草稿是空的', (await provider()).state.draft === '')

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
rmSync(root, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
