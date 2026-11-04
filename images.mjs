/**
 * lib/images.mjs —— 批量生成图片素材（图文视频用）
 * ============================================================================
 * 为什么单独一个模块：
 *   视频那条链路是"发一条 → 等一条出片 → 下载一个 mp4"，节奏是分钟级；
 *   图文视频要的是"一次发 N 条 → 收 N 张图"，节奏是几十秒级，
 *   而且判定标准和视频完全不同（图是 <img>，视频是 <video> 卡片）。
 *
 * 判据（避免抓到上一批的旧图）：
 *   只在「发送之后新出现的 src」里取，before 快照里有的全部排除。
 * ============================================================================
 */

const IMG_MIN_SIDE = 200

/** 取当前页面上所有够大的图片 src（可排除已知的） */
export async function imageSrcs(page, exclude = []) {
  const list = await page.evaluate((min) => [...document.querySelectorAll('img')]
    .filter((i) => (i.naturalWidth || 0) >= min && /^https?:/.test(i.src))
    .map((i) => ({ src: i.src, w: i.naturalWidth, h: i.naturalHeight })), IMG_MIN_SIDE)
  const seen = new Set(exclude)
  return list.filter((x) => !seen.has(x.src))
}

/** 等新图出现：轮询到出现至少 1 张，或超时 */
export async function waitNewImages(page, exclude, { timeoutMs = 90000, pollMs = 2500 } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const fresh = await imageSrcs(page, exclude)
    if (fresh.length) return { ok: true, images: fresh, waitedMs: Date.now() - started }
    await page.waitForTimeout(pollMs)
  }
  return { ok: false, images: [], waitedMs: Date.now() - started }
}

/** 下载一张图到本地 */
export async function saveImage(page, url, outPath, fsMod) {
  const res = await page.context().request.get(url)
  if (!res.ok()) return { ok: false, error: `HTTP ${res.status()}` }
  const buf = await res.body()
  if (!buf || buf.length < 2000) return { ok: false, error: `只有 ${buf?.length ?? 0} 字节` }
  fsMod.writeFileSync(outPath, buf)
  return { ok: true, path: outPath, bytes: buf.length }
}

/**
 * 批量：发一句 → 等图 → 存图。逐条串行（并发发会把对话搞乱）。
 * @param {object} gen        生成后端（lib/providers/ 的实例）
 * @param {string[]} prompts   每张图一段提示词（每段会被当成一次发送）
 * @param {object} opts        { outDir, waitSeconds, onLog }
 */
export async function generateBatch(gen, prompts, { outDir, waitSeconds = 90, onLog = () => {} } = {}) {
  const fsMod = await import('node:fs')
  const pathMod = await import('node:path')
  fsMod.mkdirSync(outDir, { recursive: true })

  const saved = []
  const failed = []

  // 图片判定得读真实页面（<img> 的 src），所以还是要 page：
  // provider 只读暴露 page，不把"怎么找图"也搬进去（这轮只搬家，不加功能）
  const page = await (typeof gen?.ensure === 'function' ? gen.ensure() : gen?.page)
  if (!page) {
    return {
      ok: false,
      saved,
      failed: [{ index: 0, reason: '当前生成后端没有页面对象，批量出图只在 web 后端可用' }],
      dir: outDir,
    }
  }

  for (let i = 0; i < prompts.length; i += 1) {
    const prompt = String(prompts[i] || '').trim()
    const idx = i + 1
    if (!prompt) { failed.push({ index: idx, reason: '空提示词' }); continue }

    const before = (await imageSrcs(page)).map((x) => x.src)
    onLog(`[${idx}/${prompts.length}] 发送：${prompt.slice(0, 40)}…`)

    const staged = await gen.stage({ uploads: [], promptText: prompt })
    if (staged.ok === false) {
      failed.push({ index: idx, reason: `写不进去：${staged.error || '浏览器没连上'}` })
      continue
    }
    const sent = await gen.submit()
    if (sent.ok === false) {
      failed.push({ index: idx, reason: `没发出去（草稿还剩 ${String(sent.draftLeft || '').length} 字）` })
      continue
    }

    const waited = await waitNewImages(page, before, { timeoutMs: waitSeconds * 1000 })
    if (!waited.ok) { failed.push({ index: idx, reason: `等 ${waitSeconds}s 没出图` }); continue }

    const file = pathMod.join(outDir, `img-${String(idx).padStart(2, '0')}.png`)
    const r = await saveImage(page, waited.images[0].src, file, fsMod)
    if (r.ok) { saved.push({ index: idx, file: r.path, bytes: r.bytes, prompt }); onLog(`  ✓ ${file}`) }
    else failed.push({ index: idx, reason: r.error })
  }

  return { ok: saved.length > 0, saved, failed, dir: outDir }
}
