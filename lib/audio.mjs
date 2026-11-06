/**
 * lib/audio.mjs —— 响度平衡 v2（2026-11-05）
 * ============================================================================
 * 为什么重写：
 *   旧版用 `loudnorm` 单遍"拉总增益凑 -16 LUFS"，安静段跟着一起被抬。
 *   真机实测（film27）：静音段 -41.1 → -20.3 dB（**+20.8dB**，底噪功率放大 ~10 倍），
 *   而第一句人声反而被 `acompressor threshold=0.12` 压小了 4.3 dB。
 *   结果就是"雨声糊满全程、人声被埋"——和工具想解决的问题正好相反。
 *
 * 新做法（校准过的，不是拍脑袋）：
 *   ① 先量三个数：整体 LUFS、底噪（10 分位）、人声（90 分位）
 *   ② 允许增益 = min(目标增益, maxGainDb)     ← 底噪最多抬 maxGainDb，抬不动就宁可不够响
 *   ③ 用 volume=XdB 做**一次可预测增益**，不交给 loudnorm 自己决定
 *   ④ 轻压缩只压峰值（threshold 0.3 / ratio 2），不做大 makeup
 *   ⑤ 输出后复量，断言"底噪涨幅 ≤ maxGainDb + 0.5"，超了**拒绝输出**
 *
 * 说清楚做不到的：豆包给的是混好的一条轨，没有人声分离。
 * 这个工具**不可能把雨声压下去**，只能"提亮人声 + 保证底噪不被放大"。
 * 真要人声浮出来，得上 demucs/UVR 这类分离模型（新依赖）。
 * ============================================================================
 */

import { spawnSync } from 'node:child_process'

/** 量整体响度（LUFS）。解析失败时把 stderr 尾巴带出来，不再静默 null */
export function measureLoudness(video, { ffmpegPath = 'ffmpeg' } = {}) {
  const r = spawnSync(ffmpegPath, ['-hide_banner', '-nostats', '-i', video,
    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'],
  { encoding: 'utf8', windowsHide: true, timeout: 10 * 60 * 1000 })
  const txt = `${r.stderr || ''}`
  const pick = (k) => {
    const m = txt.match(new RegExp(`"${k}"\\s*:\\s*"?(-?[0-9.]+)"?`))
    return m ? Number(m[1]) : null
  }
  const out = { inputI: pick('input_i'), inputTp: pick('input_tp'), inputLra: pick('input_lra') }
  // 2026-11-05：ffmpeg 版本换了、输出格式变了 —— 别静默返回 null，把现场带出来
  if (out.inputI == null) out.parseError = txt.slice(-300) || `ffmpeg 退出码 ${r.status}`
  return out
}

/** 0.1s 窗口分位响度：floor=底噪(10%) / loud=人声(90%) */
export function analyze(video, { ffmpegPath = 'ffmpeg' } = {}) {
  const l = measureLoudness(video, { ffmpegPath })
  const r2 = spawnSync(ffmpegPath, ['-v', 'error', '-i', video, '-vn', '-ac', '1', '-ar', '16000',
    '-f', 's16le', '-'], { maxBuffer: 256 * 1024 * 1024, windowsHide: true })
  const buf = r2.stdout
  if (!buf || !buf.length) return { lufs: l.inputI, floorDb: null, loudDb: null, parseError: '解不出 PCM 音频（片里没有音轨？）' }
  const n = Math.floor(buf.length / 2)
  const win = 1600 // 0.1s @16k
  const db = []
  for (let i = 0; i + win <= n; i += win) {
    let s = 0
    for (let j = i; j < i + win; j++) { const v = buf.readInt16LE(j * 2) / 32768; s += v * v }
    db.push(10 * Math.log10(s / win + 1e-12))
  }
  db.sort((a, b) => a - b)
  const q = (p) => (db.length ? db[Math.min(db.length - 1, Math.floor(db.length * p))] : null)
  return { lufs: l.inputI, floorDb: q(0.10), midDb: q(0.50), loudDb: q(0.90), windows: db.length }
}

/**
 * @param {object} o
 * @param {string} o.video
 * @param {string} o.out
 * @param {'voice'|'mix'} [o.mode]     voice=提亮人声（默认）/ mix=只做增益归一
 * @param {number} [o.targetLufs]      目标响度，默认 -16
 * @param {number} [o.presenceDb]      2–4k 提亮 dB，默认 2
 * @param {number} [o.maxGainDb]       增益上限（底噪保护），默认 6
 * @param {string} [o.ffmpegPath]
 */
export function balanceAudio({
  video, out, mode = 'voice', targetLufs = -16, presenceDb = 2, maxGainDb = 6, ffmpegPath = 'ffmpeg',
}) {
  const a = analyze(video, { ffmpegPath })
  if (a.lufs == null) return { ok: false, error: `测不到 LUFS${a.parseError ? '：' + a.parseError : ''}` }

  const wanted = Number(targetLufs) - a.lufs
  const gain = Math.min(wanted, Number(maxGainDb))
  const filters = ['highpass=f=90']
  if (mode === 'voice') {
    filters.push(`equalizer=f=3000:width_type=o:width=2:g=${Number(presenceDb) || 2}`)
  }
  filters.push(`volume=${gain.toFixed(2)}dB`)
  if (mode === 'voice') {
    // 轻压缩：只压峰值，不靠 makeup 把人声拉回来（旧版就是栽在这）
    filters.push('acompressor=threshold=0.3:ratio=2:attack=10:release=200:makeup=1')
  }
  filters.push('alimiter=limit=0.95')

  const r = spawnSync(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-i', video,
    '-af', filters.join(','), '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart', out], { encoding: 'utf8', windowsHide: true, timeout: 30 * 60 * 1000 })
  if (r.status !== 0) return { ok: false, error: `${r.stderr}`.slice(-500) }

  const b = analyze(out, { ffmpegPath })
  const noiseRise = (b.floorDb != null && a.floorDb != null) ? (b.floorDb - a.floorDb) : null
  if (noiseRise != null && noiseRise > Number(maxGainDb) + 0.5) {
    return {
      ok: false,
      error: `底噪被抬了 ${noiseRise.toFixed(1)}dB（上限 ${maxGainDb}dB），已拒绝输出。`
        + '这说明片源特别轻、需要很大增益；请改用 demucs 分离或手工调 targetLufs。',
      before: a, after: b,
    }
  }
  // 工程师补的边界：增益被截住时，响度到不了目标 —— 必须说清，不让用户以为坏了
  const shortfall = Number(targetLufs) - (b.lufs ?? Number(targetLufs))
  return {
    ok: true, out, mode,
    filters: filters.join(','),
    before: a, after: b,
    gainDb: Number(gain.toFixed(2)),
    wantedDb: Number(wanted.toFixed(2)),
    cappedBy: wanted > Number(maxGainDb) ? Number(maxGainDb) : null,
    shortfallDb: Number(shortfall.toFixed(2)),
    noiseRiseDb: noiseRise == null ? null : Number(noiseRise.toFixed(1)),
  }
}
