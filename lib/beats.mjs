/**
 * lib/beats.mjs —— 节拍检测（2026-11-12，0.1.7）
 * ============================================================================
 * 为什么要有它：剪辑手法里的「卡点 / 三连切 / 变速 ramp」全都需要知道
 * 音乐在**哪几秒打拍**。没有 BPM 就只能靠人耳数，做不了自动化。
 *
 * 做法（纯 ffmpeg + 纯 JS，不加依赖）：
 *   ① ffmpeg 解成 8kHz 单声道 PCM
 *   ② 按 20ms 帧算能量，取「能量突增」（onset）作为候选拍点
 *   ③ 对 onset 间隔做自相关，找 60–200 BPM 区间里最强的周期 → BPM
 *   ④ 以第一拍为锚，生成整条节拍网格（beat grid）
 *
 * 局限：这是"能量法"，对鼓点强的流行乐准；纯人声/环境音会噪。
 *       测不出就返回 confident:false，调用方应退回硬切，不要瞎对齐。
 * ============================================================================
 */
import { spawnSync } from 'node:child_process'

const SR = 8000
const HOP = 0.02      // 20ms
const WIN = Math.round(SR * HOP)

/** 解出单声道 PCM 能量曲线 */
function energyCurve(video, ffmpegPath = 'ffmpeg') {
  const r = spawnSync(ffmpegPath, ['-v', 'error', '-i', video, '-vn', '-ac', '1', '-ar', String(SR),
    '-f', 's16le', '-'], { maxBuffer: 512 * 1024 * 1024, windowsHide: true })
  const buf = r.stdout || Buffer.alloc(0)
  const frames = Math.floor((buf.length / 2) / WIN)
  const energy = new Float64Array(frames)
  for (let i = 0; i < frames; i += 1) {
    let s = 0
    const base = i * WIN
    for (let j = 0; j < WIN; j += 1) {
      const v = buf.readInt16LE((base + j) * 2) / 32768
      s += v * v
    }
    energy[i] = Math.sqrt(s / WIN)
  }
  return energy
}

/** 能量突增点（onset）：用"正向差分"（flux），比直接比均值稳 */
function onsets(energy, { ratio = 2.0, minGapFrames = 5 } = {}) {
  const n = energy.length
  const flux = new Float64Array(n)
  for (let i = 1; i < n; i += 1) flux[i] = Math.max(0, energy[i] - energy[i - 1])

  // 自适应阈值：全局均值的 ratio 倍（鼓点尖、环境音平，这样区分度最好）
  let sum = 0
  for (let i = 0; i < n; i += 1) sum += flux[i]
  const thr = (sum / n) * ratio

  const out = []
  let last = -Infinity
  for (let i = 1; i < n; i += 1) {
    if (flux[i] > thr && flux[i] >= flux[i - 1] && i - last >= minGapFrames) {
      out.push(+(i * HOP).toFixed(3))
      last = i
    }
  }
  return out
}

/**
 * BPM + 节拍网格。
 * @returns {{ok, bpm, beats: number[], confident, reason?}}
 */
export function detectBeats(video, { ffmpegPath = 'ffmpeg', minBpm = 60, maxBpm = 200 } = {}) {
  const energy = energyCurve(video, ffmpegPath)
  if (!energy.length) return { ok: false, bpm: null, beats: [], confident: false, reason: '解不出音频（没有音轨？）' }
  const on = onsets(energy)
  if (on.length < 8) return { ok: false, bpm: null, beats: on, confident: false, reason: `只找到 ${on.length} 个拍点，太少` }

  // 用"间隔直方图"估 BPM（自相关在拍点少时样本不够，会算出 0）。
  // 做法：相邻 onset 间隔 → 折成 60–200 BPM 的候选 → 容差内投票 → 取票最多的。
  const intervals = []
  for (let i = 1; i < on.length; i += 1) intervals.push(on[i] - on[i - 1])

  const candidates = new Map()
  const fold = (b) => {
    let x = b
    while (x < minBpm) x *= 2
    while (x > maxBpm) x /= 2
    return x
  }
  for (const iv of intervals) {
    if (!iv || iv <= 0) continue
    const b = fold(60 / iv)
    const key = Math.round(b)          // 1 BPM 一格
    candidates.set(key, (candidates.get(key) || 0) + (iv < 0.9 ? 1 : 0.6))
  }
  let bestKey = null
  let bestScore = 0
  for (const [k, v] of candidates) if (v > bestScore) { bestScore = v; bestKey = k }
  const best = { lag: 0, score: bestScore / Math.max(1, intervals.length) }

  const bpm = bestKey ? +bestKey : null
  // 2026-11-14 真机：纯对白片也会算出 BPM 150 并判"可信"。
  // 光看投票比例不够，还要看 ① 命中率（间隔是否稳定落在同一周期）② 覆盖比例（拍点铺满时长了吗）。
  const period0 = bestKey ? 60 / bestKey : 0
  let hit = 0
  for (const iv of intervals) {
    if (Math.abs(iv - period0) / period0 <= 0.05) hit += 1
  }
  const hitRate = intervals.length ? hit / intervals.length : 0
  const dur = energy.length * HOP
  const coverage = period0 ? Math.min(1, (on.length * period0) / Math.max(0.1, dur)) : 0
  const confident = !!bestKey && hitRate >= 0.6 && coverage >= 0.25 && on.length >= 8

  // 以第一拍为锚，铺满整条
  let beats = []
  if (bpm) {
    const period = 60 / bpm
    const anchor = on[0]
    const dur = energy.length * HOP
    for (let t = anchor; t < dur; t += period) beats.push(+t.toFixed(3))
  }
  return {
    ok: true, bpm, beats,
    firstBeat: beats[0] ?? null,
    periodSec: bpm ? +(60 / bpm).toFixed(4) : null,
    confident,
    hitRate: +hitRate.toFixed(2),
    coverage: +coverage.toFixed(2),
    reason: confident ? '' : `没有稳定节拍（命中率 ${(hitRate * 100).toFixed(0)}%，覆盖 ${(coverage * 100).toFixed(0)}%）—— 这种片别卡点`,
  }
}

/**
 * 卡点评分：给定的切点时间离最近的节拍有多远。
 * 偏差中位数 < 40ms 合格；> 80ms 就是没卡上。
 */
export function beatScore(cutTimes, beats) {
  if (!beats || !beats.length) return { ok: false, reason: '没有节拍网格' }
  const devs = []
  for (const t of cutTimes) {
    let best = Infinity
    for (const b of beats) best = Math.min(best, Math.abs(b - t))
    devs.push(best * 1000) // ms
  }
  devs.sort((a, b) => a - b)
  const median = devs.length ? devs[Math.floor(devs.length / 2)] : null
  const verdict = median == null ? 'none' : (median < 40 ? 'good' : median < 80 ? 'ok' : 'off')
  return { ok: true, medianMs: median == null ? null : +median.toFixed(1), worstMs: +Math.max(...devs).toFixed(1), verdict, cuts: cutTimes.length }
}

/** 把切点吸附到最近节拍（卡点用） */
export function snapToBeats(cutTimes, beats, { toleranceSec = null } = {}) {
  if (!beats || !beats.length) return cutTimes
  // 2026-11-14 真机：最后一个切点（11.2s）在网格尾部之外，直接被跳过没吸附。
  // 解决：把网格按最后两拍的平均周期向两头外推，覆盖所有切点。
  const period = beats.length >= 2 ? (beats[beats.length - 1] - beats[beats.length - 2]) : 0
  // 容差默认取半拍：卡点的本意就是吸到最近的拍，不该因为差 0.2 秒就不吸。
  const tol = toleranceSec == null ? (period > 0 ? period / 2 : 0.12) : toleranceSec
  const maxCut = Math.max(...cutTimes, beats[beats.length - 1])
  const grid = beats.slice()
  if (period > 0) {
    for (let t = beats[beats.length - 1] + period; t <= maxCut + period; t += period) grid.push(+t.toFixed(3))
  }
  return cutTimes.map((t) => {
    let best = t
    let bestD = Infinity
    for (const b of grid) {
      const d = Math.abs(b - t)
      if (d < bestD) { bestD = d; best = b }
    }
    return bestD <= tol ? +best.toFixed(3) : t
  })
}
