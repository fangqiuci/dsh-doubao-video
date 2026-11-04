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
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs'
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
import { checkModel, DEFAULT_MODEL, MODELS, maxSecondsFor } from './models.mjs'
import { buildCues, burn as burnSubs } from './subtitle.mjs'

/**
 * 把字符串参数解析成数组（2026-11-04）。
 * 为什么工具参数不直接用 type:'array'：实测装进 DSH 后**整类插件工具都挂不上 schema**，
 * 表现是 unknown tool / 会话里一个 doubao_* 都没有。改成字符串再自己解析最稳。
 */
export function parseList(v) {
  if (Array.isArray(v)) return v.filter((x) => x != null)
  const s = String(v ?? '').trim()
  if (!s) return []
  if (s.startsWith('[')) {
    try { const a = JSON.parse(s); return Array.isArray(a) ? a.filter((x) => x != null) : [] } catch { return [] }
  }
  return s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
}

/** 画幅 → 输出尺寸。16:9 走横屏，其余默认竖屏（2026-11-03 新增 16:9 支持） */
export function resolveWH(ratio, fallback = { width: 1080, height: 1920 }) {
  const r = String(ratio ?? '').trim().replace('：', ':')
  if (r === '16:9') return { width: 1920, height: 1080 }
  if (r === '9:16') return { width: 1080, height: 1920 }
  if (r === '1:1') return { width: 1080, height: 1080 }
  if (r === '4:3') return { width: 1440, height: 1080 }
  if (r === '3:4') return { width: 1080, height: 1440 }
  return fallback
}
import { speak as ttsSpeak, probe as ttsProbe } from './tts.mjs'
import { generateBatch } from './images.mjs'
// 生成后端（web / mock）：浏览器那套动作收在 lib/providers/ 里，工具只说"要做什么"
import { provider } from './providers/index.mjs'
import { findPython, transcribe, toSrt } from './asr.mjs'
import { checkQuota, commitCall, readGuard } from './guard.mjs'
import { balanceAudio, measureLoudness } from './audio.mjs'
import { providerKind } from './providers/index.mjs'
import { timelineFromScript, timelineFromClips, mixDubbing, cuesToScript, pickLine } from './dub.mjs'
import { addBgm, listBgm, resolveBgm, bgmDir } from './bgm.mjs'
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
  /** 单段最短秒数（低于这个读不出信息） */
  minSegmentSeconds: z.number().default(5).extra('volatile', true),
  /** 单段最长秒数（超过豆包单次生成撑不住） */
  maxSegmentSeconds: z.number().default(30).extra('volatile', true),
  /** 是否已开豆包会员：开了才能用 Seedance 2.0 / 2.5 */
  hasMembership: z.boolean().default(false).extra('volatile', true),
  /** 默认模型（换模型必须经本人指定） */
  defaultModel: z.string().default('Seedance 2.0 Mini').extra('volatile', true),
  /** 每段最少几个分镜 */
  minShotsPerSegment: z.natural().default(3).extra('volatile', true),
  /** 同一闸门最多重做几次（第 7 节：一共 3 次，第 4 次转人工） */
  maxAttempts: z.natural().default(3).extra('volatile', true),
  /** 严格模式：违规即 FAIL（关掉只警告，不建议） */
  strict: z.boolean().default(true).extra('volatile', true),
  /** 全片画幅，只用于提示，不参与校验 */
  aspectRatio: z.string().default('9:16').extra('volatile', true),
  /** 同一段允许自动重试几次（默认 1；第 2 次起必须本人说「确定重试」） */
  maxAutoRetries: z.number().default(1).extra('volatile', true),
  /** 一句台词连停顿约占几秒（用于"这一段塞得下几句"） */
  secondsPerLine: z.number().default(2.5).extra('volatile', true),
  /** 段长里能拿来念白的比例（默认 0.8，留画面呼吸） */
  usableRatio: z.number().default(0.8).extra('volatile', true),
  /** 从第几段起强制回拉第 1 段尾帧做人物校准（默认 5） */
  calibrateFromSegment: z.number().default(5).extra('volatile', true),
  /** 每日发送上限（风控自保，0=不限） */
  dailyCallLimit: z.number().default(30).extra('volatile', true),
  /** 两次发送的最小/最大间隔秒数（随机，打破固定节奏） */
  minGapSec: z.number().default(60).extra('volatile', true),
  maxGapSec: z.number().default(180).extra('volatile', true),
  /** 风格块强度：soft=建议一致（默认）/ strict=不得改变 / off=不加这块 */
  styleBlockMode: z.string().default('soft').extra('volatile', true),
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
    minSegmentSeconds: pickNumber(entryConfig?.minSegmentSeconds, 5),
    maxSegmentSeconds: pickNumber(entryConfig?.maxSegmentSeconds, 30),
    hasMembership: pickBool(entryConfig?.hasMembership, false),
    defaultModel: pickString(entryConfig?.defaultModel, DEFAULT_MODEL),
    maxAttempts: pickNumber(entryConfig?.maxAttempts, 3),
    strict: pickBool(entryConfig?.strict, true),
    aspectRatio: pickString(entryConfig?.aspectRatio, '9:16'),
    styleBlockMode: pickString(entryConfig?.styleBlockMode, 'soft'),
    maxAutoRetries: pickNumber(entryConfig?.maxAutoRetries, 1),
    secondsPerLine: pickNumber(entryConfig?.secondsPerLine, 2.5),
    usableRatio: pickNumber(entryConfig?.usableRatio, 0.8),
    calibrateFromSegment: pickNumber(entryConfig?.calibrateFromSegment, 5),
    dailyCallLimit: pickNumber(entryConfig?.dailyCallLimit, 30),
    minGapSec: pickNumber(entryConfig?.minGapSec, 60),
    maxGapSec: pickNumber(entryConfig?.maxGapSec, 180),
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
      // 开机自检：用户报错里最多的就是"缺东西"，先摆出来
      const pre = [`Node ${process.version}`]
      try {
        const fx = await ffmpegApi()
        pre.push(fx.version().ok ? 'ffmpeg ✅' : 'ffmpeg ❌ 未找到（取帧/混音/字幕/拼接 不可用）')
      } catch { pre.push('ffmpeg ❌ 检测失败') }
      try {
        const pw = await loadFromProfile('playwright')
        pre.push(pw ? 'Playwright ✅' : 'Playwright ❌ 未找到（浏览器五个工具不可用）')
      } catch { pre.push('Playwright ❌ 未找到（浏览器五个工具不可用）') }


      const lines = [`📽 项目「${slug}」`, `状态目录：${c.home}`, `环境：${pre.join(' · ')}`, '']
      // 风控状态（当天用量 / 自设上限）
      try {
        const g = readGuard(c.home)
        lines.push(`风控：今天已发 ${g.count}/${c.dailyCallLimit || '不限'} 次 · 间隔 ${c.minGapSec}–${c.maxGapSec}s`)
      } catch { /* 读不到不阻断 */ }

      // 当前生成后端（mock 会返回假成片，必须显眼）
      try {
        const pk = providerKind()
        lines.push(pk === 'mock'
          ? '后端：⚠️ mock（假数据！不会真的生成视频）'
          : `后端：${pk}（网页端）`)
      } catch { /* 探测失败不阻断 */ }

      const authTxt = project.auth && project.auth.grantedAt
        ? `已授权（${new Date(project.auth.grantedAt).toLocaleString('zh-CN')}，后续段落免确认）`
        : '未授权（第一段生成前需本人说一次「确定生成视频」）'
      lines.push(`授权：${authTxt}`)
      // 2026-11-04：ASR 字幕依赖 python + faster-whisper。
      // 没装不是错误 —— 出片不需要它，只是没有"按原声"的字幕。这里提前说清楚。
      try {
        const py = findPython(cfg())
        lines.push(py
          ? '字幕能力：✅ ASR 可用（按原声切岛出字幕）'
          : '字幕能力：⚠️ 未装 Python+faster-whisper —— 出片不受影响，但没有 ASR 字幕（pip install faster-whisper）')
      } catch { /* 检测失败不阻断状态面板 */ }
      lines.push(`风格锁：${project.styleLock ? `${project.styleLock.id} · ${project.styleLock.artStyle}` : '❌ 未锁定（第 0 步）'}`)
      lines.push(`脚本：${project.script ? `已通过 · ${segs.length} 段 / ${shots} 分镜` : '❌ 未提交'}`)
      lines.push(`角色：${Object.keys(project.roles).length} 张${missingRoles.length ? `（还差：${missingRoles.join('、')}）` : ''}`)
      lines.push(`场景：${Object.keys(project.scenes).length} 张${missingScenes.length ? `（还差：${missingScenes.join('、')}）` : ''}`)
      lines.push(`片段：${clipSegs.length ? clipSegs.map((n) => `第${n}段`).join(' ') : '无'}`)
      if (clipSegs.length) lines.push(`剪辑顺序：${clipSegs.join(' → ')}`)

      // 待生成 / 待确认
      const pendings = Object.entries(project.pending || {})
        .filter(([, p]) => p && !project.clips[p.segment])
        .map(([k, p]) => ({ segment: Number(k), audited: !!p.auditHash, approved: !!p.approvedAt, sent: !!p.confirmedAt }))
      if (pendings.length) {
        lines.push('待生成：')
        pendings.forEach((p) => lines.push(`  - 第 ${p.segment} 段：${p.sent
          ? `已发送，生成中（正常 ${c.genMinMinutes}–${c.genMaxMinutes} 分钟）`
          : p.approved ? '已确认待发送 ⏸（还没真发出去）'
            : p.audited ? '已审计，⏸ 等待本人确认「确定生成视频」' : '⏸ 待审计（上传图 + 补 @ 后跑 doubao_prompt_audit）'}`))
      }
      // 断点续跑（2026-11-04）：重启/崩溃后，一眼看出该从哪继续。
      const sentSegs = pendings.filter((p) => p.sent)
      const auditedSegs = pendings.filter((p) => p.audited && !p.sent)
      if (sentSegs.length) {
        lines.push('', `断点：第 ${sentSegs.map((p) => p.segment).join('、')} 段已发送、还没登记成片`)
        lines.push(`  下一步：doubao_browser_capture（抓第 ${sentSegs[0].segment} 段）→ doubao_clip_register`)
      }
      if (auditedSegs.length) {
        lines.push(`  排队：第 ${auditedSegs.map((p) => p.segment).join('、')} 段已审计，等前一段出片`)
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
      characterScale: { type: 'string', description: '人物占画幅比例，例如「全身约 90% 画面高」「中景约 1/2 画面高，头顶留白 10%」；填了会自动加防变形约束' },
      framing: { type: 'string', description: '构图要求，例如「人物居中偏左，视线朝向屏幕右侧」' },
      antiDeform: { type: 'boolean', description: '是否追加强制防变形约束（默认 true，仅在填了 characterScale 时生效）' },
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
        // 2026-11-04：人物比例 / 构图 / 自定义字段 / 强度，都要落进锁里，
        // 否则 style_lock 收了参数却没保存，提示词里也就没有。
        characterScale: String(args.characterScale || '').trim() || null,
        framing: String(args.framing || '').trim() || null,
        title: String(args.title || '').trim() || null,
        antiDeform: args.antiDeform === false ? false : true,
        extra: (args.extra && typeof args.extra === 'object') ? args.extra : null,
        custom: String(args.custom || '').trim() || null,
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
        minSegmentSeconds: c.minSegmentSeconds,
        maxSegmentSeconds: c.maxSegmentSeconds,
        minShotsPerSegment: c.minShotsPerSegment,
        secondsPerLine: c.secondsPerLine,
        usableRatio: c.usableRatio,
        styleLockId: project.styleLock?.id || null,
      })

      // 模型维度：段长不能超过该模型单条上限；换模型/会员门槛也在这里拦
      const modelName = project.model?.name || c.defaultModel
      ;(script.segments || []).forEach((seg, i) => {
        const mr = checkModel(modelName, {
          hasMembership: c.hasMembership,
          durationSeconds: seg.durationSeconds,
          approved: !!project.model?.approved,
        })
        mr.violations.forEach((v) => result.violations.push({ ...v, where: `segments[${i}].${v.where}` }))
      })
      result.ok = result.violations.length === 0

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

        // 关键帧回拉（2026-11-04）：长片里人物会越飘越远。
        // 从第 5 段起，强制把「第 1 段的尾帧」一起上传，让豆包拿它校准人物。
        const CALIBRATE_FROM = Number(c.calibrateFromSegment ?? 5)
        const firstClip = project.clips?.[1]
        if (segIndex >= CALIBRATE_FROM && firstClip?.tailFrame
            && !requiredUploads.includes(firstClip.tailFrame)) {
          requiredUploads.push(firstClip.tailFrame)
        }

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
        styleLock: project.styleLock,
        styleBlockMode: c.styleBlockMode,
        // 2026-11-02 修：模型必须写进提示词。豆包页面没有模型下拉框，
        // 只在 project.model 里记一个名字平台根本不知道 —— 真机实测两次都用了 Mini。
        modelName: project.model?.name,
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

      // 模型闸（2026-11-02 真机事故）：豆包不认插件里的项目状态，只认提示词里的文字。
      // 切了 Fast/2.0/2.5 却没把「模型：X」写进提示词，平台照样用默认 Mini 生成 —— 白跑两条。
      if (project.model?.name && project.model.name !== c.defaultModel
          && !String(args.promptText || '').includes(`模型：${project.model.name}`)) {
        return {
          ok: false,
          text: `❌ 提示词里没有「模型：${project.model.name}」。\n`
            + '豆包只认提示词里的文字，不认插件的项目状态；漏了这一行它会用默认的 Seedance 2.0 Mini 生成。\n'
            + '回去跑 doubao_shot_check 重新拿提示词（它会自动带上模型行）。',
        }
      }

      // 人物比例闸（2026-11-04）：设了 characterScale 却不写进提示词，豆包会按参考图自由缩放 ——
      // 昨晚真机出现人物被压扁、头身比忽大忽小。和"模型行"是同一类坑：只记在插件里没用。
      if (project.styleLock?.characterScale
          && !String(args.promptText || '').includes('人物比例：')) {
        return {
          ok: false,
          text: '❌ 提示词里没有「人物比例：」这一行。\n'
            + `本项目已锁定比例：${project.styleLock.characterScale}\n`
            + '不写这一行，豆包会按参考图自由缩放，容易出现人物变形/忽大忽小。\n'
            + '回去跑 doubao_shot_check 重新拿提示词（它会自动带上）。',
        }
      }

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
      // 提示词原文落进状态（2026-11-04 真机发现）：元数据 JSON 里 prompt 一直是 null，
      // 因为从来没有人把它存下来。复盘时最想看的恰好就是这段原文。
      pending.promptText = String(args.promptText || '')
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
    name: 'doubao_model_select',
    description: '切换视频模型。**默认是 Seedance 2.0 Mini，一般不用调**。'
      + 'Fast / 2.0 / 2.5 都必须由本人明确指定（confirmText 要带上模型名和「确定使用」）。'
      + '2.0 需会员且单条 ≤15 秒，2.5 需会员且单条 ≤30 秒；没会员这两档用不了。',
    parameters: {
      model: { type: 'string', description: '模型名：Seedance 2.0 Mini / Seedance 2.0 Fast / Seedance 2.0 / Seedance 2.5' },
      confirmText: { type: 'string', description: '本人原话，必须同时包含模型名和「确定使用」' },
      project: { type: 'string', description: '项目名' },
    },
    async execute(args) {
      const { c, slug, project } = openProject(args.project)
      const model = String(args.model || '').trim()
      const txt = String(args.confirmText || '').trim()

      if (!MODELS[model]) {
        return { ok: false, text: `❌ 未知模型「${model}」，可选：${Object.keys(MODELS).join(' / ')}` }
      }
      if (!txt.includes(model) || !txt.includes('确定使用')) {
        return {
          ok: false,
          text: `⛔ 换模型要本人点头：confirmText 里必须同时出现「${model}」和「确定使用」。\n`
            + '（默认用 Seedance 2.0 Mini，不需要这一步。）',
        }
      }
      const check = checkModel(model, { hasMembership: c.hasMembership, approved: true })
      if (!check.ok) {
        return { ok: false, text: formatVerdict(`模型「${model}」不可用`, check) }
      }
      project.model = { name: model, approved: model !== DEFAULT_MODEL, approvedAt: new Date().toISOString(), by: txt.slice(0, 100) }
      saveProject(c.home, slug, project)
      return {
        ok: true,
        text: `✅ 模型已切到 ${model}（单条上限 ${MODELS[model].maxSeconds} 秒）\n`
          + `会员：${c.hasMembership ? '已开' : '未开'}\n`
          + `注意：已通过的脚本若段长超限，需要重交。`,
        model: project.model,
      }
    },
  })

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

      // 授权粒度（本人 2026-11-02 改）：**首次确认，后续免问**。
      // 豆包那边的「确认生成视频」仍然每条都要发——那是平台侧的动作，与本闸无关。
      const sessionAuth = project.auth && project.auth.grantedAt
      if (!sessionAuth && !/确定生成视频/.test(text)) {
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

      if (sessionAuth && !pending.approvedAt) {
        pending.approvedAt = new Date().toISOString()
        pending.reusedAuth = true
        project.pending[String(segment)] = pending
        saveProject(c.home, slug, project)
        return {
          ok: true,
          text: `✅ 第 ${segment} 段沿用首次授权（${project.auth.grantedAt}），无需再次确认。\n`
            + '注意：豆包页面上每条仍要发一次「确认生成视频」，那是平台侧动作。',
          status: 'approved',
          reused: true,
        }
      }

      if (pending.confirmedAt) {
        return { ok: true, text: `ℹ️ 第 ${segment} 段已经确认过了（${pending.confirmedAt}），直接生成即可。`, status: 'already_confirmed' }
      }

      // 确认 ≠ 已发送：这里只记"本人批准了"。confirmedAt 留到 browser_send 真发成功后写，
      // 否则 status 会把"一条都没发出去"显示成"生成中"（2026-10-31 的真实误导）。
      pending.approvedAt = new Date().toISOString()
      if (!sessionAuth) {
        // 只在第一次落授权；后面几段直接复用，不再询问本人
        project.auth = {
          grantedAt: pending.approvedAt,
          by: text.slice(0, 100),
          note: '首次确认后，本次会话的后续片段不再询问',
        }
      }
      pending.confirmText = text.slice(0, 100)
      project.pending[String(segment)] = pending
      saveProject(c.home, slug, project)

      return {
        ok: true,
        text: `▶️ 第 ${segment} 段已获本人批准（${pending.approvedAt}）\n`
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

      const clipCheck = checkClip(clip, { segmentSeconds: c.segmentSeconds, minSegmentSeconds: c.minSegmentSeconds, maxSegmentSeconds: c.maxSegmentSeconds })

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

      // 去重：同一项目里两段字节完全相同 = 拿同一段充数（2026-11-01 真实踩过）
      let clipHash = null
      try {
        if (clip.file && existsSync(clip.file)) {
          clipHash = createHash('sha256').update(readFileSync(clip.file)).digest('hex').slice(0, 12)
          const dup = Object.entries(project.clips || {}).find(([, v]) => v && v.hash === clipHash)
          if (dup) {
            clipCheck.ok = false
            clipCheck.violations.push({
              code: 'E_CLIP_DUPLICATE', where: 'file',
              message: `与第 ${dup[0]} 段字节完全相同（hash ${clipHash}）：同一段不能登记两次`,
            })
          }
        }
      } catch { /* 读不到就跳过 */ }

      // 模型维度：成片时长同样受模型上限约束
      const clipModel = project.model?.name || c.defaultModel
      const cm = checkModel(clipModel, {
        hasMembership: c.hasMembership,
        durationSeconds: clip.durationSeconds,
        approved: !!project.model?.approved,
      })
      cm.violations.forEach((v) => clipCheck.violations.push(v))
      if (cm.violations.length) clipCheck.ok = false

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
        hash: clipHash,
        at: new Date().toISOString(),
      }
      saveProject(c.home, slug, project)

      // 元数据落盘（2026-11-04）：成片旁边留一份 <文件名>.json。
      // 复盘时不用翻聊天记录：这一段用的什么模型、什么提示词、重试了几次、生成多久。
      try {
        const shot0 = project.script?.segments?.[clip.segment - 1]?.shots?.[0]
        const meta = {
          project: slug,
          segment: clip.segment,
          file: clip.file,
          durationSeconds: clip.durationSeconds,
          tailTimeSeconds: clip.tailTimeSeconds,
          model: project.model?.name || c.defaultModel,
          aspectRatio: project.styleLock?.aspectRatio || c.aspectRatio,
          styleLock: project.styleLock || null,
          generateMinutes: project.clips[clip.segment].generateMinutes,
          retries: Number(project.pending?.[String(clip.segment)]?.retries) || 0,
          hash: clipHash,
          prompt: project.pending?.[String(clip.segment)]?.promptText || null,
          shotFields: shot0 || null,
          registeredAt: project.clips[clip.segment].at,
        }
        writeFileSync(clip.file.replace(/\.[^.]+$/, '.json'), JSON.stringify(meta, null, 2), 'utf8')
      } catch { /* 元数据写不进去不影响主流程 */ }

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

  // 浏览器动作已收进 lib/providers/：工具只说"上传/写稿/发送/等片"，
  // 具体怎么点页面在 providers/web.mjs（playwright 也是那时才连）。
  // provider() 是单例 —— 6 个工具共用同一个 page，不再每个工具 open 一次。
  // 后端选择：DOUBAO_PROVIDER=mock 时走假后端（provider-sim.mjs 用）。
  const genProvider = (args) => provider({ cdpUrl: args?.cdpUrl })

  /** provider 的 status() 允许带 ok/error；工具只想要原始页面状态（返回结构不能变） */
  const pageState = (st) => {
    if (!st || st.ok === false) return null
    const s = { ...st }
    delete s.ok
    return s
  }

  tool({
    name: 'doubao_browser_clear',
    description: '清空豆包输入框里的草稿，并尝试把已挂上的附件一起摘掉。试跑/写错了用它收拾现场，不会发送任何东西。',
    parameters: {
      cdpUrl: { type: 'string', description: 'CDP 地址' },
    },
    async execute(args) {
      const gen = await genProvider(args)
      const res = await gen.clear()
      if (res.ok === false) return { ok: false, text: `❌ 清空失败：${res.error || '浏览器没连上'}` }
      await gen.shot(join(defaultHome(), 'cleared.png'))
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
      const gen = await genProvider(args)

      const dir = join(c.home, 'clips')
      mkdirSync(dir, { recursive: true })
      const videoPath = join(dir, `${slug}-seg${segment}.mp4`)
      const tailPath = join(dir, `${slug}-seg${segment}-tail.png`)
      const waitMs = (Number(args.waitSeconds) || 900) * 1000

      // 基线快照 + 等新片 + 下载 + 尾帧全在 provider 里（providers/web.mjs）：
      //   豆包的结果是「竖版海报 + 播放控件」的懒加载卡片，DOM 里没有 <video>，
      //   而且对话是虚拟列表（只留最近几条消息），所以：
      //     · 不能数 <video>（修 #1）
      //     · 不能数「你的视频生成好了」的条数（修 #4）
      //     · 判定"新片"要看卡片数量变多 + src 没出现过（修 #3）
      // 这里只负责把 provider 带回来的现场拼成人话。
      const r = await gen.fetchClip({
        segment,
        savePath: videoPath,
        tailPath,
        waitSeconds: Number(args.waitSeconds) || 900,
      })
      const before = r.before || { cards: 0 }

      if (r.phase === 'quota-before') {
        return {
          ok: false,
          text: `⛔ 豆包提示额度不够：${r.quotaText ? `「${r.quotaText}」` : '（页面出现额度拦截文案）'}\n`
            + '这一段没有生成，也没有消耗额度。换号 / 等额度恢复 / 开通订阅后再来。',
        }
      }
      if (r.phase === 'quota-wait') {
        const hit = r.quotaText
        return {
          ok: false,
          text: `⛔ 等片期间豆包返回额度拦截：${hit ? `「${hit}」` : '（页面出现额度拦截文案）'}\n`
            + '这一段没生成出来，别登记；等额度恢复或换号后重跑。',
        }
      }
      if (!r.found || !r.found.ok) {
        const st = r.state || pageState(await gen.status()) || {}
        return {
          ok: false,
          text: `⏳ 等了 ${Math.round(waitMs / 1000)} 秒仍没出现新卡片（动手前 ${before.cards} 张，生成中=${r.found?.state?.generating ? '是' : '否'}）。\n`
            + `页面尾部：${String(st.lastText || '').slice(-200)}`,
        }
      }

      const found = r.found
      const dl = r.dl || { ok: false, error: r.detail || '成片没下下来' }
      let tf = r.tf || { ok: false, error: r.detail || '尾帧没取到' }
      if (tf && !Array.isArray(tf.size)) tf = { ...tf, size: ['?', '?'] }

      // 用 pending 的确认时间估算实际生成耗时（豆包出片后才知道）
      const pending = project.pending?.[String(segment)]
      const minutes = pending?.confirmedAt
        ? Number(((Date.now() - new Date(pending.confirmedAt).getTime()) / 60000).toFixed(1))
        : null

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
    name: 'doubao_tts',
    description: '合成语音（HTTP 调用本机 TTS 插件，不 import 对方包）。默认音色 zh-CN-XiaoyiNeural。'
      + '返回文本而不是音频时会明确报 E_TTS_NOT_AUDIO，不会把「发好了」当成功。',
    parameters: {
      project: { type: 'string', description: '项目名' },
      text: { type: 'string', description: '要合成的文字' },
      segment: { type: 'number', description: '第几段（可选，只影响文件名）' },
      line: { type: 'number', description: '段内第几句（可选，只影响文件名）' },
      voice: { type: 'string', description: '音色（默认 zh-CN-XiaoyiNeural）' },
      rate: { type: 'string', description: '语速，如 +10% / -5%（默认 +0%）' },
      out: { type: 'string', description: '输出 mp3 路径（可选）' },
    },
    async execute(args) {
      const { c, slug } = openProject(args.project)
      // 2026-11-04 修复同学修：原来只解构了 { c }，下面却用 slug → ReferenceError: slug is not defined。
      // 文件名带 项目-段-句：一次跑 6 句时，时间戳名根本分不清哪句是哪句（2026-11-02 提的）
      const parts = [slug]
      if (args.segment) parts.push(`seg${Number(args.segment)}`)
      if (args.line) parts.push(`line${Number(args.line)}`)
      const autoName = `${parts.join('-')}-${Date.now()}.mp3`
      const out = args.out || join(c.home, 'audio', autoName)
      const r = await ttsSpeak({ text: args.text, voice: args.voice, rate: args.rate, outFile: out })
      if (r.ok) return { ...r, text: `✅ 语音已生成：${r.file}（${Math.round(r.bytes / 1024)} KB，端口 ${r.port}）` }
      return { ok: false, error: r.error, text: `❌ ${r.error}\n${r.hint}` }
    },
  })

  tool({
    name: 'doubao_image_batch',
    description: '批量生成图片素材（做图文视频用）：一次给 N 段提示词，逐条发给豆包、等图出来、下载到 assets/images/。'
      + '串行执行（并发会把对话搞乱）。生成的图会按 img-01.png / img-02.png 命名。',
    parameters: {
      project: { type: 'string', description: '项目名' },
      prompts: { type: 'string', description: '每张图一段提示词。JSON 数组字符串（["...","..."]）或换行分隔都行。' },
      outDir: { type: 'string', description: '输出目录；不填 = <状态目录>/assets/images' },
      waitSeconds: { type: 'number', description: '每张图最多等多久（默认 90 秒）' },
      cdpUrl: { type: 'string', description: 'CDP 地址，默认 http://127.0.0.1:9333' },
    },
    async execute(args) {
      const { c, slug } = openProject(args.project)
      // 2026-11-04 事故：这个参数原来是 type:'array'，装进 DSH 后整类工具都挂不上去
      // （24 个工具一个都进不了 schema）。改成字符串，自己解析。
      const prompts = parseList(args.prompts)
      if (!prompts.length) return { ok: false, text: '❌ prompts 是空的：给 JSON 数组或换行分隔的多段提示词。' }
      if (!prompts.length) return { ok: false, text: '❌ prompts 是空的：给一个字符串数组，每项一段提示词。' }

      const gen = await genProvider(args)
      const outDir = String(args.outDir || '').trim() || join(c.home, 'assets', 'images')

      const logs = []
      const r = await generateBatch(gen, prompts, {
        outDir,
        waitSeconds: Number(args.waitSeconds) || 90,
        onLog: (m) => logs.push(m),
      })

      if (!r.ok) {
        return {
          ok: false,
          text: `❌ 一张都没出成。\n${r.failed.map((x) => `  - #${x.index}: ${x.reason}`).join('\n')}\n`
            + '检查：豆包是否登录、对话是否被额度拦、waitSeconds 是否给够。',
          failed: r.failed,
        }
      }
      recordHistory(c.home, slug, { gate: 'G8-images', ok: true, summary: `${r.saved.length} 张` })
      return {
        ok: true,
        text: `🖼 批量出图：${r.saved.length}/${prompts.length} 张 → ${r.dir}\n`
          + r.saved.map((x) => `  #${x.index} ${x.file.split(/[\\/]/).pop()}（${Math.round(x.bytes / 1024)} KB）`).join('\n')
          + (r.failed.length ? `\n失败 ${r.failed.length} 张：${r.failed.map((x) => `#${x.index} ${x.reason}`).join('；')}` : ''),
        dir: r.dir,
        saved: r.saved,
        failed: r.failed,
      }
    },
  })

  tool({
    name: 'doubao_dub',
    description: '按成片节奏做后期配音。**BGM 必须用户自己提供（mp3/wav 路径），插件不内置任何音乐**——' +
      '不光是体积问题，更因为商用/发布用的 BGM 版权要用户自己负责。两种模式：replace=用 TTS 铺在时间轴上替换原声，'
      + 'keep=沿用豆包原声、只叠 BGM（字幕另走 doubao_subtitle）。时间轴按脚本每段时长+分镜顺序累计，'
      + '所以「第 5 秒才说话」的镜头，声音就从第 5 秒起。',
    parameters: {
      project: { type: 'string', description: '项目名' },
      video: { type: 'string', description: '成片路径（doubao_concat 的产物）' },
      out: { type: 'string', description: '输出路径（可选）' },
      mode: { type: 'string', description: 'replace（默认，重配）| keep（沿用原声，只加 BGM）' },
      bgm: { type: 'string', description: 'BGM 文件路径——**必须用户自己提供**，插件不内置音乐（版权与体积都由用户负责）' },
      bgmDb: { type: 'number', description: 'BGM 增益 dB（默认 -18，负数=压低）' },
      voice: { type: 'string', description: '音色（默认 zh-CN-XiaoyiNeural）' },
      dryRun: { type: 'boolean', description: '只输出时间轴，不合成' },
    },
    async execute(args) {
      const { c, slug, project } = openProject(args.project)
      // 声音方案闸（2026-11-04）：没人工确认过用后期配音，不许直接重配。
      const confirmedMode = process.env.DOUBAO_SKIP_AUDIO_GATE === '1' ? 'dub' : project.audio?.mode
      if (!confirmedMode) {
        return {
          ok: false,
          text: '⛔ 还没确定这一集用哪种声音。\n先 doubao_audio_confirm(mode="dub", confirmText="确定使用后期配音")。',
        }
      }
      if (confirmedMode !== 'dub' && String(args.mode || 'replace') !== 'keep') {
        return { ok: false, text: '⛔ 本项目确认的是「豆包原声」，不能在这里重配。要改先重新 doubao_audio_confirm。' }
      }
      const mode = String(args.mode || 'replace').trim() === 'keep' ? 'keep' : 'replace'
      // 与字幕同一套时间轴（修 bug①：按真实片段时长）
      const cues = timelineFromClips(project.script?.segments || [], project.clips, { overlapMs: 40 })
      if (!cues.length) return { ok: false, text: '❌ 脚本里没有任何台词/旁白，没什么可配的。' }

      const plan = cuesToScript(cues)
      if (args.dryRun === true) {
        return { ok: true, text: `🗒 时间轴（${cues.length} 条）\n${plan}`, cues }
      }
      if (mode === 'keep' && !args.bgm) {
        return {
          ok: false,
          text: '❌ 还差一个 BGM 文件。\n'
            + '插件**不内置任何音乐**（体积 + 版权都得用户自己负责），请先准备一个音频文件再传 bgm：\n'
            + '  bgm: "C:\\...\\雨夜.mp3"（mp3 / wav / m4a 都行）\n'
            + '建议 bgmDb 设 -18 左右，别盖住人声。',
        }
      }

      const out = String(args.out || '').trim() || join(c.home, 'clips', `${slug}-dub.mp4`)
      let lines = []
      if (mode === 'replace') {
        const audioDir = join(c.home, 'audio', `dub-${Date.now()}`)
        const failed = []
        for (let i = 0; i < cues.length; i += 1) {
          const cue = cues[i]
          const file = join(audioDir, `seg${cue.segment}-line${i + 1}.mp3`)
          const sp = await ttsSpeak({ text: cue.text, voice: args.voice, outFile: file })
          if (!sp.ok) { failed.push(`${cue.start}s ${cue.text.slice(0, 12)}：${sp.error}`); continue }
          lines.push({ file: sp.file, start: cue.start })
        }
        if (!lines.length) return { ok: false, text: `❌ 一条配音都没生成：\n${failed.join('\n')}` }
        if (failed.length) {
          return {
            ok: false,
            text: `⚠️ 有 ${failed.length} 条配音失败，为避免"缺句"先不合成：\n${failed.join('\n')}\n`
              + '（缺句比音画不同步更难受，所以这里直接中止。）',
            failed,
          }
        }
      }

      // BGM 允许写「名字」：用户在 QQ 里发过、辞辞用 doubao_bgm 收进归档后，
      // 这里只写「雨夜」就能找到，不用记绝对路径。
      let bgmPath = null
      if (args.bgm) {
        bgmPath = resolveBgm(c.home, args.bgm)
        if (!bgmPath) {
          const have = listBgm(c.home).map((x) => x.name).join('、') || '（还没有）'
          return {
            ok: false,
            text: `❌ 找不到 BGM「${args.bgm}」。\n现有：${have}\n`
              + '让用户把音频发到 QQ，然后先跑 doubao_bgm（action=add）把它收进归档。',
          }
        }
      }

      const r = mixDubbing({
        video: args.video, lines, mode,
        bgm: bgmPath,
        bgmDb: args.bgmDb === undefined ? -18 : Number(args.bgmDb),
        out,
      })
      if (!r.ok) return { ok: false, text: `❌ 合成失败：${r.error}` }

      recordHistory(c.home, slug, { gate: 'G9-dub', ok: true, summary: `${mode} · ${lines.length} 条` })
      return {
        ok: true,
        text: `🎙 配音完成（${mode === 'keep' ? '沿用原声' : '重配'}）：${r.out}\n`
          + `时间轴 ${cues.length} 条，配音 ${r.lines} 条${r.bgm ? `，BGM：${r.bgm}` : ''}\n`
          + `下一步：doubao_subtitle 烧字幕（若还没烧）\n\n${plan}`,
        out: r.out, cues, lines: r.lines,
      }
    },
  })

  tool({
    name: 'doubao_audio_confirm',
    description: '确定这一集用哪种声音方案（**必须人工确认，不能由 AI 自己选**）。'
      + 'mode=original 用豆包原声（后续只加字幕/BGM）；mode=dub 用后期配音（TTS + BGM + 字幕）。'
      + 'confirmText 必须包含「确定使用豆包原声」或「确定使用后期配音」。'
      + '没确认过调 doubao_subtitle / doubao_dub 会被拒。',
    parameters: {
      project: { type: 'string', description: '项目名' },
      mode: { type: 'string', description: 'original（豆包原声）| dub（后期配音）' },
      confirmText: { type: 'string', description: '本人原话，含「确定使用豆包原声」或「确定使用后期配音」' },
    },
    async execute(args) {
      const { c, slug, project } = openProject(args.project)
      const mode = String(args.mode || '').trim()
      const txt = String(args.confirmText || '').trim()
      if (!['original', 'dub'].includes(mode)) {
        return { ok: false, text: '❌ mode 只能是 original（豆包原声）或 dub（后期配音）。' }
      }
      const phrase = mode === 'original' ? '确定使用豆包原声' : '确定使用后期配音'
      if (!txt.includes(phrase)) {
        return {
          ok: false,
          text: `⛔ 这一步必须本人拍板：confirmText 里要写「${phrase}」。\n`
            + '原因：豆包原声和后期配音是两条完全不同的成片，选错整片重做。',
        }
      }
      project.audio = { mode, confirmedAt: new Date().toISOString(), by: txt.slice(0, 100) }
      saveProject(c.home, slug, project)
      recordHistory(c.home, slug, { gate: 'G9-audio', ok: true, summary: mode })
      return {
        ok: true,
        text: `✅ 声音方案已定：${mode === 'original' ? '豆包原声（只加字幕/BGM）' : '后期配音（TTS+BGM+字幕）'}\n`
          + (mode === 'original'
            ? '下一步：doubao_subtitle（字幕按成片真实时长对齐）'
            : '下一步：doubao_dub（按节奏配音）→ doubao_subtitle'),
        audio: project.audio,
      }
    },
  })

  tool({
    name: 'doubao_asr_subtitle',
    description: '按**原声实际发声**出字幕：切语音岛 → 逐岛 ASR → 过滤幻觉 → 烧字幕，原声 -c:a copy 保留。'
      + '适用"豆包只念了部分台词"的情况——脚本台词只作校对参考，条数和时间以实测为准。'
      + '不用按脚本均分，因为脚本写 9 句而实际只念 3 句时，6 条字幕会对着空气说话。',
    parameters: {
      project: { type: 'string', description: '项目名' },
      video: { type: 'string', description: '成片路径（已拼接）' },
      out: { type: 'string', description: '输出路径（可选）' },
      thresholdDb: { type: 'number', description: '语音岛能量阈值（默认 -32dB）' },
      minGapSec: { type: 'number', description: '小于该间隙合并（默认 0.45s）' },
      minIslandSec: { type: 'number', description: '太短的岛丢弃（默认 0.35s）' },
      padStartSec: { type: 'number', description: '字幕提前量（默认 0.2s）' },
      padEndSec: { type: 'number', description: '字幕延后量（默认 0.4s）' },
      fontSize: { type: 'number', description: '字号（默认 14）' },
      dryRun: { type: 'boolean', description: '只出 srt 和报告，不烧字幕' },
    },
    async execute(args) {
      const { c, slug, project } = openProject(args.project)
      const audioMode = process.env.DOUBAO_SKIP_AUDIO_GATE === '1' ? 'original' : project.audio?.mode
      if (!audioMode) {
        return {
          ok: false,
          text: '⛔ 还没确定这一集用哪种声音。\n先让本人拍板：doubao_audio_confirm(mode="original", confirmText="确定使用豆包原声")',
        }
      }
      if (audioMode !== 'original') {
        return { ok: false, text: '⛔ 本项目确认的是「后期配音」；ASR 字幕只适用于豆包原声。先用 doubao_audio_confirm 改回 original。' }
      }

      const py = findPython(cfg())
      if (!py) {
        return {
          ok: false,
          text: '❌ 没有可用的 Python + faster-whisper。\n'
            + '安装：pip install faster-whisper\n'
            + '或用环境变量 DOUBAO_PYTHON 指向带该包的解释器。\n'
            + '（这是 ASR 字幕的硬依赖：不装就没法按原声出字幕。）',
        }
      }

      const r = transcribe({
        video: args.video, python: py,
        thresholdDb: args.thresholdDb, minGapSec: args.minGapSec, minIslandSec: args.minIslandSec,
      })
      if (!r.ok) return { ok: false, text: `❌ ASR 失败：${r.error}\n${r.hint}` }

      const srtPath = join(c.home, 'clips', `${slug}-asr.srt`)
      writeFileSync(srtPath, toSrt(r.lines, { padStartSec: args.padStartSec, padEndSec: args.padEndSec }), 'utf8')

      if (args.dryRun === true) {
        return {
          ok: true, srt: srtPath, lines: r.lines, dropped: r.dropped,
          text: `🗒 ASR 出稿：${r.lines.length} 条（丢弃 ${r.dropped.length}）\n`
            + r.lines.map((l) => `  ${l.start.toFixed(1)}–${l.end.toFixed(1)}s  ${l.text}`).join('\n')
            + `\nsrt：${srtPath}`,
        }
      }

      const out = String(args.out || '').trim() || join(c.home, 'clips', `${slug}-asr.mp4`)
      const cues = r.lines.map((l) => ({ start: Math.max(0, l.start - (Number(args.padStartSec) || 0.2)), end: l.end + (Number(args.padEndSec) || 0.4), text: l.text }))
      const b = burnSubs({ video: args.video, cues, out, fontSize: args.fontSize || 14 })
      if (!b.ok) return { ok: false, text: `❌ 烧字幕失败：${b.stderr}`, srt: srtPath }

      recordHistory(c.home, slug, { gate: 'G10-asr', ok: true, summary: `${r.lines.length} 条` })
      return {
        ok: true, srt: srtPath, out, lines: r.lines, dropped: r.dropped,
        text: `✅ 按原声出字幕：${r.lines.length} 条（丢弃 ${r.dropped.length} 条幻觉/无效）\n`
          + `成片：${out}\nsrt：${srtPath}\n`
          + r.lines.map((l) => `  ${l.start.toFixed(1)}–${l.end.toFixed(1)}s  ${l.text}`).join('\n'),
      }
    },
  })

  tool({
    name: 'doubao_audio_balance',
    description: '响度平衡：把"音效盖过人声"压下去，并归一到发布平台标准的 -16 LUFS。'
      + '豆包给的是一条混好的音轨（人声和音效烧在一起），所以做不到"抽掉雨声"，'
      + '能做的是：切掉 90Hz 以下轰鸣、2–4k 提亮人声、压缩动态让持续大声退后、整体响度归一。',
    parameters: {
      project: { type: 'string', description: '项目名' },
      video: { type: 'string', description: '成片路径' },
      out: { type: 'string', description: '输出路径（可选）' },
      mode: { type: 'string', description: 'voice（默认，强调人声）| mix（只做响度归一）' },
      targetLufs: { type: 'number', description: '目标响度，默认 -16 LUFS' },
      presenceDb: { type: 'number', description: '2–4k 提亮 dB（默认 2）' },
    },
    async execute(args) {
      const { c, slug } = openProject(args.project)
      const out = String(args.out || '').trim() || join(c.home, 'clips', `${slug}-balanced.mp4`)
      const fx = await ffmpegApi()
      const fp = (typeof fx.findFfmpeg === 'function' ? fx.findFfmpeg() : null) || 'ffmpeg'
      const before = measureLoudness(args.video, { ffmpegPath: fp }).inputI
      const r = balanceAudio({
        video: args.video, out,
        mode: String(args.mode || 'voice'),
        targetLufs: args.targetLufs === undefined ? -16 : Number(args.targetLufs),
        presenceDb: args.presenceDb === undefined ? 2 : Number(args.presenceDb),
        ffmpegPath: fp,
      })
      if (!r.ok) return { ok: false, text: `❌ 响度平衡失败：${r.error}` }
      const after = measureLoudness(out, { ffmpegPath: fp }).inputI
      recordHistory(c.home, slug, { gate: 'G11-loudness', ok: true, summary: `${before ?? '?'} → ${after ?? '?'} LUFS` })
      return {
        ok: true,
        text: `🔊 响度平衡完成：${out}\n`
          + `响度：${before ?? '测不到'} → ${after ?? '测不到'} LUFS（目标 ${args.targetLufs ?? -16}）\n`
          + `模式：${r.mode}\n滤镜：${r.filters}\n`
          + '注意：豆包把人和音效混在一条轨里，这一步只能"让人声更突出"，不能真的删掉音效。',
        out, before, after,
      }
    },
  })

  tool({
    name: 'doubao_bgm',
    description: '管理 BGM 归档。用户在 QQ 里发来音频后，用它收进固定目录（<状态目录>/bgm/），'
      + '之后 doubao_dub 只要写名字就能用。action=list 看已有；action=add 收一份（file=桥接落盘的本机路径，或 url=直链）。'
      + '**插件自带音乐库是不可能的（版权+体积），所以永远是用户提供、这里只负责归档。**',
    parameters: {
      action: { type: 'string', description: 'list（默认）| add' },
      project: { type: 'string', description: '项目名（仅用于日志）' },
      file: { type: 'string', description: '桥接把音频落盘后的本机路径（action=add 时用）' },
      url: { type: 'string', description: '音频直链（action=add 时用，和 file 二选一）' },
      name: { type: 'string', description: '归档名（默认取文件名）。之后 doubao_dub 用这个名字引用' },
    },
    async execute(args) {
      const { c, slug } = openProject(args.project)
      const action = String(args.action || 'list').trim()
      if (action === 'list') {
        const list = listBgm(c.home)
        if (!list.length) {
          return {
            ok: true,
            text: '📂 BGM 归档还是空的。\n让用户把音频发到 QQ，再用 doubao_bgm（action=add）收进来。',
            dir: bgmDir(c.home),
          }
        }
        return {
          ok: true,
          text: `📂 BGM 归档（${list.length} 首）\n` + list.map((x) => `  ${x.name}  ${Math.round(x.bytes / 1024)} KB`).join('\n'),
          items: list,
        }
      }
      if (action !== 'add') return { ok: false, text: `❌ 不认识的 action：${action}（只有 list / add）` }

      const r = await addBgm(c.home, { file: args.file, url: args.url, name: args.name })
      if (!r.ok) return { ok: false, text: `❌ 收 BGM 失败：${r.error}` }

      recordHistory(c.home, slug, { gate: 'G8-bgm', ok: true, summary: r.name })
      const how = { url: '从链接下载', copy: '从本机复制', already: '本来就在归档里' }[r.via] || r.via
      return {
        ok: true,
        text: `✅ 已收进归档：${r.name}（${Math.round(r.bytes / 1024)} KB，${how}）\n`
          + `路径：${r.file}\n`
          + `用的时候：doubao_dub(..., bgm: "${r.name}")`,
        name: r.name, file: r.file,
      }
    },
  })

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
      width: { type: 'number', description: '目标宽；不填则按项目画幅（9:16→1080，16:9→1920）' },
      height: { type: 'number', description: '目标高；不填则按项目画幅（9:16→1920，16:9→1080）' },
      overlapMs: { type: 'number', description: '接缝裁切毫秒（默认 40）：上一段尾帧=下一段首帧，硬拼会重复一帧' },
      cuts: { type: 'string', description: '按段粗剪，JSON 数组： [{"segment":1,"start":0.2,"trimEnd":0.3}]；也可写进 clip.trimStart/trimEnd' },
      allowPartial: { type: 'boolean', description: '允许缺段（默认 false，缺段拒绝）' },
      episode: { type: 'number', description: '（这一集）集号；填了会自动命名成 <项目>-EP<集>-<WxH>.mp4' },
      transition: { type: 'string', description: '转场类型：none / fade / wipeleft / slideleft / dissolve …（ffmpeg xfade 的名字）。默认 none=硬切' },
      transitionMs: { type: 'number', description: '转场时长毫秒（默认 300）' },
      project: { type: 'string', description: '项目名' },
    },
    async execute(args) {
      const { c, slug, project } = openProject(args.project)
      const segs = project.script?.segments?.length || 0
      const keys = Object.keys(project.clips || {}).map(Number).sort((a, b) => a - b)
      if (!keys.length) return { ok: false, text: '❌ 还没有登记任何片段：先把各段 clip_register 完。' }

      const missing = []
      for (let i = 1; i <= segs; i += 1) if (!project.clips[i]) missing.push(i)
      if (missing.length && args.allowPartial !== true) {
        return {
          ok: false,
          text: `❌ 第 ${missing.join('、')} 段还没登记，缺段不许先拼（否则后半截会错位）。\n`
            + '确实要只拼已登记的段，传 allowPartial: true。',
        }
      }

      const files = keys.map((k) => project.clips[k].file)
      // 2026-11-04 修复同学修：原来 nameDefault(1568) 先用了 width/height，而它们在 1571/1572 才声明
      // → 只要传了 episode 就 TDZ 崩（Cannot access 'width' before initialization）。先把宽高算出来。
      const wh = resolveWH(project.styleLock?.aspectRatio, { width: 1080, height: 1920 })
      const width = Number(args.width) || wh.width
      const height = Number(args.height) || wh.height
      // 输出标准化命名（2026-11-04）：杂乱的成片名是后期整理的大头成本。
      // 给了 episode 就按 <项目>-EP<集>-<WxH>.mp4 落盘，并在 exports/ 留一份。
      const ep = args.episode === undefined || args.episode === '' ? '' : String(args.episode).trim()
      const nameDefault = ep ? `${slug}-EP${ep}-${width}x${height}.mp4` : '成片.mp4'
      const out = String(args.out || '').trim() || join(c.home, 'clips', nameDefault)

      // 粗剪：参数优先，其次读 clip 上固化的 trimStart/trimEnd
      const cutsInput = parseList(args.cuts)
      const cuts = cutsInput.length
        ? args.cuts
        : keys.map((k) => ({
          segment: k,
          start: Number(project.clips[k]?.trimStart) || 0,
          trimEnd: Number(project.clips[k]?.trimEnd) || 0,
        })).filter((x) => x.start > 0 || x.trimEnd > 0)

      const f = await ffmpegApi()
      const overlapMs = args.overlapMs === undefined ? 40 : Number(args.overlapMs) || 0
      const r = (typeof f.concatCut === 'function' ? f.concatCut : f.concat)(files, out, {
        width, height, overlapMs, cuts,
        transition: String(args.transition || '').trim(),
        transitionMs: Number(args.transitionMs) || 300,
      })
      if (!r.ok) return { ok: false, text: `❌ 拼接失败：${r.error}` }

      recordHistory(c.home, slug, { gate: 'G7-concat', ok: true, summary: `${r.segments} 段` })
      return {
        ok: true,
        text: `🎬 拼接完成：${r.path}\n段序：${keys.join(' → ')}（共 ${r.segments} 段）\n`
          + `成片：${Number(r.meta?.duration || 0).toFixed(2)}s · ${r.meta?.width}×${r.meta?.height} · ${r.meta?.fps}fps\n`
          + `接缝：裁掉 ${r.trimmedMs ? `${r.trimmedMs.toFixed(0)}ms` : '未裁'} · 粗剪 ${cuts.length} 段 · 转场：${r.transition ? `${r.transition.type} ${r.transition.ms}ms` : '硬切'}`,
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
      const gen = await genProvider(args)
      const st = pageState(await gen.status())
      if (!st) return { ok: false, text: '❌ 连不上豆包页面：先确认带调试端口的浏览器开着，再重试。' }
      return {
        ok: true,
        text: `🖥 豆包页面：${st.title}\n${st.url}\n`
          + `输入框：${st.composer ? '在' : '没找到'}\n`
          + `草稿：${st.draftText ? st.draftText.slice(0, 80) : '（空）'}\n`
          + `正在生成：${st.generating ? '是（别插队）' : '否'}\n`
          + `文件输入口：${st.fileInputs} 个`
          + (st.fingerprintOk === false
            ? `\n\n⚠️ 页面结构不对：${(st.missing || []).map((m) => m.label).join('、')} 没了。`
              + '\n豆包很可能改版了 —— 这时候继续点只会静默出错。先告诉我，我改选择器。'
            : ''),
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

      const gen = await genProvider(args)
      const st = pageState(await gen.status())
      if (!st) return { ok: false, text: '❌ 连不上豆包页面：先确认带调试端口的浏览器开着，再重试。' }
      if (st.generating) return { ok: false, text: '⏸ 豆包正在生成上一条视频，先等它出来再说（插队会被拒或串味）。' }

      const uploads = pending.requiredUploads || []
      const text = String(args.promptText || '').trim() || buildShotPrompt(shot, {
        segIndex,
        roles: toMap(project.roles),
        scenes: toMap(project.scenes),
        clips: project.clips,
        durationSeconds: project.script?.segments?.[segIndex - 1]?.durationSeconds,
        aspectRatio: project.styleLock?.aspectRatio,
        styleLock: project.styleLock,
        styleBlockMode: c.styleBlockMode,
        // 2026-11-02 修：stage 这处也要带模型名，否则"暂存的文本"和"审计的文本"不一致
        modelName: project.model?.name,
      })
      // 上传 + 写稿是 provider 的一个动作（上传在前、写稿在后，顺序别反）
      const staged = await gen.stage({ uploads, promptText: text })
      if (staged.ok === false) return { ok: false, text: `❌ 上传/写入失败：${staged.error || '浏览器没连上'}` }
      await gen.shot(join(c.home, `stage-seg${segIndex}.png`))
      const attachRes = { attached: staged.attached ?? uploads.length }
      const fillRes = { draftLength: staged.draftLength ?? text.length }

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

      const gen = await genProvider(args)
      const before = pageState(await gen.status())
      if (!before) return { ok: false, text: '❌ 连不上豆包页面：先确认带调试端口的浏览器开着，再重试。' }
      if (before.generating) return { ok: false, text: '⏸ 正在生成中，不能再发。' }
      if (!before.draftText) return { ok: false, text: '❌ 输入框是空的：先跑 doubao_browser_stage。' }

      // 重试闸（2026-11-04）：同一段已经发过 N 次时，第 N+1 次要么是自动重试（配额内），
      // 要么必须本人说「确定重试」。自动重试上限默认 1 —— 每次重试都在烧额度。
      // 风控自保（2026-11-04）：日限额 + 随机间隔。机器人的固定节奏是封号的第一步。
      const q = checkQuota(c.home, {
        dailyLimit: c.dailyCallLimit, minGapSec: c.minGapSec, maxGapSec: c.maxGapSec,
      })
      if (!q.ok) return { ok: false, text: `⛔ ${q.reason}`, guard: { count: q.count, limit: q.limit } }
      if (q.waitMs && q.waitMs > 3000) {
        await new Promise((r) => setTimeout(r, Math.min(q.waitMs, 180000)))
      }

      const prevRetries = Number(pending.retries) || 0
      const alreadySent = !!pending.sentAt
      if (alreadySent && prevRetries > c.maxAutoRetries
          && !/确定重试/.test(String(args.confirmText || ''))) {
        return {
          ok: false,
          text: `⛔ 第 ${segment} 段已经发过 ${prevRetries + 1} 次（自动重试上限 ${c.maxAutoRetries}）。\n`
            + '再试一次要本人点头：confirmText 里写「确定重试」。\n'
            + '（每次重试都消耗额度，所以第 2 次起不再自动放行。）',
          retries: prevRetries,
        }
      }

      // 发送（内部会验"草稿真的空了"）+ 豆包追问时补一句确认，都在 provider.submit 里做完
      const sendRes = await gen.submit({ confirmAfterSend: args.confirmAfterSend })
      const after = pageState(await gen.status()) || { draftText: '' }

      if (!sendRes.ok) {
        // 没真发出去：不写 confirmedAt、不动草稿、不补发确认。
        // 这条是 2026-11-01 事故的直接修复（提示词被「确认生成视频」覆盖）。
        return {
          ok: false,
          text: `⛔ 没发出去（草稿还剩 ${String(after.draftText || '').length} 字，Enter 可能只换了行）。\n`
            + '现场已保留：状态没改、提示词没清。手动点一下发送键，或再跑一次 doubao_browser_send。',
          draftLeft: after.draftText || '',
          clickedSendButton: !!sendRes.clicked,
        }
      }

      pending.confirmedAt = new Date().toISOString()
      pending.sentAt = pending.confirmedAt
      pending.retries = prevRetries + 1
      try { commitCall(c.home) } catch { /* 记账失败不阻断发送 */ }
      pending.confirmText = String(args.confirmText).slice(0, 100)
      project.pending[String(segment)] = pending
      saveProject(c.home, slug, project)
      recordHistory(c.home, slug, { gate: 'G4.7-send', ok: true, summary: `seg${segment}` })

      // 豆包侧：每条生成都要一句「确认生成视频」（平台要求，和 QQ 那边的授权无关）。
      // 默认自动补发；显式传空字符串可以关掉。这一步在 provider.submit 里做完了。
      const confirmRes = sendRes.confirmText ? { text: sendRes.confirmText } : null

      return {
        ok: true,
        text: `📤 已发送 · 第 ${segment} 段（${pending.confirmedAt}）\n`
          + `发送前草稿：${before.draftText.length} 字\n`
          + (confirmRes
            ? (sendRes.confirmSent === false
              // 2026-11-04：补发确认失败必须说出来，否则用户以为在生成、其实豆包在等那句确认
              ? `⚠️ 补充发送失败：${sendRes.confirmError || confirmRes.text}\n   豆包可能还在等「确认生成视频」，请在页面上手动补一句。\n`
              : `补充发送：${confirmRes.text}\n`)
            : '')
          + (sendRes.generating === false
            ? '⚠️ 提示词已发出，但页面还没显示「生成中」——先看一眼是不是在等确认或撞了额度。\n'
            : '')
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
G1 脚本    ｜ 每段 ${cfg().minSegmentSeconds}–${cfg().maxSegmentSeconds}s（且不超所选模型上限）、每段 ≥${cfg().minShotsPerSegment} 分镜、12 字段写满、无占位符、表情≠感情、有台词不铺旁白、相邻段不重复 ｜ 打回，重做这一段
G2 角色卡  ｜ 名字在脚本里、kind=reference、有文件/外貌/服装 ｜ 打回；设定卡不得当参考图
G3 场景卡  ｜ 名字不带景别、画面里没人、有文件 ｜ 打回
G4 生成前  ｜ 风格锁 + 各角色参考图 + 场景卡 + 上一段尾帧齐备 ｜ 打回；齐了才吐提示词
G4.5 审计  ｜ 实际粘贴的文本必须带上全部 @、12 字段与脚本逐字一致、上传清单齐全 ｜ 打回；拿不到 auditHash
G4.6 确认  ｜ 本人明确说「确定生成视频」+ auditHash 对得上 ｜ 没有 → 不许生成
G5 片段    ｜ 时长 ${cfg().minSegmentSeconds}–${cfg().maxSegmentSeconds}s、尾帧取在段末、从确认到登记 ${cfg().genMinMinutes}–${cfg().genMaxMinutes} 分钟 ｜ 超 ${cfg().genMaxMinutes} 分钟 → 作废重来
G6 重试    ｜ 同一闸门最多 ${cfg().maxAttempts} 次；第 ${cfg().maxAttempts + 1} 次必须本人确认 ｜ 转人工`

      return {
        ok: true,
        text: '判定条件总表（与《大肥鱼豆包制作视频》v2 第 8 节一致）\n\n' + table
          + '\n\n补充口径：\n'
          + '- 模型：默认 Seedance 2.0 Mini（≤10s）· Fast（≤10s）· 2.0（需会员 ≤15s）· 2.5（需会员 ≤30s）；换模型必须本人指定\n- 一段 = 5–30 秒（受模型上限约束）= 一次豆包生成 = 一个独立片段；片段各自生成，**后期按段序拼接**\n'
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
