/**
 * scripts/check-env.mjs —— 装机环境体检
 *   node scripts/check-env.mjs
 *
 * 为什么需要它（2026-11-04 的教训）：
 *   「插件没加载」报了三天，最后发现是 **QQ 桥接的工具白名单**把 doubao_* 全拒了。
 *   插件自己 apply ok、24 个工具都注册了，但一调用就被 guard 拦掉 —— 现象和"没加载"一模一样。
 *   所以装机体检必须把「有没有别的东西在拦我的工具」也查一遍。
 */
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const ROOT = resolve(fileURLToPath(import.meta.url), '../..')
const rows = []
const ok = (name, detail = '') => rows.push({ ok: true, name, detail })
const bad = (name, detail = '') => rows.push({ ok: false, name, detail })
const warn = (name, detail = '') => rows.push({ ok: null, name, detail })

// ① Node
const major = Number(process.versions.node.split('.')[0])
major >= 22 ? ok('Node', process.version) : bad('Node', `${process.version} 太低（要 >= 22）`)

// ② ffmpeg
const ff = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', windowsHide: true })
ff.status === 0 ? ok('ffmpeg', (ff.stdout || '').split('\n')[0].slice(0, 40)) : bad('ffmpeg', '找不到 ffmpeg（取帧/拼接/字幕/配音都不可用）')

// ③ 插件能否注册全部工具
let toolCount = 0
try {
  const mod = await import(pathToFileURL(join(ROOT, 'lib/index.mjs')).href)
  const got = []
  mod.apply({ tools: { register: (t) => got.push(t.name) } }, { home: join(homedir(), '.dsh', 'doubao-video'), project: 'env-check' })
  toolCount = got.length
  toolCount >= 20 ? ok('插件注册', `${toolCount} 个工具`) : bad('插件注册', `只注册了 ${toolCount} 个`)
} catch (e) {
  bad('插件注册', e.message)
}

// ④ 关键模块（late-binding 的检查：漏了就直接报出来）
for (const m of ['models', 'subtitle', 'tts', 'images', 'dub', 'bgm', 'media', 'store', 'rules', 'browser', 'ffmpeg']) {
  const p = join(ROOT, 'lib', `${m}.mjs`)
  existsSync(p) ? ok(`模块 ${m}`, '') : bad(`模块 ${m}`, '缺失')
}

// ⑤ 有没有别的东西在拦 doubao_*（qq-tool-restrict 家族）
const candidates = [
  join(homedir(), 'qq-bridge', 'plugins', 'qq-agent-presets', 'qq-tool-restrict.mjs'),
  join(homedir(), 'qq-bridge', 'dsh', 'agent-presets', 'qq-chat-v2', 'qq-tool-restrict.mjs'),
  join(homedir(), 'qq-bridge', 'dsh', 'agent-presets', 'qq-chat', 'qq-tool-restrict.mjs'),
  join(homedir(), '.dsh', 'plugins', 'qq-agent-presets', 'qq-tool-restrict.mjs'),
]
let foundRestrict = false
for (const p of candidates) {
  if (!existsSync(p)) continue
  foundRestrict = true
  const t = readFileSync(p, 'utf8')
  if (t.includes("'doubao_'")) {
    ok('工具白名单', `${p} 已放行 doubao_`)
  } else if (t.includes("export * from")) {
    warn('工具白名单', `${p} 是 re-export 壳，真正实现要看 plugins/qq-agent-presets/qq-tool-restrict.mjs`)
  } else {
    bad('工具白名单', `${p} 的 SAFE_PREFIXES 里没有 'doubao_' —— doubao_* 调用会被拒，现象像"插件没加载"`)
  }
}
if (!foundRestrict) ok('工具白名单', '没装 qq-tool-restrict（普通用户不会被拦）')

// 输出
const badCount = rows.filter((r) => r.ok === false).length
console.log('\n装机体检\n' + '─'.repeat(52))
for (const r of rows) {
  const mark = r.ok === true ? '✅' : r.ok === null ? '⚠️ ' : '❌'
  console.log(`${mark} ${r.name.padEnd(12)} ${r.detail}`)
}
console.log('─'.repeat(52))
console.log(badCount ? `\n❌ ${badCount} 项不合格` : '\n✅ 全部通过')
process.exit(badCount ? 1 : 0)
