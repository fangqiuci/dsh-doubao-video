/**
 * lib/rules.mjs —— 《大肥鱼豆包制作视频》SOP 的判定引擎
 * ============================================================================
 * 这个文件**不碰磁盘、不碰网络、不认识 DSH**：只做纯函数校验，方便单独跑测试。
 * 判定口径全部来自 docs/大肥鱼豆包制作视频dsh.txt（v2）里的 Gate 编号，
 * 插件工具只是把这里的结果包一层返回。
 *
 * 设计原则（踩过的坑）：
 *   1. **能机检的才叫「必须通过」**。像"有没有用我给的提示词"这种要求，落不成字段就永远打回不了。
 *   2. 违规（violation）会阻断流程；可疑（warning）只提示，不阻断 —— 否则模型会被无意义的
 *      规则卡死，用户只会关插件。
 *   3. 每条违规都带 `where`（JSON 路径）和可执行的修法，模型照着改就行，不用来回猜。
 * ============================================================================
 */

/** 一个分镜必须写满的 12 个字段（顺序即输出顺序） */
export const SHOT_FIELDS = [
  '景别', '运镜', '主角', '动作', '台词', '旁白',
  '内心旁白', '表情细节', '感情细节', '音效', '光影', '场景',
]

/** 允许写「无」的三个字段：其它字段写「无」= 没写 */
export const MAY_BE_NONE = new Set(['旁白', '内心旁白', '台词'])

/**
 * 天生就该很短的字段：中景 / 固定 / 土屋 / 李观棋。
 * 对它们做「至少 4 个字」的检查只会制造噪音 —— 第一次自测就把 24 条合法景别全判成违规了。
 */
export const SHORT_BY_NATURE = new Set(['景别', '运镜', '主角', '场景'])

/** 合法景别（写别的会被当成场景名或提示词残留） */
export const SHOT_SIZES = [
  '大远景', '远景', '大全景', '全景', '中全景', '中景',
  '中近景', '近景', '特写', '大特写', '空镜',
]

/** 模板占位符：出现在成稿里 = 提示词被原样抄了，没落地成内容 */
const PLACEHOLDER_RES = [
  { re: /例如|示例|举例/, why: '模板里的「例如/示例」没删' },
  { re: /X{2,}/i, why: '还留着 XXX 占位' },
  { re: /【|】/, why: '还留着【】占位符' },
  { re: /待填|待补充|TODO|TBD/i, why: '还留着待填标记' },
  { re: /^\s*[<{].*[>}]\s*$/, why: '整段还是个尖括号占位' },
]

/** 图片扩展名 */
const IMG_RE = /\.(png|jpe?g|webp)$/i

/** 生成来源必须能追到豆包那次对话：https://www.doubao.com/chat/<数字> */
const SOURCE_RE = /doubao\.com\/chat\/\d+/

/** 新建一条违规 */
function violation(code, where, message) {
  return { code, where, message }
}

/** 新建一条提示（不阻断） */
function warning(code, where, message) {
  return { code, where, message }
}

/** 把「主角」字段拆成名字数组：支持 、，,/ 与空格分隔 */
export function splitNames(raw) {
  return String(raw || '')
    .split(/[、，,/／\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 「无」「没有」「none」都算空 */
export function isNone(raw) {
  const s = String(raw ?? '').trim()
  return s === '' || /^(无|没有|none|null|n\/a)$/i.test(s)
}

/** 场景名里不许出现景别 —— 否则同一间屋子会按景别裂成好几张场景卡 */
export function sceneNameHasShotSize(name) {
  const s = String(name || '')
  return SHOT_SIZES.some((size) => s.includes(size))
}

/* ───────────────────────── 第 1 节：脚本 ───────────────────────── */

/**
 * 校验一份分镜脚本。
 * @param {object} script 形如 { segments: [ { index, durationSeconds, styleRef, shots: [ {...12 字段} ] } ] }
 * @param {object} opts   { segmentSeconds, minShotsPerSegment, styleLockId }
 * @returns {{ ok: boolean, violations: object[], warnings: object[], counts: object }}
 */
export function checkScript(script, opts = {}) {
  const segmentSeconds = Number(opts.segmentSeconds ?? 10)
  const minSeg = Number(opts.minSegmentSeconds ?? 5)
  const maxSeg = Number(opts.maxSegmentSeconds ?? 30)
  const minShots = Number(opts.minShotsPerSegment ?? 3)
  const styleLockId = opts.styleLockId || null

  const violations = []
  const warnings = []
  const segments = Array.isArray(script?.segments) ? script.segments : []

  if (!segments.length) {
    violations.push(violation('E_NO_SEGMENTS', 'segments', '脚本里没有任何 segment（段）：至少要有 1 段，每段 10 秒'))
    return { ok: false, violations, warnings, counts: { segments: 0, shots: 0 } }
  }

  let shotCount = 0

  segments.forEach((seg, i) => {
    const at = `segments[${i}]`
    const shots = Array.isArray(seg?.shots) ? seg.shots : []

    // 段时长：全片统一 10 秒，是第 5 节「尾帧拖到 10 秒」成立的前提
    const dur = Number(seg?.durationSeconds)
    if (!Number.isFinite(dur) || dur < minSeg || dur > maxSeg) {
      violations.push(violation(
        'E_SEGMENT_DURATION', `${at}.durationSeconds`,
        `每段时长必须在 ${minSeg}–${maxSeg} 秒之间（建议 ${segmentSeconds} 秒），实际是 ${seg?.durationSeconds ?? '未填'}`,
      ))
    }

    // 每段最少 3 个分镜
    if (shots.length < minShots) {
      violations.push(violation(
        'E_TOO_FEW_SHOTS', `${at}.shots`,
        `每段至少 ${minShots} 个分镜，实际 ${shots.length} 个`,
      ))
    }

    // 风格必须是"引用"锁定值，不是各写各的
    if (styleLockId) {
      if (!seg?.styleRef) {
        violations.push(violation('E_NO_STYLE_REF', `${at}.styleRef`, `本段没写 styleRef，必须引用风格锁「${styleLockId}」`))
      } else if (String(seg.styleRef) !== String(styleLockId)) {
        violations.push(violation(
          'E_STYLE_MISMATCH', `${at}.styleRef`,
          `本段风格「${seg.styleRef}」与锁定的「${styleLockId}」不一致；全片只有一处风格定义`,
        ))
      }
    }

    shots.forEach((shot, j) => {
      shotCount += 1
      const wp = `${at}.shots[${j}]`

      for (const field of SHOT_FIELDS) {
        const raw = shot?.[field]

        if (raw === undefined || raw === null || String(raw).trim() === '') {
          violations.push(violation('E_FIELD_MISSING', `${wp}.${field}`, `缺字段或为空：「${field}」`))
          continue
        }

        const text = String(raw).trim()

        // 「无」只在这三个字段合法
        if (isNone(text) && !MAY_BE_NONE.has(field)) {
          violations.push(violation(
            'E_FIELD_NONE', `${wp}.${field}`,
            `「${field}」不能写「无」—— 只有 旁白 / 内心旁白 / 台词 允许留空写「无」`,
          ))
          continue
        }

        // 模板占位符没删
        for (const { re, why } of PLACEHOLDER_RES) {
          if (re.test(text)) {
            violations.push(violation('E_PLACEHOLDER', `${wp}.${field}`, `${why}：「${field}」= ${text.slice(0, 40)}`))
            break
          }
        }

        // 描述性字段得有实义（短于 4 个字基本是敷衍）；景别/运镜/主角/场景 本来就可以很短。
        // 台词例外：人说的话本来就短（"烧完了""在""草"），2 个字起放行，2~3 字只提示不拦
        // （2026-10-31 修 #8：真实跑的时候「烧完了」被 E_TOO_SHORT 挡了，但那是合理台词）。
        if (!SHORT_BY_NATURE.has(field) && !isNone(text)) {
          const minLen = field === '台词' ? 2 : 4
          if (text.length < minLen) {
            violations.push(violation(
              'E_TOO_SHORT', `${wp}.${field}`,
              `「${field}」只有 ${text.length} 个字，写不出可拍的画面：${text}`,
            ))
          } else if (field === '台词' && text.length < 4) {
            warnings.push(warning(
              'W_DIALOGUE_SHORT', `${wp}.${field}`,
              `「台词」只有 ${text.length} 个字（${text}）：可以是合理的短促回应，确认不是漏写就行`,
            ))
          }
        }
      }

      // 表情细节 ≠ 感情细节（原模板两处例子一模一样，模型会分不清）
      const face = String(shot?.['表情细节'] ?? '').trim()
      const feel = String(shot?.['感情细节'] ?? '').trim()
      if (face && feel && face === feel) {
        violations.push(violation(
          'E_EMOTION_DUPLICATE', `${wp}`,
          '「表情细节」和「感情细节」写成了同一段话：前者写看得见的生理反应（瞳孔/肩膀/手），后者写看不见的内心与取舍',
        ))
      }

      // 人物说话优先级最高：有台词就不该再铺旁白
      const hasLine = !isNone(shot?.['台词'])
      const hasNarr = !isNone(shot?.['旁白'])
      if (hasLine && hasNarr) {
        violations.push(violation(
          'E_PRIORITY_CONFLICT', `${wp}`,
          '同一个分镜里既有「台词」又有「旁白」：优先级是 人物说话 ＞ 旁白 ＞ 内心旁白，有台词时旁白应写「无」',
        ))
      }

      // 台词格式：角色名：内容
      if (hasLine) {
        const line = String(shot['台词']).trim()
        if (!/^[^：:]{1,16}[：:]/.test(line)) {
          warnings.push(warning(
            'W_DIALOGUE_FORMAT', `${wp}.台词`,
            '台词建议写成「角色名：内容」，豆包更容易把这句话派给对的人',
          ))
        }
      }

      // 景别用词
      const size = String(shot?.['景别'] ?? '').trim()
      if (size && !SHOT_SIZES.includes(size)) {
        warnings.push(warning(
          'W_SHOT_SIZE', `${wp}.景别`,
          `「${size}」不在常用景别里（${SHOT_SIZES.join('/')}），豆包可能按场景名理解`,
        ))
      }

      // 10 秒里硬切太多次，实际生成必崩
      const cuts = (String(shot?.['运镜'] ?? '').match(/切/g) || []).length
      if (cuts > 2) {
        warnings.push(warning('W_TOO_MANY_CUTS', `${wp}.运镜`, `运镜里出现 ${cuts} 次「切」：10 秒内硬切超过 2 次，模型基本接不住`))
      }

      // 场景名混进景别
      const scene = String(shot?.['场景'] ?? '').trim()
      if (scene && sceneNameHasShotSize(scene)) {
        violations.push(violation(
          'E_SCENE_WITH_SHOT_SIZE', `${wp}.场景`,
          `场景名「${scene}」里带了景别：场景只写地点（土屋），景别写在「景别」字段，否则同一场景会裂成好几张卡`,
        ))
      }
    })
  })

  // 相邻两段不许逐字重复（第 5 节的例子曾经把片段 2 写成了片段 1 的复制）
  for (let i = 1; i < segments.length; i += 1) {
    const prev = segments[i - 1]?.shots
    const cur = segments[i]?.shots
    const a = Array.isArray(prev) ? prev[prev.length - 1] : null
    const b = Array.isArray(cur) ? cur[0] : null
    if (!a || !b) continue
    const same = ['动作', '台词', '表情细节', '感情细节'].every(
      (f) => String(a[f] ?? '').trim() === String(b[f] ?? '').trim(),
    )
    if (same) {
      violations.push(violation(
        'E_SEGMENT_DUPLICATE', `segments[${i}].shots[0]`,
        `第 ${i} 段开头与第 ${i - 1} 段结尾逐字相同：片段 2 必须是片段 1 的**延续**，不是重演`,
      ))
    }
  }

  // 一段多句台词 —— 硬约束（2026-11-04 真机实测 + 修复同学复核）。
  //
  // 事实：film27 每段写 3 句台词，豆包**只念 shot 0 的那一句**，其余 4 句完全没声音。
  // 但光说"只念第一句"还不够 —— 物理上也塞不下：一句中文台词连停顿约 2.5 秒，
  // 8 秒片段最多放 2 句（还要留画面呼吸）。所以这里**按段长算账**，塞不下直接拒，
  // 而不是让用户写完、生成完、才发现一半台词是哑的。
  const secPerLine = Number(opts.secondsPerLine ?? 2.5)      // 一句台词连停顿约占几秒
  const usableRatio = Number(opts.usableRatio ?? 0.8)        // 段长里能拿来念白的比例
  for (const seg of segments) {
    const dur = Number(seg.durationSeconds) || 0
    const spoken = (seg.shots || [])
      .map((s) => String(s?.台词 ?? '').trim())
      .filter((v) => v && v !== '无')
    if (!spoken.length || dur <= 0) continue
    const capacity = Math.max(1, Math.floor((dur * usableRatio) / secPerLine))
    if (spoken.length > capacity) {
      violations.push(violation(
        'E_TOO_MANY_LINES',
        `segments[${Number(seg.index) - 1}].台词`,
        `这一段 ${dur} 秒要念 ${spoken.length} 句台词，但一句连停顿约 ${secPerLine} 秒，`
          + `最多只放得下 ${capacity} 句（而且豆包每段只念第一句）。`
          + '拆成多段，或用 doubao_dub 后期配音；不再说的台词改成「无」。',
      ))
    } else if (spoken.length > 1) {
      warnings.push(warning(
        'W_MULTI_LINES',
        `segments[${Number(seg.index) - 1}].台词`,
        `这一段有 ${spoken.length} 句台词，容量够（${capacity} 句），但豆包每段只念第一句；`
          + '想两句都出声，请拆段或后期用 doubao_dub 重配。',
      ))
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    warnings,
    counts: { segments: segments.length, shots: shotCount },
  }
}

/** 从脚本里收集「剧本事实」：出场角色名、场景名、台词人物 */
export function collectEntities(script) {
  const roles = new Set()
  const scenes = new Set()
  for (const seg of script?.segments || []) {
    for (const shot of seg?.shots || []) {
      for (const n of splitNames(shot?.['主角'])) roles.add(n)
      const scene = String(shot?.['场景'] ?? '').trim()
      if (scene) scenes.add(scene)
      const line = String(shot?.['台词'] ?? '').trim()
      const m = /^([^：:]{1,16})[：:]/.exec(line)
      if (m) roles.add(m[1].trim())
    }
  }
  return { roles: [...roles], scenes: [...scenes] }
}

/* ───────────────────────── 第 2 节：角色卡 ───────────────────────── */

/**
 * 校验一张角色登记。
 * @param {object} role  { name, kind, file, appearance, outfit }
 * @param {object} ctx   { scriptRoles: string[], strict: boolean }
 */
export function checkRole(role, ctx = {}) {
  const violations = []
  const warnings = []
  const name = String(role?.name || '').trim()

  if (!name) violations.push(violation('E_ROLE_NAME', 'name', '角色必须有名字，且要和脚本「主角」字段一字不差'))

  if (ctx.scriptRoles?.length && name && !ctx.scriptRoles.includes(name)) {
    violations.push(violation(
      'E_ROLE_NOT_IN_SCRIPT', 'name',
      `「${name}」不在已通过的脚本里（脚本角色：${ctx.scriptRoles.join('、')}）—— 角色卡必须从脚本里长出来`,
    ))
  }

  // 设定卡是给人看的排版图，直接当参考图喂给视频模型会把版面文字学进画面
  if (String(role?.kind || '') !== 'reference') {
    violations.push(violation(
      'E_SETTING_CARD_AS_REF', 'kind',
      '用于视频的必须是 kind=reference 的干净参考图（白底/单人/无文字/无分割线）；杂志风设定卡只能给人看，不能当参考图',
    ))
  }

  /**
   * 2026-10-31 起：**角色卡（三视图）+ 参考图两件都要**。
   * 起因：真实跑出来的角色"参考图"其实是代码画的占位符（1024×1024 只有 13KB，
   * 底部还印着 PLACEHOLDER），豆包照着它生成，脸完全是自由发挥。
   * 只校验"有没有传文件"是拦不住这种东西的。
   */
  const card = String(role?.cardImage || '').trim()
  if (!card) {
    violations.push(violation(
      'E_ROLE_NO_CARD', 'cardImage',
      '缺三视图设定卡（正面/侧面/背面全身）：没有它，视频里那张脸就是豆包自由发挥出来的',
    ))
  } else if (!IMG_RE.test(card)) {
    violations.push(violation('E_ROLE_CARD_EXT', 'cardImage', `设定卡必须是 png/jpg/webp：${card}`))
  }

  const file = String(role?.reference || role?.file || '').trim()
  if (!file) violations.push(violation('E_ROLE_FILE', 'reference', '缺参考图文件路径'))
  else if (!IMG_RE.test(file)) violations.push(violation('E_ROLE_FILE_EXT', 'reference', `参考图必须是 png/jpg/webp：${file}`))

  // 设定卡和参考图不能是同一个文件 —— 那样等于只交了一样
  if (card && file && card.toLowerCase() === file.toLowerCase()) {
    violations.push(violation(
      'E_ROLE_SAME_FILE', 'cardImage',
      '三视图和参考图填了同一个文件：设定卡是给人看的三视图，参考图是给模型的干净图，必须两张',
    ))
  }

  // 来源：强制要求写清楚这张卡是"生成"出来的，不是随手找的
  const source = String(role?.source || '').trim()
  if (!SOURCE_RE.test(source)) {
    violations.push(violation(
      'E_ROLE_SOURCE', 'source',
      '生成来源必须写豆包对话链接（形如 https://www.doubao.com/chat/38450589868511234）：只写文字说明证明不了这张卡是生成出来的',
    ))
  }

  const look = String(role?.appearance || '').trim()
  if (look.length < 8) {
    violations.push(violation('E_ROLE_APPEARANCE', 'appearance', '外貌描述太短：发色/发型/五官/体型/年龄至少写全，否则每张卡长成两个人'))
  }

  const outfit = String(role?.outfit || '').trim()
  if (!outfit) violations.push(violation('E_ROLE_OUTFIT', 'outfit', '缺服装：服装必须来自脚本，不能靠模型的默认值'))

  return { ok: violations.length === 0, violations, warnings }
}

/* ───────────────────────── 第 3 节：场景 ───────────────────────── */

/**
 * 校验一张场景登记。
 * @param {object} scene { name, file, characters }
 * @param {object} ctx   { scriptScenes: string[] }
 */
export function checkScene(scene, ctx = {}) {
  const violations = []
  const warnings = []
  const name = String(scene?.name || '').trim()

  if (!name) violations.push(violation('E_SCENE_NAME', 'name', '场景必须有名字'))

  if (sceneNameHasShotSize(name)) {
    violations.push(violation(
      'E_SCENE_WITH_SHOT_SIZE', 'name',
      `场景名「${name}」里带了景别：只写地点（土屋 / 赵府后门），景别在分镜里单独写`,
    ))
  }

  if (ctx.scriptScenes?.length && name && !ctx.scriptScenes.includes(name)) {
    violations.push(violation(
      'E_SCENE_NOT_IN_SCRIPT', 'name',
      `「${name}」不在已通过的脚本里（脚本场景：${ctx.scriptScenes.join('、')}）`,
    ))
  }

  const chars = Array.isArray(scene?.characters) ? scene.characters.filter(Boolean) : []
  if (chars.length) {
    violations.push(violation(
      'E_SCENE_HAS_CHARACTER', 'characters',
      `场景卡里不许有人物（第 3 节附加要求）：现在登记了 ${chars.join('、')}`,
    ))
  }

  const file = String(scene?.file || '').trim()
  if (!file) violations.push(violation('E_SCENE_FILE', 'file', '缺场景图文件路径'))
  else if (!IMG_RE.test(file)) violations.push(violation('E_SCENE_FILE_EXT', 'file', `场景图必须是 png/jpg/webp：${file}`))

  // 场景图也必须能溯源到"生成"，不能随便拿一张图顶上
  const source = String(scene?.source || '').trim()
  if (!SOURCE_RE.test(source)) {
    violations.push(violation(
      'E_SCENE_SOURCE', 'source',
      '生成来源必须写豆包对话链接（形如 https://www.doubao.com/chat/38450589868511234）：场景必须真在这个对话里生成过',
    ))
  }

  return { ok: violations.length === 0, violations, warnings }
}

/* ───────────────────────── 第 4 节：生成前 ───────────────────────── */

/**
 * 生成前的三件套检查：风格锁 + 角色参考图 + 场景卡 + 上一段尾帧。
 * @param {object} shot 分镜对象
 * @param {object} ctx  { styleLock, roles: Map, scenes: Map, clips: {}, segIndex }
 */
export function checkVideo(shot, ctx = {}) {
  const violations = []
  const warnings = []

  if (!ctx.styleLock) {
    violations.push(violation('E_NO_STYLE_LOCK', 'styleLock', '还没有锁定全片风格（先跑 doubao_style_lock），生成出来一定前后不是一个片子'))
  }

  const roles = ctx.roles || new Map()
  const scenes = ctx.scenes || new Map()
  const names = splitNames(shot?.['主角'])

  if (!names.length) violations.push(violation('E_NO_ACTOR', '主角', '这个分镜没写主角'))

  for (const n of names) {
    const role = roles.get(n)
    if (!role) {
      violations.push(violation('E_ROLE_MISSING', `主角.${n}`, `角色「${n}」还没登记参考图（先跑 doubao_role_register）`))
    } else if (role.kind !== 'reference') {
      violations.push(violation('E_ROLE_NOT_REF', `主角.${n}`, `角色「${n}」登记的还不是干净参考图（kind=${role.kind}）`))
    } else if (!role.cardImage) {
      // 老项目（2026-10-31 之前登记的）没有三视图字段 —— 显式挡住，
      // 免得占位图一路滑到生成环节（真实事故就是这么来的）。
      violations.push(violation(
        'E_ROLE_NO_CARD', `主角.${n}`,
        `角色「${n}」没有三视图设定卡：按新规必须重新 doubao_role_register（cardImage + reference + source）`,
      ))
    }
  }

  const sceneName = String(shot?.['场景'] ?? '').trim()
  if (!sceneName) {
    violations.push(violation('E_NO_SCENE', '场景', '这个分镜没写场景'))
  } else if (!scenes.get(sceneName)) {
    violations.push(violation('E_SCENE_MISSING', `场景.${sceneName}`, `场景「${sceneName}」还没登记（先跑 doubao_scene_register）`))
  }

  // 第 2 段起必须有上一段的尾帧
  if (Number(ctx.segIndex) > 1) {
    const prev = (ctx.clips || {})[Number(ctx.segIndex) - 1]
    if (!prev) {
      violations.push(violation('E_NO_PREV_CLIP', `clips.${Number(ctx.segIndex) - 1}`, `第 ${Number(ctx.segIndex) - 1} 段还没登记成片，没法取尾帧接首帧`))
    } else if (!prev.tailFrame) {
      violations.push(violation('E_NO_TAIL_FRAME', `clips.${Number(ctx.segIndex) - 1}.tailFrame`, `第 ${Number(ctx.segIndex) - 1} 段还没登记尾帧截图（doubao_clip_register）`))
    }
  }

  // 主角数量与参考图数量对不上时提醒（多图不等于对）
  if (names.length > 3) {
    warnings.push(warning('W_MANY_ROLES', '主角', `一个镜头里塞了 ${names.length} 个角色，豆包很难同时控住这么多脸：`
        + '建议改成过肩镜头（一人背面+一人正面）、两人同框、其余角色用画外音/局部入画，别硬塞三张正脸'))
  }

  return { ok: violations.length === 0, violations, warnings }
}

/* ───────────────────────── 第 5 节：首尾帧 ───────────────────────── */

/**
 * 校验一次片段登记。
 * @param {object} clip { segment, file, durationSeconds, tailFrame, tailTimeSeconds }
 * @param {object} ctx  { segmentSeconds, expectedSegment }
 */
export function checkClip(clip, ctx = {}) {
  const violations = []
  const warnings = []
  const segmentSeconds = Number(ctx.segmentSeconds ?? 10)
  const minSeg = Number(ctx.minSegmentSeconds ?? 5)
  const maxSeg = Number(ctx.maxSegmentSeconds ?? 30)

  const seg = Number(clip?.segment)
  if (!Number.isInteger(seg) || seg < 1) {
    violations.push(violation('E_CLIP_SEGMENT', 'segment', 'segment 必须是从 1 开始的整数（第几段）'))
  }

  const file = String(clip?.file || '').trim()
  if (!file) {
    violations.push(violation('E_CLIP_FILE', 'file', '缺成片文件路径'))
  } else if (!/\.(mp4|mov|webm|mkv)$/i.test(file)) {
    violations.push(violation('E_CLIP_FILE_EXT', 'file', `成片必须是视频文件：${file}`))
  }

  const dur = Number(clip?.durationSeconds)
  if (!Number.isFinite(dur) || dur < minSeg || dur > maxSeg) {
    violations.push(violation(
      'E_CLIP_DURATION', 'durationSeconds',
      `成片时长必须在 ${minSeg}–${maxSeg} 秒之间，实际 ${clip?.durationSeconds ?? '未填'}：太短读不出信息，太长豆包单次生成撑不住`,
    ))
  }

  const tailFrame = String(clip?.tailFrame || '').trim()
  if (!tailFrame) {
    violations.push(violation('E_CLIP_TAIL', 'tailFrame', '缺尾帧截图：下一段的首帧就靠它'))
  } else if (!IMG_RE.test(tailFrame)) {
    violations.push(violation('E_CLIP_TAIL_EXT', 'tailFrame', `尾帧必须是图片：${tailFrame}`))
  }

  // 尾帧必须取在片段末尾，不是随便拖到某一秒
  const tailTime = Number(clip?.tailTimeSeconds)
  if (Number.isFinite(tailTime) && seg) {
    const expectTail = Number.isFinite(dur) && dur > 0 ? dur : segmentSeconds
    const delta = Math.abs(tailTime - expectTail)
    if (delta > 0.25) {
      violations.push(violation(
        'E_TAIL_TIME', 'tailTimeSeconds',
        `尾帧取在 ${tailTime}s，但这一段是 ${expectTail}s：必须取最后一帧（约 ${expectTail}s 处），否则下一段会跳`,
      ))
    }
  }

  return { ok: violations.length === 0, violations, warnings }
}

/* ───────────────────────── 生成确认与耗时窗口 ───────────────────────── */

/**
 * 校验一条片段的生成耗时。
 *
 * 口径（本人 2026-10-31 定）：一条 10 秒片段的生成 + 验收，正常落在 5–10 分钟。
 *   超过 10 分钟 = 不正常（卡住 / 排队 / 拿错片），这一段作废重来。
 *   不足 5 分钟 = 提示（可能是旧片顶替），不阻断。
 *
 * @param {number} elapsedMinutes 从「确定生成视频」确认到登记成片的分钟数
 * @param {object} opts { minMinutes, maxMinutes }
 */
export function checkGenerateWindow(elapsedMinutes, opts = {}) {
  const minMinutes = Number(opts.minMinutes ?? 5)
  const maxMinutes = Number(opts.maxMinutes ?? 10)
  const violations = []
  const warnings = []

  if (!Number.isFinite(elapsedMinutes) || elapsedMinutes < 0) {
    violations.push(violation(
      'E_NO_START_TIME', 'pending.confirmedAt',
      '这一段没有「确定生成视频」的确认记录，没法计时：先让本人确认，再生成',
    ))
    return { ok: false, violations, warnings }
  }

  if (elapsedMinutes > maxMinutes) {
    violations.push(violation(
      'E_GEN_TOO_LONG', 'elapsedMinutes',
      `耗时 ${elapsedMinutes.toFixed(1)} 分钟，超过 ${maxMinutes} 分钟上限：按判定属于不正常（卡住/排队/拿错片），这一段作废重来`,
    ))
  }

  if (elapsedMinutes < minMinutes) {
    warnings.push(warning(
      'W_GEN_TOO_FAST', 'elapsedMinutes',
      `只用了 ${elapsedMinutes.toFixed(1)} 分钟，短于正常的 ${minMinutes} 分钟：确认一下不是拿旧片或别的片段顶替`,
    ))
  }

  return { ok: violations.length === 0, violations, warnings }
}

/* ───────────────────────── 提示词组装 ───────────────────────── */

const CONTINUITY_BLOCK = (n) => [
  `参考图是片段 ${n} 的最后一帧。片段 ${n + 1} 必须从这一帧开始连续播放。`,
  '首帧严格保持参考图中的同一人物、同一脸部特征、同一发型、同一服装、同一身体比例、同一站位、同一姿态、同一镜头角度、同一背景、同一光线。',
  '起始表情与参考图一致，随后按本段动作自然演进（不是定格起手）。',
  '人物动作必须自然延续，不能原地重启，不能回弹。',
  '镜头保持稳定，不突然推拉，不改变机位，不跳轴。',
  '不改变人物身份，不改变服装细节，不改变场景布局。',
].join('\n')

/** 文件名去目录、去扩展名 —— 这就是 @ 后面该写的东西 */
export function mentionToken(file) {
  const base = String(file || '').replace(/^.*[\\/]/, '')
  return base.replace(/\.[^.]+$/, '')
}

/**
 * 组装一段可以直接粘进豆包的提示词。
 * @param {object} shot 分镜
 * @param {object} ctx { segIndex, roles: Map, scenes: Map, clips }
 * @returns {string}
 */
/**
 * 全片风格锁 → 提示词尾块（2026-11-03 新增）。
 * 风格锁原来只存在 project.styleLock 里，提示词里一个字都没有 ——
 * 豆包每段自由发挥，观众看到的是"同一部片子四种画风"。
 */
/**
 * 全片统一设定 → 提示词尾块（2026-11-03 新增，2026-11-04 改灵活）。
 *
 * 设计原则：**这里只负责把用户填的东西原样摆出来，不替用户规定风格**。
 *   · 字段全空 → 返回空串，提示词里一个字都不加（做别的题材时没有负担）
 *   · mode='soft'（默认）→ 收尾是"保持一致"，留了余地
 *   · mode='strict'      → 收尾是"不得改变"，适合系列片
 *   · mode='off'         → 整块不出现
 *   · extra  → 想加什么字段都行，比如 { 画风: '国风水墨', 参考年代: '1980s' }
 *   · custom → 整段自由文本，原样附在最后
 *   · title  → 想改标题就改，默认「全片统一设定」
 */
export function styleBlock(styleLock, { mode = 'soft' } = {}) {
  if (!styleLock || mode === 'off') return ''
  const rows = []
  const push = (k, v) => {
    const s = Array.isArray(v) ? v.filter(Boolean).join('、') : v
    if (s && String(s).trim()) rows.push(`${k}：${String(s).trim()}`)
  }

  push('美术风格', styleLock.artStyle)
  push('色调', styleLock.palette)
  push('材质', styleLock.material)
  push('镜头语言', styleLock.lens)
  push('禁止', styleLock.forbidden)

  // 人物占幅与比例（2026-11-04 新增）：昨晚真机出现人物被压扁/拉长/变形。
  // 豆包会按参考图自由缩放人物，不写死"占画面多高"，同一段里人忽大忽小。
  push('人物比例', styleLock.characterScale)
  push('构图', styleLock.framing)

  // 用户自定义字段：键值随便写
  for (const [k, v] of Object.entries(styleLock.extra || {})) push(k, v)

  if (!rows.length) return ''

  const title = String(styleLock.title || '').trim() || '全片统一设定'
  const closing = mode === 'strict'
    ? '以上设定全片一致，不得自行改变。'
    : '以上为本片统一设定，请与前后片段保持一致；确有必要的变化，请在字段里写明。'

  const lines = [`—— ${title} ——`, ...rows]
  // 防变形：只在明确要求锁比例时加，避免给不需要的题材塞多余约束
  if (styleLock.characterScale && styleLock.antiDeform !== false) {
    lines.push('人物必须保持固定头身比与四肢比例：不得横向拉伸或压缩，不得改变脸型与五官位置，不得出现多指、断肢、肢体粘连或身体扭曲。')
  }
  lines.push(closing)
  if (styleLock.custom && String(styleLock.custom).trim()) lines.push(String(styleLock.custom).trim())
  return lines.join('\n')
}

export function buildShotPrompt(shot, ctx = {}) {
  const segIndex = Number(ctx.segIndex || 1)
  const roles = ctx.roles || new Map()
  const scenes = ctx.scenes || new Map()
  const parts = []

  // ① @ 引用：场景在前、角色在后（跟原文例子一致）
  const tokens = []
  const sceneName = String(shot?.['场景'] ?? '').trim()
  const scene = scenes.get(sceneName)
  if (scene) tokens.push(`@${mentionToken(scene.file)}=${scene.name}（对应场景图片）`)

  for (const n of splitNames(shot?.['主角'])) {
    const role = roles.get(n)
    if (role) tokens.push(`@${mentionToken(role.reference || role.file)}=${role.name}（对应人物角色卡）`)
  }

  // ② 第二段起：上一段尾帧作为固定首帧
  const prev = (ctx.clips || {})[segIndex - 1]
  if (segIndex > 1 && prev?.tailFrame) {
    tokens.push(`@${mentionToken(prev.tailFrame)}=参考图（=片段 ${segIndex - 1} 的尾帧截图）`)
  }

  if (tokens.length) parts.push(tokens.join(''), '')

  // ③ 连续性约束
  if (segIndex > 1 && prev?.tailFrame) parts.push(CONTINUITY_BLOCK(segIndex - 1), '')

  // ③.5 生成参数：不写豆包就自己猜（2026-10-31 实测：没写时长它默认 15 秒、画幅按参考图走）。
  //     这几行必须进提示词，否则每段都要人工补一句"10 秒 / 9:16"。
  //     2026-11-02 追加模型行：豆包页面没有模型下拉框，只在插件里记一个名字平台并不知道，
  //     真机实测「切到 Fast」但平台两次都用了 Mini —— 必须在提示词里点名。
  const duration = Number(shot?.durationSeconds ?? ctx.durationSeconds ?? 0) || 0
  const aspect = String(ctx.aspectRatio ?? '').trim()
  const modelName = String(ctx.modelName ?? '').trim()
  const params = []
  if (duration > 0) params.push(`时长：${duration} 秒`)
  if (aspect) params.push(`画幅：${aspect} 竖屏`)
  if (modelName) params.push(`模型：${modelName}`)
  if (params.length) parts.push(params.join('，'), '')

  // ④ 12 个字段，原样照抄（这里不做改写，改写在提交脚本时就该做完）
  for (const field of SHOT_FIELDS) {
    parts.push(`${field}：${String(shot?.[field] ?? '无').trim()}`)
  }

  // 全片风格锁：写在最后，权重压过前面的描述
  const sb = styleBlock(ctx.styleLock, { mode: ctx.styleBlockMode })
  if (sb) parts.push('', sb)

  return parts.join('\n').trim()
}

/* ───────────────────────── 提示词审计 ───────────────────────── */

/**
 * 审计「真正要粘进豆包的那段文字」。
 *
 * 为什么需要它（2026-10-31 真实跑出来的问题）：插件这边 G0–G4 全 PASS，
 * 但去豆包操作的那一步只粘了文字 —— 图没上传，@ 也没写，结果 @辞辞 指向不存在的图。
 * 闸门全过、成片全废。所以必须有一道**对着最终文本**的检查：
 *   · 每个角色、场景都要有 `@文件名=名字`（文件真上传了才可能有）
 *   · 12 个字段必须与已通过的脚本逐字一致（改一个字就说明是手搓的）
 *   · 不许有模板占位
 *
 * @param {object} shot  脚本里的那个分镜
 * @param {string} text  即将粘贴的完整文本
 * @param {object} ctx   { roles: Map, scenes: Map, clips, segIndex }
 */
export function auditPrompt(shot, text, ctx = {}) {
  const violations = []
  const warnings = []
  const body = String(text ?? '')
  const roles = ctx.roles || new Map()
  const scenes = ctx.scenes || new Map()

  if (!body.trim()) {
    violations.push(violation('E_PROMPT_EMPTY', 'promptText', '没有收到要粘贴的文本'))
    return { ok: false, violations, warnings }
  }

  // ① 场景 @
  const sceneName = String(shot?.['场景'] ?? '').trim()
  const scene = scenes.get(sceneName)
  if (scene) {
    const token = `@${mentionToken(scene.file)}=${scene.name}`
    if (!body.includes(token)) {
      violations.push(violation(
        'E_MISSING_SCENE_MENTION', '@场景',
        `缺少「${token}」：要么场景图没上传，要么 @ 没写。豆包认不出图，就会把它当普通背景自由发挥`,
      ))
    }
  }

  // ② 角色 @
  for (const n of splitNames(shot?.['主角'])) {
    const role = roles.get(n)
    if (!role) continue
    const token = `@${mentionToken(role.reference || role.file)}=${role.name}`
    if (!body.includes(token)) {
      violations.push(violation(
        'E_MISSING_ROLE_MENTION', `@${n}`,
        `缺少「${token}」：角色参考图没上传或 @ 没写，生成的就不是这个人`,
      ))
    }
  }

  // ③ 上一段尾帧 @（第 2 段起）
  const segIndex = Number(ctx.segIndex || 1)
  const prev = (ctx.clips || {})[segIndex - 1]
  if (segIndex > 1 && prev?.tailFrame) {
    const token = `@${mentionToken(prev.tailFrame)}=参考图`
    if (!body.includes(token)) {
      violations.push(violation(
        'E_MISSING_TAIL_MENTION', '@参考图',
        `缺少「${token}」：上一段尾帧没挂上去，首帧衔接就是空的`,
      ))
    }
  }

  // ④ 12 个字段逐字比对
  for (const field of SHOT_FIELDS) {
    const want = String(shot?.[field] ?? '').trim()
    if (!want) continue
    if (!body.includes(`${field}：${want}`)) {
      violations.push(violation(
        'E_FIELD_MISMATCH', field,
        `「${field}」与已通过的脚本不一致或缺失 —— 这说明提示词是手搓的，不是 doubao_shot_check 给的`,
      ))
    }
  }

  // ⑤ 占位残留
  for (const { re, why } of PLACEHOLDER_RES) {
    if (re.test(body)) {
      violations.push(violation('E_PLACEHOLDER', 'promptText', `${why}：粘贴的文本里还有模板痕迹`))
      break
    }
  }

  return { ok: violations.length === 0, violations, warnings }
}

/**
 * 核对「上传了哪几张」。
 * @param {string[]} required 必须有文件的绝对路径（角色参考图 + 场景卡 + 尾帧）
 * @param {string[]} uploaded 调用方报上来的已上传文件
 */
export function auditUploads(required, uploaded) {
  const violations = []
  const warnings = []
  const norm = (p) => String(p || '').replace(/^.*[\\/]/, '').toLowerCase()
  const have = new Set((Array.isArray(uploaded) ? uploaded : []).map(norm))
  for (const req of required || []) {
    if (!req) continue
    if (!have.has(norm(req))) {
      violations.push(violation(
        'E_NOT_UPLOADED', norm(req),
        `「${norm(req)}」没有在已上传清单里：豆包没这张图，@ 写对了也没用`,
      ))
    }
  }
  return { ok: violations.length === 0, violations, warnings }
}
