import type { Context } from 'cordis'
import type { LegacyConfig } from '../support/types'

/** The host owns persistence and restart/trust rules for legacy adapter configuration. */
interface HostConfig {
  readonly version: string
  get(): { musicCardSignUrl?: string }
  getLegacy(): LegacyConfig
  patchLegacy(partial: Record<string, unknown>, options?: { rules?: boolean }): Promise<unknown>
}

function hostConfig(ctx: Context): HostConfig {
  const config = ctx.get('config') as HostConfig | undefined
  if (!config?.getLegacy || !config.patchLegacy) throw new Error('当前 Bot 版本不支持旧版配置接口，请更新 Bot')
  return config
}

export const legacyConfig = (ctx: Context) => hostConfig(ctx).getLegacy()
export const applyLegacyConfig = (ctx: Context, partial: Record<string, unknown>, options?: { rules?: boolean }) =>
  hostConfig(ctx).patchLegacy(partial, options)
export const hostVersion = (ctx: Context) => (ctx.get('config') as HostConfig | undefined)?.version ?? 'unknown'
export const musicCardSignUrl = (ctx: Context) => (ctx.get('config') as unknown as HostConfig).get().musicCardSignUrl
