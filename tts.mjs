/**
 * lib/tts.mjs —— 语音合成（HTTP 客户端，不 import 对方包）
 * ============================================================================
 * 契约 v2（对方 @memef1f1y/dsh-plugin-tts，MIT）：
 *   ① POST /dsh-tts-api/speak  { text, provider:"edge-tts", voice, prosody:{rate:"+0%"} }
 *        → { url: "/dsh-tts-audio/<id>" }
 *   ② GET  {url}  → MP3（24kHz 单声道）
 *
 * 踩过的坑：
 *   - **不要硬编码端口**：53055 / 58097 都见过，还要认 DSH_WEB_PORT
 *   - prosody.rate 必须是**带符号的百分比字符串**（"+0%"），数字 1 行为不稳定
 *   - 对方可能返回**纯文本**（"发好了"）而不是 JSON —— 那不是音频，要明确报错，
 *     不能把这句话当成成功（2026-11-01 用户就是这么被坑的）
 * ============================================================================
 */

const DEFAULTS = {
  ports: [53055, 58097],
  paths: { speak: '/dsh-tts-api/speak', audioPrefix: '/dsh-tts-audio/' },
  voice: 'zh-CN-XiaoyiNeural',
  provider: 'edge-tts',
}

/**
 * 候选端口：DSH_WEB_URL 里的端口最准（宿主在哪个端口，TTS 就挂在哪个端口），
 * 其次 DSH_WEB_PORT，最后才是历史端口。
 * 2026-11-02 实测：本机 DSH 在 52151，而 53055 / 58097 都连不上。
 */
export function candidatePorts(env = process.env) {
  const list = []
  const fromUrl = String(env.DSH_WEB_URL || '').match(/:\d{2,5}/)
  if (fromUrl) {
    const p = Number(fromUrl[0].slice(1))
    if (Number.isFinite(p) && p > 0) list.push(p)
  }
  const envPort = Number(env.DSH_WEB_PORT)
  if (Number.isFinite(envPort) && envPort > 0 && !list.includes(envPort)) list.push(envPort)
  for (const p of DEFAULTS.ports) if (!list.includes(p)) list.push(p)
  for (const p of [52151, 4173]) if (!list.includes(p)) list.push(p)
  return list
}

/** 把数字速率规范成 "+10%" / "-10%" / "+0%" */
export function normalizeRate(rate) {
  if (rate === undefined || rate === null || rate === '') return '+0%'
  const s = String(rate).trim()
  if (/^[+-]\d+%$/.test(s)) return s
  const n = Number(s)
  if (!Number.isFinite(n)) return '+0%'
  const pct = Math.round((n - 1) * 100) // 1.0 → +0%
  return `${pct >= 0 ? '+' : ''}${pct}%`
}

/** 探测哪个端口活着 */
export async function probe(ports = candidatePorts()) {
  for (const port of ports) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${DEFAULTS.paths.speak}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '\u00a0', provider: DEFAULTS.provider, voice: DEFAULTS.voice, prosody: { rate: '+0%' } }),
        signal: AbortSignal.timeout(2500),
      })
      if (res.status < 500) return { ok: true, port, status: res.status }
    } catch { /* 下一个 */ }
  }
  return { ok: false, ports }
}

/**
 * 合成一段语音。返回 {ok, file, bytes, port} 或 {ok:false, error, hint}
 */
export async function speak({ text, voice = DEFAULTS.voice, rate, outFile, ports, fetchImpl = fetch }) {
  const body = String(text ?? '').trim()
  if (!body) return { ok: false, error: 'E_TTS_EMPTY', hint: '要合成的文字是空的' }

  const tried = []
  for (const port of (ports || candidatePorts())) {
    const base = `http://127.0.0.1:${port}`
    try {
      const res = await fetchImpl(`${base}${DEFAULTS.paths.speak}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: body, provider: DEFAULTS.provider, voice, prosody: { rate: normalizeRate(rate) } }),
        signal: AbortSignal.timeout(30000),
      })
      const raw = await res.text()
      tried.push(`${port}:${res.status}`)

      if (!res.ok) continue

      // 关键判据：必须能解析出 url。返回纯文本 = 对方没接上，不是成功
      let json = null
      try { json = JSON.parse(raw) } catch { /* 下面统一报 */ }
      if (!json || typeof json.url !== 'string') {
        return {
          ok: false,
          error: 'E_TTS_NOT_AUDIO',
          hint: `语音服务返回的不是音频地址（原文：${raw.slice(0, 60)}）。`
            + '多半是 TTS 插件没装好或端口对不上——先确认插件里能看到「语音」设置页。',
          port,
          raw: raw.slice(0, 200),
        }
      }

      const audioUrl = json.url.startsWith('http') ? json.url : `${base}${json.url}`
      const au = await fetchImpl(audioUrl, { signal: AbortSignal.timeout(30000) })
      if (!au.ok) return { ok: false, error: 'E_TTS_AUDIO_FETCH', hint: `取音频失败 HTTP ${au.status}`, port }
      const buf = Buffer.from(await au.arrayBuffer())
      if (buf.length < 2000) {
        return { ok: false, error: 'E_TTS_TOO_SMALL', hint: `音频只有 ${buf.length} 字节，基本是空文件`, port }
      }
      if (outFile) {
        // 2026-11-04 修复同学修：原来直接 writeFileSync，audio/ 目录不存在时抛 ENOENT，
        // 被外层 catch 吞成 "E_TTS_UNREACHABLE（连不上语音服务）" —— 误导性极强。
        const fs = await import('node:fs')
        const path = await import('node:path')
        fs.mkdirSync(path.dirname(outFile), { recursive: true })
        fs.writeFileSync(outFile, buf)
      }
      return { ok: true, file: outFile, bytes: buf.length, port, voice, rate: normalizeRate(rate) }
    } catch (e) {
      tried.push(`${port}:${e?.name || 'err'}`)
    }
  }
  return {
    ok: false,
    error: 'E_TTS_UNREACHABLE',
    hint: `连不上语音服务（试过 ${tried.join('、')}）。确认已装 TTS 插件、DSH 正在运行；端口可用 DSH_WEB_PORT 指定。`,
    tried,
  }
}
