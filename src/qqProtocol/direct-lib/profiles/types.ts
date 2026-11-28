// 每端一份协议 profile, 字段值溯源见 LuckyLillia.Sign/docs/Linux/appinfo-cross-platform.md

export type ProtocolName = 'linux' | 'windows' | 'macos' | 'watch' | 'ipad' | 'iphone' | 'harmonypad' | 'harmony'

// nt: Linux/Windows/macOS 共用 trans_emp 二维码登录 + NT SSO head + secp192k1。
// watch: Android-NT 变体 (P-256 wtlogin + watch reserve + 21 TLV + qimei36)。
// ios / harmony: 移动端 NTLogin (账号密码 + 滑块/新设备验证 + EasyLogin + 纯 TS O3 ESK/SA2)。
export type ProtocolFamily = 'nt' | 'watch' | 'ios' | 'harmony'

export type ProtocolLoginMethod = 'qr' | 'password'

// SSO reserve field 组合:
//   nt      = 现有最小集 f15(TraceParent)/16(Uid)/24(SecInfo), Windows 用
//   linux   = Linux 3.2.28/3.2.35 抓包布局
//   macos   = f9,f12,f14,f15,f16,f18-21,f23,f24,f26,f28,f34
//   watch   = nt + f12(qimei36)/21(=32)/26(=100) (Android NT marker)
//   ios     = iOS 9.3.5 布局 (f9,f12=qimei36/guid,f14,f15,f16,f18..21,f23,f24,f26=100,f28=3,f34=1)
//   harmony = HarmonyOS 9.2.71 布局 (同 iOS, f12 仅在真实 qimei36 非空时发, f21 按签名/o3 设 0/2/32/34)
export type ReserveVariant = 'nt' | 'linux' | 'macos' | 'watch' | 'ios' | 'harmony'

export type WtLoginCurve = 'secp192k1' | 'secp256r1'

export interface MobileProfileExtra {
  isPhone: boolean
  ntAppName: string
  ntPlatform: number
  ntDeviceType?: string
  defaultModel: string
  defaultOsVer: string
  screenMetrics: [string, string, string]
  osDisplayPrefix: string
}

export interface WatchProfileExtra {
  headAppId: number       // SSO head 路由 appid (537065138), 与身份 appId(16)/subAppId 不同
  loginAppId: number      // 老 wtlogin 登录 appId (世代号 16)
  apkSignMd5: Buffer      // T16 str3 / T144 用的 APK 签名 MD5
  deviceType: number      // T521 device_type (=8, Watch)
  qimeiInstanceId: string // qimei 取号 instance_id / app_key
  appKey: string
  fekitVer: string
}

export interface ProtocolProfile {
  name: ProtocolName
  family: ProtocolFamily
  loginMethod?: ProtocolLoginMethod

  // ---- 身份 / 版本 ----
  appId: number
  subAppId: number
  appIdQrCode: number   // 当前没人读
  mainSigMap: number
  subSigMap: number     // Windows=0, Linux/macOS/Watch=0x10400
  miscBitmap: number    // 死字段
  miscBitmapT116: number // buildTlv116 实际发的值 (Linux/Windows 12058620)
  ssoVersion: number         // wtlogin.login 侧 (NT=19, Watch=22)
  ssoVersionTransEmp: number // trans_emp T35/T66 侧 (Linux=19, Win/Mac=23, Watch=8)
  appClientVersion: number
  qua: string
  packageName: string
  ptVersion: string
  wtLoginSdk: string
  ntLoginType: number   // Watch 没有
  currentVersion: string
  buildVer: string
  sdkBuildTime: number  // buildTlv177 第二字段 (桌面 0, Watch 1724730201)

  // ---- 设备 / OS ----
  os: string
  kernel: string
  vendorOs: string
  devType: string
  osVer: string
  systemKernel: string  // SsoInfoSync 内核串
  vendorName: string
  vendorOsName: string
  imPlat: number        // message comm.imPlat (桌面 1)

  // ---- wtlogin ECDH ----
  wtLoginCurve: WtLoginCurve
  wtLoginCipherSuite: number // 桌面 0x0102 / watch 0x0131
  wtLoginServerPub: Buffer

  // ---- wtlogin 帧头: 服务器不较真, 仍按各端真机值填 ----
  wtLoginFrameByte: number   // Linux 19 / Windows,macOS 23
  wtLoginFrameVer: number    // 桌面各端都是 0x3374, 不是 appClientVersion

  // ---- SSO head ----
  ssoProtocolVersion: number  // inner frame 版本字节: NT=12, Watch=10
  ssoHeadField8?: number      // 覆盖 subAppId 槽 (macOS 0x2007C26B); undefined=用 subAppId
  ssoHeadField12?: number     // 覆盖 2052 槽 (macOS / Linux 3.2.35+ = 0x20027635); undefined=用 2052
  ssoFixedHeader?: Buffer     // 覆盖 FIXED_HEADER (macOS [01..01 00] / Linux 3.2.35 [01..03 00]); undefined=用默认
  ssoHeadVersion?: string     // 覆盖 head i16 version 槽 (Watch 'testrevision'; Linux 3.2.35 真机发空串); undefined=用 ctx.buildVer
  reserveVariant: ReserveVariant

  // ---- watch 专属 ----
  watch?: WatchProfileExtra

  // ---- iOS / HarmonyOS 移动端专属 ----
  mobile?: MobileProfileExtra
}
