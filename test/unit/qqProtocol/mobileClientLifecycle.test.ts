import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Verify mobile (iOS / HarmonyOS) DirectProtocolClient delegates O3 ESK/SA2 to native .node,
// binds UIN via native.setUin, clears native O3 channel on close, and propagates token1 -> token2.

const h = vi.hoisted(() => ({
  protocol: 'ipad' as 'ipad' | 'iphone' | 'harmonypad' | 'harmony',
  setUin: vi.fn(async (_uin: number) => {}),
}))

vi.mock('../../../src/support/utils/environment', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/support/utils/environment')>()),
  getProtocol: () => h.protocol,
}))

vi.mock('../../../src/qqProtocol/direct-lib/machineGuid', () => ({
  loadMachineGuidSync: () => Buffer.alloc(16, 0x33),
}))

vi.mock('../../../src/native', () => ({
  getNativeAddon: () => ({
    setUin: h.setUin,
  }),
}))

vi.mock('../../../src/qqProtocol/direct-lib/mobile/device', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../src/qqProtocol/direct-lib/mobile/device')>()
  return {
    ...orig,
    getMobileDevice: vi.fn(async (profile: { name: string }, guid: Buffer) => ({
      guid,
      guidHex: guid.toString('hex'),
      qimei36: '11223344556677889900aabbccddeeff1234',
      xwid: '',
      devicePbHex: '0a03120132',
      deviceName: `LuckyLillia-${profile.name}`,
      osVer: profile.name.startsWith('i') ? '18.3' : '5.0.0',
      model: profile.name === 'ipad' ? 'iPad14,5' : 'HUAWEI MatePad Pro',
    })),
  }
})

vi.mock('../../../src/qqProtocol/direct-lib/sign', () => ({
  requestSign: vi.fn(async () => ({
    sign: Buffer.alloc(54, 0xee),
    token: Buffer.alloc(0),
    extra: Buffer.alloc(16, 0xdd),
  })),
  setupSign: vi.fn(async () => {}),
  setSignMachineGuid: vi.fn(),
  acquireSignToken: vi.fn(async () => ({ token: 'SA2_TOK_3333', ttlSecs: 5400 })),
  acquireMacosEskOnly: vi.fn(),
  acquireMobileEskOnly: vi.fn(async () => ({
    token: 'ESK_TOK_1111',
    ttlSecs: 3600,
    expiresAt: Date.now() + 3_600_000,
  })),
  clearMobileO3Channel: vi.fn(),
  startLinuxSsoReport: vi.fn(async () => {}),
  stopLinuxSsoReport: vi.fn(),
  buildLinuxXwidBody: vi.fn(() => null),
  signLinuxXwidBurst: vi.fn(async () => null),
  startMacosSsoReport: vi.fn(async () => {}),
  macosEasyLogin: vi.fn(async () => null),
}))

vi.mock('../../../src/qqProtocol/direct-lib/connection', () => ({
  TcpConnection: class extends EventEmitter {
    isConnected = true
    send = vi.fn()
    connect = vi.fn(async () => {})
    disconnect = vi.fn(() => {
      this.isConnected = false
      this.emit('close')
    })
  },
}))

import { DirectProtocolClient, type SessionInfo } from '../../../src/qqProtocol/direct-lib/client'
import { _resetActiveProfileForTest } from '../../../src/qqProtocol/direct-lib/profiles'
import {
  acquireMobileEskOnly,
  acquireSignToken,
  clearMobileO3Channel,
  requestSign,
} from '../../../src/qqProtocol/direct-lib/sign'

const signMock = vi.mocked(requestSign)
const eskMock = vi.mocked(acquireMobileEskOnly)
const acquireMock = vi.mocked(acquireSignToken)
const clearO3Mock = vi.mocked(clearMobileO3Channel)

function fakeSession(): SessionInfo {
  return {
    uin: '721011692',
    uid: 'u_mobile_test',
    d2: Buffer.alloc(16, 0x01),
    d2Key: Buffer.alloc(16, 0x02),
    tgt: Buffer.alloc(16, 0x03),
    a2: Buffer.alloc(16, 0x03),
    a2Key: Buffer.alloc(16),
    sKey: Buffer.alloc(0),
  }
}

describe('Mobile (iOS / HarmonyOS) DirectProtocolClient native O3 & signing lifecycle', () => {
  beforeEach(() => {
    h.protocol = 'ipad'
    h.setUin.mockClear()
    signMock.mockClear()
    eskMock.mockClear()
    acquireMock.mockClear()
    clearO3Mock.mockClear()
    _resetActiveProfileForTest()
  })

  it.each(['ipad', 'iphone', 'harmonypad', 'harmony'] as const)(
    '%s: pre-login ESK -> KEX carries token1 -> post-login SA2 upgrades to token2 -> disconnect clears native channel',
    async (proto) => {
      h.protocol = proto
      _resetActiveProfileForTest()

      const client = new DirectProtocolClient({ authToken: 'jwt' })

      // 1. Pre-login ESK delegates to native acquireMobileEskOnly
      await client.acquirePreLoginToken()
      expect(eskMock).toHaveBeenCalledTimes(1)
      expect(acquireMock).not.toHaveBeenCalled()

      // 2. Bind target UIN before NTLogin -> calls native.setUin
      await client.bindSignUin('721011692')
      expect(h.setUin).toHaveBeenCalledWith(721011692)

      // 3. Pre-login KEX signs with token1 & bound uin
      signMock.mockResolvedValueOnce(null)
      await client.sendCommand('trpc.login.ecdh.EcdhService.SsoKeyExchange', Buffer.from([1, 2, 3])).catch(() => {})
      expect(signMock).toHaveBeenLastCalledWith(
        'trpc.login.ecdh.EcdhService.SsoKeyExchange',
        Buffer.from([1, 2, 3]),
        expect.any(Number),
        expect.any(Buffer),
        expect.stringMatching(/^V1_(IPH|HAR)_SQ_/),
        721011692,
        'ESK_TOK_1111',
      )

      // 4. Post-login setSession -> native acquireSignToken upgrades session token to SA2_TOK_3333
      client.setSession(fakeSession())
      await client.awaitSignTokenAcquire()
      expect(acquireMock).toHaveBeenCalledTimes(1)
      expect(acquireMock).toHaveBeenCalledWith(
        721011692,
        expect.stringMatching(/^V1_(IPH|HAR)_SQ_/),
        expect.objectContaining({ token: 'ESK_TOK_1111' }),
        expect.objectContaining({ currentToken: 'ESK_TOK_1111' }),
      )
      expect(client.getSession()?.signToken12B).toBe('SA2_TOK_3333')

      // 5. Business cmd signs with upgraded token2
      signMock.mockResolvedValueOnce(null)
      await client.sendCommand('MessageSvc.PbSendMsg', Buffer.from([9])).catch(() => {})
      expect(signMock).toHaveBeenLastCalledWith(
        'MessageSvc.PbSendMsg',
        Buffer.from([9]),
        expect.any(Number),
        expect.any(Buffer),
        expect.stringMatching(/^V1_(IPH|HAR)_SQ_/),
        721011692,
        'SA2_TOK_3333',
      )

      // 6. Disconnect clears cached native O3 channel
      client.disconnect()
      expect(clearO3Mock).toHaveBeenCalledTimes(1)
    },
  )
})
