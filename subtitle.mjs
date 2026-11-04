/**
 * lib/subtitle.mjs —— 字幕生成与烧制
 * ============================================================================
 * 为什么不用 drawtext：
 *   drawtext 要把中文、冒号、单引号、逗号全塞进 -vf 字符串里，Windows 上还要
 *   再叠一层路径转义（C\:/...），2026-11-01 就是在这里写错转义，整条命令崩。
 *   改成**先写 .srt 文件，再用 subtitles= 滤镜**——文字不进命令行，转义问题消失。
 *
 * 路径处理：
 *   ffmpeg 的 subtitles 滤镜认相对路径最稳。所以先把 .srt 写到视频同目录，
 *   然后以该目录为 cwd 跑 ffmpeg，滤镜里只写文件名。
 * ============================================================================
 */

import { writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, dirname, join } from 'node:path'

/** 00:00:01,234 */
function ts(sec, sep = ',') {
  const s = Math.max(0, Number(sec) || 0)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = Math.floor(s % 60)
  const ms = Math.round((s - Math.floor(s)) * 1000)
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${p(h)}:${p(m)}:${p(ss)}${sep}${p(ms, 3)}`
}

/**
 * 从分镜里抽出字幕条目。
 * 规则：一段内按分镜数均分时长；台词优先，没有台词才用旁白。
 * @returns {{start:number,end:number,text:string}[]}
 */
export function buildCues(segments, { startAt = 0 } = {}) {
  const cues = []
  let cursor = Number(startAt) || 0
  for (const seg of segments || []) {
    const dur = Number(seg.durationSeconds) || 10
    const shots = seg.shots || []
    const each = shots.length ? dur / shots.length : dur
    shots.forEach((shot, i) => {
      const text = pickText(shot)
      if (text) {
        cues.push({ start: cursor + each * i, end: cursor + each * (i + 1) - 0.05, text })
      }
    })
    cursor += dur
  }
  return cues
}

/** 台词 > 旁白 > 内心旁白；「无」当作没有 */
export function pickText(shot) {
  const clean = (v) => {
    const t = String(v ?? '').trim()
    if (!t || t === '无' || t === '（无）' || t === 'n/a') return ''
    // 去掉「角色：」前缀，字幕只留说的话
    return t.replace(/^[^：:]{1,12}[：:]\s*/, '').trim()
  }
  return clean(shot.台词) || clean(shot.旁白) || clean(shot.内心旁白)
}

/** 生成 SRT 文本 */
export function toSrt(cues) {
  return cues.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.text}\n`).join('\n')
}

/**
 * 把字幕烧进视频。
 * @param {{run:(args:string[],opts?:object)=>Promise<{ok:boolean,stderr?:string}>}} ff
 * @returns {{ok:boolean, out?:string, srt?:string, cues?:number, stderr?:string}}
 */
export function burn({ video, cues, out, ffmpegPath = 'ffmpeg', fontSize = 16, marginV = 42, audio = null }) {
  if (!cues?.length) return { ok: false, stderr: '没有字幕内容（分镜里台词/旁白都是「无」）' }
  const dir = dirname(video)
  const srt = join(dir, 'subs.srt')
  writeFileSync(srt, toSrt(cues), 'utf8')

  const style = [
    'FontName=Microsoft YaHei',
    `FontSize=${fontSize}`,
    'PrimaryColour=&H00FFFFFF',
    'OutlineColour=&H00000000',
    'BorderStyle=1',
    'Outline=2',
    'Shadow=0',
    'Alignment=2',
    `MarginV=${marginV}`,
  ].join(',')

  // cwd 切到视频目录、滤镜里只写文件名 —— 不出现盘符和反斜杠
  // 2026-11-04 修：以前只会 -c:a copy，源片没音轨时输出就是"只有字幕没有声音"。
  // 现在允许传 audio（配音/BGM 混好的文件），明确指定挂哪条音轨。
  const args = [
    '-y', '-i', basename(video),
    ...(audio ? ['-i', basename(audio)] : []),
    '-vf', `subtitles=${basename(srt)}:force_style='${style}'`,
    '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p',
    ...(audio
      ? ['-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '192k', '-shortest']
      : ['-c:a', 'copy']),
    basename(out),
  ]
  const r = spawnSync(ffmpegPath, args, { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 600000 })
  return r.status === 0
    ? { ok: true, out, srt, cues: cues.length }
    : { ok: false, stderr: (r.stderr || '').slice(-600), srt }
}
