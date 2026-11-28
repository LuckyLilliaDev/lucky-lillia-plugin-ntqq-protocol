import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { MacosEstablishArgs, MacosTokenResult } from '../../../src/native/sign-types'

// 按协议分流取 sign-token 的路由。重点守三件事:
//   1. 只有 linux 走本地 getLinuxSAToken; Windows 使用自己的原生 ESK 接口 ——
//      本地 ESK 是真往 QQ 发包, 并进来 watch 就会从手表连接上发一个 Linux 形状的 ESK。
//   2. macOS 通道密钥留在 native, Bot 只选择 ESK / login-token 路由并缓存 token 与有效期。
//   3. native 解不出 TTL 时返 0, 不能原样用 (等于立刻过期 -> 每 30s 打一次 ESK)。

const h = vi.hoisted(() => ({
  protocol: 'linux' as string,
  proxy: {} as Record<string, unknown>,
}))

vi.mock('../../../src/support/utils/environment', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/support/utils/environment')>()),
  getProtocol: () => h.protocol,
}))
// sign.ts 里 watch 的 device32 那段还读 profile.family, 跟 protocol 保持一致。
vi.mock('../../../src/qqProtocol/direct-lib/profiles', () => ({
  getActiveProfile: () => ({
    name: h.protocol,
    family: h.protocol === 'watch'
      ? 'watch'
      : (h.protocol === 'ipad' || h.protocol === 'iphone')
        ? 'ios'
        : (h.protocol === 'harmonypad' || h.protocol === 'harmony')
          ? 'harmony'
          : 'nt',
  }),
}))
vi.mock('../../../src/native', () => ({
  getNativeAddon: () => h.proxy,
}))
vi.mock('../../../src/qqProtocol/direct-lib/macosDevice', () => ({
  getMacosDevice: async () => ({ qimei36: 'q36', devicePbHex: 'aa' }),
}))
vi.mock('../../../src/qqProtocol/direct-lib/windowsDevice', () => ({
  getWindowsQimei: async () => 'a'.repeat(36),
}))
vi.mock('../../../src/qqProtocol/direct-lib/mobile/device', () => ({
  getMobileDevice: async () => ({
    guid: Buffer.alloc(16, 0x11),
    guidHex: '11'.repeat(16),
    qimei36: 'q36',
    xwid: '',
    devicePbHex: 'bb',
    deviceName: 'LuckyLillia-test',
    osVer: '18.3',
    model: 'iPad14,5',
  }),
}))
vi.mock('../../../src/qqProtocol/direct-lib/machineGuid', () => ({
  loadMachineGuidSync: () => Buffer.alloc(16, 0x11),
}))

import { setupSign, acquireSignToken, acquireMacosEskOnly } from '../../../src/qqProtocol/direct-lib/sign'

const DAY = 24 * 60 * 60

function makeProxy(overrides: Record<string, unknown> = {}) {
  return {
    init: vi.fn(async () => {}),
    // 经 manager 的老路: token 是 Buffer, 老代码无视它的 TTL 固定给 24h。
    acquireSignToken: vi.fn(async () => ({ token: Buffer.from('MANAGER_TOK1'), ttlSecs: 0 })),
    getLinuxSAToken: vi.fn(async () => ({ token: 'LOCAL_TOKEN1', ttlSecs: 3600 })),
    getWindowsEskToken: vi.fn(async () => ({ token: 'WINDOWS_TOK1', ttlSecs: 455 })),
    getMacosEskToken: vi.fn(async (_args: MacosEstablishArgs): Promise<MacosTokenResult> => ({ token: 'ESK_TOKEN_01', ttlSecs: 0 })),
    getMacosLoginToken: vi.fn(async (_args: MacosEstablishArgs): Promise<MacosTokenResult> => ({ token: 'LOGIN_TOKEN1', ttlSecs: 7200 })),
    getMobileEskToken: vi.fn(async () => ({ token: 'MOB_ESK_0001', ttlSecs: 3600 })),
    getMobileLoginToken: vi.fn(async () => ({ token: 'MOB_SA2_0002', ttlSecs: 5400 })),
    ...overrides,
  }
}

async function useProxy(proxy: Record<string, unknown>) {
  h.proxy = proxy
  await setupSign({
    botVersion: 'test',
    authToken: 'jwt',
    machineGuid: Buffer.alloc(16, 0x22),
    sendPacket: async () => Buffer.alloc(0),
  })
}

describe('acquireSignToken 按协议分流', () => {
  beforeEach(() => {
    h.protocol = 'linux'
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('linux 走本地 ESK, 不打 manager, 用服务器下发的 TTL', async () => {
    const proxy = makeProxy()
    await useProxy(proxy)

    const r = await acquireSignToken(10001, 'V1_LNX_NQ_3.2.28_48517_GW_B')

    expect(r).toEqual({ token: 'LOCAL_TOKEN1', ttlSecs: 3600 })
    expect(proxy.getLinuxSAToken).toHaveBeenCalledWith({ qua: 'V1_LNX_NQ_3.2.28_48517_GW_B' })
    expect(proxy.acquireSignToken).not.toHaveBeenCalled()
  })

  it('linux 解不出 TTL (0) 时回落 24h, 而不是立刻过期', async () => {
    const proxy = makeProxy({
      getLinuxSAToken: vi.fn(async () => ({ token: 'LOCAL_TOKEN1', ttlSecs: 0 })),
    })
    await useProxy(proxy)

    const r = await acquireSignToken(10001, 'V1_LNX_NQ_3.2.28_48517_GW_B')

    expect(r.ttlSecs).toBe(DAY)
  })

  it('linux 遇到没有 getLinuxSAToken 的老 .node, 退回经 manager 取', async () => {
    const proxy = makeProxy({ getLinuxSAToken: undefined })
    await useProxy(proxy)

    const r = await acquireSignToken(10001, 'V1_LNX_NQ_3.2.28_48517_GW_B')

    expect(r).toEqual({ token: 'MANAGER_TOK1', ttlSecs: DAY })
    expect(proxy.acquireSignToken).toHaveBeenCalledWith({ uin: 10001, qua: 'V1_LNX_NQ_3.2.28_48517_GW_B' })
  })

  it.each(['watch'])('%s 不走本地 ESK, 留在经 manager 的老路', async (name) => {
    h.protocol = name
    const proxy = makeProxy()
    await useProxy(proxy)

    await acquireSignToken(10001, 'V1_XXX')

    expect(proxy.getLinuxSAToken).not.toHaveBeenCalled()
    expect(proxy.acquireSignToken).toHaveBeenCalledTimes(1)
  })

  it('windows uses its native ESK with the current GUID and preserves the QQ TTL', async () => {
    h.protocol = 'windows'
    const proxy = makeProxy()
    await useProxy(proxy)
    await expect(acquireSignToken(10001, 'V1_WIN_NQ')).resolves.toEqual({ token: 'WINDOWS_TOK1', ttlSecs: 455 })
    expect(proxy.getWindowsEskToken).toHaveBeenCalledExactlyOnceWith({
      guidHex: '11'.repeat(16), qimei36: 'a'.repeat(36), qua: 'V1_WIN_NQ', uin: 10001,
    })
    expect(proxy.acquireSignToken).not.toHaveBeenCalled()
    expect(proxy.getLinuxSAToken).not.toHaveBeenCalled()
  })

  it('windows reports an outdated addon without falling back to manager token endpoints', async () => {
    h.protocol = 'windows'
    const proxy = makeProxy({ getWindowsEskToken: undefined })
    await useProxy(proxy)
    await expect(acquireSignToken(10001, 'V1_WIN_NQ')).rejects.toThrow('getWindowsEskToken')
    expect(proxy.acquireSignToken).not.toHaveBeenCalled()
  })

  it.each(['ipad', 'iphone', 'harmonypad', 'harmony'])('%s 走原生 .node getMobileEskToken/getMobileLoginToken, 不打 manager /token/*', async (name) => {
    h.protocol = name
    const proxy = makeProxy()
    await useProxy(proxy)
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000)

    const r = await acquireSignToken(10001, 'V1_MOBILE')

    expect(r).toEqual({ token: 'MOB_SA2_0002', ttlSecs: 5400 })
    expect(proxy.getMobileEskToken).toHaveBeenCalledExactlyOnceWith({ devicePbHex: 'bb', tsMs: 2_000_000 })
    expect(proxy.getMobileLoginToken).toHaveBeenCalledExactlyOnceWith({
      devicePbHex: 'bb',
      currentToken: 'MOB_ESK_0001',
      tsMs: 2_000_000,
    })
    expect(proxy.acquireSignToken).not.toHaveBeenCalled()
    expect(proxy.getLinuxSAToken).not.toHaveBeenCalled()
  })

  it.each(['ipad', 'iphone', 'harmonypad', 'harmony'])('%s 携带 live ESK 时跳过重建 ESK, 只走 getMobileLoginToken', async (name) => {
    h.protocol = name
    const proxy = makeProxy()
    await useProxy(proxy)
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000)
    const esk = { token: 'MOB_ESK_LIVE', ttlSecs: 3600, expiresAt: 5_600_000 }

    const r = await acquireSignToken(10001, 'V1_MOBILE', esk, { currentToken: 'MOB_ESK_LIVE' })

    expect(r).toEqual({ token: 'MOB_SA2_0002', ttlSecs: 5400 })
    expect(proxy.getMobileEskToken).not.toHaveBeenCalled()
    expect(proxy.getMobileLoginToken).toHaveBeenCalledExactlyOnceWith({
      devicePbHex: 'bb',
      currentToken: 'MOB_ESK_LIVE',
      tsMs: 2_000_000,
    })
    expect(proxy.acquireSignToken).not.toHaveBeenCalled()
  })

  it('macos 无缓存时先建 ESK, 再由 native 完成登录 token 流程', async () => {
    h.protocol = 'macos'
    const proxy = makeProxy()
    await useProxy(proxy)
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000)

    const r = await acquireSignToken(10001, 'V1_MAC_NQ_7.0.0_52194_GW_B')

    expect(r).toEqual({ token: 'LOGIN_TOKEN1', ttlSecs: 7200 })
    expect(proxy.getLinuxSAToken).not.toHaveBeenCalled()
    expect(proxy.acquireSignToken).not.toHaveBeenCalled()

    expect(proxy.getMacosEskToken).toHaveBeenCalledExactlyOnceWith({ devicePbHex: 'aa', tsMs: 1_000_000 })
    expect(proxy.getMacosLoginToken).toHaveBeenCalledExactlyOnceWith({ devicePbHex: 'aa', tsMs: 1_000_000 })
    expect(proxy.getMacosEskToken.mock.invocationCallOrder[0]).toBeLessThan(proxy.getMacosLoginToken.mock.invocationCallOrder[0])
  })

  it('macos 带着 ESK 状态只取登录 token, 不重建 ESK 或向 native 传回通道密钥', async () => {
    h.protocol = 'macos'
    const proxy = makeProxy()
    await useProxy(proxy)
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    const esk = { token: 'ESK_TOKEN_09', ttlSecs: 3600, expiresAt: Date.now() + 3_600_000 }

    const r = await acquireSignToken(10001, 'V1_MAC_NQ_7.0.0_52194_GW_B', esk)

    expect(r).toEqual({ token: 'LOGIN_TOKEN1', ttlSecs: 7200 })
    expect(proxy.getMacosEskToken).not.toHaveBeenCalled()
    expect(proxy.getMacosLoginToken).toHaveBeenCalledExactlyOnceWith({ devicePbHex: 'aa', tsMs: 1_000_000 })
    expect(proxy.getLinuxSAToken).not.toHaveBeenCalled()
    expect(proxy.acquireSignToken).not.toHaveBeenCalled()
  })

  it('macos ESK 解不出 TTL (0) 时回落 24h, 过期时间按它算', async () => {
    h.protocol = 'macos'
    const proxy = makeProxy()
    await useProxy(proxy)
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000)

    const esk = await acquireMacosEskOnly('V1_MAC_NQ_7.0.0_52194_GW_B')

    expect(esk).toEqual({ token: 'ESK_TOKEN_01', ttlSecs: DAY, expiresAt: 1_000_000 + DAY * 1000 })
    expect(proxy.getMacosEskToken).toHaveBeenCalledExactlyOnceWith({ devicePbHex: 'aa', tsMs: 1_000_000 })
    expect(proxy.getMacosLoginToken).not.toHaveBeenCalled()
  })

  it.each([false, true])('macos 登录 token 为空时保留 ESK token 和 TTL (已有缓存=%s)', async (cached) => {
    h.protocol = 'macos'
    const proxy = makeProxy({
      getMacosEskToken: vi.fn(async () => ({ token: 'ESK_TOKEN_09', ttlSecs: 3600 })),
      getMacosLoginToken: vi.fn(async () => ({ token: '', ttlSecs: 0 })),
    })
    await useProxy(proxy)
    const esk = cached ? { token: 'ESK_TOKEN_09', ttlSecs: 3600, expiresAt: Date.now() + 3_600_000 } : undefined

    await expect(acquireSignToken(10001, 'V1_MAC_NQ_7.0.0_52194_GW_B', esk)).resolves.toEqual({ token: 'ESK_TOKEN_09', ttlSecs: 3600 })

    expect(proxy.getMacosEskToken).toHaveBeenCalledTimes(cached ? 0 : 1)
    expect(proxy.getMacosLoginToken).toHaveBeenCalledTimes(1)
    expect(proxy.acquireSignToken).not.toHaveBeenCalled()
  })

  it('macos 明确拒绝缺少新登录 token 接口的 native 包', async () => {
    h.protocol = 'macos'
    const proxy = makeProxy({ getMacosLoginToken: undefined })
    await useProxy(proxy)

    await expect(acquireSignToken(10001, 'V1_MAC_NQ_7.0.0_52194_GW_B')).rejects.toThrow('缺 macOS o3 token 方法')

    expect(proxy.getMacosEskToken).not.toHaveBeenCalled()
    expect(proxy.acquireSignToken).not.toHaveBeenCalled()
  })
})
