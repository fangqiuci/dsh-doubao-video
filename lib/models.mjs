/**
 * lib/models.mjs —— 豆包视频模型的时长 / 会员限制表
 * ============================================================================
 * 口径（本人 2026-11-02 定）：
 *   Seedance 2.0 Mini  无会员可用，单条 ≤ 10 秒   ← 默认
 *   Seedance 2.0 Fast  无会员可用，单条 ≤ 10 秒
 *   Seedance 2.0       需会员，     单条 ≤ 15 秒
 *   Seedance 2.5       需会员，     单条 ≤ 30 秒
 *
 * 规则要点：
 *   1. 默认 Mini；换任何其它模型都要**本人明确指定**（不接受模型自己挑）
 *   2. 要会员的模型，没开会员一律拒
 *   3. 段长超过该模型上限一律拒 —— 哪怕全局区间（5–30s）允许
 * ============================================================================
 */

export const DEFAULT_MODEL = 'Seedance 2.0 Mini'

/** 模型表：上限秒数 + 是否需要会员 */
export const MODELS = {
  'Seedance 2.0 Mini': { maxSeconds: 10, needsMembership: false },
  'Seedance 2.0 Fast': { maxSeconds: 10, needsMembership: false },
  'Seedance 2.0': { maxSeconds: 15, needsMembership: true },
  'Seedance 2.5': { maxSeconds: 30, needsMembership: true },
}

export const MODEL_NAMES = Object.keys(MODELS)

/** 某个模型在当前会员状态下的最大可用秒数；不可用返回 0 */
export function maxSecondsFor(model, { hasMembership = false } = {}) {
  const m = MODELS[model]
  if (!m) return 0
  if (m.needsMembership && !hasMembership) return 0
  return m.maxSeconds
}

/**
 * 校验某个模型能不能用、能用到几秒。
 * @param {string} model 模型名
 * @param {object} ctx { hasMembership, durationSeconds, approved }
 * @returns {{ ok, violations: {code,where,message}[], warnings }}
 */
export function checkModel(model, ctx = {}) {
  const violations = []
  const warnings = []
  const name = String(model || DEFAULT_MODEL)
  const info = MODELS[name]

  if (!info) {
    violations.push({
      code: 'E_MODEL_UNKNOWN', where: 'model',
      message: `未知模型「${name}」，只能是：${MODEL_NAMES.join(' / ')}`,
    })
    return { ok: false, violations, warnings }
  }

  // 换模型必须本人点头
  if (name !== DEFAULT_MODEL && !ctx.approved) {
    violations.push({
      code: 'E_MODEL_NEEDS_APPROVAL', where: 'model',
      message: `「${name}」不是默认模型：必须由本人明确指定后才能用（doubao_model_select）`,
    })
  }

  // 会员门槛
  if (info.needsMembership && !ctx.hasMembership) {
    violations.push({
      code: 'E_MODEL_NEEDS_MEMBERSHIP', where: 'model',
      message: `「${name}」需要豆包会员；当前没开会员，只能用 ${DEFAULT_MODEL} 或 Seedance 2.0 Fast`,
    })
  }

  // 段长上限
  const dur = Number(ctx.durationSeconds)
  const cap = maxSecondsFor(name, ctx)
  if (Number.isFinite(dur) && cap > 0 && dur > cap) {
    violations.push({
      code: 'E_DURATION_EXCEEDS_MODEL', where: 'durationSeconds',
      message: `${name} 单条最多 ${cap} 秒，这一段是 ${dur} 秒：要么拆段，要么换更高的模型`,
    })
  }

  return { ok: violations.length === 0, violations, warnings }
}
