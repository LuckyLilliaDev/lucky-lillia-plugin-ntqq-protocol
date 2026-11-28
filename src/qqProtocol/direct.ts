import QRCode from 'qrcode'
import type { PBData } from './types'
import {
  DirectProtocolClient,
  fetchQrCode,
  pollQrCode,
  loginWithQrResult,
  registerOnline,
  startHeartbeat,
  getCorrectUin,
  QrCodeState,
  AppInfo,
  EncryptType,
  saveSession,
  loadSession,
  deleteSession,
  listAvailableSessions,
  persistedToSessionInfo,
  getSessionFilePathForUin,
} from './direct-lib'
import type { QrCodeResult, QrPollResult, SessionInfo } from './direct-lib'
import { getCdn, getAuthTokenPageUrl } from '../support/utils/environment'
import { overwriteMachineGuid } from './direct-lib/machineGuid'
import { getActiveProfile, isMobileFamily, supportsPasswordLogin, supportsQrLogin } from './direct-lib/profiles'
import { updateAuthToken } from './direct-lib/sign'
import { md5 } from './direct-lib/mobile/crypto'
import {
  PASSWORD_LOGIN_CMD,
  NEW_DEVICE_LOGIN_CMD,
  NTLOGIN_ERR_PROOF_WATER,
  NTLOGIN_ERR_NEW_DEVICE,
  generateClientA1,
  buildPasswordLoginRequest,
  buildNewDeviceLoginRequest,
  parseNtLoginResponse,
  parseCaptchaChallenge,
  buildCaptchaRelayUrl,
  fetchCaptchaRelayResult,
  createNewDeviceQr,
  pollNewDeviceQrOnce,
  type KexSession,
  type CaptchaSubmission,
  type CaptchaRelayResult,
  type NtLoginTickets,
} from './direct-lib/mobile/ntlogin'
import { authTokenUtil } from '../support/authToken'
import { version } from '../version'
import { AuthTokenWatcher } from './direct-lib/authTokenWatcher'
import { QQProtocolBase, type PasswordLoginState, type QuickLoginAccounts } from './base'

// Outlives the protocol plugin: native sign binds its relay to the first client and cannot rebind, so switching
// the plugin off only disconnects it and switching it back on picks the same one up
let sharedClient: DirectProtocolClient | null = null

/** 持有的 DirectProtocolClient (direct-lib/client.ts) 是底层连接, 别跟本类混淆 */
export class DirectQQProtocol extends QQProtocolBase {
  private directClient: DirectProtocolClient | null = null
  private directInitInFlight: boolean = false
  private directPendingToken: string = ''
  // poll 和登录要用的凭证 (sig / tgtgtKey); base.qrResult 只是展示缓存
  private directQrResult: QrCodeResult | null = null
  private directPollResult: QrPollResult | null = null
  private directStopHeartbeat: (() => void) | null = null
  private readonly tokenWatcher = new AuthTokenWatcher(
    this.authTokenStatus,
    (token) => this.onAuthTokenValid(token),
    this.logger,
    () => this.selfInfo.online,
  )
  // What bindDirectClientEvents attached, so stop() can take this instance off the shared client
  private clientListeners: [string, (...args: any[]) => void][] = []
  private reconnectTimer: NodeJS.Timeout | null = null
  private manualLogout = false
  // 拉新码或重建 client 时 ++, 旧的 poll 循环见它变了就退出
  private qrPollToken: number = 0
  // Cancels an in-flight doInitDirectClient (logout / session-expired / the next init). Kept apart
  // from qrPollToken: a QR fetched while a session restore runs must not abort that restore.
  private initToken: number = 0
  private static readonly QR_TTL_MS = 180_000
  // Auto-fetched QR codes (first one included) before the loop waits for a manual refresh.
  private static readonly QR_AUTO_REFRESH_LIMIT = 10
  private static readonly RECONNECT_MS = 5_000
  private static readonly RECONNECT_MAX_MS = 60_000
  // A quick login that started while another init ran waits this long for that one
  private static readonly QUICK_LOGIN_WAIT_MS = 60_000
  // How long, and how often, the console link's captcha relay is polled; the WebUI slider is not limited by it
  private static readonly CAPTCHA_RELAY_TIMEOUT_MS = 300_000
  private static readonly CAPTCHA_RELAY_POLL_MS = 3_000

  // WebUI 快速登录或登录成功时设置, 下次 initDirectClient 用它 loadSession; 优先于 -q
  private runtimeUinOverride: string | null = null
  // Why the last session restore did not get online: init falls back to QR silently, quick login reports it
  private restoreError: string | null = null

  // Mobile (iOS / HarmonyOS) interactive NTLogin state machine
  private passwordLoginToken = 0
  private passwordPollTimer: NodeJS.Timeout | null = null
  // clearPasswordPollTimer() ends the captcha relay's round as well: its request that lands afterwards belongs to
  // the wait just ended (the WebUI submitted, the flow was cancelled, a new captcha came) and is dropped
  private captchaRelayRound = 0
  private passwordState: PasswordLoginState = { supported: false, phase: 'idle' }
  private pwFlow: {
    token: number
    uin: string
    pwdMd5: Buffer
    salt: bigint
    kex: KexSession
    cookie: string
    longCookie: Buffer
    attempts: number
    captchaSid: string
    // The relay files its results by verify URL, so a record left there may outlive the captcha: send each once
    relayTicketsSent: Set<string>
    newDeviceEndpoint?: string
    newDeviceBytesToken?: string
  } | null = null

  private canPasswordLogin(): boolean {
    return supportsPasswordLogin()
  }

  private canQrLogin(): boolean {
    return supportsQrLogin()
  }

  private clearPasswordPollTimer(): void {
    this.captchaRelayRound++
    if (this.passwordPollTimer) {
      clearTimeout(this.passwordPollTimer)
      this.passwordPollTimer = null
    }
  }

  private resetPasswordLoginState(phase: PasswordLoginState['phase'] = 'idle', patch: Partial<PasswordLoginState> = {}): PasswordLoginState {
    this.clearPasswordPollTimer()
    this.passwordState = {
      supported: this.canPasswordLogin(),
      phase,
      ...patch,
    }
    return this.getPasswordLoginState()
  }

  protected override ensureQrLoop(): void {
    if (!this.canQrLogin()) return
    super.ensureQrLoop()
  }

  protected async start(): Promise<void> {
    this.ctx.on('nt/kicked-offline', (data) => {
      if (this.directStopHeartbeat) { this.directStopHeartbeat(); this.directStopHeartbeat = null }
      // 异地顶号 (1001): 删 session 退回扫码, 不拿旧凭证跟对方互顶。machine_guid 不动: 换 guid 会在服务端多出一台
      // 新设备, 还会让同目录其他账号的 session 失配。其他掉线保留 session, 重连时直接恢复
      if (data.kickedType === 1001) {
        const kickedUin = this.selfInfo.uin || this.runtimeUinOverride || this.loginOptions.autoLoginUin || ''
        if (kickedUin) deleteSession(kickedUin)
        this.runtimeUinOverride = null
        this.directClient?.clearSession()
      }
      this.directClient?.disconnect()
    })
    this.tokenWatcher.start()
  }

  /** Disconnects but keeps the saved session, so switching the plugin back on logs in without a QR code. */
  protected async stop(): Promise<void> {
    this.tokenWatcher.stop()
    // Cancels a QR poll or an init still running
    this.qrPollToken++
    this.initToken++
    this.passwordLoginToken++
    this.clearPasswordPollTimer()
    this.pwFlow = null
    this.resetPasswordLoginState('idle')
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    if (this.directStopHeartbeat) { this.directStopHeartbeat(); this.directStopHeartbeat = null }
    const client = this.directClient
    this.directClient = null
    this.directQrResult = null
    this.directPollResult = null
    if (client) {
      // Before disconnecting: the close handler would schedule a reconnect
      for (const [event, listener] of this.clientListeners) client.off(event, listener)
      this.clientListeners = []
      client.clearSession()
      client.disconnect()
    }
    await super.stop()
  }

  /** session-expired 会 clearSession, 所以 isLoggedIn 能反映凭据作废; 再加上 TCP 状态 */
  public get_is_connected(): boolean {
    return !!this.directClient?.isConnected && !!this.directClient?.isLoggedIn
  }

  public async sendPB(cmd: string, pb: Buffer | string, timeout = 15000): Promise<PBData> {
    if (!this.directClient?.isLoggedIn) {
      throw new Error('Direct client not logged in')
    }
    const buf = Buffer.isBuffer(pb) ? pb : Buffer.from(pb, 'hex')
    const resp = await this.directClient.sendCommand(cmd, buf, undefined, timeout)
    return { cmd, pb: resp.payload.toString('hex') }
  }

  public async listQuickLoginAccounts(): Promise<QuickLoginAccounts> {
    return { ready: true, accounts: listAvailableSessions() }
  }

  /**
   * 相当于带 -q <uin> 启动, 等到有结果才返回: 上线了就成功, 没上线就抛出原因, FE 显示后退回扫码。
   * init 自己失败时只会悄悄退回扫码, 不等结果的话 WebUI 只能干等
   */
  public async quickLogin(uin: string): Promise<void> {
    if (this.selfInfo.online) return
    if (!/^\d+$/.test(uin)) throw new Error('invalid uin')
    // 先探一下: 解不开要报错, 不能悄悄退回扫码, 让用户对着一张没有提示的码
    const preload = loadSession(uin)
    const fallbackHint = !this.canQrLogin() ? '请使用账号密码重新登录' : '请重新登录'
    if (!preload) {
      throw new Error(`session 已失效(可能换了机器或加密 key 变了), ${fallbackHint}`)
    }
    this.runtimeUinOverride = uin
    this.restoreError = null
    try {
      await this.initDirectClient()
      // Another init was running: it picks this uin up when it goes round again
      const deadline = Date.now() + DirectQQProtocol.QUICK_LOGIN_WAIT_MS
      while (this.directInitInFlight && !this.selfInfo.online && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 200))
      }
    } finally {
      this.ensureQrLoop()
    }
    if (this.selfInfo.online) return
    throw new Error(this.restoreError ? `快速登录失败: ${this.restoreError}, ${fallbackHint}` : `快速登录没有成功, ${fallbackHint}`)
  }

  public override getPasswordLoginState(): PasswordLoginState {
    const supported = this.canPasswordLogin()
    if (!supported) return { supported: false, phase: 'idle' }
    if (this.selfInfo.online) {
      return { supported: true, phase: 'online', uin: this.selfInfo.uin }
    }
    return {
      ...this.passwordState,
      supported: true,
    }
  }

  public override cancelPasswordLogin(): void {
    this.passwordLoginToken++
    this.pwFlow = null
    if (this.directClient && !this.directClient.isLoggedIn) {
      this.directClient.setOuterUin(null)
      this.directClient.setUin(undefined)
    }
    this.resetPasswordLoginState('idle')
    this.ensureQrLoop()
  }

  public override async passwordLogin(uinRaw: string, password: string): Promise<PasswordLoginState> {
    if (!this.canPasswordLogin()) {
      throw new Error('当前协议不支持账号密码登录，请使用扫码登录')
    }
    if (this.selfInfo.online) {
      return { supported: true, phase: 'online', uin: this.selfInfo.uin }
    }
    const uin = uinRaw.trim()
    if (!/^\d{5,15}$/.test(uin)) {
      throw new Error('请输入有效的 QQ 号')
    }
    if (!password) {
      throw new Error('请输入 QQ 密码')
    }

    const myToken = ++this.passwordLoginToken
    // Pause any active QR code poll while password NTLogin uses the connection
    this.qrPollToken++
    this.directQrResult = null
    this.resetQrState()
    this.pwFlow = null
    this.manualLogout = false
    this.authTokenStatus.loginError = ''
    this.resetPasswordLoginState('logging_in', { uin, message: '正在连接服务器并建立安全通道...' })

    try {
      if (!this.directClient) {
        await this.initDirectClient()
      }
      if (this.passwordLoginToken !== myToken || this.disposed) return this.getPasswordLoginState()
      const client = this.directClient
      if (!client) {
        throw new Error('签名授权 Token 未配置或尚未验证通过，请先配置 auth_token')
      }
      if (!client.isConnected) await client.connect()
      if (this.passwordLoginToken !== myToken || this.disposed) return this.getPasswordLoginState()

      await client.acquirePreLoginToken()
      if (this.passwordLoginToken !== myToken || this.disposed) return this.getPasswordLoginState()

      this.passwordState = { supported: true, phase: 'logging_in', uin, message: '正在验证签名授权与交换密钥...' }
      client.clearSession()
      await client.bindSignUin(uin)
      if (this.passwordLoginToken !== myToken || this.disposed) return this.getPasswordLoginState()

      const kex = await client.mobileKex(uin)
      if (this.passwordLoginToken !== myToken || this.disposed) return this.getPasswordLoginState()

      this.pwFlow = {
        token: myToken,
        uin,
        pwdMd5: md5(password),
        salt: BigInt(uin),
        kex,
        cookie: '',
        longCookie: Buffer.alloc(0),
        attempts: 0,
        captchaSid: '2000000038',
        relayTicketsSent: new Set<string>(),
      }
      return await this.runPasswordLoginAttempt(myToken)
    } catch (e) {
      if (this.passwordLoginToken !== myToken) return this.getPasswordLoginState()
      const msg = (e as Error).message || String(e)
      this.logger.warn(`[MobileLogin] passwordLogin failed for ${uin}: ${msg}`)
      this.authTokenStatus.loginError = msg
      return this.resetPasswordLoginState('error', { uin, error: msg })
    }
  }

  public override async submitLoginCaptcha(ticket: string, randStr: string, sid?: string): Promise<PasswordLoginState> {
    const flow = this.pwFlow
    if (!flow || !this.canPasswordLogin()) {
      throw new Error('当前没有待提交的滑块验证流程，请重新输入账号密码登录')
    }
    const cleanTicket = ticket.trim()
    const cleanRand = randStr.trim()
    if (!cleanTicket || !cleanRand) {
      throw new Error('请填写完整的 ticket 和 randstr')
    }
    this.clearPasswordPollTimer()
    return await this.runPasswordLoginAttempt(flow.token, {
      captcha: { ticket: cleanTicket, randStr: cleanRand, sid: sid?.trim() || flow.captchaSid },
    })
  }

  public override async submitNewDeviceSig(sig: string): Promise<PasswordLoginState> {
    const flow = this.pwFlow
    if (!flow || !this.canPasswordLogin()) {
      throw new Error('当前没有待提交的新设备验证流程，请重新输入账号密码登录')
    }
    const trimmed = sig.trim()
    if (!trimmed) throw new Error('请填写新设备验证凭证 (deviceCheckSucceedSig)')
    this.clearPasswordPollTimer()
    return await this.runPasswordLoginAttempt(flow.token, {
      newDeviceSig: Buffer.from(trimmed, 'utf-8'),
    })
  }

  private async runPasswordLoginAttempt(
    myToken: number,
    opts: { captcha?: CaptchaSubmission; newDeviceSig?: Buffer } = {},
  ): Promise<PasswordLoginState> {
    const flow = this.pwFlow
    const client = this.directClient
    if (!flow || flow.token !== myToken || !client || this.passwordLoginToken !== myToken || this.disposed) {
      return this.getPasswordLoginState()
    }
    if (++flow.attempts > 6) {
      this.pwFlow = null
      return this.resetPasswordLoginState('error', { uin: flow.uin, error: '验证次数超限，请重新发起登录' })
    }

    this.clearPasswordPollTimer()
    this.passwordState = {
      supported: true,
      phase: 'logging_in',
      uin: flow.uin,
      message: opts.captcha
        ? '正在提交滑块验证结果...'
        : opts.newDeviceSig
          ? '正在提交新设备确认凭证...'
          : '正在提交账号密码登录...',
    }

    try {
      if (!client.isConnected) {
        await client.connect()
        await client.acquirePreLoginToken()
      }
      client.setOuterUin(flow.uin)
      const profile = getActiveProfile()
      const device = await client.getNtLoginDeviceInfo()
      const { clientA1 } = generateClientA1(
        flow.uin,
        flow.salt,
        profile.appId,
        device.guid,
        flow.pwdMd5,
        Math.floor(Date.now() / 1000),
      )

      const loginReq = buildPasswordLoginRequest(
        flow.kex,
        profile,
        device,
        flow.uin,
        flow.cookie,
        flow.longCookie,
        clientA1,
        opts.captcha,
        opts.newDeviceSig,
      )
      const loginResp = await client.sendCommand(PASSWORD_LOGIN_CMD, loginReq, EncryptType.EncryptEmpty)
      if (this.passwordLoginToken !== myToken || this.disposed) return this.getPasswordLoginState()

      let tickets = parseNtLoginResponse(flow.kex, loginResp.payload)
      if (tickets.cookie) flow.cookie = tickets.cookie
      if (tickets.longCookie.length > 0) flow.longCookie = tickets.longCookie

      if (tickets.d2.length > 0 && tickets.d2Key.length === 16) {
        return await this.finalizeMobileLogin(myToken, flow.uin, clientA1, tickets)
      }

      // Fallback to SsoNTLoginPasswordLoginNewDevice (Lagrange.Core path) if f3 returned no tickets and no captcha
      if (opts.newDeviceSig && opts.newDeviceSig.length > 0) {
        const isCaptcha = !!tickets.captchaUrl || tickets.error?.code === NTLOGIN_ERR_PROOF_WATER
        if (!isCaptcha) {
          this.logger.info(`[MobileLogin] PasswordLogin(f3) returned err=${tickets.error?.code ?? 0}, trying ${NEW_DEVICE_LOGIN_CMD}`)
          const ndReq = buildNewDeviceLoginRequest(
            flow.kex,
            profile,
            device,
            flow.uin,
            flow.cookie,
            flow.longCookie,
            opts.newDeviceSig,
          )
          try {
            const ndResp = await client.sendCommand(NEW_DEVICE_LOGIN_CMD, ndReq, EncryptType.EncryptEmpty)
            if (this.passwordLoginToken !== myToken || this.disposed) return this.getPasswordLoginState()
            const ndTickets = parseNtLoginResponse(flow.kex, ndResp.payload)
            if (ndTickets.cookie) flow.cookie = ndTickets.cookie
            if (ndTickets.longCookie.length > 0) flow.longCookie = ndTickets.longCookie
            if (ndTickets.d2.length > 0 && ndTickets.d2Key.length === 16) {
              return await this.finalizeMobileLogin(myToken, flow.uin, clientA1, ndTickets)
            }
            tickets = ndTickets
          } catch (e) {
            this.logger.warn(`[MobileLogin] ${NEW_DEVICE_LOGIN_CMD} failed: ${(e as Error).message}`)
          }
        }
      }

      // 140022008: Slider captcha (ProofWater)
      if (tickets.captchaUrl || tickets.error?.code === NTLOGIN_ERR_PROOF_WATER) {
        const rawUrl = tickets.captchaUrl || tickets.error?.jumpUrl || ''
        const captcha = parseCaptchaChallenge(rawUrl, flow.uin)
        flow.captchaSid = captcha.sid
        this.logger.info(`[MobileLogin] 需要滑块验证 (140022008)，请在 WebUI 完成验证 (sid=${captcha.sid})`)
        if (rawUrl) {
          // 机器旁没有浏览器时打开这个链接也能过滑块: 验证结果存进 captcha.luckylillia.com, 由轮询取回接着登录
          console.log('\n========== 需要滑块验证，请用浏览器打开下面的链接完成 ==========')
          console.log(buildCaptchaRelayUrl(rawUrl))
          console.log('===================================================================\n')
          this.startCaptchaRelayPolling(myToken, rawUrl)
        }
        this.passwordState = {
          supported: true,
          phase: 'captcha',
          uin: flow.uin,
          message: '请完成下方滑块验证，验证通过后将自动继续登录',
          captcha,
        }
        return this.getPasswordLoginState()
      }

      // 140022010: New-device verification (`oidb_0xc9e_8` QR confirm)
      if (tickets.error?.code === NTLOGIN_ERR_NEW_DEVICE) {
        const jumpUrl = tickets.error.jumpUrl || ''
        let qrUrl: string | undefined
        let qrPng: string | undefined
        let manualFallback = false
        try {
          const qr = await createNewDeviceQr(
            flow.uin,
            jumpUrl,
            tickets.newDeviceCheckSig,
            tickets.uinToken,
            profile.os,
            device.deviceName,
          )
          if (qr) {
            qrUrl = qr.qrUrl
            flow.newDeviceEndpoint = qr.endpoint
            flow.newDeviceBytesToken = qr.bytesToken
            qrPng = await QRCode.toDataURL(qr.qrUrl, { width: 200, margin: 1 })
            const qrText = await QRCode.toString(qr.qrUrl, { type: 'terminal', small: true })
            console.log(`\n========== 请使用已登录 QQ ${flow.uin} 的手机 QQ 扫码确认新设备 ==========`)
            console.log(qrText)
            console.log(`新设备确认链接: ${qr.qrUrl}`)
            console.log('===================================================================\n')
            this.logger.info(`[MobileLogin] 需要新设备验证 (140022010): ${qr.qrUrl}`)
          } else {
            manualFallback = true
          }
        } catch (e) {
          this.logger.warn(`[MobileLogin] oidb_0xc9e_8 拉取新设备二维码失败: ${(e as Error).message}`)
          manualFallback = true
        }

        this.passwordState = {
          supported: true,
          phase: 'new_device_qr',
          uin: flow.uin,
          message: manualFallback
            ? '服务器要求新设备验证，请打开验证链接并提交验证凭证'
            : `请使用已登录 QQ ${flow.uin} 的手机 QQ 扫描二维码确认新设备登录`,
          newDevice: { qrUrl, qrPng, jumpUrl, guaranteeStatus: 0, manualFallback },
        }
        if (!manualFallback && flow.newDeviceEndpoint && flow.newDeviceBytesToken) {
          this.startNewDeviceQrPolling(myToken, flow.newDeviceEndpoint, flow.newDeviceBytesToken)
        }
        return this.getPasswordLoginState()
      }

      const errMsg = tickets.error
        ? `${tickets.error.title ? `${tickets.error.title}: ` : ''}${tickets.error.msg || '登录失败'} (code=${tickets.error.code})`
        : '登录未返回有效票据，请检查账号和密码'
      this.logger.warn(`[MobileLogin] ${errMsg}`)
      this.authTokenStatus.loginError = errMsg
      this.pwFlow = null
      return this.resetPasswordLoginState('error', { uin: flow.uin, error: errMsg })
    } catch (e) {
      if (this.passwordLoginToken !== myToken) return this.getPasswordLoginState()
      const msg = (e as Error).message || String(e)
      this.logger.warn(`[MobileLogin] attempt failed: ${msg}`)
      this.authTokenStatus.loginError = msg
      return this.resetPasswordLoginState('error', { uin: flow.uin, error: msg })
    }
  }

  private startNewDeviceQrPolling(myToken: number, endpoint: string, bytesToken: string): void {
    const deadline = Date.now() + 180_000
    const tick = async () => {
      if (this.passwordLoginToken !== myToken || this.disposed || this.selfInfo.online) return
      if (Date.now() >= deadline) {
        this.pwFlow = null
        this.resetPasswordLoginState('error', { uin: this.passwordState.uin, error: '新设备扫码确认超时 (180s)，请重新登录' })
        return
      }
      try {
        const res = await pollNewDeviceQrOnce(endpoint, bytesToken)
        if (this.passwordLoginToken !== myToken || this.disposed || this.selfInfo.online) return
        if (res.status === 'confirmed') {
          this.logger.info(`[MobileLogin] 新设备扫码确认成功 (${res.succToken.length}B)，继续提交登录...`)
          void this.runPasswordLoginAttempt(myToken, { newDeviceSig: res.succToken })
          return
        }
        if (res.status === 'failed') {
          this.pwFlow = null
          this.resetPasswordLoginState('error', { uin: this.passwordState.uin, error: res.reason })
          return
        }
        if (this.passwordState.newDevice) {
          this.passwordState = {
            ...this.passwordState,
            newDevice: { ...this.passwordState.newDevice, guaranteeStatus: res.guaranteeStatus },
          }
        }
      } catch (e) {
        this.logger.warn(`[MobileLogin] oidb_0xc9e_8 poll error: ${(e as Error).message}`)
      }
      if (this.passwordLoginToken !== myToken || this.disposed || this.selfInfo.online) return
      this.passwordPollTimer = setTimeout(tick, 2000)
    }
    this.passwordPollTimer = setTimeout(tick, 2000)
  }

  /**
   * Polls the console link's relay for the slider result and continues the login with it. The WebUI submitting its
   * own result, a cancelled or superseded flow and the five-minute limit all end it; the WebUI slider outlives them.
   */
  private startCaptchaRelayPolling(myToken: number, verifyUrl: string): void {
    const flow = this.pwFlow
    if (!flow) return
    // Read after the attempt cleared the timer: the round of the captcha just issued
    const round = this.captchaRelayRound
    const isStale = () => this.captchaRelayRound !== round || this.passwordLoginToken !== myToken
      || this.disposed || this.selfInfo.online
    const deadline = Date.now() + DirectQQProtocol.CAPTCHA_RELAY_TIMEOUT_MS
    let failures = 0
    const tick = async () => {
      if (isStale()) return
      if (Date.now() >= deadline) {
        this.logger.info(`[MobileLogin] 验证链接 ${DirectQQProtocol.CAPTCHA_RELAY_TIMEOUT_MS / 60_000} 分钟内未完成，已停止查询；仍可在 WebUI 完成验证`)
        return
      }
      let result: CaptchaRelayResult | null = null
      let delay = DirectQQProtocol.CAPTCHA_RELAY_POLL_MS
      try {
        result = await fetchCaptchaRelayResult(verifyUrl)
        failures = 0
      } catch (e) {
        if (isStale()) return
        failures++
        const networkError = e instanceof TypeError || (e instanceof Error && e.name === 'TimeoutError')
        if (networkError && failures === 1) delay = 500
        if (failures === 1 || failures % 10 === 0) {
          const cause = e instanceof Error ? e.cause as NodeJS.ErrnoException | undefined : undefined
          const reason = cause?.code || cause?.message || (e instanceof Error ? e.message : String(e))
          this.logger.warn(`[MobileLogin] 查询滑块验证结果失败: ${reason}（连续 ${failures} 次），${delay / 1000} 秒后重试`)
        }
      }
      if (isStale()) return
      if (result?.status === 'verified') {
        if (!flow.relayTicketsSent.has(result.ticket)) {
          flow.relayTicketsSent.add(result.ticket)
          this.logger.info('[MobileLogin] 验证链接的滑块已通过，正在提交验证结果...')
          void this.runPasswordLoginAttempt(myToken, {
            captcha: { ticket: result.ticket, randStr: result.randStr, sid: flow.captchaSid },
          })
          return
        }
      }
      this.passwordPollTimer = setTimeout(tick, delay)
    }
    this.passwordPollTimer = setTimeout(tick, DirectQQProtocol.CAPTCHA_RELAY_POLL_MS)
  }

  private async finalizeMobileLogin(
    myToken: number,
    fallbackUin: string,
    fallbackA1: Buffer,
    tickets: NtLoginTickets,
  ): Promise<PasswordLoginState> {
    const client = this.directClient
    if (!client || this.passwordLoginToken !== myToken || this.disposed) {
      return this.getPasswordLoginState()
    }
    const finalUin = tickets.uin || fallbackUin
    const a1ToSave = tickets.a1.length > 0 ? tickets.a1 : fallbackA1
    const session: SessionInfo = {
      uin: finalUin,
      uid: tickets.uid,
      d2: tickets.d2,
      d2Key: tickets.d2Key,
      tgt: tickets.tgtA2,
      a2: tickets.tgtA2,
      a2Key: Buffer.alloc(16),
      sKey: Buffer.alloc(0),
    }

    this.passwordState = { supported: true, phase: 'logging_in', uin: finalUin, message: '登录票据已签发，正在刷新安全 Token 并注册上线...' }
    client.setSession(session)
    await client.awaitSignTokenAcquire()
    if (this.passwordLoginToken !== myToken || client.getSession() !== session) {
      return this.getPasswordLoginState()
    }
    if ((this.selfInfo.uin || this.selfInfo.uid) &&
      (this.selfInfo.uin !== finalUin || this.selfInfo.uid !== tickets.uid)) {
      await this.clearLogin()
      if (this.passwordLoginToken !== myToken || client.getSession() !== session) {
        return this.getPasswordLoginState()
      }
    }

    try {
      await registerOnline(client)
    } catch (e) {
      if (this.passwordLoginToken !== myToken || client.getSession() !== session) {
        return this.getPasswordLoginState()
      }
      const msg = (e as Error).message || String(e)
      this.logger.error('[MobileLogin] Register online failed:', msg)
      this.authTokenStatus.loginError = `上线注册失败: ${msg}`
      client.clearSession()
      this.pwFlow = null
      return this.resetPasswordLoginState('error', { uin: finalUin, error: `上线注册失败: ${msg}` })
    }

    if (this.passwordLoginToken !== myToken || client.getSession() !== session) {
      return this.getPasswordLoginState()
    }

    this.logger.info(`[MobileLogin] Login successful! UIN=${finalUin} UID=${tickets.uid} nick="${tickets.nick}"`)
    saveSession(session, Buffer.alloc(0), client.getGuid(), a1ToSave, tickets.nick)
    this.directStopHeartbeat = startHeartbeat(client)
    void client.startSsoReport()

    this.selfInfo.uin = finalUin
    this.selfInfo.uid = tickets.uid
    this.selfInfo.nick = tickets.nick
    this.selfInfo.online = true
    this.runtimeUinOverride = finalUin
    this.pwFlow = null
    this.resetPasswordLoginState('online', { uin: finalUin })
    this.maybeEmitOnline()
    if (!this.selfInfo.nick) {
      this.scheduleFetchSelfNick(() => this.passwordLoginToken === myToken && client.getSession() === session)
    }
    return this.getPasswordLoginState()
  }

  public async logout(): Promise<void> {
    this.manualLogout = true
    this.qrPollToken++
    this.initToken++
    this.passwordLoginToken++
    this.pwFlow = null
    this.resetPasswordLoginState('idle')
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    this.directClient?.clearSession()
    this.directClient?.disconnect()
    this.runtimeUinOverride = null
    // 不然 180s 内登出会复用上一次的旧码
    this.resetQrState()
    const logoutToken = this.initToken
    await this.clearLogin()
    if (!this.disposed && logoutToken === this.initToken) this.ensureQrLoop()
  }

  protected async fetchFreshQrCode(): Promise<{ qrcodeUrl: string; pngBase64: string; expireTimeSec: number; sig: string } | null> {
    if (!this.canQrLogin()) return null
    if (!this.directClient) return null
    if (!this.directClient.isLoggedIn && !this.pwFlow) {
      this.directClient.setOuterUin(null)
      this.directClient.setUin(undefined)
    }
    // 主动 logout 后不会自动重连, 这里只重建 TCP 拉码, 不恢复 session
    if (!this.directClient.isConnected) await this.directClient.connect()
    // macOS: ESK precedes trans_emp on every connection; no-op while the current one is live.
    await this.directClient.acquirePreLoginToken()
    const qr = await fetchQrCode(this.directClient)
    this.directQrResult = qr
    return {
      qrcodeUrl: qr.url,
      pngBase64: qr.image.length > 0 ? 'data:image/png;base64,' + qr.image.toString('base64') : '',
      expireTimeSec: DirectQQProtocol.QR_TTL_MS / 1000,
      sig: qr.sig.toString('hex'),
    }
  }

  protected onQrRefreshed(): void {
    this.startDirectQrPolling()
  }

  public checkAuthToken(): void {
    // 先置 validating, 免得前端轮询到上一次的结果
    const status = this.authTokenStatus
    status.hasToken = true
    status.validation = 'validating'
    status.message = ''
    status.loginError = ''
    this.tokenWatcher.check()
  }

  /** 登录错误写进 authTokenStatus.loginError 给 WebUI; init 抛错交给 watcher 定时重试 */
  private async onAuthTokenValid(token: string): Promise<void> {
    if (this.selfInfo.online) return
    try {
      await this.initDirectClient(token)
      this.ensureQrLoop()
    } catch (e) {
      this.authTokenStatus.loginError = (e as Error)?.message || String(e)
      this.logger.error('[Sign] auth_token 校验通过但登录初始化失败:', e)
      throw e
    }
  }

  protected shouldSkipQrPrint(): boolean {
    const phase = this.passwordState.phase
    const inPasswordFlow = this.pwFlow !== null || phase === 'logging_in' || phase === 'captcha' || phase === 'new_device_qr'
    return !!this.directClient?.isLoggedIn || !this.canQrLogin() || inPasswordFlow
  }

  protected qrAutoRefreshLimit(): number {
    return DirectQQProtocol.QR_AUTO_REFRESH_LIMIT
  }

  /**
   * Only a failed init is retried, with backoff. Once init returns the QR loop takes over: rescheduling after a
   * QR fallback would replace the code every 5s.
   */
  private scheduleReconnect(attempt = 0) {
    if (this.reconnectTimer || this.selfInfo.online) return
    if (!(authTokenUtil.reload() || process.env.AUTH_TOKEN || '').trim()) return
    const delay = Math.min(DirectQQProtocol.RECONNECT_MS * 2 ** attempt, DirectQQProtocol.RECONNECT_MAX_MS)
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      if (this.selfInfo.online) return
      try {
        await this.initDirectClient()
      } catch (e) {
        this.logger.warn('[Direct] 重连失败, 稍后重试', e)
        this.scheduleReconnect(attempt + 1)
        return
      }
      this.ensureQrLoop()
    }, delay)
  }

  /** 没有 auth_token 时直接返回而不是 throw, 进程和 WebUI 照常起来 */
  private async initDirectClient(tokenArg?: string): Promise<void> {
    // 优先用 watcher 校验过的那份: 文件期间可能又被改了
    let authToken = (tokenArg || authTokenUtil.reload() || process.env.AUTH_TOKEN || '').trim()
    if (!authToken) {
      const tokenPath = authTokenUtil.getPath()
      this.logger.warn(
        `[Sign] auth_token 未配置 (${tokenPath} 为空 / 不存在). ` +
        `请在 WebUI 中录入, 或到 ${getAuthTokenPageUrl()} 获取后填入; 录入验证通过后会自动开始登录.`
      )
      return
    }
    // 已有 init 在跑就记下最新 token, 跑完再来一次
    if (this.directInitInFlight) {
      this.directPendingToken = authToken
      return
    }
    this.directInitInFlight = true
    let lastErr: unknown = null
    try {
      do {
        this.directPendingToken = ''
        try {
          lastErr = null
          await this.doInitDirectClient(authToken)
        } catch (e) {
          lastErr = e
        }
        authToken = this.directPendingToken
      } while (authToken)
    } finally {
      this.directInitInFlight = false
      this.directPendingToken = ''
    }
    if (lastErr) throw lastErr
  }

  private async doInitDirectClient(authToken: string): Promise<void> {
    this.manualLogout = false
    this.restoreError = null
    const myToken = ++this.initToken
    this.qrPollToken++
    // 不然会复用上一个账号的码
    this.resetQrState()
    this.directQrResult = null

    // 首次 init 之前是 no-op, token 由 client 的 config 带入
    await updateAuthToken(authToken).catch((e) => this.logger.warn('[Sign] updateAuthToken failed:', (e as Error).message))
    if (this.initToken !== myToken) return

    const specifiedUin = this.runtimeUinOverride || this.loginOptions.autoLoginUin || undefined
    if (specifiedUin) {
      this.logger.info('Specified login uin: %s, will try %s', specifiedUin, getSessionFilePathForUin(specifiedUin))
    } else {
      this.logger.info('No uin specified, will perform fresh QR login (session will be saved as %s)', getSessionFilePathForUin('<uin>'))
    }
    const persisted = loadSession(specifiedUin)

    // guid 以 session 为准
    if (persisted) {
      overwriteMachineGuid(Buffer.from(persisted.guid, 'hex'))
    }

    // 签握手命令要 uin, 但只在有 session 时预先给, 扫码全程不需要。指定了 uin 却没有可用 session 时把它交给 init,
    // SDK 会立刻用这个还没登记的 uin 打 /api/sign/e -> 403 -> exit(1), 所以丢掉它走扫码
    if (specifiedUin && !persisted) {
      this.logger.info(
        'Specified uin %s has no usable session; dropping it and doing a fresh QR login (it will enroll via wtlogin.login)',
        specifiedUin,
      )
    }
    const uinCandidate = persisted?.uin || ''
    const uinForInit = uinCandidate ? Number(uinCandidate) : undefined
    const uinArg = Number.isFinite(uinForInit) && (uinForInit as number) > 0 ? (uinForInit as number) : undefined

    // 只建一个 client: native sign 的 relay 只绑第一个 client 且无法重绑, 重建会让 relay 发到死掉的旧 client。
    // 换 token / 账号只热切换配置
    if (!this.directClient && sharedClient) {
      this.directClient = sharedClient
      this.bindDirectClientEvents(sharedClient)
    }
    if (!this.directClient) {
      this.directClient = sharedClient = new DirectProtocolClient({
        authToken,
        botVersion: `LLBot_${version}`,
        uin: uinArg,
        cdn: getCdn(),
      })
      this.bindDirectClientEvents(this.directClient)
    } else {
      this.directClient.syncProfile()
      this.directClient.setAuthToken(authToken)
      this.directClient.setUin(uinArg)
      this.directClient.clearSession()
      // 从别的机器导入的账号 guid 不同, 同步 client 和 native sign 的设备指纹
      if (persisted) {
        const g = Buffer.from(persisted.guid, 'hex')
        if (!g.equals(this.directClient.getGuid())) this.directClient.setGuid(g)
      }
    }

    if (persisted) {
      // uin 授权由服务端按配额判, 本地不预检
      this.logger.info('Found saved session for UIN %s (file: %s), attempting restore...', persisted.uin, getSessionFilePathForUin(persisted.uin))
      if (!this.directClient.isConnected) await this.directClient.connect()
      if (this.initToken !== myToken) return
      await this.directClient.acquirePreLoginToken()
      if (this.initToken !== myToken) return
      // macOS 用存档凭证刷新票据, d2 过期也能续; 不行就直接恢复
      let session = persistedToSessionInfo(persisted)
      const isMobile = isMobileFamily(getActiveProfile().family)
      const refreshed = !isMobile ? await this.directClient.macosEasyLogin(persisted).catch(() => null) : null
      if (this.initToken !== myToken) return
      if (refreshed) {
        session = refreshed.session
        this.logger.info('[EasyLogin] macOS 免扫码续期成功')
        saveSession(session, Buffer.from(persisted.tgtgtKey ?? '', 'hex'), this.directClient.getGuid(), Buffer.from(refreshed.a1106Hex, 'hex'), persisted.nick)
      }
      if ((this.selfInfo.uin || this.selfInfo.uid) &&
        (this.selfInfo.uin !== persisted.uin || this.selfInfo.uid !== persisted.uid)) {
        await this.clearLogin()
        if (this.initToken !== myToken) return
      }
      this.directClient.setSession(session)

      let onlineOk = false
      try {
        if (isMobile) {
          await this.directClient.awaitSignTokenAcquire()
          if (this.initToken !== myToken || this.directClient.getSession() !== session) return
        }
        await registerOnline(this.directClient)
        if (this.initToken !== myToken || this.directClient.getSession() !== session) return
        onlineOk = true
      } catch (e) {
        if (this.initToken !== myToken || this.directClient.getSession() !== session) return
        this.restoreError = (e as Error).message
        this.directClient.clearSession()

        // Mobile fallback: if d2/tgt expired, automatically refresh tickets via SsoNTLoginEasyLogin (saved A1).
        if (isMobile && persisted.tempPassword) {
          this.logger.info('[EasyLogin] Saved mobile session expired (%s), attempting SsoNTLoginEasyLogin...', this.restoreError)
          const mobileRefreshed = await this.directClient.mobileEasyLogin(persisted).catch(() => null)
          if (this.initToken !== myToken) return
          if (mobileRefreshed) {
            session = mobileRefreshed.session
            this.directClient.setSession(session)
            try {
              await this.directClient.awaitSignTokenAcquire()
              if (this.initToken !== myToken || this.directClient.getSession() !== session) return
              await registerOnline(this.directClient)
              if (this.initToken !== myToken || this.directClient.getSession() !== session) return
              saveSession(session, Buffer.alloc(0), this.directClient.getGuid(), Buffer.from(mobileRefreshed.a1Hex, 'hex'), mobileRefreshed.nick || persisted.nick)
              this.restoreError = null
              onlineOk = true
              this.logger.info('[EasyLogin] Mobile SsoNTLoginEasyLogin succeeded!')
            } catch (e2) {
              if (this.initToken !== myToken || this.directClient.getSession() !== session) return
              this.restoreError = (e2 as Error).message
              this.directClient.clearSession()
            }
          }
        }
      }

      if (onlineOk) {
        this.logger.info('[QQ Server] Online registered!')
        this.selfInfo.uin = session.uin
        this.selfInfo.uid = session.uid
        if (persisted.nick) this.selfInfo.nick = persisted.nick
        this.selfInfo.online = true
        // 断线重连时用它恢复 session
        this.runtimeUinOverride = session.uin
        this.directStopHeartbeat = startHeartbeat(this.directClient)
        // 上线后才开始遥测, 跟真机时序一致
        void this.directClient.startSsoReport()
        if (isMobile) this.resetPasswordLoginState('online', { uin: session.uin })
        this.maybeEmitOnline()
        // 恢复的 session 可能没有 nick
        if (!this.selfInfo.nick) {
          this.scheduleFetchSelfNick(() => this.initToken === myToken && this.directClient?.getSession() === session)
        }
        return
      }
      this.logger.info(
        isMobile ? 'Saved mobile session expired, waiting for password login: %s' : 'Saved session expired, will need QR login: %s',
        this.restoreError || 'unknown',
      )
    }

    if (this.initToken !== myToken) return
    if (!this.directClient.isConnected) await this.directClient.connect()
    if (this.initToken !== myToken) return
    if (!this.canQrLogin()) {
      await this.directClient.acquirePreLoginToken()
    }
  }

  /** 每个实例接上 client 时调一次 */
  private bindDirectClientEvents(client: DirectProtocolClient): void {
    const on = (event: string, listener: (...args: any[]) => void) => {
      client.on(event, listener)
      this.clientListeners.push([event, listener])
    }
    on('session-expired', (uin: string, error: Error) => {
      const wasOnline = this.onlineEmitted
      this.selfInfo.online = false
      this.onlineEmitted = false
      this.authTokenStatus.loginError = error.message
      this.logger.warn('QQ session expired:', error.message)
      if (this.directStopHeartbeat) {
        this.directStopHeartbeat()
        this.directStopHeartbeat = null
      }
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
      }
      // Remove only the rejected account's credentials; retain the device identity and native client.
      deleteSession(uin)
      this.runtimeUinOverride = null
      this.qrPollToken++
      this.initToken++
      this.passwordLoginToken++
      this.pwFlow = null
      this.resetPasswordLoginState('idle')
      this.directQrResult = null
      this.directPollResult = null
      this.resetQrState()
      if (wasOnline) {
        this.ctx.parallel('protocol/disconnect')
        this.ctx.parallel('qq/session-expired', error.message)
      }
      this.ensureQrLoop()
    })
    // Native sign reports to the client it is bound to, the only one of the process
    on('sign-refused', (detail: string) => {
      this.authTokenStatus.loginError = detail
    })
    on('error', (err: Error) => {
      this.logger.warn('Direct client error:', err.message)
    })
    on('connected', () => {
      this.lastConnectedTime = Date.now()
    })
    on('close', () => {
      const wasOnline = this.onlineEmitted
      this.selfInfo.online = false
      if (this.directStopHeartbeat) {
        this.directStopHeartbeat()
        this.directStopHeartbeat = null
      }
      this.onlineEmitted = false
      if (wasOnline) {
        this.ctx.parallel('protocol/disconnect')
        // 只有主动 logout 不重连; 顶号时 session 已删, 重连会退回扫码
        if (!this.manualLogout) this.scheduleReconnect()
      }
    })
    on('push', (packet: { cmd: string; payload: Buffer }) => {
      // Unauthenticated traffic must not postpone the disconnect notification.
      if (client.isLoggedIn) this.lastConnectedTime = Date.now()
      this.ctx.parallel('qq/raw', { cmd: packet.cmd, payload: packet.payload })
    })
  }

  private startDirectQrPolling() {
    if (!this.directClient || !this.directQrResult) return
    const myToken = ++this.qrPollToken

    const poll = async () => {
      if (this.qrPollToken !== myToken) return
      if (!this.directClient || !this.directQrResult) return
      if (this.directClient.isLoggedIn) return

      try {
        const result = await pollQrCode(this.directClient, this.directQrResult.sig)
        if (this.qrPollToken !== myToken) return
        this.directPollResult = result

        if (result.state === QrCodeState.Confirmed) {
          await this.completeDirectLogin(myToken)
          return
        }

        if (result.state === QrCodeState.Expired || result.state === QrCodeState.Cancelled) {
          const expired = result.state === QrCodeState.Expired
          // The code's age is the tell for server-side risk control: flagged devices get codes that die in seconds.
          const age = this.qrFetchedAt ? `${Math.round((Date.now() - this.qrFetchedAt) / 1000)}s` : '?'
          this.logger.info(expired ? `二维码已过期, 这张码用了 ${age}` : `手机端取消了扫码, 这张码用了 ${age}`)
          this.invalidateQrCache()
          return
        }
      } catch (e) {
        if (this.qrPollToken !== myToken) return
        this.logger.warn('QR poll error:', (e as Error).message)
      }

      if (this.qrPollToken !== myToken) return
      setTimeout(poll, 2000)
    }

    setTimeout(poll, 2000)
  }

  private async completeDirectLogin(myToken: number) {
    const client = this.directClient
    const pollResult = this.directPollResult
    const qrResult = this.directQrResult
    if (this.qrPollToken !== myToken || !client || !pollResult || !qrResult) return
    this.manualLogout = false

    // watch 的 uin 在 poll 的 confirm 里, 桌面走 getCorrectUin
    let uin: number
    if (getActiveProfile().family === 'watch') {
      uin = Number(pollResult.uin || 0)
      if (!uin) {
        this.logger.error('watch 登录: poll confirm 未拿到 uin, 无法继续')
        return
      }
    } else {
      const urlParams = new URL(qrResult.url).searchParams
      const qrSig = urlParams.get('k') || ''
      uin = await getCorrectUin(AppInfo.appId, qrSig)
      if (this.qrPollToken !== myToken) return
      pollResult.uin = String(uin)
    }

    const loginResult = await loginWithQrResult(client, pollResult, () => this.qrPollToken === myToken)
    if (this.qrPollToken !== myToken) return
    if (!loginResult.success) {
      this.logger.error(`Login failed: state=${loginResult.state} ${loginResult.tag} ${loginResult.message}`)
      this.authTokenStatus.loginError = `登录失败: ${[loginResult.tag, loginResult.message].filter(Boolean).join(' ')}`.trim()
      return
    }

    const session = client.getSession()
    if (!session) return

    await client.awaitSignTokenAcquire()
    if (this.qrPollToken !== myToken || client.getSession() !== session) return
    if ((this.selfInfo.uin || this.selfInfo.uid) &&
      (this.selfInfo.uin !== String(uin) || this.selfInfo.uid !== loginResult.uid)) {
      await this.clearLogin()
      if (this.qrPollToken !== myToken || client.getSession() !== session) return
    }

    // 上线失败要清掉半成品 session: 不然 isLoggedIn 为 true, 扫码 loop 不再出码, 成了收不到 MsgPush 的"假在线"
    try {
      await registerOnline(client)
    } catch (e) {
      if (this.qrPollToken !== myToken || client.getSession() !== session) return
      const msg = (e as Error).message
      this.logger.error('Register online failed:', msg)
      this.authTokenStatus.loginError = `上线注册失败: ${msg}`
      client.clearSession()
      return
    }
    // A completed request may resume after invalidation or a newer login attempt.
    if (this.qrPollToken !== myToken || client.getSession() !== session) return

    this.logger.info(`Login successful! UID: ${loginResult.uid}, nick: "${loginResult.nick}"`)
    saveSession(session, pollResult.tgtgtKey!, client.getGuid(), loginResult.tempPassword, loginResult.nick)

    this.directStopHeartbeat = startHeartbeat(client)
    // 上线后才开始遥测, 跟真机时序一致
    void client.startSsoReport()

    this.selfInfo.uin = String(uin)
    this.selfInfo.uid = loginResult.uid
    this.selfInfo.nick = loginResult.nick
    this.selfInfo.online = true
    // 断线重连时用它恢复 session
    this.runtimeUinOverride = String(uin)
    this.maybeEmitOnline()
    if (!this.selfInfo.nick) {
      this.scheduleFetchSelfNick(() => this.qrPollToken === myToken && client.getSession() === session)
    }
  }
}
