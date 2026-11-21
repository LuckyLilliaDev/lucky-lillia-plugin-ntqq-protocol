import { describe, it, expect } from 'vitest'
import { LINUX_PROFILE } from '../../../src/qqProtocol/direct-lib/profiles/linux'

// 54395 常量表锁死, 对齐 LuckyLillia.Sign 的 PoC M0 单测 (src/Linux/PoC/src/appinfo.rs
// constants_match_54395_capture): 身份值来自 traces/qq-3.2.35-passive 20 帧实抓 +
// docs/Linux/appinfo-cross-platform.md §8, 与 Bot profiles.rs::linux() 实跑同款。
// 下次升 QQ 版本时同步本文件与 profiles/linux.ts, 常量溯源看文件头注释。

describe('LINUX_PROFILE 54395 常量表', () => {
  it('身份/版本常量与 54395 实抓一致', () => {
    expect(LINUX_PROFILE.subAppId).toBe(537403759) // 0x2008216F, proto12 head +4
    expect(LINUX_PROFILE.appClientVersion).toBe(54395)
    expect(LINUX_PROFILE.qua).toBe('V1_LNX_NQ_3.2.35_54395_GW_B')
    expect(LINUX_PROFILE.currentVersion).toBe('3.2.35-54395')
    expect(LINUX_PROFILE.buildVer).toBe('3.2.35-54395')
  })

  it('跨版本稳定的协议常量不被顺手改坏', () => {
    expect(LINUX_PROFILE.appId).toBe(1600001615)
    expect(LINUX_PROFILE.mainSigMap).toBe(169742560)
    expect(LINUX_PROFILE.subSigMap).toBe(0x10400)
    expect(LINUX_PROFILE.miscBitmapT116).toBe(12058620)
    expect(LINUX_PROFILE.ssoVersionTransEmp).toBe(19)
  })

  it('SSO head 槽位 = 54395 抓包 (区别于 3.2.28 默认形状)', () => {
    expect(LINUX_PROFILE.ssoHeadField8).toBeUndefined() // subAppId 槽用 subAppId 本身
    expect(LINUX_PROFILE.ssoHeadField12).toBe(0x20027635)
    expect(LINUX_PROFILE.ssoFixedHeader?.equals(
      Buffer.from([0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x03, 0x00]),
    )).toBe(true)
    expect(LINUX_PROFILE.ssoHeadVersion).toBe('') // 真机 head 版本槽发空串, 不填 buildVer
  })

  it('wtlogin 帧头 0x3374 固定, 不是 appClientVersion', () => {
    expect(LINUX_PROFILE.wtLoginFrameByte).toBe(19)
    expect(LINUX_PROFILE.wtLoginFrameVer).toBe(0x3374)
  })
})
