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

  async function ensure() {
    if (!page) {
      const r = await B.open(cdpUrl || undefined)
      page = r.page
    }
    return page
  }

  /** 统一兜住异常：后端方法一律不抛 */
  const guard = (fn) => async (...args) => {
    try {
      return await fn(...args)
    } catch (e) {
      return { ok: false, error: String(e?.message || e) }
    }
  }

  return {
    name: 'web',

    /** 只读：页面对象本身（images.mjs 还在用它读 <img>） */
    get page() { return page },

    /** 提前把连接建起来（images 那类需要先拿 page 的调用方用） */
    ensure,

    status: guard(async () => {
      const st = await B.status(await ensure())
      return { ok: true, ...st }
    }),

    stage: guard(async ({ uploads = [], promptText = '' } = {}) => {
      const p = await ensure()
      const attachRes = await B.attach(p, uploads)
      const fillRes = await B.fill(p, promptText)
      return {
        ok: true,
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
      let tf
      try {
        const f = await import('../ffmpeg.mjs')
        tf = dl.ok && f.version().ok
          ? f.tailFrame(dl.path, tail, {})
          : await B.tailFrame(p, tail)
      } catch {
        tf = await B.tailFrame(p, tail)
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
