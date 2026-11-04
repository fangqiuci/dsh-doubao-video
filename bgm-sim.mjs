import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { addBgm, listBgm, resolveBgm } from '../lib/bgm.mjs'

const home = mkdtempSync(join(tmpdir(), 'bgmsim-'))
const mka = (f, s) => { spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${s}`, '-c:a', 'libmp3lame', f], { windowsHide: true }); return f }

let pass = 0, fail = 0
const t = (n, c, d = '') => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}  ${String(d).slice(0, 160)}`) } }

const src = mka(join(home, '雨夜.mp3'), 3)

console.log('── 归档 ──')
const r1 = await addBgm(home, { file: src, name: '雨夜' })
t('从本机文件归档', r1.ok === true && r1.via === 'copy', r1.error)
t('落进 bgm/ 目录', existsSync(join(home, 'bgm', '雨夜.mp3')))
t('列表能查到', listBgm(home).some((x) => x.name === '雨夜'))

const r2 = await addBgm(home, { file: join(home, 'bgm', '雨夜.mp3'), name: '雨夜' })
t('已在归档里 → 不重复复制', r2.ok && r2.via === 'already')

console.log('── 按名字解析 ──')
t('写名字能找到', resolveBgm(home, '雨夜') !== null)
t('带扩展名也能找到', resolveBgm(home, '雨夜.mp3') !== null)
t('找不存在的 → null', resolveBgm(home, '不存在的曲子') === null)

console.log('── 拒绝垃圾输入 ──')
const r3 = await addBgm(home, { file: join(home, '不存在.mp3') })
t('文件不存在 → 拒', r3.ok === false)
const txt = join(home, 'note.txt'); writeFileSync(txt, 'hello')
const r4 = await addBgm(home, { file: txt })
t('非音频扩展名 → 拒', r4.ok === false, r4.error)
const tiny = join(home, 'tiny.mp3'); writeFileSync(tiny, Buffer.alloc(1000))
const r5 = await addBgm(home, { file: tiny })
t('太小（<20KB）→ 拒', r5.ok === false, r5.error)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
rmSync(home, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
