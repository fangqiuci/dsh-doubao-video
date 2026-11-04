/**
 * lib/media.mjs —— 素材体检（不依赖 ffmpeg）
 * ============================================================================
 * 为什么要有它（2026-10-31 的真实事故）：
 *   角色"参考图"其实是代码画的占位符：1024×1024 只有 13.4KB，底部还印着
 *   `PLACEHOLDER-参考图`。插件的 G2 只校验"有没有填路径"，于是它一路通过了，
 *   豆包照着这团蓝球生成了整条片子 —— 脸当然是自由发挥的。
 *
 * 这里做的是**体量体检**，不是审美判断：
 *   · 文件在不在
 *   · 尺寸够不够（默认短边 ≥ 512）
 *   · 每百万像素占多少字节（真实渲染图一般 300KB+/MP，纯色/矢量占位图常常个位数 KB/MP）
 * 不追求 100% 准确 —— 目标是让"随手画的占位图"过不去。
 * ============================================================================
 */
import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs'

/** 读 PNG / JPEG 头，拿宽高（不依赖任何外部库） */
export function imageSize(file) {
  let fd
  try {
    fd = openSync(file, 'r')
    const head = Buffer.alloc(32)
    readSync(fd, head, 0, 32, 0)

    // PNG: 89 50 4E 47 0D 0A 1A 0A，IHDR 从第 16 字节开始（大端）
    if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
      return { format: 'png', width: head.readUInt32BE(16), height: head.readUInt32BE(20) }
    }

    // JPEG: FF D8，然后逐段扫到 SOF
    if (head[0] === 0xff && head[1] === 0xd8) {
      const buf = Buffer.alloc(64 * 1024)
      const n = readSync(fd, buf, 0, buf.length, 2)
      let i = 0
      while (i < n - 9) {
        if (buf[i] !== 0xff) { i += 1; continue }
        const marker = buf[i + 1]
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { format: 'jpeg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
        }
        const len = buf.readUInt16BE(i + 2)
        i += 2 + len
      }
      return { format: 'jpeg', width: 0, height: 0 }
    }

    // WebP: RIFF....WEBP
    if (head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') {
      return { format: 'webp', width: 0, height: 0 }
    }
    return { format: 'unknown', width: 0, height: 0 }
  } catch {
    return { format: 'unknown', width: 0, height: 0 }
  } finally {
    if (fd !== undefined) { try { closeSync(fd) } catch { /* 忽略 */ } }
  }
}

/**
 * 素材体检。
 * @param {string} file 路径
 * @param {object} opts { minSide=512, minKBPerMP=40, label='素材' }
 * @returns {{ ok, violations: {code,where,message}[], info }}
 */
export function checkImage(file, opts = {}) {
  const minSide = Number(opts.minSide ?? 512)
  const minKBPerMP = Number(opts.minKBPerMP ?? 40)
  const label = String(opts.label || '素材')
  const violations = []

  const path = String(file || '').trim()
  if (!path) {
    violations.push({ code: 'E_FILE_MISSING', where: label, message: `${label}没有路径` })
    return { ok: false, violations, info: null }
  }
  if (!existsSync(path)) {
    violations.push({
      code: 'E_FILE_MISSING', where: label,
      message: `${label}文件不存在：${path}（路径写错、或者文件被挪走了）`,
    })
    return { ok: false, violations, info: null }
  }

  const bytes = statSync(path).size
  const size = imageSize(path)
  const mp = (size.width * size.height) / 1_000_000
  const kbPerMP = mp > 0 ? (bytes / 1024) / mp : 0

  if (size.width && size.width < minSide) {
    violations.push({
      code: 'E_IMAGE_TOO_SMALL', where: label,
      message: `${label}只有 ${size.width}×${size.height}，短边要求 ≥${minSide}px`,
    })
  }
  if (size.width >= minSide && kbPerMP > 0 && kbPerMP < minKBPerMP) {
    violations.push({
      code: 'E_IMAGE_SUSPICIOUS', where: label,
      message: `${label}密度异常：${Math.round(kbPerMP)}KB/百万像素（要求 ≥${minKBPerMP}KB）。`
        + '这个体量基本是纯色块/占位图，不是渲染出来的画面',
    })
  }

  return { ok: violations.length === 0, violations, info: { path, bytes, ...size, kbPerMP: Math.round(kbPerMP) } }
}
