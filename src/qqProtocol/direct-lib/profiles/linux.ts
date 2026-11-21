import type { ProtocolProfile } from './types'

// Windows / macOS 同一把
const WTLOGIN_SERVER_PUB_192K1 = Buffer.from(
  '04928D8850673088B343264E0C6BACB8496D697799F37211DEB25BB73906CB089FEA9639B4E0260498B51A992D50813DA8',
  'hex',
)

// Linux QQNT 3.2.35-54395。溯源: LuckyLillia.Sign docs/Linux/appinfo-cross-platform.md §8
// (54395 实测表) + src/Linux/PoC/src/appinfo.rs (54395 全表, traces/qq-3.2.35-passive
// 20 帧抓包实证) + Bot crates/common/src/profile/profiles.rs::linux() (实跑同款)。
export const LINUX_PROFILE: ProtocolProfile = {
  name: 'linux',
  family: 'nt',

  appId: 1600001615,
  // 0x2008216F: major.node QQAppId/537403759 + proto12 head +4 20 帧实抓一致
  // (3.2.28 是 537352510; sign-v2.md 旧文档的 537391511 是错的)
  subAppId: 537403759,
  appIdQrCode: 0x200000013,
  mainSigMap: 169742560,
  subSigMap: 0x10400,
  miscBitmap: 32764,
  miscBitmapT116: 12058620,
  ssoVersion: 19,
  ssoVersionTransEmp: 19,
  appClientVersion: 54395,
  qua: 'V1_LNX_NQ_3.2.35_54395_GW_B',
  packageName: 'com.tencent.qq',
  ptVersion: '2.0.0',
  wtLoginSdk: 'nt.wtlogin.0.0.1',
  ntLoginType: 1,
  currentVersion: '3.2.35-54395',
  buildVer: '3.2.35-54395',
  sdkBuildTime: 0,

  os: 'Linux',
  kernel: 'Linux',
  vendorOs: 'linux',
  devType: 'Linux',
  osVer: 'Ubuntu 22.04 LTS',
  // SsoInfoSync device f3 = `uname -v`, not `uname -r`
  systemKernel: '#1 SMP Tue Nov 5 00:21:55 UTC 2024',
  vendorName: '',
  vendorOsName: 'linux',
  imPlat: 1,

  wtLoginCurve: 'secp192k1',
  wtLoginCipherSuite: 0x0102,
  wtLoginServerPub: WTLOGIN_SERVER_PUB_192K1,

  // 真机帧头 `1300 003374`: frameVer 是固定的 0x3374, 不是 appClientVersion
  // (3.2.28 / 3.2.35 两代抓包一致, 54395 20 帧实证)
  wtLoginFrameByte: 19,
  wtLoginFrameVer: 13172,

  ssoProtocolVersion: 12,
  // 3.2.35 SSO head 槽位 (traces/qq-3.2.35-passive 20 帧实抓): +8 槽不再是 3.2.28 时代的
  // 2052 而是 o3 appid 0x20027635 (与 macOS 同值, wrapper.node 烘死); 12B 固定头
  // [01 0x00*9 03 00] (3.2.28 桌面默认是 [02 0x00*11]); head i16 版本槽真机发空串, 不填 buildVer。
  ssoHeadField12: 0x20027635,
  ssoFixedHeader: Buffer.from([0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x03, 0x00]),
  ssoHeadVersion: '',
  reserveVariant: 'linux',
}

export { WTLOGIN_SERVER_PUB_192K1 }
