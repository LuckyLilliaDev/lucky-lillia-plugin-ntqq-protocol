// Mobile NTLogin protocol (`trpc.login.ecdh.EcdhService.*`) and interactive verification helpers
// for iOS (9.3.5) and HarmonyOS (9.2.71):
//   - SsoKeyExchange (P-256 ECDH + dual AES-256-GCM -> 32B session_key + ticket)
//   - SsoNTLoginGetSaltList
//   - SsoNTLoginPasswordLogin (GenerateClientA1 + optional captcha f2 / new_device_sig f3)
//   - SsoNTLoginPasswordLoginNewDevice (fallback path)
//   - SsoNTLoginEasyLogin (passwordless session refresh with saved A1 ticket)
//   - 140022008 ProofWater slider captcha (WebUI embedded TCaptcha + console-link relay + manual fallback)
//   - 140022010 NewDevice QR confirm (oidb.tim.qq.com/v3/oidbinterface/oidb_0xc9e_8)
// Mirrors LuckyLillia.Sign/src/{CommonPoC/src/kex.rs,iOS/PoC/src/ntlogin.rs,Harmony/PoC/src/{ntlogin.rs,verify.rs}}.

import { randomBytes, type ECDH } from 'node:crypto'
import { pbBytes, pbString, pbVarint } from '../pbCodec'
import { teaEncrypt } from '../tea'
import type { ProtocolProfile } from '../profiles/types'
import {
  aes256GcmOpen,
  aes256GcmSeal,
  ecdhP256RawX,
  generateP256KeyPair,
  md5,
  pbFirstBytes,
  pbFirstU64,
  pbIter,
  sha256,
} from './crypto'

export const KEX_CMD = 'trpc.login.ecdh.EcdhService.SsoKeyExchange'
export const GET_SALT_CMD = 'trpc.login.ecdh.EcdhService.SsoNTLoginGetSaltList'
export const PASSWORD_LOGIN_CMD = 'trpc.login.ecdh.EcdhService.SsoNTLoginPasswordLogin'
export const NEW_DEVICE_LOGIN_CMD = 'trpc.login.ecdh.EcdhService.SsoNTLoginPasswordLoginNewDevice'
export const EASY_LOGIN_CMD = 'trpc.login.ecdh.EcdhService.SsoNTLoginEasyLogin'

export const NTLOGIN_ERR_STRICT = 140_022_007
export const NTLOGIN_ERR_PROOF_WATER = 140_022_008
export const NTLOGIN_ERR_NEW_DEVICE = 140_022_010
export const NTLOGIN_ERR_UNUSUAL_DEVICE = 140_022_011

export const KEX_SERVER_PUB = Buffer.from(
  '049d1423332735980edabe7e9ea451b3395b6f35250db8fc56f25889f628cbae3e8e73077914071eeebc108f4e0170057792bb17aa303af652313d17c1ac815e79',
  'hex',
)
export const KEX_EMBED_KEY32 = Buffer.from(
  'e2733bf403149913cbf80c7a95168bd4ca6935ee53cd39764beebe2e007e3aee',
  'hex',
)

const OIDB_NEW_DEVICE_URL = 'https://oidb.tim.qq.com/v3/oidbinterface/oidb_0xc9e_8'
const CAPTCHA_RELAY_ORIGIN = 'https://captcha.luckylillia.com'
const DEFAULT_TCAPTCHA_APP_ID = '2081081773'

export interface KexSession {
  sessionKey: Buffer     // 32B
  sessionTicket: Buffer
}

export interface NtLoginError {
  code: number
  title: string
  msg: string
  jumpUrl: string
}

export interface NtLoginTickets {
  uin: string
  uid: string
  nick: string
  a1: Buffer
  tgtA2: Buffer
  d2: Buffer
  d2Key: Buffer
  noPicSig: Buffer
  error?: NtLoginError
  captchaUrl: string
  newDeviceCheckSig: Buffer
  unusualDeviceCheckSig: Buffer
  unusualDeviceQrSig: string
  uinToken: string
  cookie: string
  longCookie: Buffer
}

export interface SaltListResult {
  salt: bigint
  cookie: string
  error?: NtLoginError
}

export interface CaptchaSubmission {
  ticket: string
  randStr: string
  sid: string
}

export function buildKexRequest(
  uin: string,
  guid16: Buffer,
  tsSec: number = Math.floor(Date.now() / 1000),
): { body: Buffer; ecdh: ECDH } {
  const kp = generateP256KeyPair()
  const ecdhKey = ecdhP256RawX(kp.ecdh, KEX_SERVER_PUB)
  if (!ecdhKey) throw new Error('KEX P-256 ECDH failed')

  const inner = Buffer.concat([pbString(1, uin), pbBytes(2, guid16)])
  const ct1 = aes256GcmSeal(ecdhKey, inner)

  const tsBuf = Buffer.alloc(8)
  tsBuf.writeBigUInt64BE(BigInt(tsSec))
  const md = sha256(Buffer.concat([kp.pubUncompressed, Buffer.from([0, 0, 0, 1]), ct1, tsBuf]))
  const sig = aes256GcmSeal(KEX_EMBED_KEY32, md)

  const body = Buffer.concat([
    pbBytes(1, kp.pubUncompressed),
    pbVarint(2, 1),
    pbBytes(3, ct1),
    pbVarint(4, tsSec),
    pbBytes(5, sig),
  ])
  return { body, ecdh: kp.ecdh }
}

export function parseKexResponse(ecdh: ECDH, resp: Buffer): KexSession | null {
  const meta = pbFirstBytes(resp, 1)
  const serverEphPub = pbFirstBytes(resp, 3)
  if (!meta || !serverEphPub) return null
  const share2 = ecdhP256RawX(ecdh, serverEphPub)
  if (!share2) return null
  const plain = aes256GcmOpen(share2, meta)
  if (!plain) return null
  const sk = pbFirstBytes(plain, 1)
  const ticket = pbFirstBytes(plain, 2)
  if (!sk || sk.length !== 32 || !ticket) return null
  return { sessionKey: Buffer.from(sk), sessionTicket: Buffer.from(ticket) }
}

export interface NtLoginDeviceIdentity {
  guid: Buffer
  deviceName: string
  model?: string
}

function desktopNtLoginPlatform(profile: ProtocolProfile): number {
  switch (profile.name) {
    case 'windows':
      return 4 // PLATFORM_WINDOWS
    case 'macos':
      return 5 // PLATFORM_MAC
    case 'linux':
      return 7 // PLATFORM_LINUX
    default:
      return 0
  }
}

/** Mobile ECDH forward envelope: `{1: session_ticket, 4: 1, 5: GCM(key, {2: common_plain, 3: {1:0, 2:uin}})}`. */
export function wrapEcdhForward(kex: KexSession, commonPlain: Buffer, uin: string): Buffer {
  const extParts: Buffer[] = [pbVarint(1, 0)]
  if (uin) extParts.push(pbString(2, uin))
  const ecdhBody = Buffer.concat([pbBytes(2, commonPlain), pbBytes(3, Buffer.concat(extParts))])
  const secBuf = aes256GcmSeal(kex.sessionKey, ecdhBody)
  return Buffer.concat([pbBytes(1, kex.sessionTicket), pbVarint(4, 1), pbBytes(5, secBuf)])
}

/** Desktop PC (`f3`) vs Mobile (`f5`) ECDH forward envelope. */
export function wrapNtLoginForward(
  profile: ProtocolProfile,
  kex: KexSession,
  commonPlain: Buffer,
  uin: string,
): Buffer {
  if (profile.mobile) {
    return wrapEcdhForward(kex, commonPlain, uin)
  }
  const encBuf = aes256GcmSeal(kex.sessionKey, commonPlain)
  return Buffer.concat([pbBytes(1, kex.sessionTicket), pbBytes(3, encBuf), pbVarint(4, 1)])
}

function scanDecryptNtLogin(data: Buffer, key32: Buffer, depth: number): Buffer | null {
  if (data.length >= 28) {
    const pt = aes256GcmOpen(key32, data)
    if (pt && pt.length >= 8) return pt
  }
  if (depth === 0) return null
  for (const f of pbIter(data)) {
    if (f.wire === 2) {
      const r = scanDecryptNtLogin(f.bytes, key32, depth - 1)
      if (r) return r
    }
  }
  return null
}

/** Decrypt mobile NTLogin response (`f5 -> GCM -> f2`, with `f3` and recursive fallback). */
export function unwrapEcdhForward(kex: KexSession, resp: Buffer): Buffer | null {
  const f5 = pbFirstBytes(resp, 5)
  if (f5) {
    const ecdhBody = aes256GcmOpen(kex.sessionKey, f5)
    if (ecdhBody) return pbFirstBytes(ecdhBody, 2) ?? ecdhBody
  }
  const f3 = pbFirstBytes(resp, 3)
  if (f3) {
    const pt = aes256GcmOpen(kex.sessionKey, f3)
    if (pt) return pt
  }
  return scanDecryptNtLogin(resp, kex.sessionKey, 4)
}

export function buildMobileNtLoginHead(
  profile: ProtocolProfile,
  device: NtLoginDeviceIdentity,
  uin: string,
  cookie?: string,
  longCookie?: Buffer,
): Buffer {
  const mobile = profile.mobile
  if (!mobile && profile.family !== 'nt') {
    throw new Error(`buildMobileNtLoginHead called for unsupported profile ${profile.name}`)
  }

  const uinMsg = pbString(1, uin)
  const devType = mobile ? (mobile.ntDeviceType ?? device.model ?? profile.devType) : profile.os
  const platform = mobile ? mobile.ntPlatform : desktopNtLoginPlatform(profile)
  const dev = Buffer.concat([
    pbString(1, devType),
    pbString(2, device.deviceName),
    pbVarint(3, platform),
    pbBytes(4, device.guid),
  ])
  const app = Buffer.concat([
    pbString(1, mobile ? profile.ptVersion : profile.kernel),
    pbVarint(2, profile.appId),
    pbString(3, mobile ? mobile.ntAppName : profile.packageName),
    pbString(5, profile.qua),
  ])

  const headParts: Buffer[] = [pbBytes(1, uinMsg), pbBytes(2, dev), pbBytes(3, app)]
  if (cookie) headParts.push(pbBytes(5, pbString(1, cookie)))
  headParts.push(pbBytes(7, pbVarint(1, 1)))
  if (longCookie && longCookie.length > 0) headParts.push(pbBytes(8, pbBytes(1, longCookie)))
  return Buffer.concat(headParts)
}

/** Generate `client_a1` (`TEA(a1_key = MD5(pwd_md5 || be64(salt)), payload)`). */
export function generateClientA1(
  account: string,
  saltU64: bigint,
  appId: number,
  guid16: Buffer,
  pwdMd5: Buffer,
  tsSec: number = Math.floor(Date.now() / 1000),
): { clientA1: Buffer; s2Key: Buffer } {
  const keyIn = Buffer.alloc(24)
  pwdMd5.copy(keyIn, 0, 0, 16)
  keyIn.writeBigUInt64BE(saltU64, 16)
  const a1Key = md5(keyIn)

  const randU32 = randomBytes(4).readUInt32BE(0)
  const s2Key = randomBytes(16)
  const acctBuf = Buffer.from(account, 'utf-8')

  const plain = Buffer.alloc(2 + 4 + 4 + 4 + 4 + 8 + 4 + 4 + 1 + 16 + 16 + 4 + 1 + 16 + 4 + 4 + 2 + acctBuf.length)
  let off = 0
  plain.writeUInt16BE(4, off); off += 2           // version
  plain.writeUInt32BE(randU32, off); off += 4
  plain.writeUInt32BE(0, off); off += 4           // sso_ver
  plain.writeUInt32BE(appId >>> 0, off); off += 4
  plain.writeUInt32BE(8001, off); off += 4        // 0x1F41
  plain.writeBigUInt64BE(saltU64, off); off += 8
  plain.writeUInt32BE(tsSec >>> 0, off); off += 4
  plain.writeUInt32BE(0, off); off += 4           // ip
  plain.writeUInt8(1, off); off += 1
  pwdMd5.copy(plain, off, 0, 16); off += 16
  s2Key.copy(plain, off, 0, 16); off += 16
  plain.writeUInt32BE(0, off); off += 4
  plain.writeUInt8(1, off); off += 1
  guid16.copy(plain, off, 0, 16); off += 16
  plain.writeUInt32BE(1, off); off += 4
  plain.writeUInt32BE(1, off); off += 4
  plain.writeUInt16BE(acctBuf.length, off); off += 2
  acctBuf.copy(plain, off)

  return { clientA1: Buffer.from(teaEncrypt(plain, a1Key)), s2Key }
}

export function buildGetSaltRequest(
  kex: KexSession,
  profile: ProtocolProfile,
  device: NtLoginDeviceIdentity,
  uin: string,
): Buffer {
  const head = buildMobileNtLoginHead(profile, device, uin)
  return wrapNtLoginForward(profile, kex, pbBytes(1, head), uin)
}

export function buildPasswordLoginRequest(
  kex: KexSession,
  profile: ProtocolProfile,
  device: NtLoginDeviceIdentity,
  uin: string,
  cookie: string,
  longCookie: Buffer,
  clientA1: Buffer,
  captcha?: CaptchaSubmission,
  newDeviceSig?: Buffer,
): Buffer {
  const head = buildMobileNtLoginHead(profile, device, uin, cookie, longCookie)
  const bodyParts: Buffer[] = [pbBytes(1, clientA1)]
  if (captcha) {
    bodyParts.push(pbBytes(2, Buffer.concat([
      pbString(1, captcha.ticket),
      pbString(2, captcha.randStr),
      pbString(3, captcha.sid),
    ])))
  }
  if (newDeviceSig && newDeviceSig.length > 0) {
    bodyParts.push(pbBytes(3, newDeviceSig))
  }
  if (profile.mobile) {
    bodyParts.push(pbBytes(5, pbVarint(1, 1)))
  }
  const plain = Buffer.concat([pbBytes(1, head), pbBytes(2, Buffer.concat(bodyParts))])
  return wrapNtLoginForward(profile, kex, plain, uin)
}

export function buildNewDeviceLoginRequest(
  kex: KexSession,
  profile: ProtocolProfile,
  device: NtLoginDeviceIdentity,
  uin: string,
  cookie: string,
  longCookie: Buffer,
  newDeviceSig: Buffer,
): Buffer {
  const head = buildMobileNtLoginHead(profile, device, uin, cookie, longCookie)
  const body = pbBytes(1, newDeviceSig)
  const plain = Buffer.concat([pbBytes(1, head), pbBytes(2, body)])
  return wrapNtLoginForward(profile, kex, plain, uin)
}

export function buildEasyLoginRequest(
  kex: KexSession,
  profile: ProtocolProfile,
  device: NtLoginDeviceIdentity,
  uin: string,
  a1Ticket: Buffer,
): Buffer {
  const head = buildMobileNtLoginHead(profile, device, uin)
  const body = pbBytes(1, a1Ticket)
  const plain = Buffer.concat([pbBytes(1, head), pbBytes(2, body)])
  return wrapNtLoginForward(profile, kex, plain, uin)
}

function parseErrorInfo(head: Buffer): NtLoginError | undefined {
  const errPb = pbFirstBytes(head, 4)
  if (!errPb) return undefined
  const code = Number(pbFirstU64(errPb, 1) ?? 0n)
  const title = pbFirstBytes(errPb, 2)?.toString('utf-8') ?? ''
  const msg = pbFirstBytes(errPb, 3)?.toString('utf-8') ?? ''
  const jumpUrl = pbFirstBytes(errPb, 5)?.toString('utf-8') ?? ''
  if (code === 0 && !msg && !jumpUrl) return undefined
  return { code, title, msg, jumpUrl }
}

export function parseGetSaltResponse(kex: KexSession, resp: Buffer): SaltListResult {
  const plain = unwrapEcdhForward(kex, resp)
  if (!plain) throw new Error('decrypt GetSaltList response failed')
  let salt = 0n
  let cookie = ''
  let error: NtLoginError | undefined
  const head = pbFirstBytes(plain, 1)
  if (head) {
    error = parseErrorInfo(head)
    const c = (pbFirstBytes(head, 5) && pbFirstBytes(pbFirstBytes(head, 5)!, 1))
      ?? (pbFirstBytes(head, 8) && pbFirstBytes(pbFirstBytes(head, 8)!, 1))
    if (c) cookie = c.toString('utf-8')
  }
  const body = pbFirstBytes(plain, 2)
  if (body) {
    const item = pbFirstBytes(body, 1)
    if (item) {
      salt = pbFirstU64(item, 2) ?? pbFirstU64(item, 1) ?? 0n
    } else {
      salt = pbFirstU64(body, 1) ?? 0n
    }
  }
  return { salt, cookie, error }
}

export function parseNtLoginResponse(kex: KexSession, resp: Buffer): NtLoginTickets {
  const plain = unwrapEcdhForward(kex, resp)
  if (!plain) throw new Error('decrypt NTLogin response failed')
  const out: NtLoginTickets = {
    uin: '',
    uid: '',
    nick: '',
    a1: Buffer.alloc(0),
    tgtA2: Buffer.alloc(0),
    d2: Buffer.alloc(0),
    d2Key: Buffer.alloc(0),
    noPicSig: Buffer.alloc(0),
    captchaUrl: '',
    newDeviceCheckSig: Buffer.alloc(0),
    unusualDeviceCheckSig: Buffer.alloc(0),
    unusualDeviceQrSig: '',
    uinToken: '',
    cookie: '',
    longCookie: Buffer.alloc(0),
  }

  const head = pbFirstBytes(plain, 1)
  if (head) {
    const uinMsg = pbFirstBytes(head, 1)
    const u = uinMsg ? pbFirstBytes(uinMsg, 1) : null
    if (u) out.uin = u.toString('utf-8')
    out.error = parseErrorInfo(head)
    const f5 = pbFirstBytes(head, 5)
    const c = f5 ? pbFirstBytes(f5, 1) : null
    if (c) out.cookie = c.toString('utf-8')
    const f8 = pbFirstBytes(head, 8)
    const lc = f8 ? pbFirstBytes(f8, 1) : null
    if (lc) out.longCookie = Buffer.from(lc)
  }

  const body = pbFirstBytes(plain, 2)
  if (body) {
    const tickets = pbFirstBytes(body, 1)
    if (tickets) {
      for (const f of pbIter(tickets)) {
        if (f.wire !== 2) continue
        if (f.field === 3 && out.a1.length === 0 && f.bytes.length > 0) out.a1 = Buffer.from(f.bytes)
        else if (f.field === 4 && out.tgtA2.length === 0 && f.bytes.length > 0) out.tgtA2 = Buffer.from(f.bytes)
        else if (f.field === 5 && out.d2.length === 0 && f.bytes.length > 0) out.d2 = Buffer.from(f.bytes)
        else if (f.field === 6 && out.d2Key.length === 0 && f.bytes.length === 16) out.d2Key = Buffer.from(f.bytes)
        else if (f.field === 13 && out.noPicSig.length === 0 && f.bytes.length > 0) out.noPicSig = Buffer.from(f.bytes)
      }
    }

    const secCheck = pbFirstBytes(body, 2)
    if (secCheck) {
      const url = pbFirstBytes(secCheck, 3) ?? pbFirstBytes(secCheck, 1)
      if (url) {
        const s = url.toString('utf-8')
        if (s.startsWith('http')) out.captchaUrl = s
      }
    }

    const secProtect = pbFirstBytes(body, 3)
    if (secProtect) {
      const f1 = pbFirstBytes(secProtect, 1)
      const f2 = pbFirstBytes(secProtect, 2)
      const f3 = pbFirstBytes(secProtect, 3)
      const f4 = pbFirstBytes(secProtect, 4)
      if (f1) out.newDeviceCheckSig = Buffer.from(f1)
      if (f2) out.unusualDeviceCheckSig = Buffer.from(f2)
      if (f3) out.unusualDeviceQrSig = f3.toString('utf-8')
      if (f4) out.uinToken = f4.toString('utf-8')
    }

    const acct = pbFirstBytes(body, 4)
    if (acct) {
      if (!out.uin) {
        const u = pbFirstU64(acct, 1)
        if (u && u !== 0n) out.uin = u.toString()
      }
      const uid = pbFirstBytes(acct, 2)
      if (uid && uid.length > 0) out.uid = uid.toString('utf-8')
      const prof = pbFirstBytes(acct, 3)
      const nick = prof ? pbFirstBytes(prof, 1) : null
      if (nick) out.nick = nick.toString('utf-8')
    }
  }

  if (!out.captchaUrl && out.error?.code === NTLOGIN_ERR_PROOF_WATER && out.error.jumpUrl.startsWith('http')) {
    out.captchaUrl = out.error.jumpUrl
  }
  return out
}

// ---- Interactive Verification Helpers (140022008 Captcha & 140022010 New Device QR) ----

export function queryParam(url: string, key: string): string | null {
  const qIdx = url.indexOf('?')
  if (qIdx < 0) return null
  const hashIdx = url.indexOf('#', qIdx + 1)
  const query = hashIdx >= 0 ? url.slice(qIdx + 1, hashIdx) : url.slice(qIdx + 1)
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    if (pair.slice(0, eq) === key) {
      try {
        return decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '))
      } catch {
        return pair.slice(eq + 1)
      }
    }
  }
  return null
}

export interface CaptchaChallengeInfo {
  url: string
  sid: string
  appId: string
  loginAppId?: string
}

export function extractCaptchaSid(captchaUrl: string): string {
  return queryParam(captchaUrl, 'sid') || '2000000038'
}

export function parseCaptchaChallenge(captchaUrl: string, uin: string): CaptchaChallengeInfo {
  const sid = extractCaptchaSid(captchaUrl)
  const aid = queryParam(captchaUrl, 'aid')
  const fromOldPc = queryParam(captchaUrl, 'fromOldPc')
  const appId = aid || (fromOldPc ? '1' : DEFAULT_TCAPTCHA_APP_ID)
  const loginAppId = queryParam(captchaUrl, 'login_appid') || undefined
  const normalizedUrl = uin
    ? captchaUrl.replace(/([?&])uin=0(?=[&#]|$)/, `$1uin=${encodeURIComponent(uin)}`)
    : captchaUrl
  return {
    url: normalizedUrl,
    sid,
    appId,
    ...(loginAppId ? { loginAppId } : {}),
  }
}

/**
 * The link printed for hosts without a browser: the relay page embeds the slider for the verify URL and files the
 * outcome under the key below. `verify_url` carries the URL as the page reads it back, so that key is its SHA-256.
 */
export function buildCaptchaRelayUrl(verifyUrl: string): string {
  return `${CAPTCHA_RELAY_ORIGIN}/?verify_url=${encodeURIComponent(verifyUrl)}`
}

/** Where the relay page's result is published once its slider has been solved. */
export function buildCaptchaRelayResultUrl(verifyUrl: string): string {
  return `${CAPTCHA_RELAY_ORIGIN}/result/${sha256(verifyUrl).toString('hex')}`
}

export type CaptchaRelayResult =
  | { status: 'pending' }
  | { status: 'verified'; ticket: string; randStr: string }

/** 404 = nobody has solved it yet; anything that is not a usable record throws, and the caller polls on. */
export async function fetchCaptchaRelayResult(verifyUrl: string): Promise<CaptchaRelayResult> {
  const resp = await fetch(buildCaptchaRelayResultUrl(verifyUrl), { signal: AbortSignal.timeout(10_000) })
  if (!resp.ok) {
    // These responses also have bodies. Release the connection before the next poll.
    await resp.body?.cancel()
    if (resp.status === 404) return { status: 'pending' }
    throw new Error(`HTTP ${resp.status}`)
  }
  const data = await resp.json() as { ticket?: unknown; randstr?: unknown; randStr?: unknown } | null
  const ticket = typeof data?.ticket === 'string' ? data.ticket.trim() : ''
  const randStr = typeof data?.randstr === 'string'
    ? data.randstr.trim()
    : typeof data?.randStr === 'string' ? data.randStr.trim() : ''
  if (!ticket || !randStr) throw new Error('记录里没有可用的 ticket / randstr')
  return { status: 'verified', ticket, randStr }
}

export function deriveNewDeviceQueryToken(qrPageUrl: string): string | null {
  const raw = queryParam(qrPageUrl, 'str_url')
  if (!raw) return null
  const normalized = raw.replace(/\*/g, '+').replace(/-/g, '/').replace(/==/g, '')
  return Buffer.from(normalized, 'utf-8').toString('base64')
}

export interface NewDeviceQrSession {
  endpoint: string
  qrUrl: string
  bytesToken: string
}

interface NewDeviceQrResp {
  ActionStatus?: string
  ErrorCode?: number
  ErrorInfo?: string
  uint32_guarantee_status?: number
  str_url?: string
  str_nt_succ_token?: string
}

export async function createNewDeviceQr(
  uin: string,
  jumpUrl: string,
  fallbackDevSig: Buffer,
  fallbackUinToken: string,
  devType: string,
  devName: string,
): Promise<NewDeviceQrSession | null> {
  const sig = queryParam(jumpUrl, 'sig') || (fallbackDevSig.length > 0 ? fallbackDevSig.toString('utf-8') : '')
  const uinToken = queryParam(jumpUrl, 'uin-token') || queryParam(jumpUrl, 'uin_token') || fallbackUinToken
  if (!sig || !uinToken) return null

  const endpoint = `${OIDB_NEW_DEVICE_URL}?uid=${encodeURIComponent(uin)}&getqrcode=1&sdkappid=39998&actype=2`
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      uint32_flag: 1,
      uint32_url_type: 0,
      str_dev_auth_token: sig,
      str_uin_token: uinToken,
      str_dev_type: devType,
      str_dev_name: devName,
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!resp.ok) throw new Error(`oidb_0xc9e_8 HTTP ${resp.status}`)
  const data = (await resp.json()) as NewDeviceQrResp
  if (!data.str_url) {
    throw new Error(`oidb_0xc9e_8 未返回二维码: status=${data.ActionStatus ?? ''} err=${data.ErrorCode ?? 0} ${data.ErrorInfo ?? ''}`)
  }
  const bytesToken = deriveNewDeviceQueryToken(data.str_url)
  if (!bytesToken) throw new Error('无法从 oidb_0xc9e_8 返回的 str_url 提取轮询 token')
  return { endpoint, qrUrl: data.str_url, bytesToken }
}

export type NewDevicePollResult =
  | { status: 'pending'; guaranteeStatus: number }
  | { status: 'confirmed'; succToken: Buffer }
  | { status: 'failed'; reason: string }

export async function pollNewDeviceQrOnce(
  endpoint: string,
  bytesToken: string,
): Promise<NewDevicePollResult> {
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      uint32_flag: 0,
      bytes_token: bytesToken,
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!resp.ok) throw new Error(`oidb_0xc9e_8 poll HTTP ${resp.status}`)
  const data = (await resp.json()) as NewDeviceQrResp
  if (data.ActionStatus === 'OK' && data.str_nt_succ_token) {
    return { status: 'confirmed', succToken: Buffer.from(data.str_nt_succ_token, 'utf-8') }
  }
  if (data.ActionStatus && data.ActionStatus !== 'OK') {
    return {
      status: 'failed',
      reason: `新设备验证失败: status=${data.ActionStatus} err=${data.ErrorCode ?? 0} ${data.ErrorInfo ?? ''}`.trim(),
    }
  }
  return { status: 'pending', guaranteeStatus: data.uint32_guarantee_status ?? 0 }
}
