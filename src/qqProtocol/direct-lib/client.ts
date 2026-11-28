import { getLogger, isDebugEnabled } from '../../support/logger'
import { TcpConnection } from './connection'
import { buildServicePacket, buildServicePacket13, parseServicePacket, EncryptType, PacketContext, SsoPacket } from './packet'
import { generateEcdhKeyPair, EcdhKeyPair } from './ecdh'
import { generateWatchEcdhKeyPair } from './watch/ecdh'
import { requestSign, setupSign, setSignMachineGuid, acquireSignToken, acquireMacosEskOnly, acquireMobileEskOnly, clearMobileO3Channel, startLinuxSsoReport, stopLinuxSsoReport, buildLinuxXwidBody, signLinuxXwidBurst, startMacosSsoReport as runMacosSsoReport, macosEasyLogin as runMacosEasyLogin, SignResult, type MacosEskState } from './sign'
import { getMacosDevice } from './macosDevice'
import type { PersistedSession } from './session'
import { AppInfo, DeviceInfo } from './appInfo'
import { getActiveProfile, isMobileFamily, supportsPasswordLogin } from './profiles'
import { loadMachineGuidSync } from './machineGuid'
import { getNativeAddon } from '../../native'
import { getMobileDevice, type MobileDevice } from './mobile/device'
import {
  KEX_CMD,
  EASY_LOGIN_CMD,
  buildKexRequest,
  parseKexResponse,
  buildEasyLoginRequest,
  parseNtLoginResponse,
  type KexSession,
  type NtLoginDeviceIdentity,
} from './mobile/ntlogin'
import { EventEmitter } from 'node:events'
import { CmdNotPermittedError, CMD_NOT_PERMITTED_RET_CODE } from '../../support/protocolErrors'
import { isCmdAllowed, CmdBlockedError, logCmdWhitelistStatus } from './cmdWhitelist'
import { cmdNeedsSign } from './cmd'
import { recordKey } from './packetDump'
import {
  buildGetNewFlag, buildClientReport, buildPsKey, TELEMETRY_CMDS,
  buildPsKey102a1, build116d1, build9067202, buildSsoGetConfig, AUX_TELEMETRY_CMDS,
} from './telemetry'
import { parseConfigPushReq, buildConfigPushResp, CONFIG_PUSH_REQ, CONFIG_PUSH_RESP } from './configPush'

const logger = getLogger('direct')

// 真机登录瞬间连号发上千条 SsoReport xwid, 约 1000/s; 缺了这波爆发反而是非真客户端的信号。
// LINUX_XWID_BURST 调条数 (0 关闭), LINUX_XWID_BURST_RATE 调速率 (包/秒)
const LINUX_XWID_BURST = Math.max(0, Number(process.env.LINUX_XWID_BURST || '2000') | 0)
const LINUX_XWID_BURST_RATE = Math.max(1, Number(process.env.LINUX_XWID_BURST_RATE || '1000') | 0)

export interface DirectClientConfig {
  appId: number
  subAppId: number
  ssoVersion: number
  buildVer: string
  useIPv6?: boolean
  /** 用户从 manager-web 拿到放进 data/auth_token.txt, 随 sign 请求发送 */
  authToken?: string
  botVersion?: string
  /** 存 device_ids.json 等跨重启的指纹, 默认 'data' */
  dataDir?: string
  uin?: number
  /** 'cf' (默认) / 'china' */
  cdn?: string
}

// Per client: the profile is only settled once the client is created
const defaultConfig = (): DirectClientConfig => ({
  appId: AppInfo.appId,
  subAppId: AppInfo.subAppId,
  ssoVersion: AppInfo.ssoVersion,
  buildVer: AppInfo.buildVer,
  useIPv6: false,
})

export interface SessionInfo {
  uin: string
  uid: string
  d2: Buffer
  d2Key: Buffer
  tgt: Buffer
  a2: Buffer
  a2Key: Buffer
  sKey: Buffer
  /** 原生模块 acquireSignToken 拿到的 12B token, 不是 authToken */
  signToken12B?: string
  signTokenExpiresAt?: number
}

export class DirectProtocolClient extends EventEmitter {
  private conn: TcpConnection
  private config: DirectClientConfig
  private ecdhKeyPair: EcdhKeyPair
  private guid: Buffer
  private seq = (Math.random() * 0x00FFFFFF) >>> 0
  private session: SessionInfo | null = null
  private signSetupDone = false
  private pendingPackets: Map<number, {
    resolve: (packet: SsoPacket) => void
    reject: (err: Error) => void
    timeout: NodeJS.Timeout
  }> = new Map()
  private signTokenRefreshInflight: Promise<void> | null = null
  private signTokenLastFetchAt = 0
  // macOS ESK channel (token1 + ttl; keys stay in native .node), scoped to one TCP connection
  private macosEskState: MacosEskState | null = null
  // iOS / HarmonyOS ESK state (token1 + ttl; O3 channel keys stay strictly in native .node)
  private mobileEskState: MacosEskState | null = null
  private mobileDevice: MobileDevice | null = null
  private mobileDeviceProfile: string | null = null
  private profileName: string
  private connTs = Math.floor(Date.now() / 1000)
  // Mobile NTLogin sends the target UIN in outer proto12 frames before session tickets arrive
  private outerUinOverride: string | null = null
  // Bumped on every close, so an ESK still in flight when its connection dies gets discarded.
  private connEpoch = 0
  private heartbeatAliveTimer: NodeJS.Timeout | null = null
  private telemetryTimer: NodeJS.Timeout | null = null
  private auxTelemetryTimer: NodeJS.Timeout | null = null
  // 诊断: 按 seq 记响应帧到达的时刻, 拆 wire / parse 耗时
  private frameArriveAt: Map<number, number> = new Map()
  private maxLoopLag = 0
  private loopLagTimer: NodeJS.Timeout | null = null
  private lastLoopTick = 0
  // 撞过 -10122 的 cmd: 权限是固定的, 记下来免得每次白发 (比如 WebUI 每翻一页历史)
  private unsupportedCmds = new Set<string>()

  constructor(config: Partial<DirectClientConfig> = {}) {
    super()
    const profile = getActiveProfile()
    this.profileName = profile.name
    this.config = { ...defaultConfig(), ...config }
    this.guid = loadMachineGuidSync()
    this.conn = new TcpConnection()
    // watch wtlogin 用 P-256, 桌面用 secp192k1
    this.ecdhKeyPair = profile.family === 'watch' ? generateWatchEcdhKeyPair() : generateEcdhKeyPair()
    recordKey('ecdh.privateKey', this.ecdhKeyPair.privateKey, 'wtlogin ECDH, per client instance')
    recordKey('ecdh.publicKey', this.ecdhKeyPair.publicKey, 'sent in the wtlogin frame head')
    recordKey('ecdh.shareKey', this.ecdhKeyPair.shareKey, 'TEA key of every wtlogin body')
    recordKey('device.guid', this.guid, 'machine guid')

    this.conn.on('packet', (frame: Buffer) => this.handlePacket(frame))
    this.conn.on('error', (err) => this.emit('error', err))
    this.conn.on('close', () => {
      // client 是单例: 不停 timer 会往死连接发包, 重连时幂等 guard 也会以为它们还在跑
      this.stopHeartbeatAlive()
      this.stopTelemetry()
      this.connEpoch++
      this.macosEskState = null
      this.mobileEskState = null
      if (isMobileFamily(getActiveProfile().family)) clearMobileO3Channel()
      this.emit('close')
    })
  }

  /** native init 是 async (带 uin 时要等 /api/bu bind), 所以由 connect() 调, 不放构造函数 */
  private async ensureSignSetup(): Promise<void> {
    if (this.signSetupDone || !this.config.authToken) return
    this.signSetupDone = true
    await setupSign({
      botVersion: this.config.botVersion ?? 'unknown',
      authToken: this.config.authToken,
      machineGuid: this.guid,
      uin: this.config.uin,
      cdn: this.config.cdn,
      sendPacket: async ({ cmd, body, signToken }) => {
        const req = Buffer.from(body)
        // ESK / SA 真机走 enc0x02 零钥通道, 用登录后默认的 enc0x01 SA 会返 1001。A2 分支要登录凭证,
        // 必须 enc0x01 + d2 (走零钥回 -10005), 所以给 undefined 让 sendCommand 按 session 选。
        // macOS 的 .o3.report. 和 login.ecdh 真机恒为 enc0x02
        const isMacos = getActiveProfile().name === 'macos'
        const enc =
          (cmd.includes('.o3.ecdh_access.') && !cmd.includes('SsoSecureA2')) ||
          (isMacos && (cmd.includes('.o3.report.') || cmd.includes('login.ecdh')))
            ? EncryptType.EncryptEmpty
            : undefined
        // signToken 是本命令 SecInfo sf2 的签名 token: SA 带 token1, 其它为空
        const resp = (await this.sendCommand(cmd, req, enc, undefined, undefined, signToken || undefined)).payload
        logger.debug(`[relay] ${cmd} enc=${enc === undefined ? 'auto' : enc} signTok=${signToken ? signToken.length + 'B' : '-'}: req=${req.length}B resp=${resp.length}B reqHex=%h respHex=%h`, req, resp)
        return resp
      },
      // For the protocol instance listening to this client right now
      onRefused: (detail) => this.emit('sign-refused', detail),
    })
  }

  /** Refresh cached profile metadata & ECDH keys when switching protocols across remounts on the shared client. */
  syncProfile(): boolean {
    const profile = getActiveProfile()
    if (this.profileName === profile.name) return false
    this.clearSession()
    if (this.conn.isConnected) this.disconnect()
    this.macosEskState = null
    this.mobileEskState = null
    clearMobileO3Channel()
    this.mobileDevice = null
    this.mobileDeviceProfile = null
    this.unsupportedCmds.clear()
    this.profileName = profile.name
    this.config.appId = AppInfo.appId
    this.config.subAppId = AppInfo.subAppId
    this.config.ssoVersion = AppInfo.ssoVersion
    this.config.buildVer = AppInfo.buildVer
    this.ecdhKeyPair = profile.family === 'watch' ? generateWatchEcdhKeyPair() : generateEcdhKeyPair()
    recordKey('ecdh.privateKey', this.ecdhKeyPair.privateKey, 'wtlogin ECDH, per client instance')
    recordKey('ecdh.publicKey', this.ecdhKeyPair.publicKey, 'sent in the wtlogin frame head')
    recordKey('ecdh.shareKey', this.ecdhKeyPair.shareKey, 'TEA key of every wtlogin body')
    return true
  }

  async connect(): Promise<void> {
    this.syncProfile()
    logCmdWhitelistStatus()
    // 不在这里校验 token: 无效 token 会让 native SDK process.exit, 校验走 validateAuthToken (HTTP)
    await this.ensureSignSetup()
    await this.conn.connect({ useIPv6: this.config.useIPv6 })
    this.connTs = Math.floor(Date.now() / 1000)
    this.emit('connected')
    this.startLoopLagMonitor()

    if (isMobileFamily(getActiveProfile().family)) {
      await this.getMobileDeviceInfo().catch((e) => {
        logger.warn(`[MobileDevice] init failed: ${(e as Error).message}`)
      })
      await this.sendCorrectTime()
    } else {
      // Heartbeat.Alive 是 NT 端后续命令的前置包
      await this.sendHeartbeat()
    }
    this.startHeartbeatAlive()
  }

  /** Mobile (iOS / HarmonyOS): send Client.CorrectTime right after TCP connect, matching PoC & real clients. */
  async sendCorrectTime(): Promise<void> {
    const seq = this.nextSeq()
    const ctx = this.getPacketContext(false)
    const payload = Buffer.alloc(4)
    payload.writeUInt32BE(Math.floor(Date.now() / 1000) >>> 0)
    const packet = buildServicePacket(seq, 'Client.CorrectTime', ctx, payload, EncryptType.NoEncrypt, null)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPackets.delete(seq)
        resolve()
      }, 5000)
      this.pendingPackets.set(seq, {
        resolve: () => { clearTimeout(timer); resolve() },
        reject: () => { clearTimeout(timer); resolve() },
        timeout: timer,
      })
      this.conn.send(packet)
    })
  }

  /**
   * macOS / iOS / HarmonyOS: ESK right after connect, before login / session restore, as real clients do.
   * Failures only warn: the post-login token acquire retries it.
   */
  async acquirePreLoginToken(): Promise<void> {
    if (isMobileFamily(getActiveProfile().family)) {
      await this.ensureMobileEsk()
      return
    }
    await this.ensureMacosEsk()
  }

  private liveMobileEsk(): MacosEskState | null {
    const esk = this.mobileEskState
    return esk && Date.now() < esk.expiresAt ? esk : null
  }

  async getMobileDeviceInfo(): Promise<MobileDevice> {
    const profile = getActiveProfile()
    if (
      this.mobileDevice &&
      this.mobileDeviceProfile === profile.name &&
      this.mobileDevice.guidHex === this.guid.toString('hex')
    ) {
      return this.mobileDevice
    }
    const dev = await getMobileDevice(profile, this.guid)
    this.mobileDevice = dev
    this.mobileDeviceProfile = profile.name
    return dev
  }

  async getNtLoginDeviceInfo(): Promise<NtLoginDeviceIdentity> {
    const profile = getActiveProfile()
    if (isMobileFamily(profile.family)) {
      return await this.getMobileDeviceInfo()
    }
    return {
      guid: this.guid,
      deviceName: DeviceInfo.devName,
      model: profile.devType,
    }
  }

  /** Native-backed pre-login ESK (`SsoEstablishShareKey`) for iOS & HarmonyOS; O3 keys stay in .node. */
  private async ensureMobileEsk(): Promise<MacosEskState | null> {
    const profile = getActiveProfile()
    if (!isMobileFamily(profile.family) || !this.config.authToken) return null
    const live = this.liveMobileEsk()
    if (live) return live
    const epoch = this.connEpoch
    try {
      const esk = await acquireMobileEskOnly(profile, this.guid)
      if (epoch !== this.connEpoch) return null
      this.mobileEskState = esk
      logger.info(`[SignToken][${profile.name}] ESK acquired (token ${esk.token.length}B) ttl=${esk.ttlSecs}s`)
      return esk
    } catch (e) {
      logger.warn(`[SignToken][${profile.name}] ESK failed: ${(e as Error).message}`)
      return null
    }
  }

  private liveMacosEsk(): MacosEskState | null {
    const esk = this.macosEskState
    return esk && Date.now() < esk.expiresAt ? esk : null
  }

  /** null on other protocols or on failure. */
  private async ensureMacosEsk(): Promise<MacosEskState | null> {
    if (getActiveProfile().name !== 'macos' || !this.config.authToken) return null
    const live = this.liveMacosEsk()
    if (live) return live
    const epoch = this.connEpoch
    try {
      const esk = await acquireMacosEskOnly(AppInfo.qua)
      // The connection closed while ESK was in flight; its channel must not leak into the next one.
      if (epoch !== this.connEpoch) return null
      this.macosEskState = esk
      logger.info(`[SignToken] macOS ESK acquired (token ${esk.token.length}B) ttl=${esk.ttlSecs}s`)
      return esk
    } catch (e) {
      logger.warn(`[SignToken] macOS ESK failed: ${(e as Error).message}`)
      return null
    }
  }

  /**
   * macOS: the o3 handshake cmds (ESK / A2 / SA2) carry an empty token; after login business cmds carry
   * sa2_token, or a live ESK token1 until SA2 lands. signToken12B === '' is the 403 soft-degrade: no ESK fallback.
   */
  private protocolTokenFor(cmd: string): string | undefined {
    const profile = getActiveProfile()
    if (isMobileFamily(profile.family)) {
      if (cmd === 'trpc.o3.ecdh_access.EcdhAccess.SsoEstablishShareKey') return undefined
      return this.session?.signToken12B || this.liveMobileEsk()?.token
    }
    if (profile.name !== 'macos') return this.session?.signToken12B
    if (!this.session || cmd.includes('ecdh_access')) return undefined
    return this.session.signToken12B ?? this.liveMacosEsk()?.token
  }

  private startHeartbeatAlive(): void {
    if (this.heartbeatAliveTimer || getActiveProfile().family === 'watch') return
    // 真机约 13.5s 一跳且有抖动, 固定间隔本身就是机器特征
    const tick = () => {
      this.sendHeartbeat().catch((e) => {
        logger.error('[Heartbeat.Alive] Failed:', (e as Error).message)
      })
      this.heartbeatAliveTimer = setTimeout(tick, 12_000 + Math.floor(Math.random() * 3_000))
    }
    this.heartbeatAliveTimer = setTimeout(tick, 12_000 + Math.floor(Math.random() * 3_000))
  }

  private stopHeartbeatAlive(): void {
    if (this.heartbeatAliveTimer) {
      clearTimeout(this.heartbeatAliveTimer)
      this.heartbeatAliveTimer = null
    }
  }

  /**
   * 真机登录后每约 316s 发 getNewFlag + ClientReport + 0x102a_0 (psKey); 只有心跳的"哑连接"容易被判会话失效
   * (KickNT 1001)
   */
  private startTelemetryLoop(): void {
    if (this.telemetryTimer || getActiveProfile().name !== 'linux') return
    const tick = () => {
      void this.sendTelemetryRound()
      this.telemetryTimer = setTimeout(tick, 310_000 + Math.floor(Math.random() * 15_000))
    }
    this.telemetryTimer = setTimeout(tick, 310_000 + Math.floor(Math.random() * 15_000))
  }

  private stopTelemetry(): void {
    if (this.telemetryTimer) {
      clearTimeout(this.telemetryTimer)
      this.telemetryTimer = null
    }
    if (this.auxTelemetryTimer) {
      clearTimeout(this.auxTelemetryTimer)
      this.auxTelemetryTimer = null
    }
  }

  /** 真机每 26-30min 发一组 0x102a_1 / 0x116d_1 / 0x9067_202 / SsoGetConfig; 首发延后, 避开登录爆发 */
  private startAuxTelemetryLoop(): void {
    if (this.auxTelemetryTimer || getActiveProfile().name !== 'linux') return
    const tick = () => {
      void this.sendAuxTelemetryRound()
      this.auxTelemetryTimer = setTimeout(tick, 1_500_000 + Math.floor(Math.random() * 360_000))
    }
    this.auxTelemetryTimer = setTimeout(tick, 300_000 + Math.floor(Math.random() * 120_000))
  }

  /** 0x102a_1 在签名白名单里会自动签 (真机带 f24), 其余不签 */
  private async sendAuxTelemetryRound(): Promise<void> {
    if (!this.session || !this.isConnected) return
    const uid = this.session.uid
    const guidHex = this.guid.toString('hex')
    const jobs: Array<[string, Buffer]> = [
      [AUX_TELEMETRY_CMDS.psKey102a1, buildPsKey102a1()],
      [AUX_TELEMETRY_CMDS.oidb116d1, build116d1(uid)],
      [AUX_TELEMETRY_CMDS.oidb9067202, build9067202()],
      [AUX_TELEMETRY_CMDS.ssoGetConfig, buildSsoGetConfig(guidHex)],
    ]
    for (const [cmd, body] of jobs) {
      if (!this.session || !this.isConnected) break
      try {
        await this.sendCommand(cmd, body)
      } catch (e) {
        logger.debug(`[aux-telemetry] ${cmd} failed: ${(e as Error).message}`)
      }
    }
  }

  private async sendTelemetryRound(): Promise<void> {
    if (!this.session || !this.isConnected) return
    const uin = this.session.uin ? Number(this.session.uin) : (this.config.uin || 0)
    if (!uin) return
    const jobs: Array<[string, Buffer]> = [
      [TELEMETRY_CMDS.getNewFlag, buildGetNewFlag(uin)],
      [TELEMETRY_CMDS.clientReport, buildClientReport(uin)],
      [TELEMETRY_CMDS.psKey, buildPsKey()],
    ]
    for (const [cmd, body] of jobs) {
      if (this.session?.uin !== String(uin) || !this.isConnected) break
      try {
        await this.sendCommand(cmd, body)
      } catch (e) {
        logger.debug(`[telemetry] ${cmd} failed: ${(e as Error).message}`)
      }
    }
  }

  /**
   * 新建 SSO 连接时服务器推 ConfigPushSvc.PushReq, 真机必回 PushResp 回显 {type,seq}, 服务器不再回包。
   * reserve 只在 linux 上验证过
   */
  private respondConfigPush(payload: Buffer): void {
    if (getActiveProfile().name !== 'linux' || !this.session || !this.isConnected) return
    try {
      const req = parseConfigPushReq(payload)
      if (!req) return
      const seq = this.nextSeq()
      const ctx = this.getPacketContext()
      const body = buildConfigPushResp(req.type, req.seq)
      this.conn.send(buildServicePacket(seq, CONFIG_PUSH_RESP, ctx, body, EncryptType.EncryptD2Key, null))
      logger.debug(`[ConfigPush] PushResp sent (type=${req.type} seq=${req.seq})`)
    } catch (e) {
      logger.debug(`[ConfigPush] respond failed: ${(e as Error).message}`)
    }
  }

  // 诊断: 50ms 一跳, 超出的部分 = 主线程被同步阻塞的时长
  private startLoopLagMonitor(): void {
    if (this.loopLagTimer || !isDebugEnabled()) return
    const EXPECT = 50
    this.lastLoopTick = Date.now()
    this.loopLagTimer = setInterval(() => {
      const now = Date.now()
      const lag = now - this.lastLoopTick - EXPECT
      if (lag > this.maxLoopLag) this.maxLoopLag = lag
      this.lastLoopTick = now
    }, EXPECT)
    this.loopLagTimer.unref?.()
  }

  private takeMaxLoopLag(): number {
    const v = this.maxLoopLag
    this.maxLoopLag = 0
    return v
  }


  async sendHeartbeat(): Promise<void> {
    // 手表真机从不发这个 type-13 裸包 (libwrapper.9.0.5.so 里没有), 保活只靠 SSO 层, 见 online.ts
    if (getActiveProfile().family === 'watch') return
    if (!isCmdAllowed('Heartbeat.Alive')) return
    const seq = this.nextSeq()
    const ctx = this.getPacketContext()
    const payload = Buffer.alloc(4)
    payload.writeUInt32BE(0x00000004)
    const packet = buildServicePacket13(seq, 'Heartbeat.Alive', ctx, payload, EncryptType.NoEncrypt)

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPackets.delete(seq)
        resolve() // Don't fail on heartbeat timeout
      }, 5000)

      this.pendingPackets.set(seq, {
        resolve: () => { clearTimeout(timer); resolve() },
        reject: (err) => { clearTimeout(timer); reject(err) },
        timeout: timer,
      })

      this.conn.send(packet)
    })
  }

  disconnect(): void {
    this.stopHeartbeatAlive()
    this.stopTelemetry()
    this.conn.disconnect()
    for (const [, pending] of this.pendingPackets) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('Disconnected'))
    }
    this.pendingPackets.clear()
  }

  private nextSeq(): number {
    return this.seq++
  }

  private getPacketContext(forSessionEnc = true): PacketContext {
    const mobile = isMobileFamily(getActiveProfile().family)
    const includeSessionHead = !mobile || forSessionEnc
    return {
      uin: this.session?.uin || this.outerUinOverride || '0',
      uid: includeSessionHead ? (this.session?.uid || '') : '',
      d2: this.session?.d2 || Buffer.alloc(0),
      d2Key: this.session?.d2Key || Buffer.alloc(16),
      tgt: includeSessionHead ? (this.session?.tgt || Buffer.alloc(0)) : Buffer.alloc(0),
      guid: this.guid,
      appId: this.config.appId,
      subAppId: this.config.subAppId,
      buildVer: this.config.buildVer,
      qimei36: mobile ? (this.mobileDevice?.qimei36 || '') : undefined,
      connTs: this.connTs,
    }
  }

  private wantsMobileSessionEncryption(cmd: string): boolean {
    if (!this.session) return false
    if (cmd.includes('SsoSecureA2')) return true
    return !(cmd.includes('login.ecdh') || cmd.includes('ecdh_access') || cmd.includes('.o3.report.'))
  }

  async sendCommand(cmd: string, payload: Buffer, encryptType?: EncryptType, timeout = 15000, skipSign = false, signTokenOverride?: string): Promise<SsoPacket> {
    if (this.unsupportedCmds.has(cmd)) throw new CmdNotPermittedError(cmd)
    if (!isCmdAllowed(cmd)) throw new CmdBlockedError(cmd)
    const seq = this.nextSeq()
    const session = this.session
    const profile = getActiveProfile()
    const mobile = isMobileFamily(profile.family)
    const enc = encryptType ?? (mobile
      ? (this.wantsMobileSessionEncryption(cmd) ? EncryptType.EncryptD2Key : EncryptType.EncryptEmpty)
      : (this.session ? EncryptType.EncryptD2Key : EncryptType.EncryptEmpty))
    const ctx = this.getPacketContext(enc === EncryptType.EncryptD2Key)

    const t0 = Date.now()
    let tTokenDone = t0
    let tSignDone = t0

    // skipSign: watch 的 trans_emp 签了会被拒绝扫码授权
    let signResult: SignResult | null = null
    if (!skipSign && this.config.authToken && cmdNeedsSign(cmd, profile.name)) {
      // Pre-login ESK must not attach an unbound uin; NTLogin uses outerUinOverride (bound via /api/bu).
      const isPreLoginEsk = !this.session && cmd === 'trpc.o3.ecdh_access.EcdhAccess.SsoEstablishShareKey'
      const uin = isPreLoginEsk
        ? undefined
        : (this.session?.uin
            ? Number(this.session.uin)
            : ((this.outerUinOverride ? Number(this.outerUinOverride) : this.config.uin) || undefined))
      await this.ensureSignTokenFresh(uin)
      tTokenDone = Date.now()
      // SA 必须用 token1 签, 而此时 session.signToken12B 还没取到
      const protocolToken = signTokenOverride ?? this.protocolTokenFor(cmd)
      signResult = await requestSign(cmd, payload, seq, this.guid, AppInfo.qua, uin, protocolToken)
      tSignDone = Date.now()
      if (signResult?.token.length === 0) {
        signResult.token = Buffer.from(protocolToken ?? '')
      }
      logger.debug(`[sign] ${cmd} seq=${seq}: result=${signResult ? `sign=${signResult.sign.length}B token=${signResult.token.length}B extra=${signResult.extra.length}B` : 'null'}`)
      // 不发未签名的包; 具体错因 requestSign 已经打过
      if (!signResult) {
        throw new Error(`sign failed for ${cmd}; see [Sign] log above`)
      }
    }

    // Signing can still be in flight when another request invalidates the session.
    if (this.session !== session) {
      throw new Error('QQ session changed before the command could be sent')
    }
    const packet = buildServicePacket(seq, cmd, ctx, payload, enc, signResult)

    const tSendStart = Date.now()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPackets.delete(seq)
        reject(new Error(`Command ${cmd} timed out after ${timeout}ms`))
      }, timeout)

      const finish = (fn: (v: any) => void) => (v: any) => {
        if (isDebugEnabled()) {
          const tDone = Date.now()
          const arrive = this.frameArriveAt.get(seq)
          this.frameArriveAt.delete(seq)
          const wire = arrive ? arrive - tSendStart : -1   // send -> 字节到达 socket (网络+服务端+event-loop 投递)
          const parse = arrive ? tDone - arrive : -1        // 字节到达 -> resolve (解密/解析, 纯本地)
          logger.debug(
            `[timing] ${cmd} seq=${seq}: token=${tTokenDone - t0}ms sign=${tSignDone - tTokenDone}ms wire=${wire}ms parse=${parse}ms netRTT=${tDone - tSendStart}ms maxLoopLag=${this.takeMaxLoopLag()}ms total=${tDone - t0}ms`
          )
        }
        fn(v)
      }

      this.pendingPackets.set(seq, { resolve: finish(resolve), reject: finish(reject), timeout: timer })
      this.conn.send(packet)
    })
  }

  private handlePacket(frame: Buffer): void {
    const tArrive = Date.now()
    const d2Key = this.session?.d2Key || Buffer.alloc(16)
    const parsed = parseServicePacket(frame, d2Key)
    if (!parsed) {
      this.emit('error', new Error('Failed to parse incoming packet'))
      return
    }
    // Authentication failures can have seq=0 and no command, so handle them before request matching.
    if (parsed.retCode === -10001 && this.session) {
      const uin = this.session.uin
      const error = new Error(
        `QQ session authentication failed: retCode=${parsed.retCode}, ${parsed.extraMsg || 'Please log in again'}`,
      )
      this.clearSession()
      for (const pending of this.pendingPackets.values()) {
        clearTimeout(pending.timeout)
        pending.reject(error)
      }
      this.pendingPackets.clear()
      this.frameArriveAt.clear()
      this.emit('session-expired', uin, error)
      return
    }
    if (isDebugEnabled()) this.frameArriveAt.set(parsed.seq, tArrive)
    const pending = this.pendingPackets.get(parsed.seq)
    if (pending) {
      clearTimeout(pending.timeout)
      this.pendingPackets.delete(parsed.seq)
      if (parsed.retCode && parsed.retCode !== 0) {
        pending.reject(this.toCommandError(parsed))
      } else {
        pending.resolve(parsed)
      }
      return
    }

    // 无主的错误帧不是推送, body 也不是 protobuf
    if (parsed.retCode && parsed.retCode !== 0) {
      logger.warn(`[SSO] unmatched error frame cmd=${parsed.cmd} seq=${parsed.seq} retCode=${parsed.retCode} extraMsg=${parsed.extraMsg || ''}`)
      return
    }

    if (parsed.cmd === CONFIG_PUSH_REQ) this.respondConfigPush(parsed.payload)

    this.emit('push', parsed)
  }

  /** -10122 单独成型, 调用方据此降级而不是重试 */
  private toCommandError(parsed: SsoPacket): Error {
    if (parsed.retCode === CMD_NOT_PERMITTED_RET_CODE) {
      this.unsupportedCmds.add(parsed.cmd)
      logger.warn(`[Protocol] ${parsed.cmd} not permitted for ${getActiveProfile().name}, will not retry it`)
      return new CmdNotPermittedError(parsed.cmd, parsed.extraMsg || '')
    }
    return new Error(`SSO ${parsed.cmd} failed: retCode=${parsed.retCode}, extraMsg=${parsed.extraMsg || ''}`)
  }

  get isConnected(): boolean {
    return this.conn.isConnected
  }

  get isLoggedIn(): boolean {
    return this.session !== null
  }

  getGuid(): Buffer {
    return this.guid
  }

  setGuid(guid: Buffer): void {
    this.guid = guid
    this.mobileDevice = null
    this.mobileDeviceProfile = null
    setSignMachineGuid(guid)
  }

  /** native sign 是进程单例, relay 只绑第一个 client: 换 token / uin 只能原地改, 不能重建 client */
  setAuthToken(token: string): void {
    this.config.authToken = token
  }

  setUin(uin?: number): void {
    this.config.uin = uin
  }

  setOuterUin(uin: string | null): void {
    this.outerUinOverride = uin
  }

  /**
   * Bind a target QQ number to the user's ManagerServer token (`/api/bu`) before mobile NTLogin signs
   * `SsoKeyExchange` / `SsoNTLogin*`. Surfaces 403/409 quota/conflict errors instead of triggering SDK exit.
   */
  async bindSignUin(uin: string): Promise<void> {
    const num = Number(uin)
    if (!Number.isFinite(num) || num <= 0) throw new Error(`无效 QQ 号: ${uin}`)
    await this.ensureSignSetup()
    const proxy = getNativeAddon()
    if (typeof proxy.setUin === 'function') {
      await proxy.setUin(num)
    }
    this.config.uin = num
    this.outerUinOverride = uin
  }

  /** Run mobile `SsoKeyExchange` (P-256 ECDH -> 32B session_key + ticket). */
  async mobileKex(uin: string): Promise<KexSession> {
    const { body, ecdh } = buildKexRequest(uin, this.guid, Math.floor(Date.now() / 1000))
    const resp = await this.sendCommand(KEX_CMD, body, EncryptType.EncryptEmpty)
    const kex = parseKexResponse(ecdh, resp.payload)
    if (!kex) throw new Error('SsoKeyExchange 响应解密 session_key 失败')
    return kex
  }

  /** Passwordless EasyLogin using saved `a1` ticket (`persisted.tempPassword`). Returns null on failure. */
  async mobileEasyLogin(
    persisted: PersistedSession,
  ): Promise<{ session: SessionInfo; a1Hex: string; nick: string } | null> {
    const profile = getActiveProfile()
    if (!supportsPasswordLogin(profile) || !persisted.tempPassword) return null
    try {
      await this.acquirePreLoginToken()
      await this.bindSignUin(persisted.uin)
      const dev = await this.getNtLoginDeviceInfo()
      const kex = await this.mobileKex(persisted.uin)
      const a1Buf = Buffer.from(persisted.tempPassword, 'hex')
      const req = buildEasyLoginRequest(kex, profile, dev, persisted.uin, a1Buf)
      const resp = await this.sendCommand(EASY_LOGIN_CMD, req, EncryptType.EncryptEmpty)
      const tickets = parseNtLoginResponse(kex, resp.payload)
      if (tickets.d2.length === 0 || tickets.d2Key.length !== 16) {
        if (tickets.error) {
          logger.warn(`[EasyLogin][${profile.name}] failed code=${tickets.error.code} ${tickets.error.title} ${tickets.error.msg}`)
        }
        return null
      }
      const nextA1 = tickets.a1.length > 0 ? tickets.a1 : a1Buf
      const session: SessionInfo = {
        uin: tickets.uin || persisted.uin,
        uid: tickets.uid || persisted.uid,
        d2: tickets.d2,
        d2Key: tickets.d2Key,
        tgt: tickets.tgtA2.length > 0 ? tickets.tgtA2 : Buffer.from(persisted.tgt ?? '', 'hex'),
        a2: tickets.tgtA2.length > 0 ? tickets.tgtA2 : Buffer.from(persisted.tgt ?? '', 'hex'),
        a2Key: Buffer.alloc(16),
        sKey: Buffer.alloc(0),
      }
      return { session, a1Hex: nextA1.toString('hex'), nick: tickets.nick || persisted.nick || '' }
    } catch (e) {
      logger.warn(`[EasyLogin][${profile.name}] failed: ${(e as Error).message}`)
      return null
    }
  }

  getSession(): SessionInfo | null {
    return this.session
  }

  getEcdhPublicKey(): Buffer {
    return this.ecdhKeyPair.publicKey
  }

  getEcdhShareKey(): Buffer {
    return this.ecdhKeyPair.shareKey
  }

  setSession(session: SessionInfo): void {
    this.session = session
    recordKey('d2Key', session.d2Key, `TEA key of every EncryptD2Key SSO frame (uin ${session.uin})`)
    recordKey('d2', session.d2, 'SSO head credential, not a key')
    recordKey('tgt', session.tgt, 'SSO head credential, not a key')
    recordKey('a2Key', session.a2Key, 'from TLV 0x10D')
    this.emit('login', session)
    void this.tryAcquireSignToken()
    // 遥测不在这里起: 真机是 ESK -> SA -> SsoInfoSync 上线之后才报告, 由 direct.ts 上线后调 startLinuxSsoReportLoop
  }

  async startLinuxSsoReportLoop(): Promise<void> {
    if (getActiveProfile().name !== 'linux' || !this.session || !this.config.authToken) return
    await startLinuxSsoReport({
      qua: AppInfo.qua,
      guidHex: this.guid.toString('hex'),
      uin: this.session.uin,
    })
    if (LINUX_XWID_BURST > 0) {
      const body = buildLinuxXwidBody(AppInfo.qua)
      if (body) void this.sendXwidBurst(LINUX_XWID_BURST, body)
    }
    this.startTelemetryLoop()
    this.startAuxTelemetryLoop()
  }

  /** linux 循环发, macos 一次性爆发 */
  startSsoReport(): void {
    void this.startLinuxSsoReportLoop()
    void this.startMacosSsoReport()
  }

  /** sec_init + channel_report + env_detect + login */
  async startMacosSsoReport(): Promise<void> {
    if (getActiveProfile().name !== 'macos' || !this.session || !this.config.authToken) return
    let qimei36 = ''
    try {
      qimei36 = (await getMacosDevice(AppInfo.qua)).qimei36
    } catch {
      // 没有 qimei 也照发
    }
    await runMacosSsoReport({ guidHex: this.guid.toString('hex'), qimei36, uin: this.session.uin })
  }

  /** 用存档的 0x106 凭证换新票据, 失败返 null。须在没有 session 时调: KEX / EasyLogin 走零钥帧 */
  async macosEasyLogin(persisted: PersistedSession): Promise<{ session: SessionInfo; a1106Hex: string } | null> {
    if (getActiveProfile().name !== 'macos' || !persisted.tempPassword) return null
    await this.acquirePreLoginToken()
    const q36 = await getMacosDevice(AppInfo.qua).then((d) => d.qimei36).catch(() => undefined)
    const t = await runMacosEasyLogin({
      uin: persisted.uin,
      guidHex: persisted.guid,
      a1106Hex: persisted.tempPassword,
      seedHex: this.guid.toString('hex'),
      qua: AppInfo.qua,
      q36,
    })
    if (!t) return null
    const session: SessionInfo = {
      uin: persisted.uin,
      uid: persisted.uid,
      d2: Buffer.from(t.d2Hex, 'hex'),
      d2Key: Buffer.from(t.d2KeyHex, 'hex'),
      tgt: Buffer.from(t.tgtHex, 'hex'),
      a2: Buffer.from(t.tgtHex, 'hex'),
      a2Key: Buffer.alloc(16),
      sKey: Buffer.alloc(0),
    }
    return { session, a1106Hex: t.a1106Hex }
  }

  /**
   * 一次 NAPI 批量签完 (逐条 requestSign 的 JS <-> NAPI 往返才是慢点), 预留连续 seq 段, 再按
   * LINUX_XWID_BURST_RATE 分块发。不登记 pendingPackets: 服务端对 SsoReport 基本不回
   */
  async sendXwidBurst(count: number, body: Buffer): Promise<void> {
    if (count <= 0 || !body?.length) return
    const cmd = 'trpc.o3.report.Report.SsoReport'
    if (!this.isConnected || !this.session || !this.config.authToken) return
    if (!cmdNeedsSign(cmd, getActiveProfile().name)) return
    const session = this.session
    const uin = this.session.uin ? Number(this.session.uin) : (this.config.uin || undefined)
    // 真机 xwid 带 token1。acquire 还在跑时 ensureSignTokenFresh 会直接放行, 所以再等一次 in-flight;
    // burst 不在 acquire 的发包路径上, 不会死锁
    await this.ensureSignTokenFresh(uin)
    if (this.signTokenRefreshInflight) { try { await this.signTokenRefreshInflight } catch { /* 取失败退化空 token */ } }
    if (this.session !== session || !this.isConnected) return

    const base = this.seq
    this.seq = (this.seq + count) >>> 0
    const token = this.protocolTokenFor(cmd)

    // 老 .node 没有 signXwidBurst 时返 null, 直接跳过
    const sigs = await signLinuxXwidBurst({
      cmd,
      bodyHex: body.toString('hex'),
      seq: base,
      guidHex: this.guid.toString('hex'),
      qua: AppInfo.qua,
      uin: uin ?? 0,
      protocolTokenHex: token ? Buffer.from(token, 'utf-8').toString('hex') : '',
    }, count)
    if (!sigs || sigs.length === 0) return
    if (this.session !== session || !this.isConnected) return

    const ctx = this.getPacketContext()
    const CHUNK = 20
    const chunkDelayMs = LINUX_XWID_BURST_RATE >= 100000 ? 0 : Math.max(0, Math.round((1000 * CHUNK) / LINUX_XWID_BURST_RATE))
    let sent = 0
    for (let i = 0; i < sigs.length; i++) {
      if (this.session !== session || !this.isConnected) break
      const seq = (base + i) >>> 0
      try {
        this.conn.send(buildServicePacket(seq, cmd, ctx, body, EncryptType.EncryptD2Key, sigs[i]))
        sent++
      } catch { break }
      if (chunkDelayMs > 0 && (i + 1) % CHUNK === 0) {
        await new Promise((r) => setTimeout(r, chunkDelayMs))
      }
    }
    logger.debug(`[xwid-burst] sent ${sent}/${count} (seq ${base}..${(base + count - 1) >>> 0}, rate~${LINUX_XWID_BURST_RATE}/s)`)
  }

  /** 走 ensureSignTokenFresh 的 in-flight lock, 免得跟首次 sendCommand 各开一个 acquire */
  private async tryAcquireSignToken(): Promise<void> {
    if (!this.session || !this.config.authToken) return
    const uin = Number(this.session.uin)
    if (!Number.isFinite(uin) || uin <= 0) return
    await this.ensureSignTokenFresh(uin)
  }

  /** 上线 (SsoInfoSync) 前等 ESK -> SA 跑完, 跟真机时序一致。不抛 */
  async awaitSignTokenAcquire(): Promise<void> {
    if (!this.session || !this.config.authToken) return
    const uin = Number(this.session.uin)
    if (!Number.isFinite(uin) || uin <= 0) return
    await this.ensureSignTokenFresh(uin)
    // 撞上 in-flight 时 ensureSignTokenFresh 直接返回, 所以显式等
    const inflight = this.signTokenRefreshInflight
    if (inflight) {
      try { await inflight } catch { /* 失败按原回退, 不阻断登录 */ }
    }
  }

  /** 按服务端给的 TTL 续期。token 不落盘, 每次启动都要首拉; 空 token (403 软降级) 不刷 */
  private async ensureSignTokenFresh(uin: number | undefined): Promise<void> {
    // watch 的 token 随 sign 一起返回, sign-service 也没有 /token/* (取必 404)
    if (getActiveProfile().family === 'watch') return
    if (!this.session || !uin || !this.config.authToken) return
    if (this.session.signTokenExpiresAt) {
      const expired = Date.now() >= this.session.signTokenExpiresAt
      if (!this.session.signToken12B || !expired) return
      // 续期失败时 expiresAt 停在旧值, 限个最小间隔, 免得每条命令都去续
      if (Date.now() - this.signTokenLastFetchAt < 30_000) return
    }
    // 别改成 await: acquire 自己发的 ecdh_access 包也会经 sendCommand 重入这里, 等 inflight 就是等自己, 死锁
    if (this.signTokenRefreshInflight) return
    this.signTokenRefreshInflight = (async () => {
      try {
        this.signTokenLastFetchAt = Date.now()
        const isMobile = isMobileFamily(getActiveProfile().family)
        // macOS & mobile: A2+SA2 need this connection's native ESK channel; a renewal past its TTL re-runs ESK first.
        const esk = isMobile ? await this.ensureMobileEsk() : await this.ensureMacosEsk()
        const { token, ttlSecs } = await acquireSignToken(
          uin,
          AppInfo.qua,
          esk,
          isMobile ? { guid: this.guid, currentToken: this.session?.signToken12B || esk?.token } : undefined,
        )
        if (this.session) {
          this.session.signToken12B = token
          this.session.signTokenExpiresAt = Date.now() + ttlSecs * 1000
          logger.info(`[SignToken] acquired "${token}" ttl=${ttlSecs}s`)
          recordKey('signToken12B', Buffer.from(token, 'utf-8'), `sign device token, ttl=${ttlSecs}s`)
        }
      } catch (e) {
        // expiresAt 仍为 undefined, 下一条要签名的命令会再试
        logger.warn(`[SignToken] acquire failed: ${(e as Error).message}`)
      } finally {
        this.signTokenRefreshInflight = null
      }
    })()
    await this.signTokenRefreshInflight
  }

  clearSession(): void {
    this.session = null
    this.outerUinOverride = null
    stopLinuxSsoReport()
  }
}
