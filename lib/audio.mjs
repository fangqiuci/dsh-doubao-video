/**
 * lib/audio.mjs —— 响度平衡（2026-11-04，修复同学提的"音效盖过人声"）
 * ============================================================================
 * 问题现场：film27 成片里 6–9 秒的雨声/电流声和人声差不多响，
 * 听感上像"有两种声音在里面"——其实只有一条音轨。
 *
 * 现实约束：豆包给的是**混好的一条音轨**，人声和音效已经烧在一起，
 * 我们没有分离音轨（没有 stem）。所以能做的只有三件事：
 *   ① 高频人声提亮（equalizer 抬高 2–4k）
 *   ② 压缩动态（acompressor：把雨声那种持续大声压下去，人声相对浮起来）
 *   ③ 整体响度归一到 -16 LUFS（发布平台的标准）
 *
 * 做不到的：把某一条声音单独抽出来（那需要人声分离模型）。
 * 所以别指望它"消掉雨声"，它做的是"让人声在混音里更突出"。
 * ============================================================================
 */

import { spawnSync } from 'node:child_process'

/**
 * @param {object} o
 * @param {string} o.video
 * @param {string} o.out
 * @param {'voice'|'mix'} [o.mode]  voice=强调人声（默认） / mix=只做响度归一
 * @param {number} [o.targetLufs]   目标响度，默认 -16（平台标准）
 * @param {number} [o.presenceDb]   2–4k 提亮多少 dB，默认 2
 * @param {string} [o.ffmpegPath]
 */
export function balanceAudio({
  video, out, mode = 'voice', targetLufs = -16, presenceDb = 2, ffmpegPath = 'ffmpeg',
}) {
  const filters = []
  if (mode === 'voice') {
    // 90Hz 以下基本是风声/震动，切掉；2–4k 是人声清晰度带，抬一点
    filters.push('highpass=f=90')
    filters.push(`equalizer=f=3000:width_type=o:width=2:g=${Number(presenceDb) || 2}`)
    // 压缩：阈值低、比率温和，把持续大声（雨声）压下去，人声相对浮起来
    filters.push('acompressor=threshold=0.12:ratio=3:attack=8:release=180:makeup=1')
  }
  // 双通道 loudnorm：先测后归，比单遍准
  filters.push(`loudnorm=I=${Number(targetLufs) || -16}:TP=-1.5:LRA=11`)

  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', video,
    '-af', filters.join(','),
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    out,
  ]
  const r = spawnSync(ffmpegPath, args, { encoding: 'utf8', windowsHide: true, timeout: 30 * 60 * 1000 })
  if (r.status !== 0) return { ok: false, error: (r.stderr || '').slice(-500) }
  return { ok: true, out, mode, filters: filters.join(',') }
}

/** 量一下整体响度（LUFS），用于"改前/改后"对比 */
export function measureLoudness(video, { ffmpegPath = 'ffmpeg' } = {}) {
  const r = spawnSync(ffmpegPath, ['-hide_banner', '-nostats', '-i', video,
    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'],
  { encoding: 'utf8', windowsHide: true, timeout: 10 * 60 * 1000 })
  const txt = `${r.stderr || ''}`
  const pick = (k) => {
    const m = txt.match(new RegExp(`"${k}"\\s*:\\s*"?(-?[0-9.]+)"?`))
    return m ? Number(m[1]) : null
  }
  return { inputI: pick('input_i'), inputTp: pick('input_tp'), inputLra: pick('input_lra') }
}
