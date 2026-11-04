/**
 * lib/providers/index.mjs —— 生成后端的入口（web / mock / 以后的 ark）
 * ============================================================================
 * 工具层只说"要做什么"：stage（上传+写稿）、submit（发送）、fetchClip（等片+下载+尾帧）。
 * 至于这些事是点网页做还是走官方 API 做，由这里挑一个后端实现。
 *
 * 为什么是单例：
 *   以前每个工具都 `open()` 一次 —— 6 个工具就是 6 次 connectOverCDP。
 *   现在按 (后端 + CDP 地址) 缓存，一个进程只连一次；浏览器窗口留着不动。
 *
 * 选后端：
 *   provider({ cdpUrl })            默认 web
 *   DOUBAO_PROVIDER=mock            测试用假后端（不连浏览器、不花额度）
 *   provider({ kind: 'mock' })      显式指定，优先级最高
 * ============================================================================
 */
import { createWebProvider } from './web.mjs'
import { createMockProvider } from './mock.mjs'

export const PROVIDER_KINDS = ['web', 'mock']

/** 缓存：key = `${kind}|${cdpUrl}` —— 同一后端同一地址只建一个 */
const instances = new Map()

/** 当前该用哪个后端：显式 kind > 环境变量 > 默认 web */
export function providerKind() {
  const raw = String(process.env.DOUBAO_PROVIDER || '').trim().toLowerCase()
  return raw || 'web'
}

/**
 * 取一个后端实例（同参数复用同一个）。
 * @param {{ cdpUrl?: string, kind?: string }} [cfg]
 */
export async function provider(cfg = {}) {
  const kind = String(cfg?.kind || providerKind()).trim().toLowerCase()
  if (!PROVIDER_KINDS.includes(kind)) {
    throw new Error(`未知的生成后端：${kind}（目前支持 ${PROVIDER_KINDS.join(' / ')}）`)
  }
  // mock 收口（2026-11-04）：它会返回假成片。生产环境必须再显式开一道门才允许。
  if (kind === 'mock' && process.env.NODE_ENV === 'production' && process.env.DOUBAO_ALLOW_MOCK !== '1') {
    throw new Error('生产环境不允许 mock 后端（会返回假成片）。确实要测，设 DOUBAO_ALLOW_MOCK=1。')
  }
  const cdpUrl = cfg?.cdpUrl ? String(cfg.cdpUrl) : ''
  const key = `${kind}|${cdpUrl}`
  if (!instances.has(key)) {
    instances.set(key, kind === 'mock'
      ? createMockProvider()
      : createWebProvider({ cdpUrl: cdpUrl || undefined }))
  }
  return instances.get(key)
}

/** 测试用：丢掉所有实例（下一个 provider() 重新构造） */
export function resetProviders() {
  instances.clear()
}
