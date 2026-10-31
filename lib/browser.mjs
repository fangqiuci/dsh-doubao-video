/**
 * lib/browser.mjs —— 直接操作豆包网页（通过 CDP 连到已开着的 Edge）
 * ============================================================================
 * 为什么走 CDP 而不是自己 launch：
 *   `~/.dsh/doubao-browser/profile` 已经被一个带 `--remote-debugging-port=9333`
 *   的 Edge 占着了，再 launch 同一个 user-data-dir 会直接失败（SingletonLock）。
 *   连上去还能直接复用已登录的会话，不用重新扫码。
 *
 * 三条铁律（踩过就知道疼）：
 *   1. **绝不调用 browser.close()** —— connectOverCDP 拿到的 Browser 一旦 close，
 *      用户正在用的那个浏览器会被真的关掉。
 *   2. **fill 不能用 locator.fill** —— 豆包输入框是 Tiptap/ProseMirror，
 *      直接改 DOM 不会同步到它的内部状态，得用键盘事件（insertText）。
 *   3. **发送（Enter）单独成一个方法**，调用方必须先过审计和本人确认，
 *      这个方法本身不做任何授权判断。
 * ============================================================================
 */
import { loadFromProfile } from './hostdeps.mjs'
import { writeFileSync, statSync, existsSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const CDP_URL = 'http://127.0.0.1:9333'
export const COMPOSER = 'div.tiptap.ProseMirror[contenteditable="true"]'
export const DOUBAO_HOME = 'https://www.doubao.com/chat/'

/** 浏览器用户目录：跟之前手工打开时用的同一个，登录态在里面 */
export function profileDir() {
  const base = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(base, 'doubao-browser', 'profile')
}

/** Edge 的可执行文件（本机只装了 Edge，没有 Chrome） */
export function edgePath() {
  const cands = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '',
  ].filter(Boolean)
  return cands.find((p) => existsSync(p)) || null
}

let _chromium = null
async function chromium() {
  if (_chromium) return _chromium
  const mod = await loadFromProfile('playwright')
  if (!mod) throw new Error('找不到 playwright：profile 的 node_modules 里没有装')
  const c = mod.chromium || mod.default?.chromium
  if (!c) throw new Error('playwright 加载了但没有 chromium 导出')
  _chromium = c
  return c
}

/**
 * 自己把带调试端口的 Edge 拉起来。
 * 只在连不上 9333 时才会走到这里 —— 用户本来开着就用他的，不开就我们自己开。
 */
export function launchEdge({ port = 9333, dir } = {}) {
  const exe = edgePath()
  if (!exe) throw new Error('没找到 msedge.exe')
  const userDataDir = dir || profileDir()
  mkdirSync(userDataDir, { recursive: true })
  const args = [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--start-maximized',
    DOUBAO_HOME,
  ]
  const child = spawn(exe, args, { detached: true, stdio: 'ignore' })
  child.unref()
  return { ok: true, pid: child.pid, exe, userDataDir }
}

/** 轮询调试端口，最多等 timeoutMs */
async function waitForPort(url, timeoutMs = 45000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const r = await fetch(`${url}/json/version`)
      if (r.ok) return true
    } catch { /* 还没起来 */ }
    await new Promise((res) => setTimeout(res, 700))
  }
  return false
}

/**
 * 连上浏览器并取出豆包标签页。连不上就自己拉一个。
 * ⚠️ 绝不 close()：connectOverCDP 拿到的 Browser 一旦 close，
 *    用户正在用的窗口会被真的关掉（2026-10-31 差点踩到）。
 */
export async function open(cdpUrl = CDP_URL) {
  const c = await chromium()
  let browser = null
  let launched = null

  try {
    browser = await c.connectOverCDP(cdpUrl)
  } catch {
    launched = launchEdge({ port: Number(new URL(cdpUrl).port || 9333) })
    const up = await waitForPort(cdpUrl, 45000)
    if (!up) throw new Error(`浏览器拉起来了但调试端口 ${cdpUrl} 45 秒没响应（可能被安全软件拦了）`)
    browser = await c.connectOverCDP(cdpUrl)
  }

  let page = null
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) {
      if (!page && /doubao\.com/.test(p.url())) page = p
    }
  }
  if (!page) {
    const ctx = browser.contexts()[0]
    page = ctx ? await ctx.newPage() : await browser.newContext().then((x) => x.newPage())
    await page.goto(DOUBAO_HOME, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForTimeout(3000)
  }
  return { browser, page, launched }
}

/** 页面状态：有没有输入框、是不是正在生成、草稿里有什么 */
export async function status(page) {
  return page.evaluate(() => {
    const composer = document.querySelector('div.tiptap.ProseMirror[contenteditable="true"]')
    const body = document.body.innerText
    return {
      url: location.href,
      title: document.title,
      composer: !!composer,
      draftText: composer ? composer.innerText.trim() : '',
      generating: /视频生成中|生成中…|正在生成/.test(body.slice(-800)),
      fileInputs: document.querySelectorAll('input[type="file"]').length,
      lastText: body.slice(-200),
    }
  })
}

/**
 * 上传本地图片到豆包输入框。
 * 直接对隐藏的 input[type=file] 触发 change，比点"＋"再选菜单稳得多。
 */
export async function attach(page, files) {
  const list = (Array.isArray(files) ? files : [files]).filter(Boolean)
  if (!list.length) return { ok: true, attached: 0 }
  const input = page.locator('input[type="file"]').first()
  await input.setInputFiles(list)
  // 等缩略图/文件名出现在输入框附近（最多 15 秒）
  const name = list[0].replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '')
  await page.waitForTimeout(1500)
  const body = await page.evaluate(() => document.body.innerText.slice(-600))
  return { ok: true, attached: list.length, hint: `已投喂 ${list.length} 个文件（${name}…），页面尾部：${body.slice(-80)}` }
}

/**
 * 把提示词写进输入框。
 * 用 insertText 而不是 fill：Tiptap 只认真实的输入事件。
 */
export async function fill(page, text) {
  const box = page.locator(COMPOSER).first()
  await box.click()
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  await page.keyboard.insertText(String(text))
  await page.waitForTimeout(500)
  const draft = await page.evaluate(() => {
    const el = document.querySelector('div.tiptap.ProseMirror[contenteditable="true"]')
    return el ? el.innerText : ''
  })
  return { ok: true, draftLength: draft.length, head: draft.slice(0, 60) }
}

/**
 * 发送（按 Enter）。调用方必须先过审计 + 本人确认。
 */
export async function send(page) {
  await page.keyboard.press('Enter')
  await page.waitForTimeout(2000)
  return { ok: true, url: page.url() }
}

/** 等助手回复里出现某个特征，返回是否等到 */
export async function waitForText(page, needle, timeoutMs = 120000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const body = await page.evaluate(() => document.body.innerText)
    if (body.includes(needle)) return { ok: true, waitedMs: Date.now() - started }
    await page.waitForTimeout(2000)
  }
  return { ok: false, waitedMs: Date.now() - started }
}

/** 截图（给尾帧/取证用） */
export async function shot(page, path) {
  await page.screenshot({ path, fullPage: false })
  return { ok: true, path }
}

/* ───────────────── 清草稿 / 等出片 / 抓尾帧 / 下载 ───────────────── */

/** 清空输入框和已挂的附件（stage 试错后收拾现场用） */
export async function clear(page) {
  const box = page.locator(COMPOSER).first()
  await box.click()
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  await page.waitForTimeout(300)

  /**
   * 附件不是按钮，是 `div[data-testid="attachment-image-card"]`，
   * 删除图标 `svg[aria-label="delete"]` **只在 hover 之后才渲染**。
   * （2026-10-31：先前按"附近带 删除/close 的按钮"去找，一个都没点到，removed=0。）
   */
  let removed = 0
  const cards = page.locator('[data-testid="attachment-image-card"]')
  for (let i = 0; i < 12; i += 1) {
    const n = await cards.count()
    if (!n) break
    const card = cards.first()
    try {
      await card.hover({ timeout: 3000 })
      await page.waitForTimeout(250)
      const del = card.locator('svg[aria-label="delete"]')
      if (!(await del.count())) break
      await del.first().click({ force: true, timeout: 3000 })
      removed += 1
      await page.waitForTimeout(400)
    } catch { break }
  }

  const draft = await page.evaluate(() => {
    const el = document.querySelector('div.tiptap.ProseMirror[contenteditable="true"]')
    return el ? el.innerText.trim() : ''
  })
  const attachmentsLeft = await cards.count()
  return { ok: true, removed, attachmentsLeft, draft }
}

/** 等视频生成结束（"视频生成中" 消失） */
export async function waitIdle(page, timeoutMs = 900000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const generating = await page.evaluate(() => /视频生成中|正在生成/.test(document.body.innerText.slice(-1500)))
    if (!generating) return { ok: true, waitedMs: Date.now() - started }
    await page.waitForTimeout(3000)
  }
  return { ok: false, timeoutMs }
}

/** 页面上最后一个 <video> 的元信息 */
export async function lastVideo(page) {
  return page.evaluate(() => {
    const vids = [...document.querySelectorAll('video')]
    const v = vids[vids.length - 1]
    if (!v) return null
    return {
      src: v.currentSrc || v.src || '',
      duration: v.duration || 0,
      width: v.videoWidth || 0,
      height: v.videoHeight || 0,
    }
  })
}

/**
 * 抓最后一帧（原生分辨率）。
 *
 * 为什么不用 ffmpeg：这台机器上没装。改用页面内 canvas —— 把 video 定位到
 * duration-0.06 秒，drawImage 到 canvas，再 toDataURL。
 * 跨域视频会让 canvas 变 tainted（toDataURL 抛 SecurityError），那种情况会返回
 * error，调用方再退化成整页截图（分辨率差，但聊胜于无）。
 */
export async function tailFrame(page, outPath, atSeconds) {
  const res = await page.evaluate(async (at) => {
    const vids = [...document.querySelectorAll('video')]
    const v = vids[vids.length - 1]
    if (!v) return { error: '页面上没有 <video>' }
    const dur = v.duration || 0
    const t = (typeof at === 'number' && at >= 0) ? at : Math.max(0, dur - 0.06)
    try {
      if (Math.abs((v.currentTime || 0) - t) > 0.02) {
        await new Promise((done) => {
          const onSeek = () => { v.removeEventListener('seeked', onSeek); done() }
          v.addEventListener('seeked', onSeek)
          v.currentTime = t
          setTimeout(done, 3000)
        })
      }
      const c = document.createElement('canvas')
      c.width = v.videoWidth || 720
      c.height = v.videoHeight || 1280
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height)
      return { dataUrl: c.toDataURL('image/png'), t, dur, width: c.width, height: c.height }
    } catch (e) {
      return { error: String(e?.message || e) }
    }
  }, typeof atSeconds === 'number' ? atSeconds : undefined)

  if (res.error) return { ok: false, error: res.error }
  const b64 = String(res.dataUrl).split(',')[1] || ''
  writeFileSync(outPath, Buffer.from(b64, 'base64'))
  // 落盘校验（修 #2）：writeFileSync 成功不代表文件真的可用，统一在这里确认一次
  try {
    const st = statSync(outPath)
    if (!st.size) return { ok: false, error: `尾帧写出来是 0 字节：${outPath}` }
  } catch (e) {
    return { ok: false, error: `尾帧没有落盘：${String(e?.message || e)}` }
  }
  return { ok: true, path: outPath, at: res.t, duration: res.dur, size: [res.width, res.height] }
}

/* ───────── 2026-10-31 新增：视频卡片识别 / 挂载 / 等待 / 带重试下载 ─────────
 *
 * 豆包现在（2026-10）的视频结果不是 <video>，而是「竖版海报 + 右上角播放控件」的
 * 懒加载卡片；不点播放，DOM 里根本没有 <video>，所以旧的"数 <video>"判断永远失败。
 * 另外对话是虚拟列表，只保留最近几条消息，按"你的视频生成好了"的条数等待也不可靠。
 * 这里统一改成：数卡片 → 点最后一张的播放控件 → 读出 src。
 */

/** 当前页面的媒体状态：已挂载的 video src、竖版卡片数量、最后一张卡片位置、是否被额度拦 */
export async function mediaState(page) {
  return page.evaluate(() => {
    const srcs = [...document.querySelectorAll('video')].map((v) => v.currentSrc || v.src || '').filter(Boolean)
    const cards = []
    for (const img of document.querySelectorAll('img')) {
      const r = img.getBoundingClientRect()
      // 竖版、够大、在视口内才算"视频卡片的海报"
      if (r.width > 80 && r.height > r.width * 1.3 && r.height > 180) {
        cards.push({ x: r.x, y: r.y, w: r.width, h: r.height })
      }
    }
    // 额度拦截的文案豆包会换着说法写。2026-10-31 实测出现过两种：
    //   「当前免费体验套餐不可用于创作使用，可升级正式订阅」
    //   「今日视频生成免费额度已用完。开通订阅畅享更多额度。」
    // 只认第一种会漏判 → waitForNewVideo 会空等到超时（当天真机测试抓到的缺陷）。
    // 所以这里放宽成一组关键词，并且把命中原文带出去，方便事后核对。
    const tail = document.body.innerText.slice(-1200)
    const QUOTA_RE = /免费体验套餐不可用于创作|升级正式订阅|今日视频生成免费额度已用完|开通豆包订阅|开通订阅畅享|额度已用完|额度不足|no quota|quota exceeded/i
    const quotaHit = tail.match(QUOTA_RE)
    return {
      srcs,
      cards: cards.length,
      last: cards[cards.length - 1] || null,
      quota: !!quotaHit,
      quotaText: quotaHit ? quotaHit[0] : null,
      generating: /视频生成中|正在生成/.test(tail),
    }
  })
}

/** 点最后一张竖版卡片的播放控件，把 <video> 真正挂载出来 */
export async function mountLatestVideo(page) {
  const st = await mediaState(page)
  if (!st.last) return { ok: false, error: '页面上没有找到竖版视频卡片' }
  // 播放控件在卡片右上角（实测偏移约 14px）
  await page.mouse.click(st.last.x + st.last.w - 14, st.last.y + 14).catch(() => {})
  const started = Date.now()
  while (Date.now() - started < 15000) {
    const now = await mediaState(page)
    if (now.srcs.length) return { ok: true, srcs: now.srcs, waitedMs: Date.now() - started }
    await page.waitForTimeout(800)
  }
  return { ok: false, error: '点了播放控件，但 15 秒内没有挂载出 <video>', state: st }
}

/**
 * 等"新的一段视频"出现。
 * @param before { srcs: string[], cards: number } —— 动手前用 mediaState() 采一次
 * 判据是**卡片数量变多**（虚拟列表会丢消息，但卡片还在），再点最后一张挂载取 src。
 */
export async function waitForNewVideo(page, before = { srcs: [], cards: 0 }, timeoutMs = 900000) {
  const started = Date.now()
  const beforeSrcs = before.srcs || []
  while (Date.now() - started < timeoutMs) {
    const st = await mediaState(page)
    if (st.quota) return { ok: false, quota: true, waitedMs: Date.now() - started, state: st }
    if (st.cards > (before.cards || 0)) {
      const m = await mountLatestVideo(page)
      if (m.ok) {
        const fresh = m.srcs.find((s) => !beforeSrcs.includes(s)) || m.srcs[m.srcs.length - 1]
        if (fresh) return { ok: true, src: fresh, srcs: m.srcs, waitedMs: Date.now() - started, cards: st.cards }
      }
    } else {
      // 卡片没变但视频已经挂着（页面刷新过）：只认没见过的 src
      const fresh = st.srcs.find((s) => !beforeSrcs.includes(s))
      if (fresh) return { ok: true, src: fresh, srcs: st.srcs, waitedMs: Date.now() - started, cards: st.cards }
    }
    await page.waitForTimeout(5000)
  }
  return { ok: false, timeout: true, waitedMs: Date.now() - started }
}

/**
 * 带重试的下载。
 * 豆包的视频 URL 带签名时效（`l=YYYYMMDDHHmmss…`），过期直接 403/404；
 * 所以失败时重载页面、重新挂载播放器拿一次新签名再试（修 #11）。
 */
export async function downloadVideoRetry(page, savePath, { src, attempts = 3 } = {}) {
  let cur = src
  for (let i = 0; i < attempts; i += 1) {
    if (!cur) cur = (await lastVideo(page))?.src || null
    if (cur && /^https?:/i.test(cur)) {
      try {
        const r = await page.context().request.get(cur)
        if (r.ok()) {
          writeFileSync(savePath, await r.body())
          const st = statSync(savePath)
          if (st.size > 0) return { ok: true, via: 'request', path: savePath, attempt: i + 1, bytes: st.size }
        }
      } catch { /* 落到重载重试 */ }
    }
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {})
    await page.waitForTimeout(4000)
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {})
    for (let k = 0; k < 4; k += 1) {
      await page.mouse.wheel(0, 1200).catch(() => {})
      await page.waitForTimeout(800)
    }
    const m = await mountLatestVideo(page)
    cur = m.ok ? m.srcs[m.srcs.length - 1] : null
  }
  return { ok: false, error: `重试 ${attempts} 次仍然下载不了（签名过期或网络问题）` }
}

/**
 * 下载最后一条视频。
 *   A. 点页面上的「下载」按钮，等 Playwright 的 download 事件（最干净，拿到原文件）
 *   B. 拿不到就退化成用 context.request 直接抓 video.src（blob: 抓不了）
 */
export async function downloadVideo(page, savePath, opts = {}) {
  // 先按"指定的那一条"抓：capture 会把新出现的那条 src 传进来，
  // 避免在页面上有旧视频时把旧片当新的下下来（2026-10-31 踩过）。
  if (opts && opts.src && /^https?:/i.test(opts.src)) {
    try {
      const r0 = await page.context().request.get(opts.src)
      if (r0.ok()) { writeFileSync(savePath, await r0.body()); return { ok: true, via: 'src', path: savePath } }
    } catch { /* 落到按钮 */ }
  }
  const btn = page.locator('[aria-label*="下载"], [title*="下载"]').last()
  if (await btn.count()) {
    const wait = page.waitForEvent('download', { timeout: 25000 }).catch(() => null)
    await btn.click({ force: true }).catch(() => {})
    const dl = await wait
    if (dl) {
      await dl.saveAs(savePath)
      return { ok: true, via: 'download', path: savePath, name: dl.suggestedFilename() }
    }
  }

  const meta = await lastVideo(page)
  if (meta?.src && /^https?:/i.test(meta.src)) {
    try {
      const resp = await page.context().request.get(meta.src)
      if (resp.ok()) {
        writeFileSync(savePath, await resp.body())
        return { ok: true, via: 'request', path: savePath, bytes: (await statSync(savePath)).size }
      }
    } catch { /* 落到失败 */ }
  }
  return { ok: false, error: '没找到可下载的视频（按钮点不到，src 也不可抓）', meta }
}
