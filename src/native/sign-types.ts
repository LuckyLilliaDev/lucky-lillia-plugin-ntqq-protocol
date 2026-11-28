export interface NativeSign {
  init(args: InitArgs, sendPacket: (p: RelayPacket) => Promise<Buffer>, logger: (log: SignLog) => void): Promise<void>
  ping(): string
  setAuthToken(authToken: string): Promise<void>
  setMachineGuid?(guidHex: string): void
  setUin?(uin: number): Promise<void>
  preflight(): Promise<string | null>
  /** 401/403 不 exit。返回 "valid" / "invalid" / "retry:<reason>" */
  validateAuthToken?(args: ValidateAuthTokenArgs): Promise<string>
  signRequest(args: SignRequestArgs): Promise<SignResultJs>
  acquireSignToken(args: AcquireSignTokenArgs): Promise<AcquireSignTokenResult>
  postEnvelope(args: PostEnvelopeArgs): Promise<string>
  /** ESK 拿 token1, 再 SA 换 token2 返回; 包走 bot 自己的 SSO, 不经 manager */
  getLinuxSAToken?(args: LinuxEskTokenArgs): Promise<LinuxTokenResult>
  getWindowsQimei?(args: { guidHex: string }): Promise<string>
  getWindowsEskToken?(args: { guidHex: string; qimei36: string; qua: string; uin: number }): Promise<{ token: string; ttlSecs: number }>
  startSsoReportLinux?(args: StartSsoReportLinuxArgs): Promise<void>
  stopSsoReport?(): void
  /** body 恒定, 每帧只有 sign 不同。reportId 默认是跨装机常量 "0df00071646" */
  buildXwidBody?(qua: string, reportId?: string | null): Buffer
  /** 一次调用签 count 条, 省掉逐条 signRequest 的 NAPI 往返 */
  signXwidBurst?(args: SignRequestArgs, count: number): Promise<SignResultJs[]>
  // ---- macOS o3: 本地组包, 只借 sendPacket 走 bot 的 SSO ----
  /** StarTrail 取号必须走本机出口: 服务端代取会把所有设备注册在同一个 IP */
  getMacosQimei?(args: MacosQimeiArgs): Promise<MacosQimeiResult>
  /** 34 字段的设备指纹, o3 各步共用 */
  buildMacosDevicePb?(args: MacosDevicePbArgs): string
  /** 登录前 ESK 拿 token1; 通道密钥只留在 .node 里 */
  getMacosEskToken?(args: MacosEstablishArgs): Promise<MacosTokenResult>
  /** 登录后 A2Establish + A2Access, 复用缓存的 ESK 通道 */
  getMacosLoginToken?(args: MacosEstablishArgs): Promise<MacosTokenResult>
  /** 一次性爆发 (sec_init + channel_report + env_detect + login), 不用 stop */
  startSsoReportMacos?(args: StartSsoReportMacosArgs): Promise<void>
  /** SsoKeyExchange + SsoNTLoginEasyLogin, 用存档的 0x106 刷新 d2 / d2key / tgt / 0x106。失败不抛, success=false */
  macosEasyLogin?(args: MacosEasyLoginArgs): Promise<MacosEasyLoginResult>
  // ---- Mobile (iOS / HarmonyOS): QIMEI / device_pb / O3 token 全留在 .node 内 ----
  /** HarmonyOS 在线取号 (走本机网络出口), 进程级缓存 */
  getHarmonyQimei?(args: HarmonyQimeiArgs): Promise<HarmonyQimeiResult>
  /** 回填磁盘持久化的 HarmonyOS qimei 到进程级缓存 */
  setHarmonyQimei?(args: SetHarmonyQimeiArgs): void
  /** 在原生模块内组装 iOS / HarmonyOS device_pb 并派生 iOS qimei36 */
  buildMobileDevicePb?(args: MobileDevicePbArgs): MobileDevicePbResult
  /** 移动端登录前 ESK 拿 token1; O3 通道密钥留在 .node 内 */
  getMobileEskToken?(args: MobileEstablishArgs): Promise<MobileTokenResult>
  /** 移动端登录后 A2Establish + A2Access 换取/续期 token2 */
  getMobileLoginToken?(args: MobileLoginTokenArgs): Promise<MobileTokenResult>
  /** 连接断开时清理 .node 内缓存的移动端 O3 通道 */
  clearMobileO3Channel?(): void
}

export interface LinuxEskTokenArgs {
  /** 选 ProtocolVersion 用 (拿 ESK field4 的 xwid 常量)。 */
  qua: string
}

export interface LinuxTokenResult {
  /** 12B ASCII token; 解不出是空串而不是报错。 */
  token: string
  /** ESK 响应 field 3 的 TTL(秒); 没解析到是 0 —— 调用方别直接拿 0 算过期时间。 */
  ttlSecs: number
  /** 诊断用, 不参与过期计算: ESK 内层 field2 */
  eskInnerF2?: number
  /** 诊断用: ESK 内层 field3, 是相对 TTL 还是绝对时间戳待定 */
  eskInnerF3?: number
  /** 诊断用: ESK 内层 field4 里跟 token 同级的时间戳 */
  eskInnerTokenTs?: number
}

export interface StartSsoReportLinuxArgs {
  qua: string
  guidHex: string
  uin: string
  reportId?: string
  loginXwidBurst?: number
  verifyFileIntervalMs?: number
  uiReportMetric?: string
}

export interface MacosQimeiArgs {
  seedHex: string
  appKey?: string
  /** Entry QUA, drives the reported app_version; without it the crate default won't match the device_pb QUA. */
  qua?: string
}

export interface MacosQimeiResult {
  qimei36: string
  /** macOS schema 下 StarTrail 不返这个, 基本恒空。别依赖。 */
  qimei16: string
}

export interface MacosDevicePbArgs {
  seedHex: string
  qua: string
  q36: string
}

export interface MacosEstablishArgs {
  devicePbHex: string
  /** 毫秒时间戳; 不传 = .node 用当前时间。 */
  tsMs?: number
}

export interface MacosTokenResult {
  /** 12B token; 解不出是空串而不是报错 */
  token: string
  ttlSecs: number
}

export interface StartSsoReportMacosArgs {
  /** 32-hex, 与登录 / device_pb 同源 */
  guidHex: string
  qimei36: string
  uin: string
  /** QQ.app 的 Contents/Resources/app 绝对路径; 缺省 /Applications/QQ.app/Contents/Resources/app。 */
  appDir?: string
}

export interface MacosEasyLoginArgs {
  uin: string
  /** 32-hex 设备 guid (前 16B 进 KEX / EasyLogin body)。 */
  guidHex: string
  /** 存档 TLV 0x106 凭证 hex (= session.tempPassword, 登录响应 0x119 内层 0x106)。 */
  a1106Hex: string
  /** 稳定设备种子 hex (= machine guid; 派生 serial/osver, 与 device_pb 同源)。 */
  seedHex: string
  qua: string
  /** 不影响 serial */
  q36?: string
}

export interface MacosEasyLoginResult {
  /** false 时其余字段为空 */
  success: boolean
  d2Hex: string
  /** 注意 napi 命名: 数字后首字母大写, 故 d2key_hex -> d2KeyHex (跟 SessionInfo.d2Key 一致)。 */
  d2KeyHex: string
  tgtHex: string
  /** 刷新后的 TLV 0x106 凭证 hex (存回 session 供下次 EasyLogin)。 */
  a1106Hex: string
}

export interface InitArgs {
  botVersion: string
  /** manager JWT. */
  authToken: string
  /** 16B device GUID hex (32 chars). 跟 wtlogin client.guid 同源. */
  machineGuidHex: string
  /** 没有的话 原生模块等登录后绑定 */
  uin?: number
  /** "cf" (默认) / "china" */
  cdn?: string
}

export interface RelayPacket {
  cmd: string
  body: Buffer
  /** 本命令 SecInfo sf2 的签名 token, 只有 SA 带 (token1); 缺省用 session 的 token */
  signToken?: string
}

/** level: "warn" / "error"。401/403 时 SDK 报 error 后会 exit */
export interface SignLog {
  level: string
  message: string
}

export interface ValidateAuthTokenArgs {
  authToken: string
  /** "cf" (默认) / "china"; dev build 忽略 */
  cdn?: string
}

export interface SignRequestArgs {
  cmd: string
  bodyHex: string
  seq: number
  guidHex: string
  qua: string
  uin: number
  /** QQ 12B session token 的 utf-8 hex (登录后由 acquireSignToken 拿到). 登录前传 "". */
  protocolTokenHex: string
  /**
   * 仅 watch: 32B per-install GUID 的 hex。不传后端就用空 blob, 即模拟器身份, 会被真机服务器拒。
   * napi 对未知字段静默丢弃: 加字段必须重编 .node 并 sync:plugin, 否则传了也白传
   */
  device32Hex?: string
}

export interface SignResultJs {
  sign: Buffer
  token: Buffer
  extra: Buffer
}

export interface AcquireSignTokenArgs {
  uin: number
  qua: string
}

/** acquireSignToken 返回: 12B token + QQ 下发的 TTL(秒, 0 = native 没解析到 ESK field 3). */
export interface AcquireSignTokenResult {
  token: Buffer
  ttlSecs: number
}

export interface PostEnvelopeArgs {
  path: string
  plaintextJson: string
}

export interface HarmonyQimeiArgs {
  seedHex: string
  isPhone: boolean
  qua: string
  model?: string
  osVer?: string
  appKey?: string
}

export interface HarmonyQimeiResult {
  qimei36: string
  qimei16: string
}

export interface SetHarmonyQimeiArgs {
  seedHex: string
  isPhone: boolean
  qimei36: string
  qimei16?: string
}

export interface MobileDevicePbArgs {
  platform: 'ios' | 'harmony'
  isPhone: boolean
  seedHex: string
  qua: string
  packageName: string
  ptVersion: string
  buildVer: string
  deviceName: string
  model: string
  osVer: string
  q36?: string
  xwid?: string
  vendorName?: string
  screenMetrics?: string[]
}

export interface MobileDevicePbResult {
  devicePbHex: string
  qimei36: string
}

export interface MobileEstablishArgs {
  devicePbHex: string
  tsMs?: number
}

export interface MobileLoginTokenArgs {
  devicePbHex: string
  currentToken?: string
  tsMs?: number
}

export interface MobileTokenResult {
  token: string
  ttlSecs: number
}
