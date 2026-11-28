import type { ProtocolProfile } from './types'
import { WTLOGIN_SERVER_PUB_192K1 } from './linux'

// HarmonyOS QQ 9.2.71 (versionCode 3494, build 7230) constants verified from qq_decrypted.hap.
// Source: LuckyLillia.Sign/src/Harmony/PoC/src/appinfo.rs.
const HARMONY_SSO_HEAD_FIELD12 = 0x20027635
const HARMONY_SSO_FIXED_HEADER = Buffer.from([0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x03, 0x00])

function makeHarmonyProfile(isPhone: boolean): ProtocolProfile {
  return {
    name: isPhone ? 'harmony' : 'harmonypad',
    family: 'harmony',
    loginMethod: 'password',

    appId: 16,
    subAppId: isPhone ? 537390531 : 537390542, // 0x2007EDC3 (Phone) / 0x2007EDCE (Pad)
    appIdQrCode: 16,
    mainSigMap: 169742560,
    subSigMap: 0x10400,
    miscBitmap: 0x7ffc,
    miscBitmapT116: 12058620,
    ssoVersion: 22,
    ssoVersionTransEmp: 22,
    appClientVersion: 3494,
    qua: 'V1_HAR_SQ_9.2.71_3494_APP_D',
    packageName: 'com.tencent.mqq',
    ptVersion: '9.2.71',
    wtLoginSdk: '6.0.0.2564',
    ntLoginType: 1,
    currentVersion: '7230',
    buildVer: '7230',
    sdkBuildTime: 0,

    os: 'HarmonyOS',
    kernel: 'OpenHarmony',
    vendorOs: 'ohos',
    devType: isPhone ? 'phone' : 'tablet',
    osVer: 'HarmonyOS 5.0.0',
    systemKernel: 'HarmonyOS 5.0.0',
    vendorName: 'HUAWEI',
    vendorOsName: 'ohos',
    imPlat: 1,

    wtLoginCurve: 'secp192k1',
    wtLoginCipherSuite: 0x0102,
    wtLoginServerPub: WTLOGIN_SERVER_PUB_192K1,
    wtLoginFrameByte: 19,
    wtLoginFrameVer: 0x3374,

    ssoProtocolVersion: 12,
    ssoHeadField12: HARMONY_SSO_HEAD_FIELD12,
    ssoFixedHeader: HARMONY_SSO_FIXED_HEADER,
    ssoHeadVersion: '',
    reserveVariant: 'harmony',

    mobile: {
      isPhone,
      ntAppName: 'com.tencent.qq',
      ntPlatform: 8,
      ntDeviceType: 'PLATFORM_HARMONY',
      defaultModel: isPhone ? 'HUAWEI Mate 60 Pro' : 'HUAWEI MatePad Pro',
      defaultOsVer: '5.0.0',
      screenMetrics: isPhone ? ['2720', '1260', '480'] : ['2800', '1840', '480'],
      osDisplayPrefix: 'HarmonyOS',
    },
  }
}

export const HARMONY_PAD_PROFILE: ProtocolProfile = makeHarmonyProfile(false)
export const HARMONY_PHONE_PROFILE: ProtocolProfile = makeHarmonyProfile(true)
