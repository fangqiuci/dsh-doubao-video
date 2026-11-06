/**
 * lib/providers/web.mjs —— 操作豆包网页的后端（Playwright + CDP）
 * ============================================================================
 * 这一层只做"薄包装"：所有真正点页面的代码仍在 lib/browser.mjs，
 * 这里负责三件事：
 *   1. 构造时**不**连浏览器，第一次用到才连（open 只走一次，之后复用同一个 page）
 *   2. 把 browser.mjs 的几个动作拼成工具需要的语义（stage / submit / fetchClip）
 *   3. 任何异常都吞掉，返回 { ok:false, error }，绝不往工具层抛
 *
 * ⚠️ 绝不 close：connectOverCDP 拿到的 Browser 一旦 close，用户正在用的窗口会被关掉。
 * ============================================================================
 */
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import * as B from '../browser.mjs'

/** 由成片路径推出尾帧路径（<名>.mp4 → <名>-tail.png），与 capture 工具的命名一致 */
function tailFor(savePath) {
  return String(savePath).replace(/\.[^./\\]+$/, '') + '-tail.png'
}

/**
 * 创建 web 后端。
 * @param {{ cdpUrl?: string }} opts
 */
export function createWebProvider({ cdpUrl } = {}) {
  let page = null

  /**
   * 拿页面：**每次用前探活**（2026-11-06 P0-1）。
   * 旧实现只缓存一次 —— 用户手动关掉豆包浏览器后，之后所有浏览器工具永远"连不上"，
   * 只能重启 DSH 才能恢复。批量跑的时候中途关一次，整批就废。
   */
  async function ensure() {
    if (page) {
      try {
        await page.evaluate(() => document.readyState, [], { timeout: 3000 })
        return page
      } catch {
        page = null            // 探活失败：连接已经死了，丢掉重连
      }
    }
    page = (await B.open(cdpUrl || undefined)).page
    return page
  }

  /** 统一兜住异常：后端方法一律不抛 */
  // 2026-11-06：真机上首次调用偶尔报"连不上豆包页面"，重试一次就好（CDP 刚起来的空窗）。
  // 这里统一兜一层：失败 → 扔缓存 → 1 秒后重试一次。
  const guard = (fn) => async (...args) => {
    try {
      return await fn(...args)
    } catch (e) {
      try {
        page = null
        await new Promise((r) => setTimeout(r, 1000))
        return await fn(...args)
      } catch (e2) {
        return { ok: false, error: String(e2?.message || e?.message || e) }
      }
    }
  }

  return {
    name: 'web',

    /** 只读：页面对象本身（images.mjs 还在用它读 <img>） */
    get page() { return page },

    /** 提前把连接建起来（images 那类需要先拿 page 的调用方用） */
    ensure,

    status: guard(async () => {
      const p = await ensure()
      // 豆包是 SPA：刚打开时输入框还没挂上（2026-11-06 P2-7）。
      // 直接判"改版了"会误报，所以缺输入框先轮询最多 12 秒（800ms 一次）。
      let st = await B.status(p)
      for (let i = 0; i < 15 && st.composer === false; i += 1) {
        await p.waitForTimeout(800)
        st = await B.status(p)
      }
      return { ok: true, ...st }
    }),

    stage: guard(async ({ uploads = [], promptText = '' } = {}) => {
      const p = await ensure()
      // 先清空再挂（2026-11-06 P0-2）：豆包的附件发送后**不会自动消失**，
      // 不清就会带着上一段的参考图（"不管生成谁都在传辞辞那张图"）。
      let removed = 0
      try { removed = (await B.clear(p))?.removed ?? 0 } catch { /* 清不掉也继续，别阻断 */ }
      const attachRes = await B.attach(p, uploads)
      const fillRes = await B.fill(p, promptText)
      return {
        ok: true,
        removed,
        attached: attachRes?.attached ?? 0,
        filled: !!fillRes,
        draftLength: fillRes?.draftLength ?? 0,
      }
    }),

    submit: guard(async ({ confirmAfterSend } = {}) => {
      const p = await ensure()
      // B.send 内部已经验过"草稿真的空了"，没发出去会返回 ok:false
      const r = await B.send(p)
      if (!r.ok) return { ok: false, draftLeft: r.draftLeft, clicked: r.clicked, confirmed: false, confirmText: null }

      // 豆包侧：每条生成都要一句「确认生成视频」（平台要求，和 QQ 那边的授权无关）。
      // 默认自动补发；显式传空字符串可以关掉。
      let extra = confirmAfterSend === undefined ? '' : String(confirmAfterSend).trim()
      if (confirmAfterSend === undefined) {
        await p.waitForTimeout(4000)
        const asked = await p.evaluate(() => /确认后我再开始生成视频|确认生成视频/.test(document.body.innerText.slice(-1200)))
        if (asked) extra = '确认生成视频'
      }
      // 补发确认：**结果必须带出去**。2026-11-04 复核发现这里原来把第二次 send 的
      // 返回值丢了 —— 补发失败也报 ok，用户看到"已发送"却永远等不到片（豆包在等那句确认）。
      let confirmSent = null
      let confirmError = null
      if (extra) {
        await p.waitForTimeout(6000)
        await B.fill(p, extra)
        const r2 = await B.send(p)
        confirmSent = !!r2?.ok
        if (!confirmSent) confirmError = r2?.error || `补发「${extra}」没发出去`
      }

      // 再读一次状态：能确认"是否真的进入生成中"，供工具层给准确文案
      let generating = null
      try { generating = (await B.status(p))?.generating ?? null } catch { /* 读不到不影响发送成功 */ }

      return {
        ok: true,
        draftLeft: r.draftLeft,
        clicked: r.clicked,
        confirmed: true,
        confirmText: extra || null,
        confirmSent,
        confirmError,
        generating,
      }
    }),

    /**
     * 等新片 → 下载 → 抓尾帧。
     * 返回里除了契约要求的 ok/path/tailPath/waitedMs/quota/detail，
     * 还带着 before / found / state / dl / tf 这些原始现场，供工具层拼文案 ——
     * 文案一个字都不能变，所以现场必须原样带出去。
     */
    fetchClip: guard(async ({ segment, savePath, tailPath, waitSeconds = 900 } = {}) => {
      const p = await ensure()
      const dir = dirname(String(savePath))
      mkdirSync(dir, { recursive: true })
      const tail = tailPath || tailFor(savePath)
      const waitMs = (Number(waitSeconds) || 900) * 1000

      // 基线：卡片数 + 已挂载的 src。
      // 豆包的结果是「竖版海报 + 播放控件」的懒加载卡片，DOM 里没有 <video>，
      // 而且对话是虚拟列表（只留最近几条消息），所以：
      //   · 不能数 <video>（修 #1）
      //   · 不能数「你的视频生成好了」的条数（修 #4）
      //   · 判定"新片"要看卡片数量变多 + src 没出现过（修 #3）
      const before = await B.mediaState(p)
      if (before.quota) {
        return {
          ok: false,
          phase: 'quota-before',
          quota: true,
          quotaText: before.quotaText,
          before,
          waitedMs: 0,
          path: null,
          tailPath: null,
          detail: before.quotaText || '页面出现额度拦截文案',
        }
      }

      const found = await B.waitForNewVideo(p, { srcs: before.srcs, cards: before.cards }, waitMs)
      if (!found.ok) {
        const state = await B.status(p)
        return {
          ok: false,
          phase: found.quota ? 'quota-wait' : 'timeout',
          quota: !!found.quota,
          quotaText: found.state?.quotaText,
          before,
          found,
          state,
          waitedMs: found.waitedMs,
          waitMs,
          path: null,
          tailPath: null,
          detail: found.detail || (found.quota ? '等片期间出现额度拦截' : '等片超时，没出现新卡片'),
        }
      }

      // 豆包视频 URL 带签名时效，过期会 403/404：失败会自动重载页面拿新签名（修 #11）
      const dl = await B.downloadVideoRetry(p, savePath, { src: found.src })

      // 有 ffmpeg 就用它取尾帧（精确到片尾 0.05s）；没有才退回浏览器 canvas。
      // 2026-11-06 真机：film30 的 mp4 下来了（1215KB），但尾帧没生成、也没有任何日志。
      // 手动 ffmpeg -sseof 能取到，说明文件是好的 —— 问题在取帧这条链路没有兜底。
      // 现在按"可靠度"依次试：ffmpeg 模块 → ffmpeg 命令行 → 浏览器 canvas。
      let tf = null
      if (dl.ok) {
        try {
          const f = await import('../ffmpeg.mjs')
          if (f.version().ok) tf = f.tailFrame(dl.path, tail, {})
        } catch { /* 落到命令行 */ }
        if (!tf || !tf.ok) {
          try {
            const { spawnSync } = await import('node:child_process')
            const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-sseof', '-0.3',
              '-i', dl.path, '-frames:v', '1', tail], { windowsHide: true })
            if (r.status === 0) tf = { ok: true, path: tail, via: 'cli' }
          } catch { /* 落到 canvas */ }
        }
        if (!tf || !tf.ok) {
          try { tf = await B.tailFrame(p, tail) } catch { /* 保留原错误 */ }
        }
      } else {
        try { tf = await B.tailFrame(p, tail) } catch { /* 下载就失败了 */ }
      }
      // ffmpeg 分支失败时再用 canvas 兜一次
      if (dl.ok && (!tf || !tf.ok)) {
        try {
          const t2 = await B.tailFrame(p, tail)
          if (t2?.ok) tf = t2
        } catch { /* 保留原错误 */ }
      }
      // 落盘校验（修 #2）：writeFileSync 成功不代表文件真的可用
      if (dl.ok && tf?.ok && !existsSync(tf.path)) {
        tf = { ok: false, error: `尾帧路径不存在：${tf.path}` }
      }

      return {
        ok: !!(dl.ok && tf?.ok),
        phase: dl.ok && tf?.ok ? 'done' : 'failed',
        quota: false,
        before,
        found,
        dl,
        tf,
        waitedMs: found.waitedMs,
        cards: found.cards,
        path: dl.ok ? dl.path : null,
        tailPath: tf?.ok ? tf.path : null,
        detail: dl.ok ? (tf?.ok ? '' : String(tf?.error || '尾帧没取到')) : String(dl.error || '成片没下下来'),
        segment: Number(segment) || 0,
      }
    }),

    clear: guard(async () => {
      const r = await B.clear(await ensure())
      return { ok: true, removed: r?.removed ?? 0, attachmentsLeft: r?.attachmentsLeft ?? 0, draft: r?.draft ?? '' }
    }),

    shot: guard(async (path) => {
      const r = await B.shot(await ensure(), path)
      return { ok: true, path: r?.path ?? path }
    }),

    /** 保持连接：用户可能还在用这个浏览器，绝不断开 */
    async close() { /* 故意什么都不做 */ },
  }
}
