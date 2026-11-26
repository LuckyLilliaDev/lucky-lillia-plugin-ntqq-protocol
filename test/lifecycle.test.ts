import { existsSync } from 'node:fs'
import path from 'node:path'
import { Context, Service } from 'cordis'
import { Status } from '@satorijs/protocol'
import { createTestApp } from '@luckylillia-dev/plugin-sdk/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as NTProtocol from '../src/index'
import { getDbDir } from '../src/support/globalVars'

const state = vi.hoisted(() => ({ starts: [] as { mode: string; uin: string }[], stops: 0 }))
vi.mock('../src/qqProtocol', async () => {
  const { Service } = await import('cordis')
  const fake = (mode: string) => class extends Service {
    selfInfo = { uin: '', uid: '', nick: '', online: false }
    constructor(ctx: Context, readonly config: { autoLoginUin?: string } = {}) { super(ctx, 'qqProtocol') }
    onDisconnect() { return 'test-watcher' }
    offDisconnect() {}
    async [Service.init]() {
      state.starts.push({ mode, uin: this.config.autoLoginUin ?? '' })
      return () => { state.stops++ }
    }
  }
  return { DirectQQProtocolClient: fake('direct'), NativeQQProtocolClient: fake('nativeqq') }
})

const contexts: Context[] = []
const apps: Awaited<ReturnType<typeof createTestApp>>[] = []
async function createContext() {
  const app = await createTestApp()
  apps.push(app)
  const ctx = app.ctx
  contexts.push(ctx)
  ctx.provide('config', { get: () => ({ logLevel: 'error', msgCacheExpire: 3600, webui: { enable: false } }) })
  return ctx
}
const has = (ctx: Context, name: string) => ctx.get(name) !== undefined
const beforeLogin = ['qqProtocol', 'ntLoginApi', 'ntSystemApi']
const afterLogin = ['store', 'app', 'ntFriendApi', 'ntGroupApi', 'ntMsgApi', 'ntUserApi', 'ntFileApi', 'ntWebApi', 'ntOnebot']
async function login(ctx: Context, uin = '10001') {
  Object.assign(ctx.get('qqProtocol')!.selfInfo, { uin, uid: 'u_' + uin, nick: 'test', online: true })
  await ctx.parallel('qq/online')
  await vi.waitFor(() => { for (const name of afterLogin) expect(has(ctx, name), name).toBe(true) })
  await vi.waitFor(() => expect(ctx.bots.get(`ntqq:${uin}`)?.status).toBe(Status.ONLINE))
}
beforeEach(() => { state.starts.length = 0; state.stops = 0 })
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const app of apps.splice(0)) await app.dispose()
})

describe('standalone NTQQ plugin lifecycle', () => {
  it('reuses one identity on reconnect and replaces account resources after identity changes or logout', async () => {
    const ctx = await createContext()
    await ctx.plugin(NTProtocol)
    await vi.waitFor(() => { for (const name of beforeLogin) expect(has(ctx, name), name).toBe(true) })
    for (const name of afterLogin) expect(has(ctx, name), name).toBe(false)
    expect(ctx.bots.size).toBe(0)
    await login(ctx)
    const bot = ctx.bots.get('ntqq:10001')!
    const store = ctx.reflect._getImpl('store')
    const friends = ctx.reflect._getImpl('ntFriendApi')
    ctx.get('qqProtocol')!.selfInfo.online = false
    await ctx.parallel('protocol/disconnect')
    expect(bot.status).toBe(Status.OFFLINE)
    await Promise.all([login(ctx), login(ctx)])
    expect(ctx.reflect._getImpl('store') === store).toBe(true)
    expect(ctx.bots.get('ntqq:10001')).toBe(bot)
    expect(bot.status).toBe(Status.ONLINE)
    await login(ctx, '10002')
    expect(ctx.bots.get('ntqq:10001')).toBeUndefined()
    expect(ctx.bots.size).toBe(1)
    expect(ctx.bots.get('ntqq:10002')?.user.id).toBe('10002')
    expect(bot.user.id).toBe('10001')
    expect(ctx.reflect._getImpl('store') === store).toBe(false)
    expect(ctx.reflect._getImpl('ntFriendApi') === friends).toBe(false)
    for (const uin of ['10001', '10002']) expect(existsSync(path.join(getDbDir(), uin + '.v3.db'))).toBe(true)
    Object.assign(ctx.get('qqProtocol')!.selfInfo, { uin: '', uid: '', nick: '', online: false })
    await ctx.parallel('qq/logout')
    expect(ctx.bots.size).toBe(0)
    for (const name of afterLogin) expect(has(ctx, name), name).toBe(false)
    for (const name of beforeLogin) expect(has(ctx, name), name).toBe(true)
    await login(ctx, '10002')
  })

  it('stops all account resources and dependents on unload, and mounts a clean session on reload', async () => {
    const ctx = await createContext()
    const dependent: string[] = []
    ctx.plugin({ name: 'test-dependent', inject: ['app', 'store'], apply(ctx: Context) {
      ctx.effect(() => { dependent.push('up'); return () => { dependent.push('down') } })
    } })
    let entry = await ctx.plugin(NTProtocol)
    await login(ctx)
    await vi.waitFor(() => expect(dependent).toEqual(['up']))
    await entry.dispose()
    expect(ctx.bots.size).toBe(0)
    for (const name of [...beforeLogin, ...afterLogin]) expect(has(ctx, name), name).toBe(false)
    expect(state.stops).toBe(1)
    expect(dependent).toEqual(['up', 'down'])
    entry = await ctx.plugin(NTProtocol)
    await vi.waitFor(() => expect(state.starts).toHaveLength(2))
    expect(ctx.get('qqProtocol')!.selfInfo.uin).toBe('')
    expect(ctx.bots.size).toBe(0)
    expect(dependent).toEqual(['up', 'down'])
    await login(ctx)
    await vi.waitFor(() => expect(dependent).toEqual(['up', 'down', 'up']))
    await entry.dispose()
  })

  it.each(['direct', 'nativeqq'])('changes automatic login without interrupting %s and uses it on the next mount', async mode => {
    const ctx = await createContext()
    const entry = await ctx.plugin(NTProtocol, { mode })
    await vi.waitFor(() => expect(state.starts).toEqual([{ mode, uin: '' }]))
    const protocol = ctx.reflect._getImpl('qqProtocol')
    await entry.update({ mode, autoLoginUin: '123456' })
    expect(ctx.reflect._getImpl('qqProtocol') === protocol).toBe(true)
    expect(state.stops).toBe(0)
    await entry.dispose()
    await ctx.plugin(NTProtocol, { mode, autoLoginUin: '123456' })
    await vi.waitFor(() => expect(state.starts).toEqual([{ mode, uin: '' }, { mode, uin: '123456' }]))
  })

  it('remounts for another login mode or bridge executable, but not for pure-protocol preferences', async () => {
    const ctx = await createContext()
    const entry = await ctx.plugin(NTProtocol, { mode: 'direct', protocol: 'linux' })
    await vi.waitFor(() => expect(state.starts).toHaveLength(1))
    await entry.update({ mode: 'direct', protocol: 'macos', nativeQQ: { qqPath: '/other/QQ' } })
    expect(state.starts).toHaveLength(1)
    await entry.update({ mode: 'nativeqq', protocol: 'macos', nativeQQ: { qqPath: '/other/QQ' } })
    await vi.waitFor(() => expect(state.starts).toHaveLength(2))
    await entry.update({ mode: 'nativeqq', protocol: 'linux', nativeQQ: { qqPath: '/other/QQ' } })
    expect(state.starts).toHaveLength(2)
    await entry.update({ mode: 'nativeqq', nativeQQ: { qqPath: '/QQ' } })
    await vi.waitFor(() => expect(state.starts).toHaveLength(3))
  })
})
