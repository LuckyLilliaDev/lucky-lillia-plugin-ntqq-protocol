import type { ProtocolProfile } from './types'
import { WTLOGIN_SERVER_PUB_192K1 } from './linux'

// iOS QQ 9.3.5 (9.3.5.609) constants verified from QQ.app/QQ (ARM64 Mach-O).
// Source: LuckyLillia.Sign/src/iOS/PoC/src/appinfo.rs.
const IOS_SSO_HEAD_FIELD12 = 0x20027635
const IOS_SSO_FIXED_HEADER = Buffer.from([0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x03, 0x00])

function makeIosProfile(isPhone: boolean): ProtocolProfile {
  return {
    name: isPhone ? 'iphone' : 'ipad',
    family: 'ios',
    loginMethod: 'password',

    appId: 16,
    subAppId: isPhone ? 537364155 : 537364166, // 0x200786BB (iPhone) / 0x200786C6 (iPad)
    appIdQrCode: 16,
    mainSigMap: 169742560,
    subSigMap: 0x10400,
    miscBitmap: 0x7ffc,
    miscBitmapT116: 12058620,
    ssoVersion: 22,
    ssoVersionTransEmp: 22,
    appClientVersion: 0,
    qua: 'V1_IPH_SQ_9.3.5_1_APP_A',
    packageName: 'com.tencent.mqq',
    ptVersion: '9.3.5',
    wtLoginSdk: '6.0.0.2564',
    ntLoginType: 1,
    currentVersion: '9.3.5.609',
    buildVer: '9.3.5.609',
    sdkBuildTime: 0,

    os: 'iOS',
    kernel: 'Darwin',
    vendorOs: 'ios',
    devType: isPhone ? 'iPhone' : 'iPad',
    osVer: isPhone ? 'iOS 18.3' : 'iPadOS 18.3',
    systemKernel: isPhone ? 'iOS 18.3' : 'iPadOS 18.3',
    vendorName: '',
    vendorOsName: 'ios',
    imPlat: 1,

    // Mobile NTLogin uses P-256 KEX (not wtlogin), keep shape compatible with ProtocolProfile.
    wtLoginCurve: 'secp192k1',
    wtLoginCipherSuite: 0x0102,
    wtLoginServerPub: WTLOGIN_SERVER_PUB_192K1,
    wtLoginFrameByte: 19,
    wtLoginFrameVer: 0x3374,

    ssoProtocolVersion: 12,
    ssoHeadField12: IOS_SSO_HEAD_FIELD12,
    ssoFixedHeader: IOS_SSO_FIXED_HEADER,
    ssoHeadVersion: '',
    reserveVariant: 'ios',

    mobile: {
      isPhone,
      ntAppName: 'com.tencent.mqq',
      ntPlatform: 1,
      defaultModel: isPhone ? 'iPhone16,2' : 'iPad14,5',
      defaultOsVer: '18.3',
      screenMetrics: isPhone ? ['1290', '2796', '460'] : ['2048', '2732', '264'],
      osDisplayPrefix: isPhone ? 'iOS' : 'iPadOS',
    },
  }
}

export const IPAD_PROFILE: ProtocolProfile = makeIosProfile(false)
export const IPHONE_PROFILE: ProtocolProfile = makeIosProfile(true)
