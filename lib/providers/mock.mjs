/**
 * lib/providers/mock.mjs —— 测试用的假后端（不连浏览器、不花额度）
 * ============================================================================
 * 为什么要有它：
 *   浏览器那 5 个工具以前永远测不到（要么真连豆包烧额度，要么人工点）。
 *   有了 mock，stage / send / capture 的**分支逻辑**（尤其"没发出去就不算成功"）
 *   可以进自动化。它只模拟状态，不模拟豆包的真实行为。
 *
 * 开关（环境变量，脚本里设）：
 *   DOUBAO_PROVIDER=mock          选它当后端
 *   DOUBAO_MOCK_DRAFT_STUCK=1     submit 后草稿不消失（模拟 Enter 只换行）
 *   DOUBAO_MOCK_QUOTA=1           status/fetchClip 报额度拦截
 *   DOUBAO_MOCK_TIMEOUT=1         fetchClip 直接超时
 * ============================================================================
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 一个合法的"空壳" PNG（只有签名，宽高读出来是 0，媒体体检不会误判） */
const FAKE_PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)])
const FAKE_MP4 = Buffer.from('mock-mp4-placeholder')

const on = (name) => process.env[name] === '1'

export function createMockProvider() {
  /** 后端的全部"记忆"：草稿、生成中标志、发送次数 */
  const st = {
    draft: '',
    generating: false,
    attached: 0,
    submitted: 0,
    cleared: 0,
  }
  const tailFor = (savePath) => String(savePath).replace(/\.[^./\\]+$/, '') + '-tail.png'

  /**
   * 给所有返回值盖戳（2026-11-04 收口）：
   * mock 会让工具"看起来成功"，但产出是 12 字节的占位文件。
   * 之前只有 url 里一个 mock:// 露馅，用户/上层很容易当成真片。
   * 现在强制三处留痕：mock:true、text 前缀 [MOCK]、文件名带 mock-。
   */
  const stampMock = (r) => {
    if (!r || typeof r !== 'object') return r
    const out = { ...r, mock: true }
    if (typeof out.text === 'string' && !out.text.startsWith('[MOCK]')) {
      out.text = '[MOCK] ' + out.text
    }
    return out
  }

  const guard = (fn) => async (...args) => {
    try {
      return stampMock(await fn(...args))
    } catch (e) {
      return { ok: false, mock: true, error: String(e?.message || e) }
    }
  }

  return {
    name: 'mock',

    /** mock 没有浏览器页面 */
    get page() { return null },

    /** 给测试看的状态快照（非契约字段） */
    get state() { return { ...st } },

    status: guard(async () => ({
      ok: true,
      url: 'mock://doubao.com/chat/',
      title: '豆包（mock 后端）',
      composer: true,
      draftText: st.draft,
      generating: st.generating,
      fileInputs: 1,
      lastText: '（mock 后端，没有真实页面）',
      cards: 0,
      quota: on('DOUBAO_MOCK_QUOTA'),
      quotaText: on('DOUBAO_MOCK_QUOTA') ? '今日视频生成免费额度已用完' : null,
    })),

    stage: guard(async ({ uploads = [], promptText = '' } = {}) => {
      const list = (Array.isArray(uploads) ? uploads : [uploads]).filter(Boolean)
      st.attached = list.length
      st.draft = String(promptText || '')
      return { ok: true, attached: list.length, filled: st.draft.length > 0, draftLength: st.draft.length }
    }),

    submit: guard(async () => {
      if (st.generating) return { ok: false, draftLeft: st.draft, clicked: false, confirmed: false, error: '正在生成中' }
      if (!st.draft) return { ok: false, draftLeft: '', clicked: false, confirmed: false, error: '输入框是空的' }
      st.submitted += 1
      if (on('DOUBAO_MOCK_DRAFT_STUCK')) {
        // 模拟 2026-11-01 的真事故：Enter 只换了行，草稿还在 = 没发出去
        return { ok: false, draftLeft: st.draft, clicked: true, confirmed: false, error: '草稿没变空（Enter 只换了行）' }
      }
      st.draft = ''
      st.generating = true
      // 与 web 后端保持契约一致（2026-11-04）：工具层靠 confirmSent/generating
      // 判断"补发确认成功没""到底进没进生成中"。
      return {
        ok: true, draftLeft: '', clicked: true, confirmed: true,
        confirmText: null, confirmSent: null, confirmError: null, generating: true,
      }
    }),

    fetchClip: guard(async ({ segment, savePath, tailPath, waitSeconds = 900 } = {}) => {
      const tail = tailPath || tailFor(savePath)
      const before = { srcs: [], cards: 0, quota: on('DOUBAO_MOCK_QUOTA'), quotaText: on('DOUBAO_MOCK_QUOTA') ? '今日视频生成免费额度已用完' : null }
      if (before.quota) {
        return { ok: false, phase: 'quota-before', quota: true, quotaText: before.quotaText, before, path: null, tailPath: null, waitedMs: 0, detail: 'mock 额度拦截' }
      }
      if (on('DOUBAO_MOCK_TIMEOUT')) {
        return { ok: false, phase: 'timeout', quota: false, before, found: { ok: false, timeout: true, waitedMs: Number(waitSeconds) * 1000 }, path: null, tailPath: null, waitedMs: 0, detail: 'mock 等片超时' }
      }
      st.generating = false
      mkdirSync(dirname(String(savePath)), { recursive: true })
      writeFileSync(savePath, FAKE_MP4)
      mkdirSync(dirname(String(tail)), { recursive: true })
      writeFileSync(tail, FAKE_PNG)
      return {
        ok: true,
        phase: 'done',
        quota: false,
        before,
        found: { ok: true, src: 'mock://video/1.mp4', waitedMs: 1200, cards: 1 },
        dl: { ok: true, via: 'request', path: savePath, attempt: 1, bytes: FAKE_MP4.length },
        tf: { ok: true, path: tail, at: 9.95, duration: 10, size: [720, 1280] },
        waitedMs: 1200,
        cards: 1,
        path: savePath,
        tailPath: tail,
        detail: '',
        segment: Number(segment) || 0,
      }
    }),

    clear: guard(async () => {
      st.draft = ''
      st.attached = 0
      st.cleared += 1
      return { ok: true, removed: 0, attachmentsLeft: 0, draft: '' }
    }),

    shot: guard(async (path) => {
      mkdirSync(dirname(String(path)), { recursive: true })
      writeFileSync(path, FAKE_PNG)
      return { ok: true, path }
    }),

    async close() { st.generating = false },
  }
}
