/**
 * dsh-doubao-video —— host 半端
 * ============================================================================
 * 它是干什么的：把《大肥鱼豆包制作视频》这份 SOP 里"写了但没人能验"的部分，
 * 变成一串**模型必须调用、调了就有明确 PASS/FAIL** 的闸门工具。
 *
 *   风格锁  →  doubao_style_lock        （第 0 节 / 原第 6 节，必须在写脚本之前）
 *   脚本    →  doubao_script_submit     （第 1 节：10 秒一段 / ≥3 分镜 / 12 字段 / 占位符 / 情绪不重复）
 *   角色卡  →  doubao_role_register     （第 2 节：角色必须来自脚本 / 设定卡 ≠ 参考图）
 *   场景    →  doubao_scene_register    （第 3 节：场景名不带景别 / 场景里不许有人）
 *   生成    →  doubao_shot_check        （第 4 节：风格锁 + 参考图 + 场景卡 + 上一段尾帧，顺带拼好提示词）
 *   首尾帧  →  doubao_clip_register     （第 5 节：成片 10 秒 / 尾帧取在段末）
 *   总览    →  doubao_status / doubao_gate_table
 *
 * 设计约束（都是踩过的）：
 *   - `@deepseek-ai/dsh-tools` / `schemastery` 是 optional peer，桌面版 profile
 *     （autoInstallPeers=false）可能根本没有 ⇒ **裸 import 失败会让整条插件不激活**。
 *     所以这里全部 try/catch 动态取，取不到就降级（没有 Config，工具照常注册）。
 *   - 工具返回值必须是无损 JSON（函数/循环引用会让宿主报 "value is not lossless JSON"）。
 *   - 每条违规都带 `where` + **怎么改**，不然模型只会反复重试同一份稿子。
 * ============================================================================
 */
import { readFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  SHOT_FIELDS,
  checkScript,
  checkRole,
  checkScene,
  checkVideo,
  checkClip,
  checkGenerateWindow,
  auditPrompt,
  auditUploads,
  buildShotPrompt,
  collectEntities,
  splitNames,
} from './rules.mjs'
import { loadHostPackage, loadFromProfile } from './hostdeps.mjs'
import { checkImage } from './media.mjs'
import {
  defaultHome,
  loadProject,
  saveProject,
  recordHistory,
  bumpAttempt,
  resetAttempt,
  safeSlug,
  toMap,
} from './store.mjs'

/* ── 宿主依赖：能拿就拿，拿不到就降级 ───────────────────────────── */

let z = null
const schemastery = await loadHostPackage('schemastery')
if (schemastery) z = schemastery.default ?? schemastery

let defineTool = null
const dshTools = await loadHostPackage('dsh-tools')
if (dshTools?.defineTool) defineTool = dshTools.defineTool
if (typeof defineTool !== 'function') {
  // 宿主的 defineTool 会做 schema 转换与参数校验；这里只保证"原样透传"，
  // 参数已经按 JSON Schema 写好了，不影响使用。
  defineTool = (options) => options
}

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const PKG = (() => {
  try { return JSON.parse(readFileSync(join(PLUGIN_DIR, '..', 'package.json'), 'utf8')) } catch { return { version: '0.1.0' } }
})()

export const name = 'doubao-video'
// 只声明 tools：没有 webServer 也要能装，设置命名空间靠 entry id + Config 推导
export const inject = ['tools']

/**
 * 设置命名空间（entry id 必须等于 `doubao-video`，见 cordis.patch.yml）。
 * ⚠️ 每个字段都要 `.extra('volatile', true)`，否则 DSH 的 settings.update() 会抛
 *    "Plugin entry … has no volatile fields"，设置页写不进去。
 */
export const Config = !z ? undefined : z.object({
  /** 状态目录；留空 = $DSH_HOME/doubao-video */
  home: z.string().default('').extra('volatile', true),
  /** 当前项目名（一个项目一个文件） */
  project: z.string().default('default').extra('volatile', true),
  /** 每段时长（秒）：第 5 节取尾帧、第 1 节校验都按它 */
  segmentSeconds: z.number().default(10).extra('volatile', true),
  /** 每段最少几个分镜 */
  minShotsPerSegment: z.natural().default(3).extra('volatile', true),
  /** 同一闸门最多重做几次（第 7 节：一共 3 次，第 4 次转人工） */
  maxAttempts: z.natural().default(3).extra('volatile', true),
  /** 严格模式：违规即 FAIL（关掉只警告，不建议） */
  strict: z.boolean().default(true).extra('volatile', true),
  /** 全片画幅，只用于提示，不参与校验 */
  aspectRatio: z.string().default('9:16').extra('volatile', true),
  /** 一条 10 秒片段的正常生成耗时下限（分钟）：低于它只提示，不阻断。
   *  2026-10-31 实测这台机器 0.5–3.4 分钟就出片，原来写 5 会天天误报"太快，可能旧片"（修 #7）。 */
  genMinMinutes: z.number().default(1).extra('volatile', true),
  /** 一条 10 秒片段的生成耗时上限（分钟）：超过即判不正常，这段作废 */
  genMaxMinutes: z.number().default(10).extra('volatile', true),
  /** 素材体检：图片短边下限（px） */
  mediaMinSide: z.number().default(512).extra('volatile', true),
  /** 素材体检：每百万像素最少多少 KB（太低=纯色/占位图） */
  mediaMinKBPerMP: z.number().default(40).extra('volatile', true),
})

/* ── 小工具 ────────────────────────────────────────────────────── */

/** 工具返回值一律过一遍：宿主只吃无损 JSON */
const safe = (v) => {
  if (v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
}

const textOutput = {
  schema: { type: 'object', properties: {}, additionalProperties: true },
  render: (_args, value) => {
    const text = value && typeof value === 'object' && typeof value.text === 'string'
      ? value.text
      : JSON.stringify(value, null, 2)
    return [{ type: 'text', text }]
  },
}

/** 把判定结果排成人能读的几行 */
function formatVerdict(title, result, extra = '') {
  const lines = []
  lines.push(`${result.ok ? '✅ PASS' : '❌ FAIL'} · ${title}`)
  if (extra) lines.push(extra)
  if (result.violations?.length) {
    lines.push(`违规 ${result.violations.length} 条（必须改完再提交）：`)
    result.violations.forEach((v, i) => lines.push(`  ${i + 1}. [${v.code}] ${v.where}\n     → ${v.message}`))
  } else {
    lines.push('违规 0 条')
  }
  if (result.warnings?.length) {
    lines.push(`提示 ${result.warnings.length} 条（不阻断）：`)
    result.warnings.forEach((w) => lines.push(`  - [${w.code}] ${w.where}：${w.message}`))
  }
  return lines.join('\n')
}

/** 解析 scriptJson：接受字符串或已经是对象 */
function parseScript(input) {
  if (input === undefined || input === null) return { error: '没有收到 script（scriptJson 为空）' }
  if (typeof input === 'object') return { value: input }
  const raw = String(input).trim()
  if (!raw) return { error: 'scriptJson 是空字符串' }
  try {
    return { value: JSON.parse(raw) }
  } catch (e) {
    return { error: `scriptJson 不是合法 JSON：${String(e?.message || e).slice(0, 200)}\n提示：先用 json 代码块包好，避免中文引号` }
  }
}

/* ── apply ─────────────────────────────────────────────────────── */

export function apply(ctx, entryConfig = {}) {
  /**
   * ⚠️ 2026-10-31 实测踩坑：DSH 传进来的第 2 个参数**不是普通配置对象**。
   *   表现为 `entryConfig.home` 是个对象 ⇒ `path.join()` 抛
   *   `The "path" argument must be of type string. Received an instance of Object`，
   *   doubao_status / doubao_style_lock 一调就挂，而且连 diag 日志都被同一个
   *   try/catch 吞掉，磁盘上什么都留不下（排查时等于盲人摸象）。
   *   ⇒ 配置一律按类型取：不是 string / number / boolean 就回落默认值，
   *     绝不把未知对象直接丢给 fs。
   */
  const pickString = (v, fallback) => (typeof v === 'string' && v.trim() ? v.trim() : fallback)
  const pickNumber = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback)
  const pickBool = (v, fallback) => (typeof v === 'boolean' ? v : fallback)

  const cfg = () => ({
    home: pickString(entryConfig?.home, defaultHome()),
    project: pickString(entryConfig?.project, 'default'),
    segmentSeconds: pickNumber(entryConfig?.segmentSeconds, 10),
    minShotsPerSegment: pickNumber(entryConfig?.minShotsPerSegment, 3),
    maxAttempts: pickNumber(entryConfig?.maxAttempts, 3),
    strict: pickBool(entryConfig?.strict, true),
    aspectRatio: pickString(entryConfig?.aspectRatio, '9:16'),
    genMinMinutes: pickNumber(entryConfig?.genMinMinutes, 1),
    genMaxMinutes: pickNumber(entryConfig?.genMaxMinutes, 10),
    mediaMinSide: pickNumber(entryConfig?.mediaMinSide, 512),
    mediaMinKBPerMP: typeof entryConfig?.mediaMinKBPerMP === 'number' ? entryConfig.mediaMinKBPerMP : 40,
  })

  // 装配留痕写死到系统临时目录：**不要**依赖 cfg().home —— 那段一坏，日志也跟着消失。
  try {
    appendFileSync(join(tmpdir(), 'doubao-video-apply.jsonl'), `${JSON.stringify({
      at: new Date().toISOString(),
      version: PKG.version,
      hasTools: typeof ctx?.tools?.register === 'function',
      keys: entryConfig && typeof entryConfig === 'object' ? Object.keys(entryConfig) : [],
      typeofHome: typeof entryConfig?.home,
      homePreview: (() => { try { return String(entryConfig?.home) } catch { return '<unstringable>' } })(),
      resolvedHome: cfg().home,
      schemastery: !!z,
      defineTool: defineTool?.name || 'local',
    })}\n`, 'utf8')
  } catch { /* 留痕失败不该挡住插件 */ }

  // 装配留痕：插件到底有没有被 DSH 装进来，看这一个文件就够了。
  // （DSH 没有专门的插件日志，装失败时常常只有一句 "did not activate"，排查全靠猜。）
  try {
    const diagDir = cfg().home
    mkdirSync(diagDir, { recursive: true })
    appendFileSync(
      join(diagDir, 'plugin.log'),
      `[${new Date().toISOString()}] apply ok · v${PKG.version} · tools=${typeof ctx?.tools?.register} · schemastery=${!!z} · defineTool=${defineTool?.name || 'local'}\n`,
      'utf8',
    )
  } catch { /* 留痕失败不该挡住插件 */ }

  /** 读项目（每次工具调用都重读，避免多轮之间状态过期） */
  const openProject = (slugRaw) => {
    const c = cfg()
    const slug = safeSlug(slugRaw || c.project)
    return { c, slug, project: loadProject(c.home, slug) }
  }

  /** 判定收尾：落盘 + 记历史 + 重试计数 */
  const settle = ({ c, slug, project }, gateId, result, summary) => {
    let attempt = 0
    if (result.ok) {
      resetAttempt(project, gateId)
    } else {
      attempt = bumpAttempt(project, gateId)
    }
    project.history = [...(project.history || []), {
      gate: gateId,
      ok: !!result.ok,
      attempt,
      summary: summary || '',
      at: new Date().toISOString(),
    }].slice(-200)
    saveProject(c.home, slug, project)
    recordHistory(c.home, slug, { gate: gateId, ok: result.ok, summary })

    if (!result.ok && attempt >= c.maxAttempts) {
      result.warnings = [...(result.warnings || []), {
        code: 'W_HUMAN_REQUIRED',
        where: 'attempts',
        message: `第 ${attempt} 次仍不通过：按第 7 节「一共制作三次」的口径已经到上限，第 ${attempt + 1} 次必须先经本人确认`,
      }]
    }
    return { attempt, maxAttempts: c.maxAttempts }
  }

  const tool = (spec) => ctx.tools.register(defineTool({
    ...spec,
    output: spec.output || textOutput,
    async execute(args = {}) {
      try {
        return safe(await spec.execute(args))
      } catch (e) {
        return safe({
          ok: false,
          text: `❌ 工具执行出错：${String(e?.message || e)}\n（插件 ${PKG.version}；这多半是参数格式问题，检查 JSON 后用 doubao_status 看当前状态）`,
        })
      }
    },
  }))

  /* ── 1. 总览 ──────────────────────────────────────────────── */

  tool({
    name: 'doubao_status',
    description: '看当前视频项目的进度：风格锁有没有、脚本过没过、角色/场景登记了几张、片段到第几段、哪道闸门被打回几次。\n'
      + '每次开新会话、或不确定下一步做什么时先跑它。',
    parameters: {
      project: { type: 'string', description: '项目名（不填用设置里的 default）' },
    },
    async execute(args) {
      const { c, slug, project } = openProject(args.project)
      const segs = project.script?.segments || []
      const shots = segs.reduce((n, s) => n + (s.shots?.length || 0), 0)
      const entities = project.script ? collectEntities(project.script) : { roles: [], scenes: [] }
      const missingRoles = entities.roles.filter((n) => !project.roles[n])
      const missingScenes = entities.scenes.filter((n) => !project.scenes[n])
      const clipSegs = Object.keys(project.clips).map(Number).sort((a, b) => a - b)
      const attempts = Object.entries(project.attempts || {}).filter(([, n]) => n > 0)

      const lines = [`📽 项目「${slug}」`, `状态目录：${c.home}`, '']
      lines.push(`风格锁：${project.styleLock ? `${project.styleLock.id} · ${project.styleLock.artStyle}` : '❌ 未锁定（第 0 步）'}`)
      lines.push(`脚本：${project.script ? `已通过 · ${segs.length} 段 / ${shots} 分镜` : '❌ 未提交'}`)
      lines.push(`角色：${Object.keys(project.roles).length} 张${missingRoles.length ? `（还差：${missingRoles.join('、')}）` : ''}`)
      lines.push(`场景：${Object.keys(project.scenes).length} 张${missingScenes.length ? `（还差：${missingScenes.join('、')}）` : ''}`)
      lines.push(`片段：${clipSegs.length ? clipSegs.map((n) => `第${n}段`).join(' ') : '无'}`)
      if (clipSegs.length) lines.push(`剪辑顺序：${clipSegs.join(' → ')}`)

      // 待生成 / 待确认
      const pendings = Object.entries(project.pending || {})
        .filter(([, p]) => p && !project.clips[p.segment])
        .map(([k, p]) => ({ segment: Number(k), audited: !!p.auditHash, confirmed: !!p.confirmedAt }))
      if (pendings.length) {
        lines.push('待生成：')
        pendings.forEach((p) => lines.push(`  - 第 ${p.segment} 段：${p.confirmed
          ? `已确认，生成中（正常 ${c.genMinMinutes}–${c.genMaxMinutes} 分钟）`
          : p.audited ? '已审计，⏸ 等待本人确认「确定生成视频」' : '⏸ 待审计（上传图 + 补 @ 后跑 doubao_prompt_audit）'}`))
      }
      if (attempts.length) {
        lines.push('', '被打回过的闸门：')
        attempts.forEach(([gate, n]) => lines.push(`  - ${gate}: ${n} 次${n >= c.maxAttempts ? '（已到上限，需本人确认）' : ''}`))
      }

      // 下一步建议
      let next = ''
      if (!project.styleLock) next = '先 doubao_style_lock 锁定全片风格（第 0 步，必须在写脚本之前）'
      else if (!project.script) next = '用第 1 节提示词让豆包出脚本 → doubao_script_submit 提交'
      else if (missingRoles.length) next = `补角色参考图：doubao_role_register（还差 ${missingRoles.join('、')}）`
      else if (missingScenes.length) next = `补场景卡：doubao_scene_register（还差 ${missingScenes.join('、')}）`
      else if (pendings.some((p) => p.confirmed)) next = `第 ${pendings.find((p) => p.confirmed).segment} 段生成中：出片后取 10 秒处尾帧 → doubao_clip_register`
      else if (pendings.some((p) => p.audited)) next = `第 ${pendings.find((p) => p.audited).segment} 段已审计，等本人回「确定生成视频」→ doubao_generate_confirm`
      else if (pendings.length) next = `第 ${pendings[0].segment} 段：先上传图 + 补 @，再跑 doubao_prompt_audit（否则确认会被拒）`
      else if (clipSegs.length < segs.length) next = `第 ${clipSegs.length + 1} 段：doubao_shot_check 拿提示词 → 本人确认 → 生成 → doubao_clip_register`
      else next = '全部片段已登记，可以进后期（配音/字幕/拼接）'

      lines.push('', `👉 下一步：${next}`)

      return {
        ok: true,
        text: lines.join('\n'),
        project: slug,
        styleLock: project.styleLock,
        script: project.script ? { segments: segs.length, shots } : null,
        roles: Object.keys(project.roles),
        scenes: Object.keys(project.scenes),
        clips: clipSegs,
        next,
      }
    },
  })

  /* ── 2. 风格锁 ────────────────────────────────────────────── */

  tool({
    name: 'doubao_style_lock',
    description: '锁定全片美术基准（风格/色调/材质/镜头语言/禁止项）。**必须在写脚本之前调用** —— 原文档把「视频风格确定」放在第 6 节，'
      + '但第 1 节的提示词就要求"每一段统一风格、统一色调"，不先锁死这条就是空话。锁定后脚本、角色卡、场景卡都只能引用它。',
    parameters: {
      artStyle: { type: 'string', description: '美术风格，例如「3D 动漫（非写实）」「东方玄幻写实」' },
      palette: { type: 'string', description: '色调/色温，例如「冷调冰雪质感，低饱和度」' },
      material: { type: 'string', description: '材质渲染，例如「PBR 次世代材质，无夸张光效」' },
      lens: { type: 'string', description: '镜头语言，例如「固定机位为主，不炫技推拉」' },
      forbidden: { type: 'string', description: '禁止项，逗号分隔，例如「真人质感,字幕水印,夸张光效」' },
      force: { type: 'boolean', description: '已经锁过还想改，传 true（会作废已通过的脚本与片段）' },
      project: { type: 'string', description: '项目名' },
    },
    async execute(args) {
      const { c, slug, project } = openProject(args.project)

      if (project.styleLock && !args.force) {
        return {
          ok: false,
          text: `⚠️ 这个项目已经锁过风格了：${project.styleLock.id} · ${project.styleLock.artStyle}\n`
            + `全片只能有一处风格定义。真要改，传 force=true —— 但已通过的脚本和已生成的片段都会作废。`,
          styleLock: project.styleLock,
        }
      }

      const artStyle = String(args.artStyle || '').trim()
      const palette = String(args.palette || '').trim()
      const material = String(args.material || '').trim()
      const lens = String(args.lens || '').trim()
      const forbidden = String(args.forbidden || '')
        .split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean)

      const violations = []
      if (artStyle.length < 2) violations.push({ code: 'E_STYLE_ART', where: 'artStyle', message: '必须写美术风格（3D 动漫 / 写实 / 水墨…），这是后面所有提示词的唯一基准' })
      if (palette.length < 2) violations.push({ code: 'E_STYLE_PALETTE', where: 'palette', message: '必须写色调与色温，否则每段生成出来不是一个片子' })
      if (violations.length) {
        const result = { ok: false, violations, warnings: [] }
        settle({ c, slug, project }, 'G0-style', result, 'style lock missing fields')
        return { ok: false, text: formatVerdict('G0 风格锁', result) }
      }

      const lock = {
        id: 'SL-1',
        artStyle, palette, material, lens, forbidden,
        aspectRatio: c.aspectRatio,
        lockedAt: new Date().toISOString(),
      }
      project.styleLock = lock
      if (args.force) {
        // 改了风格，下游全部作废：宁可重做，也不要交出前后两个片子
        project.script = null
        project.clips = {}
      }
      resetAttempt(project, 'G0-style')
      const result = { ok: true, violations: [], warnings: [] }
      settle({ c, slug, project }, 'G0-style', result, `${artStyle} / ${palette}`)

      const block = [
        `风格：${artStyle}`,
        `色调：${palette}`,
        material ? `材质：${material}` : null,
        lens ? `镜头：${lens}` : null,
        forbidden.length ? `禁止：${forbidden.join('、')}` : null,
      ].filter(Boolean).join('\n')

      return {
        ok: true,
        text: `✅ 风格已锁定（${lock.id}）\n\n${block}\n\n画幅：${lock.aspectRatio}\n\n`
          + '接下来：角色卡、场景卡、每一段脚本都必须原样引用这段文字，一个字都不许改写。',
        styleLock: lock,
      }
    },
  })

  /* ── 3. 脚本 ──────────────────────────────────────────────── */

  tool({
    name: 'doubao_script_submit',
    description: '提交第 1 节产出的分镜脚本并做机器校验：每段 10 秒、每段 ≥3 个分镜、每个分镜 12 个字段写满、'
      + '不许留「例如/XXX/【】」占位、表情细节 ≠ 感情细节、有台词就不许再铺旁白、相邻两段不许逐字重复。\n'
      + '⚠️ 提交的是**豆包照着第 1 节提示词产出的成稿**，不是让本工具替你写。',
    parameters: {
      scriptJson: { type: 'string', description: '脚本 JSON 字符串：{ segments:[{ index, durationSeconds, styleRef, shots:[{景别,运镜,主角,动作,台词,旁白,内心旁白,表情细节,感情细节,音效,光影,场景}] }] }' },
      project: { type: 'string', description: '项目名' },
      replace: { type: 'boolean', description: '已有通过稿时是否覆盖' },
    },
    async execute(args) {
      const { c, slug, project } = openProject(args.project)

      // G0 必须先过：没有风格锁，第 1 节的「每一段统一风格、统一色调」就是一句空话，
      // 到第 4 节才发现风格对不上时，脚本已经白写了。
      if (!project.styleLock) {
        const result = {
          ok: false,
          violations: [{
            code: 'E_NO_STYLE_LOCK',
            where: 'styleLock',
            message: '还没锁定全片风格：先 doubao_style_lock（artStyle / palette 至少这两项），再交脚本',
          }],
          warnings: [],
        }
        const { attempt } = settle({ c, slug, project }, 'G1-script', result, 'no style lock')
        return { ok: false, text: formatVerdict('G1 脚本', result, `第 ${attempt}/${c.maxAttempts} 次`), attempts: attempt }
      }

      if (project.script && !args.replace) {
        return {
          ok: false,
          text: `⚠️ 这个项目已经有通过校验的脚本了（${project.script.segments?.length || 0} 段）。\n`
            + '要重交传 replace=true。',
        }
      }

      const parsed = parseScript(args.scriptJson)
      if (parsed.error) {
        return { ok: false, text: `❌ 脚本没读懂：${parsed.error}` }
      }

      const script = parsed.value
      const result = checkScript(script, {
        segmentSeconds: c.segmentSeconds,
        minShotsPerSegment: c.minShotsPerSegment,
        styleLockId: project.styleLock?.id || null,
      })

      const { attempt } = settle({ c, slug, project }, 'G1-script', result, `${result.counts.segments} 段 / ${result.counts.shots} 分镜`)

      if (!result.ok) {
        return {
          ok: false,
          text: formatVerdict('G1 脚本', result, `统计：${result.counts.segments} 段 / ${result.counts.shots} 分镜 · 第 ${attempt}/${c.maxAttempts} 次`)
            + '\n\n打回后不要自己重写，把上面每条违规交给豆包按第 1 节提示词重做这一段。',
          attempts: attempt,
        }
      }

      const entities = collectEntities(script)
      project.script = {
        id: `SC-${Date.now()}`,
        approvedAt: new Date().toISOString(),
        segments: script.segments,
        entities,
      }
      saveProject(c.home, slug, project)

      const missingRoles = entities.roles.filter((n) => !project.roles[n])
      const missingScenes = entities.scenes.filter((n) => !project.scenes[n])

      return {
        ok: true,
        text: `✅ 脚本通过（${result.counts.segments} 段 / ${result.counts.shots} 分镜）\n`
          + `出场角色：${entities.roles.join('、') || '（无）'}\n`
          + `场景：${entities.scenes.join('、') || '（无）'}\n\n`
          + `下一步：\n`
          + (missingRoles.length ? `  1. 给这些角色出参考图：${missingRoles.join('、')} → doubao_role_register\n` : '')
          + (missingScenes.length ? `  2. 给这些场景出场景卡：${missingScenes.join('、')} → doubao_scene_register\n` : '')
          + '  记牢：角色卡分两种 —— 设定卡（杂志排版，给人看）和参考图（白底单人，给模型看），视频只用后者。',
        entities,
        attempts: attempt,
      }
    },
  })

  /* ── 4. 角色卡 ────────────────────────────────────────────── */

  tool({
    name: 'doubao_role_register',
    description: '登记一个角色。**三视图设定卡 + 干净参考图两件都要**，并且必须写生成来源。'
      + '同时做体量体检：文件不存在、尺寸太小、像纯色占位图（KB/百万像素过低）都会被拒 —— '
      + '2026-10-31 就是一张 13KB 的占位符混进来，豆包照着它生成了整条片子的脸。',
    parameters: {
      name: { type: 'string', description: '角色名，与脚本「主角」字段一字不差' },
      cardImage: { type: 'string', description: '三视图设定卡路径（正面/侧面/背面全身，png/jpg/webp）' },
      reference: { type: 'string', description: '干净参考图路径（白底/单人/无文字；文件名叫什么，@ 就写什么）' },
      source: { type: 'string', description: '生成来源：豆包对话链接 / 生成时间 / 用的哪版提示词（必填，没有溯源不收）' },
      appearance: { type: 'string', description: '外貌：年龄/发型发色/五官/体型' },
      outfit: { type: 'string', description: '服装：必须来自脚本设定' },
      project: { type: 'string', description: '项目名' },
    },
    async execute(args) {
      const { c, slug, project } = openProject(args.project)
      const scriptRoles = project.script?.entities?.roles || []

      const role = {
        name: String(args.name || '').trim(),
        cardImage: String(args.cardImage || '').trim(),
        reference: String(args.reference || args.file || '').trim(),
        source: String(args.source || '').trim(),
        appearance: String(args.appearance || '').trim(),
        outfit: String(args.outfit || '').trim(),
        kind: 'reference',
      }

      const result = checkRole(role, { scriptRoles })

      // 体量体检：文件在不在、尺寸、以及"是不是纯色占位图"
      for (const [label, p] of [['三视图设定卡', role.cardImage], ['参考图', role.reference]]) {
        if (!p) continue
        const m = checkImage(p, { label, minSide: c.mediaMinSide, minKBPerMP: c.mediaMinKBPerMP })
        result.violations.push(...m.violations)
        if (m.info) (result.infos ||= {})[label] = m.info
      }
      result.ok = result.violations.length === 0

      const { attempt } = settle({ c, slug, project }, 'G2-role', result, role.name)

      if (!result.ok) {
        return { ok: false, text: formatVerdict(`G2 角色卡 · ${role.name || '(未命名)'}`, result, `第 ${attempt}/${c.maxAttempts} 次`), attempts: attempt }
      }

      project.roles[role.name] = { ...role, at: new Date().toISOString() }
      saveProject(c.home, slug, project)

      const token = role.reference.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '')
      return {
        ok: true,
        text: `✅ 角色「${role.name}」已登记\n`
          + `三视图：${role.cardImage}\n`
          + `参考图：${role.reference}\n`
          + `来源：${role.source}\n\n`
          + `引用时写：@${token}=${role.name}（对应人物角色卡）`,
        role,
        mention: `@${token}=${role.name}（对应人物角色卡）`,
      }
    },
  })

  /* ── 5. 场景 ──────────────────────────────────────────────── */

  tool({
    name: 'doubao_scene_register',
    description: '登记一张场景卡。硬性校验：场景名里不能带景别（土屋中景 ✗ / 土屋 ✓）；场景卡里不许有人物。'
      + '同一场景不同景别复用同一张卡，不要再生成一次。',
    parameters: {
      name: { type: 'string', description: '场景名，只写地点（土屋 / 赵府后门）' },
      file: { type: 'string', description: '场景图本地路径（png/jpg/webp）' },
      source: { type: 'string', description: '生成来源：豆包对话链接 / 生成时间 / 用的哪版提示词（必填）' },
      characters: { type: 'string', description: '画面里的人物，应为空；有的话逗号分隔（会被拒）' },
      project: { type: 'string', description: '项目名' },
    },
    async execute(args) {
      const { c, slug, project } = openProject(args.project)
      const scriptScenes = project.script?.entities?.scenes || []
      const characters = String(args.characters || '').split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean)

      const scene = {
        name: String(args.name || '').trim(),
        file: String(args.file || '').trim(),
        source: String(args.source || '').trim(),
        characters,
      }

      const result = checkScene(scene, { scriptScenes })
      if (scene.file) {
        const m = checkImage(scene.file, { label: '场景图', minSide: c.mediaMinSide, minKBPerMP: c.mediaMinKBPerMP })
        result.violations.push(...m.violations)
        if (m.info) result.info = m.info
      }
      result.ok = result.violations.length === 0

      const { attempt } = settle({ c, slug, project }, 'G3-scene', result, scene.name)

      if (!result.ok) {
        return { ok: false, text: formatVerdict(`G3 场景卡 · ${scene.name || '(未命名)'}`, result, `第 ${attempt}/${c.maxAttempts} 次`), attempts: attempt }
      }

      project.scenes[scene.name] = { ...scene, at: new Date().toISOString() }
      saveProject(c.home, slug, project)

      const token = scene.file.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '')
      return {
        ok: true,
        text: `✅ 场景「${scene.name}」已登记\n来源：${scene.source}\n引用时写：@${token}=${scene.name}（对应场景图片）`,
        scene,
        mention: `@${token}=${scene.name}（对应场景图片）`,
      }
    },
  })

  /* ── 6. 生成前检查 ────────────────────────────────────────── */

  tool({
    name: 'doubao_shot_check',
    description: '生成某一段之前的闸门：检查风格锁、该镜头的角色参考图、场景卡、以及上一段尾帧是否齐；通过后**直接吐出可以粘进豆包的完整提示词**'
      + '（@ 引用 + 12 字段 + 首帧衔接块）。这是第 4 节唯一该走的入口。',
    parameters: {
      segment: { type: 'number', description: '第几段（从 1 开始）' },
      shotIndex: { type: 'number', description: '段内第几个分镜（从 0 开始，默认 0）' },
      project: { type: 'string', description: '项目名' },
    },
    async execute(args) {
      const { c, slug, project } = openProject(args.project)
      const segIndex = Math.max(1, Number(args.segment) || 1)
      const shotIndex = Math.max(0, Number(args.shotIndex) || 0)

      if (!project.script) {
        return { ok: false, text: '❌ 还没有通过校验的脚本：先 doubao_script_submit（第 1 节）。' }
      }

      const seg = project.script.segments?.[segIndex - 1]
      if (!seg) {
        return { ok: false, text: `❌ 脚本里没有第 ${segIndex} 段（一共 ${project.script.segments?.length || 0} 段）` }
      }
      const shot = seg.shots?.[shotIndex]
      if (!shot) {
        return { ok: false, text: `❌ 第 ${segIndex} 段没有第 ${shotIndex} 个分镜（这段有 ${seg.shots?.length || 0} 个）` }
      }

      const result = checkVideo(shot, {
        styleLock: project.styleLock,
        roles: toMap(project.roles),
        scenes: toMap(project.scenes),
        clips: project.clips,
        segIndex,
      })
      const { attempt } = settle({ c, slug, project }, 'G4-video', result, `seg${segIndex}.shot${shotIndex}`)

      // 校验通过 = 可以生成，但**还不能生成**：等本人确认。这里只记一个待确认记录，
      // 计时从确认那一刻开始（见 doubao_generate_confirm / doubao_clip_register）。
      const roleMap = toMap(project.roles)
      const sceneMap = toMap(project.scenes)
      if (result.ok) {
        // 上传清单：豆包必须先看到这些图，@ 才有意义（2026-10-31 真实跑掉的就是这一步）
        const requiredUploads = []
        const scene = sceneMap.get(String(shot['场景'] ?? '').trim())
        if (scene?.file) requiredUploads.push(scene.file)
        for (const n of splitNames(shot['主角'])) {
          const role = roleMap.get(n)
          const ref = role?.reference || role?.file
          if (ref) requiredUploads.push(ref)
        }
        const prev = (project.clips || {})[segIndex - 1]
        if (segIndex > 1 && prev?.tailFrame) requiredUploads.push(prev.tailFrame)

        project.pending = project.pending || {}
        project.pending[String(segIndex)] = {
          segment: segIndex,
          shotIndex,
          startedAt: new Date().toISOString(),
          confirmedAt: null,
          requiredUploads,
          auditHash: null,
        }
        saveProject(c.home, slug, project)
      }

      if (!result.ok) {
        return { ok: false, text: formatVerdict(`G4 生成前 · 第 ${segIndex} 段 #${shotIndex}`, result, `第 ${attempt}/${c.maxAttempts} 次`), attempts: attempt }
      }

      const prompt = buildShotPrompt(shot, {
        segIndex,
        roles: roleMap,
        scenes: sceneMap,
        clips: project.clips,
        // 让提示词自带时长/画幅，豆包就不会自己猜（修 #5：实测不写就默认 15 秒）
        durationSeconds: seg.durationSeconds,
        aspectRatio: project.styleLock?.aspectRatio,
      })

      const pending = project.pending[String(segIndex)]
      const uploadList = (pending?.requiredUploads || [])
        .map((f, i) => `   ${i + 1}. ${f}`).join('\n')

      return {
        ok: true,
        text: `✅ 校验通过 · 第 ${segIndex} 段 #${shotIndex}\n\n`
          + '① 先上传这几张图（少一张都不行，@ 才有意义）：\n'
          + `${uploadList || '   （无需上传）'}\n\n`
          + '② 再把这整段粘进豆包（一个字都别改，尤其是第一行的 @）：\n'
          + '────────────\n' + prompt + '\n────────────\n\n'
          + '③ 粘完先自检：@ 后面的字必须和文件名一模一样；12 个字段和上面一字不差。\n'
          + `   然后调用 doubao_prompt_audit（segment=${segIndex}, promptText=你实际粘的那段, uploadedFiles=已上传的文件）\n\n`
          + '⏸ 还没到生成：审计通过后，本人回「确定生成视频」，再调 doubao_generate_confirm。\n'
          + `   确认后到出片正常 ${c.genMinMinutes}–${c.genMaxMinutes} 分钟，超过 ${c.genMaxMinutes} 分钟按不正常处理。`,
        prompt,
        segment: segIndex,
        shotIndex,
        requiredUploads: pending?.requiredUploads || [],
        status: 'awaiting_audit',
      }
    },
  })

  /* ── 6.4 提示词审计（新） ──────────────────────────────────── */

  tool({
    name: 'doubao_prompt_audit',
    description: '把**你真正要粘进豆包的那段文字**交上来审计：每个角色/场景都要有 @文件名=名字、'
      + '12 个字段必须与已通过的脚本逐字一致、上一段尾帧要挂上、不许有模板占位；同时核对已上传的文件清单。\n'
      + '没通过就拿不到 auditHash，doubao_generate_confirm 会拒绝。\n'
      + '⚠️ 这一步就是拦「图没上传 / 漏了 @ / 手搓提示词」的闸门。',
    parameters: {
      segment: { type: 'number', description: '第几段（从 1 开始）' },
      shotIndex: { type: 'number', description: '段内第几个分镜（默认 0）' },
      promptText: { type: 'string', description: '实际要粘贴给豆包的完整文本（含 @ 行与 12 个字段）' },
      uploadedFiles: { type: 'string', description: '已经上传到豆包的文件，多个用换行或分号分隔（绝对路径或文件名都行）' },
      project: { type: 'string', description: '项目名' },
    },
    async execute(args) {
      const { c, slug, project } = openProject(args.project)
      const segIndex = Math.max(1, Number(args.segment) || 1)
      const shotIndex = Math.max(0, Number(args.shotIndex) || 0)
      const shot = project.script?.segments?.[segIndex - 1]?.shots?.[shotIndex]

      if (!shot) {
        return { ok: false, text: `❌ 找不到第 ${segIndex} 段 #${shotIndex} 的分镜：先 doubao_shot_check。` }
      }

      const pending = project.pending?.[String(segIndex)]
      if (!pending) {
        return { ok: false, text: `❌ 第 ${segIndex} 段还没过 doubao_shot_check：先拿提示词，再来审计。` }
      }

      const uploaded = String(args.uploadedFiles || '')
        .split(/[\n;；]+/).map((s) => s.trim()).filter(Boolean)
      const uploadedAll = uploaded.length ? uploaded : (args.uploadedFiles ? [String(args.uploadedFiles)] : [])

      const textCheck = auditPrompt(shot, args.promptText, {
        roles: toMap(project.roles),
        scenes: toMap(project.scenes),
        clips: project.clips,
        segIndex,
      })
      const uploadCheck = auditUploads(pending.requiredUploads || [], uploadedAll)

      const result = {
        ok: textCheck.ok && uploadCheck.ok,
        violations: [...textCheck.violations, ...uploadCheck.violations],
        warnings: [...textCheck.warnings, ...uploadCheck.warnings],
      }
      const { attempt } = settle({ c, slug, project }, 'G4.5-audit', result, `seg${segIndex}.shot${shotIndex}`)

      if (!result.ok) {
        return {
          ok: false,
          text: formatVerdict(`G4.5 提示词审计 · 第 ${segIndex} 段 #${shotIndex}`, result, `第 ${attempt}/${c.maxAttempts} 次`)
            + '\n\n按上面逐条改：缺图的先上传，缺 @ 的补 @，字段对不上就改用 doubao_shot_check 给的原文。',
          attempts: attempt,
        }
      }

      // 加盐：只对文本做 hash 会让两个项目"同文同 hash"，拿 A 的 hash 去确认 B 也能对上。
      // 带上项目与段/镜编号，才算这一段的审计。
      const hash = createHash('sha256').update([slug, segIndex, shotIndex, String(args.promptText)].join('|')).digest('hex').slice(0, 16)
      pending.auditHash = hash
      pending.auditAt = new Date().toISOString()
      pending.uploadedFiles = uploadedAll
      project.pending[String(segIndex)] = pending
      saveProject(c.home, slug, project)

      return {
        ok: true,
        text: `✅ 审计通过 · 第 ${segIndex} 段 #${shotIndex}\n`
          + `auditHash：${hash}\n`
          + `已上传：${uploadedAll.length} 个文件\n\n`
          + `下一步：本人回「确定生成视频」→ doubao_generate_confirm（segment=${segIndex}, auditHash=${hash}）`,
        auditHash: hash,
        uploaded: uploadedAll,
        status: 'awaiting_confirm',
      }
    },
  })

  /* ── 6.5 生成确认 ──────────────────────────────────────────── */

  tool({
    name: 'doubao_generate_confirm',
    description: '生成前的最后一个闸门：必须**先通过 doubao_prompt_audit**（拿到 auditHash），并且由本人明确说「确定生成视频」。\n'
      + '两道缺一不可 —— 没审计就等于图没上传/漏 @/手搓提示词，确认了也是白生成。\n'
      + '调用后开始计时（正常按设置里的生成窗口判定），超过上限登记时会被判不正常。',
    parameters: {
      segment: { type: 'number', description: '第几段（从 1 开始）' },
      confirmText: { type: 'string', description: '本人原话，必须包含「确定生成视频」' },
      auditHash: { type: 'string', description: 'doubao_prompt_audit 返回的 auditHash（证明那段提示词+上传清单已经审过）' },
      project: { type: 'string', description: '项目名' },
    },
    async execute(args) {
      const { c, slug, project } = openProject(args.project)
      const segment = Number(args.segment) || 0
      const text = String(args.confirmText || '').trim()

      if (!/确定生成视频/.test(text)) {
        return {
          ok: false,
          text: '⛔ 没有本人授权，不能生成。\n'
            + '这一步要求本人在对话里明确说出「确定生成视频」，再把原话放进 confirmText。\n'
            + '（不接受"可以了""你继续"这类模糊同意——生成要花额度。）',
          status: 'blocked',
        }
      }

      const pending = project.pending?.[String(segment)]
      if (!pending) {
        return { ok: false, text: `❌ 第 ${segment} 段没有待生成记录：先跑 doubao_shot_check（segment=${segment}）通过校验。` }
      }

      // 没有审计就没有确认：这一步专治"图没传、@ 没写、提示词手搓"。
      if (!pending.auditHash) {
        return {
          ok: false,
          text: `⛔ 第 ${segment} 段还没过 doubao_prompt_audit。\n`
            + '先把图传上去、把 @ 写全，再把实际要粘的那段文字交给 doubao_prompt_audit 审一遍。\n'
            + '「图没上传 / 漏了 @ / 手搓提示词」就是在这道闸上被拦的。',
          status: 'blocked',
        }
      }

      const givenHash = String(args.auditHash || '').trim()
      if (givenHash !== pending.auditHash) {
        return {
          ok: false,
          text: `⛔ auditHash 对不上（当前应为 ${pending.auditHash}）。\n`
            + '如果你改了提示词或换了图，说明审计已经作废，回去重跑 doubao_prompt_audit。',
          status: 'blocked',
        }
      }

      if (pending.confirmedAt) {
        return { ok: true, text: `ℹ️ 第 ${segment} 段已经确认过了（${pending.confirmedAt}），直接生成即可。`, status: 'already_confirmed' }
      }

      pending.confirmedAt = new Date().toISOString()
      pending.confirmText = text.slice(0, 100)
      project.pending[String(segment)] = pending
      saveProject(c.home, slug, project)

      return {
        ok: true,
        text: `▶️ 第 ${segment} 段已确认生成（${pending.confirmedAt}）\n`
          + `计时开始：正常 ${c.genMinMinutes}–${c.genMaxMinutes} 分钟出片；超过 ${c.genMaxMinutes} 分钟，登记时会被判不正常并要求重做。\n`
          + '出片后：取最后一帧（10 秒处）截图 → doubao_clip_register 登记。',
        status: 'generating',
        startedAt: pending.confirmedAt,
      }
    },
  })

  /* ── 7. 片段登记 ──────────────────────────────────────────── */

  tool({
    name: 'doubao_clip_register',
    description: '登记一段生成好的成片：文件、时长（必须 10 秒）、尾帧截图（必须取在这段末尾）。'
      + '尾帧就是下一段的首帧，取早了下一段会跳。',
    parameters: {
      segment: { type: 'number', description: '第几段（从 1 开始）' },
      file: { type: 'string', description: '成片视频路径（mp4/mov/webm/mkv）' },
      tailFrame: { type: 'string', description: '尾帧截图路径（png/jpg/webp）' },
      durationSeconds: { type: 'number', description: '成片时长，默认 10' },
      tailTimeSeconds: { type: 'number', description: '尾帧取在第几秒，应该等于段长' },
      generateMinutes: { type: 'number', description: '可选：从点「生成」到出片的实际分钟数。填了就按它判生成窗口（默认 1–10 分钟），不看墙钟（避免登记晚了被误判超时）' },
      project: { type: 'string', description: '项目名' },
    },
    async execute(args) {
      const { c, slug, project } = openProject(args.project)

      const clip = {
        segment: Number(args.segment) || 0,
        file: String(args.file || '').trim(),
        durationSeconds: args.durationSeconds === undefined ? c.segmentSeconds : Number(args.durationSeconds),
        tailFrame: String(args.tailFrame || '').trim(),
        tailTimeSeconds: args.tailTimeSeconds === undefined ? c.segmentSeconds : Number(args.tailTimeSeconds),
      }

      const clipCheck = checkClip(clip, { segmentSeconds: c.segmentSeconds })

      /**
       * 音轨只**记录**，不拦截。
       * 口径（本人 2026-10-31）：豆包出的片子有声无声都可以，后期要不要留原声由人工决定，
       * 所以这里探一下就存下来，绝不因为它有声或没声而打回。
       */
      let hasAudio = null
      try {
        const f = await ffmpegApi()
        if (f.version().ok && clip.file) {
          const meta = f.probe(clip.file)
          if (meta.ok) hasAudio = !!meta.hasAudio
        }
      } catch { /* 探测失败就留 null，不影响登记 */ }

      // 生成必须经过本人确认；没确认就不认这条成片
      const pending = project.pending?.[String(clip.segment)]
      let elapsedMinutes = NaN
      let confirmCheck
      if (!pending?.confirmedAt) {
        confirmCheck = {
          ok: false,
          violations: [{
            code: 'E_NOT_CONFIRMED',
            where: `pending.${clip.segment}`,
            message: '这一段没有「确定生成视频」的确认记录：先让本人确认，再 doubao_generate_confirm，最后登记成片',
          }],
          warnings: [],
        }
      } else {
        const wallMinutes = (Date.now() - new Date(pending.confirmedAt).getTime()) / 60000
        const reported = Number(args.generateMinutes)
        // 墙钟会把"生成完忘了来登记"也算进去，所以允许填实际耗时。
        // 但差太多要提示一句，免得有人用这个参数把超时洗掉。
        if (Number.isFinite(reported) && reported > 0) {
          elapsedMinutes = reported
          if (wallMinutes - reported > 20) {
            confirmCheck = {
              ok: true,
              violations: [],
              warnings: [{
                code: 'W_LATE_REGISTER',
                where: 'generateMinutes',
                message: `登记晚了：墙钟已过 ${wallMinutes.toFixed(0)} 分钟，按你填的实际生成 ${reported} 分钟判定`,
              }],
            }
          } else {
            confirmCheck = { ok: true, violations: [], warnings: [] }
          }
        } else {
          elapsedMinutes = wallMinutes
          confirmCheck = { ok: true, violations: [], warnings: [] }
        }
        const windowCheck = checkGenerateWindow(elapsedMinutes, {
          minMinutes: c.genMinMinutes,
          maxMinutes: c.genMaxMinutes,
        })
        confirmCheck = {
          ok: confirmCheck.ok && windowCheck.ok,
          violations: [...confirmCheck.violations, ...windowCheck.violations],
          warnings: [...confirmCheck.warnings, ...windowCheck.warnings],
        }
      }

      const result = {
        ok: clipCheck.ok && confirmCheck.ok,
        violations: [...clipCheck.violations, ...confirmCheck.violations],
        warnings: [...clipCheck.warnings, ...confirmCheck.warnings],
      }
      const { attempt } = settle({ c, slug, project }, 'G5-clip', result, `seg${clip.segment}`)

      if (!result.ok) {
        return { ok: false, text: formatVerdict(`G5 片段登记 · 第 ${clip.segment} 段`, result, `第 ${attempt}/${c.maxAttempts} 次`), attempts: attempt }
      }

      project.clips[clip.segment] = {
        ...clip,
        generateMinutes: Number.isFinite(elapsedMinutes) ? Number(elapsedMinutes.toFixed(1)) : null,
        hasAudio,
        at: new Date().toISOString(),
      }
      saveProject(c.home, slug, project)

      const total = project.script?.segments?.length || 0
      const done = Object.keys(project.clips).length
      const order = Object.keys(project.clips).map(Number).sort((a, b) => a - b).join(' → ')
      return {
        ok: true,
        text: `✅ 第 ${clip.segment} 段已登记（${done}/${total} 段）· 本次生成耗时 ${Number.isFinite(elapsedMinutes) ? elapsedMinutes.toFixed(1) : '?'} 分钟\n`
          + `音轨：${hasAudio === null ? '未探测' : hasAudio ? '有（后期保留还是丢弃，由人定）' : '无（后期需要配音）'}\n`
          + `剪辑顺序：${order}\n`
          + (done < total
            ? `下一段：doubao_shot_check segment=${clip.segment + 1} —— 上一段尾帧会自动作为首帧参考`
            : '全部片段到齐，进后期：按段序拼接 → 配音（同一角色跨片段同音色）→ 字幕 → AIGC 标识'),
        clip,
        done,
        total,
      }
    },
  })

  /* ── 7.5 浏览器直连（上传 + 粘贴 + 发送） ─────────────────── */

  // 懒加载：playwright 只在真的要用浏览器时才 import，
  // 不然插件加载时就得去解析它的依赖树，启动会明显变慢。
  const browserApi = async () => {
    const mod = await import('./browser.mjs')
    return mod
  }

  tool({
    name: 'doubao_browser_clear',
    description: '清空豆包输入框里的草稿，并尝试把已挂上的附件一起摘掉。试跑/写错了用它收拾现场，不会发送任何东西。',
    parameters: {
      cdpUrl: { type: 'string', description: 'CDP 地址' },
    },
    async execute(args) {
      const b = await browserApi()
      const { page } = await b.open(args.cdpUrl || undefined)
      const res = await b.clear(page)
      await b.shot(page, join(defaultHome(), 'cleared.png'))
      return {
        ok: true,
        text: `🧹 已清空输入框${res.removed ? `，摘掉 ${res.removed} 张附件` : ''}\n`
          + `当前草稿：${res.draft ? res.draft.slice(0, 60) : '（空）'}\n`
          + `剩余附件：${res.attachmentsLeft} 张\n`
          + `截图：${join(defaultHome(), 'cleared.png')}`,
        removed: res.removed,
        attachmentsLeft: res.attachmentsLeft,
        draft: res.draft,
      }
    },
  })

  tool({
    name: 'doubao_browser_capture',
    description: '等这一条视频生成完，**自动下载成片**并**抓最后一帧（原生分辨率）**，落盘后直接给出可以喂给 doubao_clip_register 的两个路径。',
    parameters: {
      segment: { type: 'number', description: '第几段（决定文件命名与尾帧归属）' },
      waitSeconds: { type: 'number', description: '最多等多久（秒），默认 900' },
      project: { type: 'string', description: '项目名' },
      cdpUrl: { type: 'string', description: 'CDP 地址' },
    },
    async execute(args) {
      const { c, slug, project } = openProject(args.project)
      const segment = Math.max(1, Number(args.segment) || 1)
      const b = await browserApi()
      const { page } = await b.open(args.cdpUrl || undefined)

      // 基线：卡片数 + 已挂载的 src。
      // 豆包的结果是「竖版海报 + 播放控件」的懒加载卡片，DOM 里没有 <video>，
      // 而且对话是虚拟列表（只留最近几条消息），所以：
      //   · 不能数 <video>（修 #1）
      //   · 不能数「你的视频生成好了」的条数（修 #4）
      //   · 判定"新片"要看卡片数量变多 + src 没出现过（修 #3）
      const before = await b.mediaState(page)
      if (before.quota) {
        return {
          ok: false,
          text: `⛔ 豆包提示额度不够：${before.quotaText ? `「${before.quotaText}」` : '（页面出现额度拦截文案）'}\n`
            + '这一段没有生成，也没有消耗额度。换号 / 等额度恢复 / 开通订阅后再来。',
        }
      }
      const waitMs = (Number(args.waitSeconds) || 900) * 1000
      const found = await b.waitForNewVideo(page, { srcs: before.srcs, cards: before.cards }, waitMs)
      if (!found.ok) {
        const st = await b.status(page)
        if (found.quota) {
          const hit = found.state?.quotaText
          return {
            ok: false,
            text: `⛔ 等片期间豆包返回额度拦截：${hit ? `「${hit}」` : '（页面出现额度拦截文案）'}\n`
              + '这一段没生成出来，别登记；等额度恢复或换号后重跑。',
          }
        }
        return {
          ok: false,
          text: `⏳ 等了 ${Math.round(waitMs / 1000)} 秒仍没出现新卡片（动手前 ${before.cards} 张，生成中=${found.state?.generating ? '是' : '否'}）。\n`
            + `页面尾部：${st.lastText.slice(-200)}`,
        }
      }

      const dir = join(c.home, 'clips')
      mkdirSync(dir, { recursive: true })
      // 用 pending 的确认时间估算实际生成耗时（豆包出片后才知道）
      const pending = project.pending?.[String(segment)]
      const minutes = pending?.confirmedAt
        ? Number(((Date.now() - new Date(pending.confirmedAt).getTime()) / 60000).toFixed(1))
        : null

      const videoPath = join(dir, `${slug}-seg${segment}.mp4`)
      const tailPath = join(dir, `${slug}-seg${segment}-tail.png`)
      // 豆包视频 URL 带签名时效，过期会 403/404：这里失败会自动重载页面拿新签名（修 #11）
      const dl = await b.downloadVideoRetry(page, videoPath, { src: found.src })
      // 有 ffmpeg 就用它取尾帧（精确到片尾 0.05s）；没有才退回浏览器 canvas。
      let tf
      try {
        const f = await ffmpegApi()
        tf = dl.ok && f.version().ok
          ? f.tailFrame(dl.path, tailPath, {})
          : await b.tailFrame(page, tailPath)
      } catch {
        tf = await b.tailFrame(page, tailPath)
      }
      // ffmpeg 分支失败时再用 canvas 兜一次，并确认文件真的落盘（修 #2）
      if (dl.ok && (!tf || !tf.ok)) {
        try {
          const t2 = await b.tailFrame(page, tailPath)
          if (t2?.ok) tf = t2
        } catch { /* 保留原错误 */ }
      }
      if (dl.ok && tf?.ok && !existsSync(tf.path)) {
        tf = { ok: false, error: `尾帧路径不存在：${tf.path}` }
      }

      const lines = [`🎬 第 ${segment} 段抓取结果`]
      lines.push(dl.ok ? `成片：${dl.path}（${dl.via}，第 ${dl.attempt || 1} 次尝试${dl.bytes ? `，${Math.round(dl.bytes / 1024)} KB` : ''}）` : `成片：❌ ${dl.error}`)
      lines.push(tf.ok ? `尾帧：${tf.path}（取自 ${Number(tf.at).toFixed(2)}s / 全长 ${Number(tf.duration).toFixed(2)}s，${tf.size.join('×')}）` : `尾帧：❌ ${tf.error}`)
      if (minutes !== null) lines.push(`距确认：${minutes} 分钟`)
      if (found.waitedMs) lines.push(`等片耗时：${(found.waitedMs / 1000).toFixed(0)} 秒（卡片 ${before.cards} → ${found.cards}）`)
      lines.push('')
      lines.push(dl.ok && tf.ok
        ? `下一步：doubao_clip_register(segment=${segment}, file="${dl.path}", tailFrame="${tf.path}"${minutes !== null ? `, generateMinutes=${minutes}` : ''})`
        : '有一步没成功：成片没下下来就手动另存，尾帧抓不到就手动截最后一帧（必须是 10 秒处）。')

      return {
        ok: dl.ok && tf.ok,
        text: lines.join('\n'),
        video: dl.ok ? dl.path : null,
        tailFrame: tf.ok ? tf.path : null,
        generateMinutes: minutes,
      }
    },
  })

  /* ── 7.6 后期：ffmpeg ─────────────────────────────────────── */

  const ffmpegApi = async () => import('./ffmpeg.mjs')

  tool({
    name: 'doubao_ffmpeg_status',
    description: '看 ffmpeg 装没装、版本、路径。后期取帧/拼接/压片都靠它。',
    parameters: {
      ffmpegPath: { type: 'string', description: '可选：手动指定 ffmpeg.exe 路径' },
    },
    async execute(args) {
      const f = await ffmpegApi()
      const v = f.version(args.ffmpegPath)
      if (!v.ok) {
        return {
          ok: false,
          text: '❌ 没找到 ffmpeg。\n'
            + '便携版装在 ~/.dsh/tools/ffmpeg/bin/，或设环境变量 FFMPEG_PATH，或在设置里填路径。',
        }
      }
      return { ok: true, text: `🎞 ${v.version}\n路径：${v.path}`, path: v.path, version: v.version }
    },
  })

  tool({
    name: 'doubao_tail_frame',
    description: '用 ffmpeg 精确取尾帧（默认片尾前 0.05 秒，可手动指定秒数）。比浏览器 canvas 准，且不受播放器状态影响。',
    parameters: {
      video: { type: 'string', description: '视频文件路径' },
      out: { type: 'string', description: '输出 png 路径；不填就放在同目录 <名字>-tail.png' },
      atSeconds: { type: 'number', description: '取第几秒；不填 = 时长 - 0.05' },
      ffmpegPath: { type: 'string', description: '可选：ffmpeg.exe 路径' },
    },
    async execute(args) {
      const f = await ffmpegApi()
      const video = String(args.video || '').trim()
      if (!video) return { ok: false, text: '❌ 没给 video 路径' }
      const out = String(args.out || '').trim() || video.replace(/\.[^.]+$/, '') + '-tail.png'
      const r = f.tailFrame(video, out, { atSeconds: args.atSeconds, ffmpegPath: args.ffmpegPath })
      if (!r.ok) return { ok: false, text: `❌ 取帧失败：${r.error}` }
      return {
        ok: true,
        text: `✅ 尾帧已取出\n文件：${r.path}\n取自 ${Number(r.at).toFixed(2)}s / 全长 ${Number(r.duration).toFixed(2)}s · ${r.size.join('×')}`,
        path: r.path,
      }
    },
  })

  tool({
    name: 'doubao_concat',
    description: '把项目里已登记的片段**按段序拼接**成整片（统一重编码到同规格，避免接缝花屏）。后期合成就靠这一步。',
    parameters: {
      out: { type: 'string', description: '输出路径；不填 = <状态目录>/clips/成片.mp4' },
      width: { type: 'number', description: '目标宽，默认 1080' },
      height: { type: 'number', description: '目标高，默认 1920' },
      project: { type: 'string', description: '项目名' },
    },
    async execute(args) {
      const { c, slug, project } = openProject(args.project)
      const segs = project.script?.segments?.length || 0
      const keys = Object.keys(project.clips || {}).map(Number).sort((a, b) => a - b)
      if (!keys.length) return { ok: false, text: '❌ 还没有登记任何片段：先把各段 clip_register 完。' }

      const missing = []
      for (let i = 1; i <= segs; i += 1) if (!project.clips[i]) missing.push(i)
      if (missing.length) {
        return { ok: false, text: `❌ 第 ${missing.join('、')} 段还没登记，缺段不许先拼（否则后半截会错位）。` }
      }

      const files = keys.map((k) => project.clips[k].file)
      const out = String(args.out || '').trim() || join(c.home, 'clips', '成片.mp4')
      const f = await ffmpegApi()
      const r = f.concat(files, out, {
        width: Number(args.width) || 1080,
        height: Number(args.height) || 1920,
      })
      if (!r.ok) return { ok: false, text: `❌ 拼接失败：${r.error}` }

      recordHistory(c.home, slug, { gate: 'G7-concat', ok: true, summary: `${r.segments} 段` })
      return {
        ok: true,
        text: `🎬 拼接完成：${r.path}\n段序：${keys.join(' → ')}（共 ${r.segments} 段）\n`
          + `成片：${Number(r.meta?.duration || 0).toFixed(2)}s · ${r.meta?.width}×${r.meta?.height} · ${r.meta?.fps}fps`,
        path: r.path,
        segments: r.segments,
      }
    },
  })

  tool({
    name: 'doubao_browser_status',
    description: '看豆包网页现在是什么状态：连没连上、在哪个对话、输上框里有没有草稿、是不是正在生成。只读，不会动任何东西。',
    parameters: {
      cdpUrl: { type: 'string', description: 'CDP 地址，默认 http://127.0.0.1:9333' },
    },
    async execute(args) {
      const b = await browserApi()
      const { page } = await b.open(args.cdpUrl || undefined)
      const st = await b.status(page)
      return {
        ok: true,
        text: `🖥 豆包页面：${st.title}\n${st.url}\n`
          + `输入框：${st.composer ? '在' : '没找到'}\n`
          + `草稿：${st.draftText ? st.draftText.slice(0, 80) : '（空）'}\n`
          + `正在生成：${st.generating ? '是（别插队）' : '否'}\n`
          + `文件输入口：${st.fileInputs} 个`,
        state: st,
      }
    },
  })

  tool({
    name: 'doubao_browser_stage',
    description: '把该段的图片上传到豆包、把提示词写进输入框——**但不发送**。发送要另外过 doubao_browser_send 的审计+确认。'
      + '默认会用 doubao_shot_check 拼好的那段原文；传 promptText 则用你给的（仍建议先跑 doubao_prompt_audit）。',
    parameters: {
      segment: { type: 'number', description: '第几段（从 1 开始）' },
      shotIndex: { type: 'number', description: '段内第几个分镜（默认 0）' },
      promptText: { type: 'string', description: '可选：要写进去的原文；不传就用插件拼好的' },
      project: { type: 'string', description: '项目名' },
      cdpUrl: { type: 'string', description: 'CDP 地址' },
    },
    async execute(args) {
      const { c, slug, project } = openProject(args.project)
      const segIndex = Math.max(1, Number(args.segment) || 1)
      const shotIndex = Math.max(0, Number(args.shotIndex) || 0)
      const shot = project.script?.segments?.[segIndex - 1]?.shots?.[shotIndex]
      if (!shot) return { ok: false, text: `❌ 找不到第 ${segIndex} 段 #${shotIndex} 的分镜：先 doubao_shot_check。` }

      const pending = project.pending?.[String(segIndex)]
      if (!pending) return { ok: false, text: `❌ 第 ${segIndex} 段还没过 doubao_shot_check。` }

      const b = await browserApi()
      const { page } = await b.open(args.cdpUrl || undefined)
      const st = await b.status(page)
      if (st.generating) return { ok: false, text: '⏸ 豆包正在生成上一条视频，先等它出来再说（插队会被拒或串味）。' }

      const uploads = pending.requiredUploads || []
      const attachRes = await b.attach(page, uploads)

      const text = String(args.promptText || '').trim() || buildShotPrompt(shot, {
        segIndex,
        roles: toMap(project.roles),
        scenes: toMap(project.scenes),
        clips: project.clips,
        durationSeconds: project.script?.segments?.[segIndex - 1]?.durationSeconds,
        aspectRatio: project.styleLock?.aspectRatio,
      })
      const fillRes = await b.fill(page, text)
      await b.shot(page, join(c.home, `stage-seg${segIndex}.png`))

      const prompt = text.startsWith('@') ? text : `（缺 @ 行！）\n${text}`
      return {
        ok: true,
        text: `✅ 已上传 ${attachRes.attached} 张、已写进输入框 ${fillRes.draftLength} 字（**没有按发送**）\n\n`
          + `截图：${join(c.home, `stage-seg${segIndex}.png`)}\n`
          + `开头：${prompt.slice(0, 120)}\n\n`
          + '下一步：对着截图核对 @ 与图是否都在，然后 doubao_prompt_audit → 本人说「确定生成视频」→ doubao_browser_send。',
        attached: uploads,
        draftLength: fillRes.draftLength,
      }
    },
  })

  tool({
    name: 'doubao_browser_send',
    description: '把已经写进输入框的内容发送出去。必须同时满足：该段审计通过（auditHash 对得上）+ 本人明确说「确定生成视频」。'
      + '发送即开始消耗额度，所以这道闸刻意做得很窄。',
    parameters: {
      segment: { type: 'number', description: '第几段' },
      confirmText: { type: 'string', description: '本人原话，必须含「确定生成视频」' },
      auditHash: { type: 'string', description: 'doubao_prompt_audit 返回的 auditHash' },
      confirmAfterSend: { type: 'string', description: '可选：发送后再补一句话（例如豆包要求确认时回「确认生成视频」）' },
      project: { type: 'string', description: '项目名' },
      cdpUrl: { type: 'string', description: 'CDP 地址' },
    },
    async execute(args) {
      const { c, slug, project } = openProject(args.project)
      const segment = Number(args.segment) || 0
      const pending = project.pending?.[String(segment)]

      if (!pending) return { ok: false, text: `❌ 第 ${segment} 段没有待生成记录。` }
      if (!pending.auditHash) return { ok: false, text: '⛔ 还没过 doubao_prompt_audit，不许发送。' }
      if (String(args.auditHash || '').trim() !== pending.auditHash) {
        return { ok: false, text: `⛔ auditHash 对不上（应为 ${pending.auditHash}）：改过字或换过图就得重审。` }
      }
      if (!/确定生成视频/.test(String(args.confirmText || ''))) {
        return { ok: false, text: '⛔ 没有本人授权：要求本人在对话里明确说「确定生成视频」。' }
      }

      const b = await browserApi()
      const { page } = await b.open(args.cdpUrl || undefined)
      const before = await b.status(page)
      if (before.generating) return { ok: false, text: '⏸ 正在生成中，不能再发。' }
      if (!before.draftText) return { ok: false, text: '❌ 输入框是空的：先跑 doubao_browser_stage。' }

      await b.send(page)
      const after = await b.status(page)

      pending.confirmedAt = new Date().toISOString()
      pending.sentAt = pending.confirmedAt
      pending.confirmText = String(args.confirmText).slice(0, 100)
      project.pending[String(segment)] = pending
      saveProject(c.home, slug, project)
      recordHistory(c.home, slug, { gate: 'G4.7-send', ok: true, summary: `seg${segment}` })

      const extra = String(args.confirmAfterSend || '').trim()
      let confirmRes = null
      if (extra) {
        await page.waitForTimeout(6000)
        await b.fill(page, extra)
        await b.send(page)
        confirmRes = { text: extra }
      }

      return {
        ok: true,
        text: `📤 已发送 · 第 ${segment} 段（${pending.confirmedAt}）\n`
          + `发送前草稿：${before.draftText.length} 字\n`
          + (confirmRes ? `补充发送：${extra}\n` : '')
          + `计时开始：正常 ${c.genMinMinutes}–${c.genMaxMinutes} 分钟出片；超过 ${c.genMaxMinutes} 分钟登记会被判不正常。\n`
          + '出片后取最后一帧截图 → doubao_clip_register。',
        status: after,
      }
    },
  })



  tool({
    name: 'doubao_gate_table',
    description: '打印这套 SOP 的全部判定条件（Gate 编号 → 判据 → 失败动作），写文档、跟人对齐口径时用。只读，不改任何状态。',
    parameters: {},
    async execute() {
      const table = `G0 风格锁 ｜ 在写脚本之前锁定 artStyle/palette/material/lens/forbidden；全片只有这一处定义 ｜ 缺 → 不许进第 1 节
G1 脚本    ｜ 每段 ${cfg().segmentSeconds}s、每段 ≥${cfg().minShotsPerSegment} 分镜、12 字段写满、无占位符、表情≠感情、有台词不铺旁白、相邻段不重复 ｜ 打回，重做这一段
G2 角色卡  ｜ 名字在脚本里、kind=reference、有文件/外貌/服装 ｜ 打回；设定卡不得当参考图
G3 场景卡  ｜ 名字不带景别、画面里没人、有文件 ｜ 打回
G4 生成前  ｜ 风格锁 + 各角色参考图 + 场景卡 + 上一段尾帧齐备 ｜ 打回；齐了才吐提示词
G4.5 审计  ｜ 实际粘贴的文本必须带上全部 @、12 字段与脚本逐字一致、上传清单齐全 ｜ 打回；拿不到 auditHash
G4.6 确认  ｜ 本人明确说「确定生成视频」+ auditHash 对得上 ｜ 没有 → 不许生成
G5 片段    ｜ 时长 ${cfg().segmentSeconds}s、尾帧取在段末、从确认到登记 ${cfg().genMinMinutes}–${cfg().genMaxMinutes} 分钟 ｜ 超 ${cfg().genMaxMinutes} 分钟 → 作废重来
G6 重试    ｜ 同一闸门最多 ${cfg().maxAttempts} 次；第 ${cfg().maxAttempts + 1} 次必须本人确认 ｜ 转人工`

      return {
        ok: true,
        text: '判定条件总表（与《大肥鱼豆包制作视频》v2 第 8 节一致）\n\n' + table
          + '\n\n补充口径：\n'
          + '- 一段 = 10 秒 = 一次豆包生成 = 一个独立片段；片段各自生成，**后期按段序拼接**\n'
          + '- 段内 ≥3 个分镜是表演节拍，不是硬切三刀；要硬切必须在「运镜」里写明\n'
          + '- 每次生成前必须本人在对话里说「确定生成视频」（doubao_generate_confirm）\n'
          + `- 一条片段的生成验收窗口 ${cfg().genMinMinutes}–${cfg().genMaxMinutes} 分钟：超过按不正常作废，不足只提示\n`
          + '- @ 后面的文字必须等于文件名（去扩展名）\n'
          + '- 台词优先级：人物说话 ＞ 旁白 ＞ 内心旁白\n'
          + '- 角色卡分「设定卡（给人看）」和「参考图（给模型看）」，视频只用后者\n'
          + '- 后期统一补：配音（跨片段同角色同音色）/ 字幕 / AIGC 显式标识',
      }
    },
  })
}
