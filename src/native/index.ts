import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDevMode } from '../support/utils/environment'
import type { NativeSign } from './sign-types'
import type { NativeQQ } from '../../native/production'

export type { NativeQQ } from '../../native/production'
export interface NativeAddon extends NativeSign {
  NativeQQ: new () => NativeQQ
  getNativeDirectory(): string
  getNativeBuildInfo(): { package: string; version: string; variant: string; target: string; buildId: string }
}

const requireNative = createRequire(import.meta.url)
let addon: NativeAddon | undefined

/** One verified addon per host. Copy the entire target so Windows upgrades keep the sidecar paired. */
export function getNativeAddon(): NativeAddon {
  if (addon) return addon
  const variant = isDevMode() ? 'development' : 'production'
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [path.join(here, '../native', variant), path.join(here, '../../native', variant)]
  const root = candidates.find(dir => existsSync(path.join(dir, 'loader.cjs')))
  if (!root) throw new Error(`缺少 NTQQ 插件的 ${variant} 原生包；请重新安装插件，源码开发时在 LuckyLillia.node 执行 sync:plugin 后重新构建插件。查找位置：${candidates.join(', ')}`)
  const loader = requireNative(path.join(root, 'loader.cjs'))
  if (loader.inspectBundle(root).manifest.variant !== variant) throw new Error('Native bundle authorization variant mismatch')
  const loaded = loader.loadNative(root, { cacheDir: path.join(tmpdir(), 'lucky-lillia-node') }) as NativeAddon
  if (typeof loaded.NativeQQ !== 'function') throw new Error('原生包缺少 NativeQQ，请更新 NTQQ 协议插件')
  addon = loaded
  return addon
}
