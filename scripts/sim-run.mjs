/**
 * scripts/sim-run.mjs —— 用「磁盘上的新代码」跑一遍完整流程（不依赖 DSH 进程里的旧模块）
 * ---------------------------------------------------------------------------
 * 目的：DSH 不热重载这个插件，所以用这个脚本直接调 lib/* 的新实现，验证 8 条修复：
 *   #5 提示词自带时长/画幅 · #8 短台词 · #7 生成窗口下限
 *   #1/#3/#4 卡片识别 + 新片判定 · #11 签名过期重试 · #2 尾帧落盘校验
 *
 * 用法：node scripts/sim-run.mjs --live     # 全流程（会真的生成一段，花额度）
 *       node scripts/sim-run.mjs            # 默认 dry：只到"写进输入框"为止，不发送、不花额度
 *       node scripts/sim-run.mjs --live --home D:\tmp\sim   # 指定状态目录（留样用）
 *       node scripts/sim-run.mjs --live --keep              # 临时目录跑完不删
 *
 * 安全默认（2026-10-31 主作者提，已采纳）：
 *   1. 默认 dry，真生成必须显式写 --live（以前默认就发送，误敲一次就烧一次额度）。
 *   2. 默认写**临时状态目录**（跟 smoke.mjs 一样用 mkdtemp），跑完自动删。
 *      不隔离的话，测试会直接往正式状态目录写 projects/sim-run.json、clips/*.mp4，
 *      slug 一旦撞上真项目（比如 run-30s）就会把交付状态覆盖掉。
 *      真要留样：加 --home <目录>（写到指定位置），或 --keep（保留临时目录）。
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, existsSync, statSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { defaultHome, emptyProject, saveProject, toMap } from '../lib/store.mjs'
import {
  checkScript, checkRole, checkScene, checkVideo, buildShotPrompt,
  auditPrompt, checkClip, checkGenerateWindow,
} from '../lib/rules.mjs'
import * as b from '../lib/browser.mjs'
import * as f from '../lib/ffmpeg.mjs'

const argv = process.argv.slice(2)
const DRY = !argv.includes('--live')
const KEEP = argv.includes('--keep')
const homeFlagIdx = argv.indexOf('--home')
const explicitHome = homeFlagIdx >= 0 ? argv[homeFlagIdx + 1] : null
// 没给 --home 就用临时目录：跑完删掉，绝不碰正式状态
const home = explicitHome || mkdtempSync(join(tmpdir(), 'doubao-video-sim-'))
const isTempHome = !explicitHome
const slug = 'sim-run'
// 素材目录跟状态目录同源，不写死本机路径（发布体检要求）
const assets = join(defaultHome(), 'assets')
const clipsDir = join(home, 'clips')
mkdirSync(clipsDir, { recursive: true })

// 临时目录的清理：正常退出、异常退出都要清（--keep 除外）
process.on('exit', () => {
  if (!isTempHome || KEEP) return
  try { rmSync(home, { recursive: true, force: true }) } catch { /* 清不掉就算了 */ }
})

const log = (...a) => console.log(...a)
const gate = (name, r) => {
  const ok = r.ok
  log(`\n${ok ? '✅' : '❌'} ${name}`, ok ? '' : `\n   ${r.violations.map((v) => `[${v.code}] ${v.where}: ${v.message}`).join('\n   ')}`)
  if (r.warnings?.length) r.warnings.forEach((w) => log(`   ⚠️ [${w.code}] ${w.message}`))
  return ok
}

/* ── 0. 状态 ─────────────────────────────────────────────── */
const project = emptyProject(slug)
project.styleLock = {
  id: 'SL-1',
  artStyle: '3D 动漫（非写实），日系 Q 版三头身',
  palette: '夜戏冷蓝主调 + 台灯暖黄点缀，低饱和',
  material: 'PBR 哑光，布料细密绒毛感',
  lens: '固定机位 + 缓慢推近',
  forbidden: '真人质感,字幕水印,夸张光效',
  aspectRatio: '9:16',
}

const shot = {
  '景别': '中景', '运镜': '固定', '主角': '辞辞',
  '动作': '趴在台灯下的书桌前敲键盘，尾巴有一下没一下地甩',
  '台词': '辞辞：烧完了',            // ← 故意用短台词，验证 #8
  '旁白': '无', '内心旁白': '无',
  '表情细节': '眼皮半垂，嘴角向下撇',
  '感情细节': '不耐烦但还是没停手',
  '音效': '键盘连打声、台灯电流轻嗡',
  '光影': '冷蓝环境光加台灯暖黄侧逆光',
  '场景': '书桌',
}
const script = {
  segments: [{
    index: 1, durationSeconds: 10, styleRef: 'SL-1',
    shots: [shot, { ...shot, '景别': '近景', '动作': '伸手去捞屏幕上浮起的白碗图标，指尖穿了过去', '台词': '辞辞：喂，我的白饭呢' }, { ...shot, '景别': '特写', '动作': '白碗图标碎成光点，她僵在椅子上', '台词': '辞辞：白饭这就烧完了' }],
  }],
}

/* ── 1. G0/G1 ───────────────────────────────────────────── */
log('项目:', slug, '| 状态目录:', home)
log(isTempHome
  ? `🛡 临时目录（跑完自动删，不碰正式状态）${KEEP ? '；--keep 生效，保留' : ''}；要留样：--home <目录>`
  : '📁 指定目录（产物会留在这里）')
gate('G1 脚本', checkScript(script, { styleLockId: 'SL-1', segmentSeconds: 10 }))
project.script = script

const roles = {
  '辞辞': { name: '辞辞', kind: 'reference', file: join(assets, '辞辞_参考图.png'), reference: join(assets, '辞辞_参考图.png'), cardImage: join(assets, '辞辞_三视图.png'), appearance: 'Q 版三头身，蓝白渐变长发，蓝瞳，鲸尾', outfit: '深蓝白女仆裙 + 蕾丝发箍 + 小蓝鲸围裙', source: 'https://www.doubao.com/chat/38450401752355074' },
}
const scenes = {
  '书桌': { name: '书桌', file: join(assets, '书桌_场景图.png'), characters: '', source: 'https://www.doubao.com/chat/38450401752355074' },
}
gate('G2 角色', checkRole(roles['辞辞'], {}))
gate('G3 场景', checkScene(scenes['书桌'], {}))
project.roles = roles
project.scenes = scenes

/* ── 2. G4 生成前 + 提示词（验证 #5） ───────────────────── */
const v = checkVideo(script.segments[0].shots[0], { styleLock: project.styleLock, roles: toMap(roles), scenes: toMap(scenes), clips: {}, segIndex: 1 })
gate('G4 生成前', v)
const prompt = buildShotPrompt(script.segments[0].shots[0], {
  segIndex: 1, roles: toMap(roles), scenes: toMap(scenes), clips: {},
  durationSeconds: 10, aspectRatio: '9:16',
})
log('\n──────── 提示词 ────────\n' + prompt + '\n────────────────────────')
if (!/时长：10 秒/.test(prompt) || !/画幅：9:16/.test(prompt)) {
  log('❌ #5 未生效：提示词里没有时长/画幅')
  process.exit(1)
}
log('✅ #5 生效：提示词自带时长/画幅')

/* ── 3. 上传 + 写入输入框 ───────────────────────────────── */
const requiredUploads = [scenes['书桌'].file, roles['辞辞'].reference]
const { page } = await b.open()

log('\n→ 上传素材:', requiredUploads.map((p) => p.split(/[\\/]/).pop()).join(' + '))
const att = await b.attach(page, requiredUploads)
log('  已上传:', att.attached, '/', requiredUploads.length)

const fill = await b.fill(page, prompt)
log('  写入输入框:', fill.draftLength, '字')
await b.shot(page, join(home, 'sim-stage.png'))
log('  截图:', join(home, 'sim-stage.png'))

/* ── 4. G4.5 审计 ───────────────────────────────────────── */
const audit = auditPrompt(script.segments[0].shots[0], prompt, { roles: toMap(roles), scenes: toMap(scenes), clips: {}, segIndex: 1 })
gate('G4.5 提示词审计', audit)

if (DRY) {
  log('\n默认 dry：已停在发送前，未消耗额度（真跑加 --live）')
  process.exit(0)
}

/* ── 5. 发送（本会话已获授权：确定生成视频） ─────────────── */
const startedAt = Date.now()
await b.send(page)
log('\n📤 已发送')
await page.waitForTimeout(9000)
const tailText = (await b.status(page)).lastText || ''
if (/确认后我再开始生成视频|确认生成视频/.test(tailText) && !/预计等待/.test(tailText)) {
  log('  豆包要求确认 → 补一句「时长 10 秒、画幅 9:16 竖屏，确认无误，直接开始生成视频。」')
  await b.fill(page, '时长 10 秒、画幅 9:16 竖屏，确认无误，直接开始生成视频。')
  await b.send(page)
}

/* ── 6. 抓片（验证 #1/#3/#4/#11） ────────────────────────── */
log('\n👀 等新卡片…')
const before = await b.mediaState(page)
log('  基线：卡片', before.cards, '张，已挂载视频', before.srcs.length, '个')
const found = await b.waitForNewVideo(page, { srcs: before.srcs, cards: before.cards }, 12 * 60 * 1000)
if (!found.ok) {
  if (found.quota) {
    // 额度拦截：这是**预期内**的失败，不是缺陷。重点是"多快识别出来"（不空等）
    log(`⛔ 额度不够，已拦截：${found.state?.quotaText || '（页面出现额度文案）'}`)
    log(`   识别耗时 ${found.waitedMs} ms —— 这段没有生成、没有消耗额度。`)
    log('   修法：换号 / 等额度恢复 / 开通订阅，然后重跑同一条命令。')
    process.exit(2) // 用 2 区分"额度问题"和"代码问题"
  }
  log('❌ 等片失败:', JSON.stringify(found).slice(0, 300))
  process.exit(1)
}
log(`✅ 发现新片（${(found.waitedMs / 1000).toFixed(0)} 秒，卡片 ${before.cards} → ${found.cards}）`)
log('  src:', found.src.slice(0, 70) + '…')

const videoPath = join(clipsDir, `${slug}-seg1.mp4`)
const dl = await b.downloadVideoRetry(page, videoPath, { src: found.src })
log(dl.ok ? `✅ 下载成功（第 ${dl.attempt} 次尝试，${Math.round((dl.bytes || 0) / 1024)} KB）` : `❌ 下载失败：${dl.error}`)
if (!dl.ok) process.exit(1)

const tailPath = join(clipsDir, `${slug}-seg1-tail.png`)
const tf = f.tailFrame(dl.path, tailPath, {})
log(tf.ok ? `✅ 尾帧：${tailPath}（${Number(tf.at).toFixed(2)}s / 全长 ${Number(tf.duration).toFixed(2)}s）` : `❌ 尾帧失败：${tf.error}`)
if (tf.ok) {
  const st = statSync(tailPath)
  log(`  落盘校验：${st.size} 字节 ${st.size > 0 ? '✅' : '❌'}`)
}

/* ── 7. G5 登记 ─────────────────────────────────────────── */
const clip = { segment: 1, file: dl.path, durationSeconds: Math.round(tf.duration || 10), tailFrame: tailPath, tailTimeSeconds: Number((tf.at || 9.95).toFixed(2)) }
gate('G5 片段', checkClip(clip, { segmentSeconds: 10 }))
const minutes = Number(((Date.now() - startedAt) / 60000).toFixed(1))
gate('G5 生成窗口', checkGenerateWindow(minutes, { minMinutes: 1, maxMinutes: 10 }))
log(`  实测启动到出片：${minutes} 分钟`)

project.clips = { 1: { ...clip, at: new Date().toISOString() } }
saveProject(home, slug, project)
log('\n已保存项目状态:', join(home, 'projects', `${slug}.json`))

// 临时目录跑完会删：真机产物得先留一份到 _backup/sim-artifacts/，否则证据跟着临时目录一起没了
let kept = null
if (isTempHome && dl.ok) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 13)
  const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  kept = join(pluginRoot, '_backup', 'sim-artifacts', stamp)
  mkdirSync(kept, { recursive: true })
  for (const [src, name] of [[dl.path, `${slug}-seg1.mp4`], [tailPath, `${slug}-seg1-tail.png`]]) {
    if (existsSync(src)) copyFileSync(src, join(kept, name))
  }
  log('留样（临时目录会被删，证据在这里）:', kept)
}

process.exit(0)
