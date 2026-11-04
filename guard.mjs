/**
 * lib/guard.mjs —— 风控自保（2026-11-04）
 * ============================================================================
 * 为什么需要它：
 *   我们用网页自动化操作真实账号。机器人的特征太明显 —— 固定节奏、高频、无间隔。
 *   豆包的风控一旦判定，轻则当天限速，重则封号，用户会直接骂"插件把我号搞没了"。
 *
 * 两道自保：
 *   ① 每日调用上限（默认 30 次）—— 超了就拒绝，不给用户"不知不觉刷满"的机会
 *   ② 随机间隔（默认 60–180 秒）—— 打破固定节奏，模拟人的出手时间
 *
 * 状态落盘：<home>/guard.json  { date: 'YYYY-MM-DD', count: N, lastAt: ISO }
 * ============================================================================
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

/**
 * 「今天」按北京时区算（2026-11-04 修复同学抓到的真 bug）。
 * 原来用 toISOString().slice(0,10) —— 那是 UTC：北京 11-05 01:00 会被算成 11-04，
 * 也就是凌晨 0–8 点做视频的人**额度不重置**，8 点一到突然清零，用户会觉得"插件抽风"。
 */
export function dateKey(d = new Date()) {
  // en-CA 的日期格式就是 YYYY-MM-DD，加时区后不受运行环境区域设置影响
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(d)
}
const today = () => dateKey()

function guardPath(home) {
  const p = join(home, 'guard.json')
  mkdirSync(dirname(p), { recursive: true })
  return p
}

export function readGuard(home) {
  const p = guardPath(home)
  if (!existsSync(p)) return { date: today(), count: 0, lastAt: null }
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'))
    // 跨天自动清零
    if (j.date !== today()) return { date: today(), count: 0, lastAt: null }
    return { date: j.date, count: Number(j.count) || 0, lastAt: j.lastAt || null }
  } catch {
    return { date: today(), count: 0, lastAt: null }
  }
}

function writeGuard(home, g) {
  writeFileSync(guardPath(home), JSON.stringify(g, null, 2), 'utf8')
}

/** 生成一个 [min,max] 秒的随机等待（毫秒） */
export function randomGapMs(minSec = 60, maxSec = 180) {
  const lo = Math.max(0, Number(minSec) || 0)
  const hi = Math.max(lo, Number(maxSec) || lo)
  return Math.round((lo + Math.random() * (hi - lo)) * 1000)
}

/**
 * 发送前检查：今天还能不能发。
 * @returns {{ ok: boolean, reason?: string, count: number, limit: number, waitMs?: number }}
 */
export function checkQuota(home, { dailyLimit, dailyCallLimit, minGapSec = 60, maxGapSec = 180 } = {}) {
  // 2026-11-04：两个键名都认。以前只认 dailyLimit，调用方传 dailyCallLimit 时会静默
  // 回落到默认 30 —— 配置改了但没生效，最难查。
  const limit = Number.isFinite(Number(dailyLimit))
    ? Number(dailyLimit)
    : (Number.isFinite(Number(dailyCallLimit)) ? Number(dailyCallLimit) : 30)
  const dailyLimit_ = limit
  const g = readGuard(home)
  if (dailyLimit_ > 0 && g.count >= dailyLimit_) {
    return {
      ok: false,
      count: g.count,
      limit: dailyLimit_,
      reason: `今天已经发了 ${g.count} 次，达到自设上限 ${dailyLimit_} 次。\n`
        + '这是风控自保：固定高频操作真实账号容易被判定成机器人（限速甚至封号）。\n'
        + '确实还要发，把设置里的 dailyCallLimit 调大，或者明天再来。',
    }
  }
  // 随机间隔：距上次发送不足 minGap 就先等一会
  let waitMs = 0
  if (g.lastAt) {
    const since = Date.now() - new Date(g.lastAt).getTime()
    const need = randomGapMs(minGapSec, maxGapSec)
    if (since < need) waitMs = need - since
  }
  return { ok: true, count: g.count, limit: dailyLimit_, waitMs }
}

/** 发送成功后记账 */
export function commitCall(home) {
  const g = readGuard(home)
  const next = { date: today(), count: g.count + 1, lastAt: new Date().toISOString() }
  writeGuard(home, next)
  return next
}
