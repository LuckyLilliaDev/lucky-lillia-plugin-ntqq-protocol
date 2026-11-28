import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { pbBytes, pbString, pbVarint } from '../../../src/qqProtocol/direct-lib/pbCodec'
import { teaDecrypt } from '../../../src/qqProtocol/direct-lib/tea'
import { IPAD_PROFILE } from '../../../src/qqProtocol/direct-lib/profiles/ios'
import { HARMONY_PAD_PROFILE, HARMONY_PHONE_PROFILE } from '../../../src/qqProtocol/direct-lib/profiles/harmony'
import { LINUX_PROFILE } from '../../../src/qqProtocol/direct-lib/profiles/linux'
import { MACOS_PROFILE } from '../../../src/qqProtocol/direct-lib/profiles/macos'
import { WINDOWS_PROFILE } from '../../../src/qqProtocol/direct-lib/profiles/windows'
import {
  aes256GcmOpen,
  aes256GcmSeal,
  ecdhP256RawX,
  generateP256KeyPair,
  md5,
  pbFirstBytes,
  pbFirstU64,
} from '../../../src/qqProtocol/direct-lib/mobile/crypto'
import {
  NTLOGIN_ERR_NEW_DEVICE,
  NTLOGIN_ERR_PROOF_WATER,
  buildEasyLoginRequest,
  buildKexRequest,
  buildNewDeviceLoginRequest,
  buildPasswordLoginRequest,
  deriveNewDeviceQueryToken,
  extractCaptchaSid,
  generateClientA1,
  parseCaptchaChallenge,
  parseNtLoginResponse,
  unwrapEcdhForward,
  wrapEcdhForward,
  type KexSession,
} from '../../../src/qqProtocol/direct-lib/mobile/ntlogin'

const nativeMock = vi.hoisted(() => ({
  getHarmonyQimei: vi.fn(async () => ({ qimei36: 'fff2b52f191c5f3eafdf971c40001b71ab1b', qimei16: 'a1b2c3d4e5f60718' })),
  setHarmonyQimei: vi.fn(),
  buildMobileDevicePb: vi.fn((args: { platform: string; q36?: string }) => ({
    devicePbHex: args.platform === 'ios' ? '0a03120132' : '0a03120138',
    qimei36: args.q36 || (args.platform === 'ios' ? '11223344556677889900aabbccddeeff1234' : ''),
  })),
}))

vi.mock('../../../src/native', () => ({
  getNativeAddon: () => nativeMock,
}))

import { getMobileDevice, _resetMobileDeviceCacheForTest, type MobileDevice } from '../../../src/qqProtocol/direct-lib/mobile/device'

describe('Mobile crypto / native device delegation / NTLogin', () => {
  beforeEach(() => {
    nativeMock.getHarmonyQimei.mockClear()
    nativeMock.setHarmonyQimei.mockClear()
    nativeMock.buildMobileDevicePb.mockClear()
    _resetMobileDeviceCacheForTest()
  })

  it('P-256 ECDH and AES-256-GCM roundtrip cleanly', () => {
    const a = generateP256KeyPair()
    const b = generateP256KeyPair()
    const x1 = ecdhP256RawX(a.ecdh, b.pubCompressed)!
    const x2 = ecdhP256RawX(b.ecdh, a.pubUncompressed)!
    expect(x1.equals(x2)).toBe(true)

    const sealed = aes256GcmSeal(x1, Buffer.from('hello mobile'))
    expect(aes256GcmOpen(x1, sealed)?.toString('utf-8')).toBe('hello mobile')
  })

  it('delegates iOS & HarmonyOS QIMEI and device_pb construction to native .node and caches on disk', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'll-mobile-dev-'))
    try {
      const guid = Buffer.alloc(16, 0x11)
      const iosFile = join(dir, 'ipad_device.json')
      const iosDev = await getMobileDevice(IPAD_PROFILE, guid, { filePath: iosFile })
      expect(iosDev.qimei36).toBe('11223344556677889900aabbccddeeff1234')
      expect(iosDev.devicePbHex).toBe('0a03120132')
      expect(nativeMock.getHarmonyQimei).not.toHaveBeenCalled()
      expect(nativeMock.buildMobileDevicePb).toHaveBeenCalledWith(expect.objectContaining({
        platform: 'ios',
        isPhone: false,
        seedHex: guid.toString('hex'),
        qua: IPAD_PROFILE.qua,
      }))

      // HarmonyOS calls native getHarmonyQimei + buildMobileDevicePb, persists to disk, and hydrates setHarmonyQimei on reload.
      const harFile = join(dir, 'harmony_device.json')
      const harDev = await getMobileDevice(HARMONY_PHONE_PROFILE, guid, { filePath: harFile })
      expect(harDev.qimei36).toBe('fff2b52f191c5f3eafdf971c40001b71ab1b')
      expect(harDev.devicePbHex).toBe('0a03120138')
      expect(nativeMock.getHarmonyQimei).toHaveBeenCalledTimes(1)
      expect(nativeMock.getHarmonyQimei).toHaveBeenCalledWith(expect.objectContaining({
        seedHex: guid.toString('hex'),
        isPhone: true,
        qua: HARMONY_PHONE_PROFILE.qua,
      }))

      // Clear memory cache and reload from disk: must NOT re-register online, must hydrate native cache.
      _resetMobileDeviceCacheForTest()
      nativeMock.getHarmonyQimei.mockClear()
      nativeMock.buildMobileDevicePb.mockClear()
      const reloaded = await getMobileDevice(HARMONY_PHONE_PROFILE, guid, { filePath: harFile })
      expect(reloaded.qimei36).toBe('fff2b52f191c5f3eafdf971c40001b71ab1b')
      expect(reloaded.devicePbHex).toBe('0a03120138')
      expect(nativeMock.setHarmonyQimei).toHaveBeenCalledWith({
        seedHex: guid.toString('hex'),
        isPhone: true,
        qimei36: 'fff2b52f191c5f3eafdf971c40001b71ab1b',
      })
      expect(nativeMock.getHarmonyQimei).not.toHaveBeenCalled()
      expect(nativeMock.buildMobileDevicePb).not.toHaveBeenCalled()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('NTLogin KEX, client_a1, PasswordLogin, NewDeviceLogin, EasyLogin, and verify helpers match PoC', () => {
    const guid = Buffer.alloc(16, 0x42)
    const { body: kexBody } = buildKexRequest('123456789', guid, 1_700_000_000)
    expect(pbFirstBytes(kexBody, 1)?.length).toBe(65)
    expect(pbFirstU64(kexBody, 2)).toBe(1n)
    expect(pbFirstU64(kexBody, 4)).toBe(1_700_000_000n)

    // client_a1 TEA roundtrip
    const pwdMd5 = md5('secret123')
    const salt = 123456789n
    const { clientA1, s2Key } = generateClientA1('123456789', salt, 16, guid, pwdMd5, 1_700_000_000)
    const keyIn = Buffer.alloc(24)
    pwdMd5.copy(keyIn, 0)
    keyIn.writeBigUInt64BE(salt, 16)
    const a1Plain = Buffer.from(teaDecrypt(clientA1, md5(keyIn)))
    expect(a1Plain.readUInt16BE(0)).toBe(4)
    expect(a1Plain.readUInt32BE(10)).toBe(16)
    expect(a1Plain.readUInt32BE(14)).toBe(8001)
    expect(a1Plain.readBigUInt64BE(18)).toBe(salt)
    expect(a1Plain.includes(pwdMd5)).toBe(true)
    expect(a1Plain.includes(s2Key)).toBe(true)
    expect(a1Plain.includes(guid)).toBe(true)

    const kex: KexSession = { sessionKey: Buffer.alloc(32, 0x5a), sessionTicket: Buffer.from('ticket_demo') }
    const dev: MobileDevice = {
      guid,
      guidHex: guid.toString('hex'),
      qimei36: '',
      xwid: '',
      devicePbHex: '0a03120138',
      deviceName: 'HUAWEI MatePad Pro',
      osVer: '5.0.0',
      model: 'HUAWEI MatePad Pro',
    }
    const pwWire = buildPasswordLoginRequest(
      kex, HARMONY_PAD_PROFILE, dev, '123456', 'ck1', Buffer.alloc(0), clientA1,
      { ticket: 't1', randStr: '@r1', sid: '2000000038' },
      Buffer.from('succ_sig'),
    )
    const pwDec = unwrapEcdhForward(kex, pwWire)!
    const head = pbFirstBytes(pwDec, 1)!
    const body = pbFirstBytes(pwDec, 2)!
    const devPb = pbFirstBytes(head, 2)!
    expect(pbFirstBytes(devPb, 1)?.toString('utf-8')).toBe('PLATFORM_HARMONY')
    expect(pbFirstU64(devPb, 3)).toBe(8n)
    expect(pbFirstBytes(body, 3)?.toString('utf-8')).toBe('succ_sig')

    const ndWire = buildNewDeviceLoginRequest(kex, HARMONY_PAD_PROFILE, dev, '123456', 'ck1', Buffer.alloc(0), Buffer.from('succ_sig'))
    expect(pbFirstBytes(pbFirstBytes(unwrapEcdhForward(kex, ndWire)!, 2)!, 1)?.toString('utf-8')).toBe('succ_sig')

    const easyWire = buildEasyLoginRequest(kex, IPAD_PROFILE, { ...dev, model: 'iPad14,5' }, '123456', Buffer.alloc(64, 0xaa))
    const easyDec = unwrapEcdhForward(kex, easyWire)!
    expect(pbFirstU64(pbFirstBytes(pbFirstBytes(easyDec, 1)!, 2)!, 3)).toBe(1n)

    // Desktop NTLogin (Linux / macOS / Windows) uses f3 forward envelope + PLATFORM_{WINDOWS=4,MAC=5,LINUX=7}
    for (const [deskProfile, expectedPlatform] of [
      [WINDOWS_PROFILE, 4n],
      [MACOS_PROFILE, 5n],
      [LINUX_PROFILE, 7n],
    ] as const) {
      const deskWire = buildPasswordLoginRequest(
        kex,
        deskProfile,
        { guid, deviceName: 'DESKTOP-TEST01', model: deskProfile.devType },
        '123456',
        '',
        Buffer.alloc(0),
        clientA1,
      )
      expect(pbFirstBytes(deskWire, 3)).not.toBeNull()
      expect(pbFirstBytes(deskWire, 5)).toBeNull()
      const deskDec = unwrapEcdhForward(kex, deskWire)!
      const deskDevPb = pbFirstBytes(pbFirstBytes(deskDec, 1)!, 2)!
      expect(pbFirstBytes(deskDevPb, 1)?.toString('utf-8')).toBe(deskProfile.os)
      expect(pbFirstU64(deskDevPb, 3)).toBe(expectedPlatform)
      // PC PasswordLogin omits mobile LoginProcessReq f5
      expect(pbFirstBytes(pbFirstBytes(deskDec, 2)!, 5)).toBeNull()
    }

    // Parse 140022008 captcha response
    const capRespPlain = Buffer.concat([
      pbBytes(1, Buffer.concat([
        pbBytes(4, Buffer.concat([pbVarint(1, NTLOGIN_ERR_PROOF_WATER), pbString(5, 'https://ti.qq.com/safe/verify?uin=0&sid=2000000038')])),
        pbBytes(5, pbString(1, 'ck_next')),
      ])),
    ])
    const capParsed = parseNtLoginResponse(kex, wrapEcdhForward(kex, capRespPlain, '123456'))
    expect(capParsed.error?.code).toBe(NTLOGIN_ERR_PROOF_WATER)
    expect(capParsed.captchaUrl).toBe('https://ti.qq.com/safe/verify?uin=0&sid=2000000038')
    expect(capParsed.cookie).toBe('ck_next')

    // Parse 140022010 new device response
    const ndRespPlain = Buffer.concat([
      pbBytes(1, pbBytes(4, Buffer.concat([pbVarint(1, NTLOGIN_ERR_NEW_DEVICE), pbString(5, 'https://accounts.qq.com/safe?sig=s1&uin-token=u1')]))),
      pbBytes(2, pbBytes(3, Buffer.concat([pbString(1, 'fallback_sig'), pbString(4, 'fallback_utok')]))),
    ])
    const ndParsed = parseNtLoginResponse(kex, wrapEcdhForward(kex, ndRespPlain, '123456'))
    expect(ndParsed.error?.code).toBe(NTLOGIN_ERR_NEW_DEVICE)
    expect(ndParsed.newDeviceCheckSig.toString('utf-8')).toBe('fallback_sig')
    expect(ndParsed.uinToken).toBe('fallback_utok')

    // Captcha & NewDevice URL helpers
    const rawCap = 'https://ti.qq.com/safe/verify?uin=0&sid=2000000038&cap_cd=abc%2B123&login_appid=16'
    expect(parseCaptchaChallenge(rawCap, '721011692')).toEqual({
      url: 'https://ti.qq.com/safe/verify?uin=721011692&sid=2000000038&cap_cd=abc%2B123&login_appid=16',
      sid: '2000000038',
      appId: '2081081773',
      loginAppId: '16',
    })
    expect(extractCaptchaSid(rawCap)).toBe('2000000038')
    expect(deriveNewDeviceQueryToken('https://accounts.qq.com/safe/verify?foo=1&str_url=ab*cd-ef%3D%3D&bar=2')).toBe('YWIrY2QvZWY=')
  })
})
