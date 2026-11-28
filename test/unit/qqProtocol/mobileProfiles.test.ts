import { describe, it, expect, afterEach, vi } from 'vitest'
import { IPAD_PROFILE, IPHONE_PROFILE } from '../../../src/qqProtocol/direct-lib/profiles/ios'
import { HARMONY_PAD_PROFILE, HARMONY_PHONE_PROFILE } from '../../../src/qqProtocol/direct-lib/profiles/harmony'
import { PROFILES, _resetActiveProfileForTest, isMobileFamily, isMobileProtocol } from '../../../src/qqProtocol/direct-lib/profiles'
import { cmdNeedsSign } from '../../../src/qqProtocol/direct-lib/cmd'
import { buildIosReservedField, buildHarmonyReservedField } from '../../../src/qqProtocol/direct-lib/ssoReserved'
import { buildSsoInfoSync } from '../../../src/qqProtocol/direct-lib/online'
import { pbFirstBytes, pbFirstU64, pbIter } from '../../../src/qqProtocol/direct-lib/mobile/crypto'
import { getProtocol } from '../../../src/support/utils/environment'
import { NTProtocolSchema } from '../../../src/settings'

describe('iOS & HarmonyOS 协议常量表与白名单', () => {
  afterEach(() => {
    vi.mocked(getProtocol).mockReturnValue('linux')
    _resetActiveProfileForTest()
  })

  it('四端移动端 profile 常量与逆向 PoC 逐项一致', () => {
    expect(IPAD_PROFILE).toMatchObject({
      name: 'ipad',
      family: 'ios',
      loginMethod: 'password',
      appId: 16,
      subAppId: 537364166,
      qua: 'V1_IPH_SQ_9.3.5_1_APP_A',
      packageName: 'com.tencent.mqq',
      ptVersion: '9.3.5',
      buildVer: '9.3.5.609',
      ssoHeadField12: 0x20027635,
      ssoHeadVersion: '',
      reserveVariant: 'ios',
    })
    expect(IPHONE_PROFILE.subAppId).toBe(537364155)
    expect(IPHONE_PROFILE.qua).toBe('V1_IPH_SQ_9.3.5_1_APP_A')
    expect(IPHONE_PROFILE.mobile?.isPhone).toBe(true)

    expect(HARMONY_PAD_PROFILE).toMatchObject({
      name: 'harmonypad',
      family: 'harmony',
      loginMethod: 'password',
      appId: 16,
      subAppId: 537390542,
      qua: 'V1_HAR_SQ_9.2.71_3494_APP_D',
      packageName: 'com.tencent.mqq',
      ptVersion: '9.2.71',
      buildVer: '7230',
      ssoHeadField12: 0x20027635,
      ssoHeadVersion: '',
      reserveVariant: 'harmony',
    })
    expect(HARMONY_PHONE_PROFILE.subAppId).toBe(537390531)
    expect(HARMONY_PHONE_PROFILE.qua).toBe('V1_HAR_SQ_9.2.71_3494_APP_D')
    expect(HARMONY_PHONE_PROFILE.mobile?.ntPlatform).toBe(8)
    expect(HARMONY_PHONE_PROFILE.mobile?.ntAppName).toBe('com.tencent.qq')

    for (const id of ['ipad', 'iphone', 'harmonypad', 'harmony'] as const) {
      expect(PROFILES[id]).toBeDefined()
      expect(isMobileProtocol(id)).toBe(true)
      expect(isMobileFamily(PROFILES[id]!.family)).toBe(true)
      expect(NTProtocolSchema({ mode: 'direct', protocol: id }).protocol).toBe(id)
    }
  })

  it('iOS 与 HarmonyOS 签名白名单包含登录 / O3 / 业务命令与 iOS TrpcProxy 前缀', () => {
    for (const ios of ['ipad', 'iphone'] as const) {
      expect(cmdNeedsSign('trpc.o3.ecdh_access.EcdhAccess.SsoEstablishShareKey', ios)).toBe(true)
      expect(cmdNeedsSign('trpc.o3.ecdh_access.EcdhAccess.SsoSecureA2Access', ios)).toBe(true)
      expect(cmdNeedsSign('trpc.login.ecdh.EcdhService.SsoKeyExchange', ios)).toBe(true)
      expect(cmdNeedsSign('trpc.login.ecdh.EcdhService.SsoNTLoginPasswordLogin', ios)).toBe(true)
      expect(cmdNeedsSign('trpc.login.ecdh.EcdhService.SsoNTLoginPasswordLoginNewDevice', ios)).toBe(true)
      expect(cmdNeedsSign('MessageSvc.PbSendMsg', ios)).toBe(true)
      expect(cmdNeedsSign('trpc.qlive.qlive_proxy_svr.TrpcProxy.CustomCall', ios)).toBe(true)
      expect(cmdNeedsSign('Client.CorrectTime', ios)).toBe(false)
    }
    for (const har of ['harmonypad', 'harmony'] as const) {
      expect(cmdNeedsSign('trpc.o3.ecdh_access.EcdhAccess.SsoEstablishShareKey', har)).toBe(true)
      expect(cmdNeedsSign('trpc.o3.ecdh_access.EcdhAccess.SsoSecureA2Establish', har)).toBe(true)
      expect(cmdNeedsSign('trpc.login.ecdh.EcdhService.SsoNTLoginPasswordLogin', har)).toBe(true)
      expect(cmdNeedsSign('trpc.login.ecdh.EcdhService.SsoNTLoginEasyLogin', har)).toBe(true)
      expect(cmdNeedsSign('OidbSvcTrpcTcp.0xfd4_1', har)).toBe(true) // ShortSign cmd
      expect(cmdNeedsSign('MessageSvc.PbSendMsg', har)).toBe(true) // LongSign cmd
      expect(cmdNeedsSign('Client.CorrectTime', har)).toBe(false)
    }
  })

  it('iOS 与 HarmonyOS reserve 字段布局精确对齐 PoC', () => {
    const sec = { sign: Buffer.alloc(54, 0xaa), token: Buffer.from('tok123456789'), extra: Buffer.alloc(16, 0xbb) }

    // iOS O3 packet: no f14, no f15, no f16, f21=0
    const iosO3 = buildIosReservedField('trpc.o3.ecdh_access.EcdhAccess.SsoEstablishShareKey', 'q36_demo', 'u_1', 1700000000, sec)
    expect(pbFirstU64(iosO3, 9)).toBe(1n)
    expect(pbFirstBytes(iosO3, 12)?.toString('utf-8')).toBe('q36_demo')
    expect(pbFirstU64(iosO3, 14)).toBeNull()
    expect(pbFirstBytes(iosO3, 15)).toBeNull()
    expect(pbFirstBytes(iosO3, 16)).toBeNull()
    expect(pbFirstU64(iosO3, 21)).toBe(0n)
    expect(pbFirstU64(iosO3, 26)).toBe(100n)
    expect(pbFirstU64(iosO3, 28)).toBe(3n)
    expect(pbFirstU64(iosO3, 34)).toBe(1n)
    expect(pbFirstBytes(iosO3, 24)).not.toBeNull()

    // HarmonyOS signed business packet vs O3 vs unsigned: f21 = 34 / 32 / 2, empty qimei36 omits f12
    const harBiz = buildHarmonyReservedField('MessageSvc.PbSendMsg', 'har_qimei36', 'u_har', 1700000000, sec)
    expect(pbFirstBytes(harBiz, 12)?.toString('utf-8')).toBe('har_qimei36')
    expect(pbFirstU64(harBiz, 14)).toBe(1n)
    expect(pbFirstBytes(harBiz, 15)?.toString('utf-8')).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
    expect(pbFirstBytes(harBiz, 16)?.toString('utf-8')).toBe('u_har')
    expect(pbFirstU64(harBiz, 21)).toBe(34n)

    const harO3Signed = buildHarmonyReservedField('trpc.o3.ecdh_access.EcdhAccess.SsoEstablishShareKey', '', 'u_har', 1700000000, sec)
    expect(pbFirstBytes(harO3Signed, 12)).toBeNull()
    expect(pbFirstU64(harO3Signed, 21)).toBe(32n)

    const harUnsigned = buildHarmonyReservedField('Client.CorrectTime', '', '', 1700000000, null)
    expect(pbFirstU64(harUnsigned, 21)).toBe(2n)
  })

  it('SsoInfoSync 对 iOS 与 HarmonyOS 产出移动端 RegisterDeviceInfo 与扩展字段', () => {
    const guid = Buffer.alloc(16, 0x07)

    vi.mocked(getProtocol).mockReturnValue('ipad')
    _resetActiveProfileForTest()
    const iosSync = buildSsoInfoSync(guid)
    expect(pbIter(iosSync).map(f => f.field)).toEqual([1, 2, 4, 5, 6, 8, 9, 10, 11, 13])
    const iosRi = pbFirstBytes(iosSync, 9)!
    expect(pbFirstBytes(iosRi, 3)?.toString('utf-8')).toBe('9.3.5.609')
    expect(pbFirstU64(iosRi, 16)).toBe(7n)
    const iosRdi = pbFirstBytes(iosRi, 6)!
    expect(pbFirstBytes(iosRdi, 2)?.toString('utf-8')).toBe('Darwin')
    expect(pbFirstBytes(iosRdi, 3)?.toString('utf-8')).toBe('iPadOS 18.3')
    expect(pbFirstBytes(iosRdi, 5)?.toString('utf-8')).toBe('ios')

    vi.mocked(getProtocol).mockReturnValue('harmony')
    _resetActiveProfileForTest()
    const harSync = buildSsoInfoSync(guid)
    const harRi = pbFirstBytes(harSync, 9)!
    expect(pbFirstBytes(harRi, 3)?.toString('utf-8')).toBe('7230')
    const harRdi = pbFirstBytes(harRi, 6)!
    expect(pbFirstBytes(harRdi, 2)?.toString('utf-8')).toBe('OpenHarmony')
    expect(pbFirstBytes(harRdi, 3)?.toString('utf-8')).toBe('HarmonyOS 5.0.0')
    expect(pbFirstBytes(harRdi, 4)?.toString('utf-8')).toBe('HUAWEI')
    expect(pbFirstBytes(harRdi, 5)?.toString('utf-8')).toBe('ohos')
  })
})
