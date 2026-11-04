/**
 * lib/dub.mjs —— 按成片节奏配音 / 叠 BGM
 * ============================================================================
 * 为什么要单独一个模块：
 *   原来 doubao_tts 只"生成一段音频"就结束了，谁也不知道它该放在第几秒。
 *   实际配音必须**贴着画面走**：第 5 秒镜头里人物开口，声音就得从第 5 秒开始，
 *   早一点像对不上口型，晚一点像穿帮。
 *
 * 两种模式（本人 2026-11-04 定）：
 *   replace  替换原声：TTS 铺在时间轴上 + BGM 垫底，豆包原声丢掉
 *   keep     沿用豆包原声：只叠 BGM + 字幕，一句话都不重新配
 *
 * 时间轴来源：脚本里每段的 durationSeconds + 分镜顺序，累计出每个镜头的起止。
 * ============================================================================
 */

import { spawnSync } from 'node:child_process'
import { dirname, join, basename } from 'node:path'
import { writeFileSync } from 'node:fs'

const CLIP_FIELDS = ['台词', '旁白', '内心旁白']

/** 从脚本累计出每个镜头的起止秒（按段内均分） */
export function timelineFromScript(segments, { startAt = 0, skipEmpty = true } = {}) {
  const cues = []
  let cursor = Number(startAt) || 0
  ;(segments || []).forEach((seg) => {
    const dur = Number(seg.durationSeconds) || 10
    const shots = seg.shots || []
    const each = shots.length ? dur / shots.length : dur
    shots.forEach((shot, i) => {
      const text = pickLine(shot)
      if (!text && skipEmpty) return
      cues.push({
        segment: Number(seg.index) || 0,
        shotIndex: i,
        start: Number((cursor + each * i).toFixed(3)),
        end: Number((cursor + each * (i + 1)).toFixed(3)),
        text,
      })
    })
    cursor += dur
  })
  return cues
}

/** 台词 > 旁白 > 内心旁白；「无」当空 */
export function pickLine(shot) {
  for (const f of CLIP_FIELDS) {
    const v = String(shot?.[f] ?? '').trim()
    if (v && v !== '无' && v !== '（无）') return v
  }
  return ''
}

/**
 * 把配音轨铺到时间轴上，并可选叠 BGM。
 *
 * @param {object} o
 * @param {string} o.video        成片（豆包拼好的）
 * @param {{file:string,start:number,volume?:number}[]} o.lines  配音片段 + 起始秒
 * @param {'replace'|'keep'} o.mode
 * @param {string} [o.bgm]        BGM 文件
 * @param {number} [o.bgmDb]      BGM 增益（负数=压低，默认 -18）
 * @param {number} [o.voiceDb]    配音增益（默认 0）
 * @param {string} o.out
 * @param {string} [o.ffmpegPath]
 */
export function mixDubbing({
  video, lines = [], mode = 'replace', bgm = null,
  bgmDb = -18, voiceDb = 0, out, ffmpegPath = 'ffmpeg',
}) {
  const exe = ffmpegPath
  // keep 模式的意义就是「保留原声 + 加 BGM」；两样都没有时没有后期可做，直接拒。
  if (mode === 'keep' && !bgm) {
    return { ok: false, error: 'keep 模式至少要给 BGM：不重配又不加 BGM，等于什么都没做' }
  }
  const inputs = ['-i', video]
  const filters = []
  const pads = []

  // 原声：replace 模式下丢掉，keep 模式保留
  const keepOriginal = mode === 'keep'
  if (keepOriginal) pads.push('[0:a]')

  // 配音片段：每个 adelay 到自己的起点
  lines.forEach((ln, i) => {
    const idx = inputs.length / 2 // 当前要加的输入序号
    inputs.push('-i', ln.file)
    const ms = Math.max(0, Math.round((Number(ln.start) || 0) * 1000))
    const vol = Number.isFinite(ln.volume) ? ln.volume : 1
    filters.push(
      `[${idx}:a]adelay=${ms}|${ms},volume=${vol},aresample=44100[narr${i}]`,
    )
    pads.push(`[narr${i}]`)
  })

  // BGM：循环到成片长度后压低
  if (bgm) {
    const idx = inputs.length / 2
    inputs.push('-stream_loop', '-1', '-i', bgm)
    filters.push(`[${idx}:a]volume=${bgmDb}dB,aresample=44100[bgm]`)
    pads.push('[bgm]')
  }

  if (!pads.length) {
    return { ok: false, error: '没有任何可混的音轨：replace 模式要至少一条配音，keep 模式要 BGM' }
  }

  // amix 会把多轨相加；单轨时直接用
  let audioLabel
  if (pads.length === 1) {
    audioLabel = pads[0]
  } else {
    filters.push(`${pads.join('')}amix=inputs=${pads.length}:duration=first:dropout_transition=0,volume=1.2[mix]`)
    audioLabel = '[mix]'
  }
  // 末尾必须 apad：否则 -shortest 会按「最短的那条音轨」截断成片。
  // 2026-11-04 实测：10 秒视频 + 两条 1 秒配音，出来只有 4.3 秒。
  filters.push(`${audioLabel}${voiceDb ? `volume=${voiceDb}dB,` : ''}apad[fin]`)
  const outLabel = '[fin]'

  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '0:v', '-map', outLabel,
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
    '-shortest', '-movflags', '+faststart',
    out,
  ]
  const r = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true, timeout: 30 * 60 * 1000 })
  if (r.status !== 0) return { ok: false, error: (r.stderr || '').slice(-600), args }
  return { ok: true, out, lines: lines.length, mode, bgm: bgm ? basename(bgm) : null }
}

/** 生成一份「配音脚本」清单，方便先核对时间轴再合成 */
export function cuesToScript(cues) {
  return cues.map((c, i) => `${String(i + 1).padStart(2, '0')}  ${c.start.toFixed(2)}s–${c.end.toFixed(2)}s  [第${c.segment}段#${c.shotIndex}]  ${c.text}`).join('\n')
}

/**
 * 按**已登记片段的真实时长**算时间轴（2026-11-04 修 bug①：字幕/音频对不齐）。
 *
 * 原来用脚本里的 durationSeconds（理论值）。成片实际会短一点
 * （豆包给的时长、去重叠 40ms、粗剪），累计几段后字幕就和声音错开。
 * 这里优先用 clips[n].durationSeconds（登记时 ffprobe 出的真值），
 * 并扣掉接缝裁掉的 overlapMs —— 字幕按"实际画面"对，而不是按"计划"对。
 */
export function timelineFromClips(segments, clips, { overlapMs = 40 } = {}) {
  const cues = []
  let cursor = 0
  const list = segments || []
  list.forEach((seg, idx) => {
    const n = Number(seg.index) || idx + 1
    const real = Number(clips?.[n]?.durationSeconds)
    const planned = Number(seg.durationSeconds) || 10
    const dur = Number.isFinite(real) && real > 0 ? real : planned
    const shots = seg.shots || []
    const each = shots.length ? dur / shots.length : dur
    shots.forEach((shot, i) => {
      const text = pickLine(shot)
      if (!text) return
      cues.push({
        segment: n,
        shotIndex: i,
        start: Number((cursor + each * i).toFixed(3)),
        end: Number((cursor + each * (i + 1)).toFixed(3)),
        text,
        estimated: !(Number.isFinite(real) && real > 0),
      })
    })
    cursor += dur
    if (idx < list.length - 1) cursor -= Math.max(0, Number(overlapMs) || 0) / 1000
  })
  return cues
}
