/**
 * lib/ffmpeg.mjs —— 后期环节的底座：探测 / 取帧 / 拼接
 * ============================================================================
 * 为什么必须用 ffmpeg 而不是浏览器 canvas：
 *   · 尾帧要**精确到段末**（第 5 节要求 10.0s±0.25s），canvas 只能抓"当前显示的那一帧"，
 *     能不能对上全看播放器心情；
 *   · 拼接、字幕、音轨这些后期工序，浏览器根本做不了。
 *
 * 安装位置（2026-10-31 装的便携版）：
 *   ~/.dsh/tools/ffmpeg/bin/ffmpeg.exe（同时已加入用户 PATH）
 * 查找顺序：设置里的 ffmpegPath → 环境变量 FFMPEG_PATH → PATH → DSH_HOME 下的约定位置
 * ============================================================================
 */
import { existsSync, readdirSync, writeFileSync, mkdirSync, statSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** 在 DSH_HOME 下找常见的便携安装位置 */
function scanHome() {
  const roots = [join(dshHome(), 'tools', 'ffmpeg', 'bin'), join(dshHome(), 'tools', 'ffmpeg')]
  for (const root of roots) {
    const direct = join(root, 'ffmpeg.exe')
    if (existsSync(direct)) return direct
    try {
      for (const d of readdirSync(root)) {
        const p = join(root, d, 'bin', 'ffmpeg.exe')
        if (existsSync(p)) return p
      }
    } catch { /* 没有就算了 */ }
  }
  return null
}

/** 找出 ffmpeg.exe；找不到返回 null */
export function findFfmpeg(explicit) {
  if (explicit && existsSync(explicit)) return explicit
  if (process.env.FFMPEG_PATH && existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH
  const hit = scanHome()
  if (hit) return hit
  try {
    const r = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', windowsHide: true })
    if (r.status === 0) return 'ffmpeg'
  } catch { /* 不在 PATH */ }
  return null
}

/** ffprobe 一般和 ffmpeg 同目录 */
export function findFfprobe(explicit) {
  if (explicit && existsSync(explicit)) return explicit
  const ff = findFfmpeg()
  if (ff && ff !== 'ffmpeg') {
    const p = join(dirname(ff), 'ffprobe.exe')
    if (existsSync(p)) return p
  }
  if (process.env.FFPROBE_PATH && existsSync(process.env.FFPROBE_PATH)) return process.env.FFPROBE_PATH
  return 'ffprobe'
}

function run(exe, args, { timeoutMs = 120000 } = {}) {
  const r = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true, timeout: timeoutMs })
  return {
    ok: r.status === 0,
    code: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    error: r.error ? String(r.error.message) : null,
  }
}

/** 版本信息（给 status 工具用） */
export function version(ffmpegPath) {
  const exe = findFfmpeg(ffmpegPath)
  if (!exe) return { ok: false }
  const r = run(exe, ['-version'])
  const first = (r.stdout || r.stderr).split('\n')[0] || ''
  return { ok: r.ok, path: exe, version: first.trim() }
}

/** 探测视频：时长/分辨率/帧率/有没有音轨 */
export function probe(video, { ffprobePath } = {}) {
  const exe = findFfprobe(ffprobePath)
  const r = run(exe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', video])
  if (!r.ok) return { ok: false, error: (r.stderr || r.error || '').slice(0, 300) }
  try {
    const j = JSON.parse(r.stdout)
    const v = (j.streams || []).find((s) => s.codec_type === 'video') || {}
    const a = (j.streams || []).find((s) => s.codec_type === 'audio')
    const fps = String(v.r_frame_rate || '0/1').split('/').reduce((n, d, i, arr) => (i === 1 ? Number(arr[0]) / Number(d) : n), 0)
    return {
      ok: true,
      duration: Number(j.format?.duration || v.duration || 0),
      width: Number(v.width || 0),
      height: Number(v.height || 0),
      fps: Number.isFinite(fps) ? Number(fps.toFixed(2)) : 0,
      hasAudio: !!a,
      sizeBytes: Number(j.format?.size || 0),
    }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
}

/**
 * 取某一时刻的帧（默认取片尾前 0.05 秒 —— 这就是"尾帧"）。
 *
 * 2026-10-31 真实踩到的坑（修 #2）：
 *   输入侧 `-ss (时长-0.05)` 有时正好落在**最后一帧之后**，ffmpeg 一帧都不写，
 *   但退出码仍是 0 —— 于是"尾帧成功"却根本找不到文件，下一段首帧就断了。
 *   所以这里改成：多个时间点依次试 + **每次都校验文件真的写出来了**。
 */
export function tailFrame(video, outPath, { atSeconds, ffmpegPath } = {}) {
  const exe = findFfmpeg(ffmpegPath)
  if (!exe) return { ok: false, error: '找不到 ffmpeg' }
  const meta = probe(video)
  if (!meta.ok) return { ok: false, error: `探测失败：${meta.error}` }
  const dur = meta.duration || 0
  mkdirSync(dirname(outPath), { recursive: true })
  const base = typeof atSeconds === 'number' ? atSeconds : Math.max(0, dur - 0.05)

  const tries = [
    { at: base, pre: true },                          // 原口径：片尾前 0.05s
    { at: Math.max(0, base - 0.2), pre: true },       // 退 0.2s 再试（避开"最后一帧之后"）
    { at: Math.max(0, base - 0.05), pre: false },     // 输出侧定位：慢但帧一定存在
  ]

  for (const t of tries) {
    try { if (existsSync(outPath)) unlinkSync(outPath) } catch { /* 清不掉就继续 */ }
    const args = t.pre
      ? ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(t.at.toFixed(3)), '-i', video, '-frames:v', '1', '-q:v', '2', outPath]
      : ['-y', '-hide_banner', '-loglevel', 'error', '-i', video, '-ss', String(t.at.toFixed(3)), '-frames:v', '1', '-q:v', '2', outPath]
    const r = run(exe, args)
    if (!r.ok) continue
    try {
      const st = statSync(outPath)
      if (st.size > 0) return { ok: true, path: outPath, at: t.at, duration: dur, size: [meta.width, meta.height] }
    } catch { /* 没写出来，换下一个时间点 */ }
  }

  return { ok: false, error: 'ffmpeg 没有写出尾帧（试了 3 个时间点，文件都不存在或为 0 字节）', meta }
}

/**
 * 按顺序拼接多段（段序 = 拼接顺序）。
 * 各段可能由豆包单独生成，参数未必完全一致，所以统一重编码到同一规格，
 * 不然 concat demuxer 会在接缝处花屏或直接拒绝。
 */
export function concat(files, outPath, { width = 1080, height = 1920, fps = 30, ffmpegPath } = {}) {
  const exe = findFfmpeg(ffmpegPath)
  if (!exe) return { ok: false, error: '找不到 ffmpeg' }
  const list = (files || []).filter((f) => f && existsSync(f))
  if (!list.length) return { ok: false, error: '没有可拼接的片段' }
  if (list.length !== (files || []).length) {
    return { ok: false, error: `有 ${(files || []).length - list.length} 个片段文件不存在，先确认路径` }
  }

  const listFile = join(dirname(outPath), `concat-${Date.now()}.txt`)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(listFile, list.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8')

  const vf = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,fps=${fps},format=yuv420p`
  const r = run(exe, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-vf', vf,
    '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    outPath,
  ], { timeoutMs: 30 * 60 * 1000 })
  if (!r.ok) return { ok: false, error: (r.stderr || r.error || '').slice(0, 400), listFile }
  return { ok: true, path: outPath, segments: list.length, listFile, meta: probe(outPath) }
}
