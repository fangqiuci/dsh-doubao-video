/**
 * lib/asr.mjs —— 按原声语音岛出字幕（2026-11-04，采纳修复同学的实测方案）
 * ============================================================================
 * 为什么不用"脚本台词均分"那一套（我原来的做法）：
 *   film26 真机实测：脚本 9 句台词，豆包**只念了 3 句**。按脚本均分排 9 条字幕，
 *   就有 6 条在对着空气说话 —— 偏差 5.8~6.8 秒，比"算得准不准"严重得多。
 *
 * 所以改成：
 *   ① 先按能量切「语音岛」（0.1s RMS，阈值 -32dB，间隙 <0.45s 合并）
 *   ② 逐岛喂 whisper —— 不要整段喂，长静音会让时间戳漂到离谱
 *   ③ 幻觉过滤：纯音效段 whisper 会吐"字幕by索兰娅""请不吝点赞"这类固定短语
 *   ④ 找不到 python / faster-whisper 时**明确报错 + 给安装命令**，不静默降级
 * ============================================================================
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKER = join(HERE, '..', 'scripts', 'asr_run.py')

/** whisper 在无语音处的高频幻觉，命中即丢（可继续补） */
export const HALLUCINATIONS = [
  '字幕by索兰娅', '字幕由索兰娅提供', '请不吝点赞', '订阅转发', '打赏支持明镜与点点栏目',
  '谢谢观看', '谢谢大家', '下期再见', '明镜与点点', '請不吝點贊',
]

/** 繁体/标点规范化（他实测发现 '你到底是什麼?' 会原样吐出来） */
export function normalizeText(s) {
  return String(s || '')
    .replace(/什麼/g, '什么')
    .replace(/這/g, '这')
    .replace(/單/g, '单')
    .replace(/[?？!！,，。.\s]+$/g, '')
    .replace(/\s+/g, '')
    .trim()
}

/**
 * 2026-11-04 修复同学补：DSH 自带解释器要进候选。
 * 实测这台机器 PATH 上的 `python.exe` 是**微软商店占位符**（WindowsApps 下的 0 字节转发器），
 * 一调就退出、没有 faster_whisper ⇒ findPython 判定"没装 Python"，但 DSH 运行时里其实就带了一个。
 * 顺带把失败原因记下来，别再让用户对着"pip install"发呆（他装的可能是另一个解释器）。
 */
export function pythonCandidates(cfg = {}) {
  const out = [process.env.DOUBAO_PYTHON, cfg.pythonPath]
  const home = process.env.USERPROFILE || process.env.HOME || ''
  if (home) {
    const rt = join(home, '.dsh', 'dsh-runtimes')
    for (const base of ['dsh-primary-runtime', 'dsh-runtime']) {
      out.push(join(rt, base, 'dependencies', 'python', 'python.exe'))
    }
  }
  const local = process.env.LOCALAPPDATA || ''
  if (local) out.push(join(local, 'Programs', 'Python', 'Python312', 'python.exe'), join(local, 'Programs', 'Python', 'Python311', 'python.exe'))
  out.push('python', 'python3', 'py')
  return out.filter(Boolean)
}

export function findPython(cfg = {}, tried = []) {
  for (const c of pythonCandidates(cfg)) {
    const r = spawnSync(c, ['-c', 'import faster_whisper,sys;print("ok")'], { encoding: 'utf8', windowsHide: true })
    const ok = r.status === 0 && /ok/.test(r.stdout || '')
    tried.push({ python: c, ok, why: ok ? '' : (r.error?.code || r.stderr?.split('\n')[0]?.slice(0, 80) || `exit ${r.status}`) })
    if (ok) return c
  }
  return null
}

/**
 * 抽音轨 → 切岛 → 逐岛识别 → 返回行。
 * worker 第 6 个参数传输出文件（Windows 控制台 GBK 会把 stdin/stdout 中文打成 U+FFFD）。
 */
export function transcribe({ video, python, thresholdDb = -32, minGapSec = 0.45, minIslandSec = 0.35, model = 'small', outJson = null }) {
  const jsonOut = outJson || join(dirname(video), `asr-${Date.now()}.json`)
  const args = [WORKER, video, String(thresholdDb), String(minGapSec), String(minIslandSec), model, jsonOut]
  const r = spawnSync(python, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
  if (r.status !== 0) {
    return { ok: false, error: 'E_ASR_FAILED', hint: (r.stderr || '').slice(-400) || `python worker 退出码 ${r.status}` }
  }
  let rows
  try {
    rows = JSON.parse(readFileSync(jsonOut, 'utf8'))
  } catch {
    try { rows = JSON.parse(r.stdout) } catch { return { ok: false, error: 'E_ASR_BAD_JSON', hint: (r.stdout || '').slice(0, 200) } }
  }

  const dropped = []
  const lines = []
  for (const it of rows) {
    const text = normalizeText(it.text)
    if (!text) { dropped.push({ ...it, why: 'empty' }); continue }
    if (HALLUCINATIONS.some((h) => text.includes(h))) { dropped.push({ ...it, why: 'hallucination' }); continue }
    if (Number(it.lp) > -0.35 && text.length <= 2 && it.end - it.start < 0.4) { dropped.push({ ...it, why: 'low-conf-short' }); continue }
    lines.push({ start: Number(it.start), end: Number(it.end), text, conf: it.lp })
  }
  return { ok: true, lines, dropped, raw: rows, json: jsonOut }
}

const ts = (t) => {
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = t % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`.replace('.', ',')
}

export function toSrt(lines, { padStartSec = 0.2, padEndSec = 0.4 } = {}) {
  return lines.map((l, i) => `${i + 1}\n${ts(Math.max(0, l.start - padStartSec))} --> ${ts(l.end + padEndSec)}\n${l.text}\n`).join('\n')
}
