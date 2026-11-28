import { createHash } from 'node:crypto'
import { Context } from 'cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getProtocol } from '../../../src/support/utils/environment'
import { DirectQQProtocol } from '../../../src/qqProtocol/direct'
import type { DirectProtocolClient } from '../../../src/qqProtocol/direct-lib/client'
import { _resetActiveProfileForTest } from '../../../src/qqProtocol/direct-lib/profiles'
import { pbBytes, pbString, pbVarint } from '../../../src/qqProtocol/direct-lib/pbCodec'
import { md5, pbFirstBytes } from '../../../src/qqProtocol/direct-lib/mobile/crypto'
import {
  NTLOGIN_ERR_PROOF_WATER,
  buildCaptchaRelayResultUrl,
  buildCaptchaRelayUrl,
  fetchCaptchaRelayResult,
  unwrapEcdhForward,
  wrapEcdhForward,
  type KexSession,
} from '../../../src/qqProtocol/direct-lib/mobile/ntlogin'

// The console link's captcha relay (captcha.luckylillia.com): the link printed for the raw verify URL, the poll that
// takes its result into the login, and everything that ends that poll.

vi.mock('../../../src/support/authToken', () => ({
  authTokenUtil: { reload: vi.fn(() => 'test-auth-token') },
}))

vi.mock('../../../src/qqProtocol/direct-lib/authTokenWatcher', () => ({
  AuthTokenWatcher: class {
    start = vi.fn()
    stop = vi.fn()
    check = vi.fn()
  },
}))

vi.mock('../../../src/qqProtocol/direct-lib/machineGuid', () => ({
  loadMachineGuidSync: vi.fn(() => Buffer.alloc(16)),
  overwriteMachineGuid: vi.fn(),
  deleteMachineGuid: vi.fn(),
}))

vi.mock('../../../src/qqProtocol/direct-lib/session', () => ({
  saveSession: vi.fn(),
  loadSession: vi.fn(),
  deleteSession: vi.fn(),
  listAvailableSessions: vi.fn(() => []),
  persistedToSessionInfo: vi.fn(),
  getSessionFilePathForUin: vi.fn(),
}))

vi.mock('../../../src/qqProtocol/direct-lib/sign', () => ({
  requestSign: vi.fn(),
  setupSign: vi.fn(),
  setSignMachineGuid: vi.fn(),
  acquireSignToken: vi.fn(async () => ({ token: 'test-token', ttlSecs: 3600 })),
  updateAuthToken: vi.fn(),
  startLinuxSsoReport: vi.fn(async () => {}),
  stopLinuxSsoReport: vi.fn(),
  buildLinuxXwidBody: vi.fn(() => null),
  signLinuxXwidBurst: vi.fn(async () => null),
  acquireMacosEskOnly: vi.fn(),
  acquireMobileEskOnly: vi.fn(),
  clearMobileO3Channel: vi.fn(),
}))

vi.mock('../../../src/qqProtocol/direct-lib/online', () => ({
  registerOnline: vi.fn(async () => 'ok'),
  startHeartbeat: vi.fn(() => vi.fn()),
}))

const UIN = '721011692'
const SID = '2000000038'
const VERIFY_URL = 'https://ti.qq.com/safe/verify?uin=0&sid=2000000038&cap_cd=abc%2B123&aid=16'
const RELAY_TICKET = { ticket: 't03tserverSiCFmhz3nV3SefxybNmcNH1Q', randstr: '@OUX' }

const kex: KexSession = { sessionKey: Buffer.alloc(32, 0x5a), sessionTicket: Buffer.from('ticket_demo') }
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()

let protocol: DirectQQProtocol | undefined
let consoleLog: ReturnType<typeof vi.spyOn>
let warn: ReturnType<typeof vi.spyOn>
let info: ReturnType<typeof vi.spyOn>

function httpResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

/** A SsoNTLoginPasswordLogin answer that asks for the slider at `verifyUrl`. */
function captchaResponse(verifyUrl: string): Buffer {
  const head = Buffer.concat([
    pbBytes(4, Buffer.concat([pbVarint(1, NTLOGIN_ERR_PROOF_WATER), pbString(5, verifyUrl)])),
    pbBytes(5, pbString(1, 'ck_next')),
  ])
  return wrapEcdhForward(kex, pbBytes(1, head), UIN)
}

/** A SsoNTLoginPasswordLogin answer that hands out the session tickets. */
function onlineResponse(): Buffer {
  const tickets = Buffer.concat([pbBytes(5, Buffer.alloc(16, 0xd2)), pbBytes(6, Buffer.alloc(16, 0x6e))])
  const account = Buffer.concat([pbVarint(1, BigInt(UIN)), pbString(2, 'u_relay'), pbBytes(3, pbString(1, 'RelayBot'))])
  const plain = Buffer.concat([
    pbBytes(1, pbBytes(5, pbString(1, 'ck_ok'))),
    pbBytes(2, Buffer.concat([pbBytes(1, tickets), pbBytes(4, account)])),
  ])
  return wrapEcdhForward(kex, plain, UIN)
}

/** Just what the password login path of DirectQQProtocol calls on the connection. */
function fakeClient() {
  let session: unknown = null
  return {
    isConnected: true,
    isLoggedIn: false,
    setOuterUin: vi.fn(),
    setUin: vi.fn(),
    getNtLoginDeviceInfo: vi.fn(async () => ({ guid: Buffer.alloc(16, 0x42), deviceName: 'LuckyLillia-iPad' })),
    sendCommand: vi.fn<(cmd: string, req: Buffer) => Promise<{ payload: Buffer }>>(),
    setSession: vi.fn((next: unknown) => { session = next }),
    getSession: vi.fn(() => session),
    awaitSignTokenAcquire: vi.fn(async () => {}),
    getGuid: vi.fn(() => Buffer.alloc(16, 0x42)),
    startSsoReport: vi.fn(async () => {}),
    clearSession: vi.fn(),
    disconnect: vi.fn(),
  }
}

/** Answers the first password attempt with the slider and polls the relay from there. */
async function atCaptcha(client: ReturnType<typeof fakeClient>) {
  protocol = new DirectQQProtocol(new Context())
  protocol['directClient'] = client as unknown as DirectProtocolClient
  warn = vi.spyOn(protocol['logger'], 'warn')
  info = vi.spyOn(protocol['logger'], 'info')
  const token = ++protocol['passwordLoginToken']
  protocol['pwFlow'] = {
    token,
    uin: UIN,
    pwdMd5: md5('secret123'),
    salt: BigInt(UIN),
    kex,
    cookie: '',
    longCookie: Buffer.alloc(0),
    attempts: 0,
    captchaSid: SID,
    relayTicketsSent: new Set<string>(),
  }
  await protocol['runPasswordLoginAttempt'](token)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(getProtocol).mockReturnValue('ipad')
  _resetActiveProfileForTest()
  // Nobody has solved the slider on the relay unless a test says otherwise
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(httpResponse(404, { error: '未找到验证记录' }))
  vi.stubGlobal('fetch', fetchMock)
  consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(async () => {
  await protocol?.['stop']()
  vi.unstubAllGlobals()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('captcha relay helpers', () => {
  it('links to the relay with the raw verify URL and reads the result under its SHA-256', () => {
    const link = buildCaptchaRelayUrl(VERIFY_URL)
    // The relay page hashes the URL exactly as it reads verify_url back
    expect(new URL(link).searchParams.get('verify_url')).toBe(VERIFY_URL)
    expect(buildCaptchaRelayResultUrl(VERIFY_URL)).toBe(
      `https://captcha.luckylillia.com/result/${createHash('sha256').update(VERIFY_URL, 'utf8').digest('hex')}`,
    )
    expect(buildCaptchaRelayResultUrl('')).toBe(
      'https://captcha.luckylillia.com/result/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })

  it('reads 404 as not solved yet and a stored record as the result', async () => {
    const pending = new Response('{"error":"未找到验证记录"}', { status: 404 })
    fetchMock.mockResolvedValueOnce(pending)
    await expect(fetchCaptchaRelayResult(VERIFY_URL)).resolves.toEqual({ status: 'pending' })
    expect(pending.bodyUsed).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(buildCaptchaRelayResultUrl(VERIFY_URL), expect.anything())

    fetchMock.mockResolvedValueOnce(httpResponse(200, { ticket: ` ${RELAY_TICKET.ticket} `, randstr: RELAY_TICKET.randstr }))
    await expect(fetchCaptchaRelayResult(VERIFY_URL)).resolves.toEqual({
      status: 'verified',
      ticket: RELAY_TICKET.ticket,
      randStr: RELAY_TICKET.randstr,
    })
  })

  it.each([
    ['another error status', () => httpResponse(503, { error: 'boom' })],
    ['a record without tickets', () => httpResponse(200, { saved: true })],
    ['a non-JSON body', () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <') } })],
  ])('rejects on %s, so that the caller polls on', async (_case, response) => {
    fetchMock.mockResolvedValueOnce(response() as Response)
    await expect(fetchCaptchaRelayResult(VERIFY_URL)).rejects.toThrow()
  })
})

describe('captcha relay poll of a password login', () => {
  it('prints the link for the raw verify URL and takes the relay result into the login', async () => {
    const client = fakeClient()
    client.sendCommand
      .mockResolvedValueOnce({ payload: captchaResponse(VERIFY_URL) })
      .mockResolvedValueOnce({ payload: captchaResponse('https://ti.qq.com/safe/verify?uin=0&sid=2000000038&cap_cd=next') })
    fetchMock
      .mockResolvedValueOnce(httpResponse(404, { error: '未找到验证记录' }))
      .mockResolvedValueOnce(httpResponse(200, RELAY_TICKET))
    await atCaptcha(client)

    expect(protocol!.getPasswordLoginState()).toMatchObject({ phase: 'captcha', captcha: { sid: SID } })
    expect(consoleLog).toHaveBeenCalledWith(buildCaptchaRelayUrl(VERIFY_URL))

    await vi.advanceTimersByTimeAsync(6_000)

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      buildCaptchaRelayResultUrl(VERIFY_URL),
      buildCaptchaRelayResultUrl(VERIFY_URL),
    ])
    expect(client.sendCommand).toHaveBeenCalledTimes(2)
    // The retry carries the relay's ticket with the sid of the login session
    const request = client.sendCommand.mock.calls[1][1]
    expect(pbFirstBytes(pbFirstBytes(unwrapEcdhForward(kex, request)!, 2)!, 2)).toEqual(
      Buffer.concat([pbString(1, RELAY_TICKET.ticket), pbString(2, RELAY_TICKET.randstr), pbString(3, SID)]),
    )
    // The server asked again: the link for that captcha is printed and polled in turn
    expect(consoleLog).toHaveBeenCalledWith(buildCaptchaRelayUrl('https://ti.qq.com/safe/verify?uin=0&sid=2000000038&cap_cd=next'))
  })

  it('ends the poll once the WebUI slider gets the account online, dropping a relay answer still in flight', async () => {
    const client = fakeClient()
    client.sendCommand
      .mockResolvedValueOnce({ payload: captchaResponse(VERIFY_URL) })
      .mockResolvedValueOnce({ payload: onlineResponse() })
    const inFlight = Promise.withResolvers<Response>()
    fetchMock.mockReturnValueOnce(inFlight.promise)
    await atCaptcha(client)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await protocol!.submitLoginCaptcha('ticket_from_webui', '@web', SID)
    expect(protocol!.getPasswordLoginState()).toMatchObject({ phase: 'online' })

    inFlight.resolve(httpResponse(200, RELAY_TICKET))
    await vi.advanceTimersByTimeAsync(30_000)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(client.sendCommand).toHaveBeenCalledTimes(2)
  })

  it('ends the poll when the WebUI submits a result that only leads to another captcha, dropping the answer in flight', async () => {
    const NEXT_URL = 'https://ti.qq.com/safe/verify?uin=0&sid=2000000038&cap_cd=next'
    const client = fakeClient()
    client.sendCommand.mockResolvedValueOnce({ payload: captchaResponse(VERIFY_URL) })
    const inFlight = Promise.withResolvers<Response>()
    fetchMock.mockReturnValueOnce(inFlight.promise)
    await atCaptcha(client)
    await vi.advanceTimersByTimeAsync(3_000)

    // The WebUI's ticket is rejected with a new captcha: the poll of the old URL must not submit into it
    client.sendCommand.mockResolvedValueOnce({ payload: captchaResponse(NEXT_URL) })
    await protocol!.submitLoginCaptcha('ticket_from_webui', '@web', SID)
    inFlight.resolve(httpResponse(200, RELAY_TICKET))
    await vi.advanceTimersByTimeAsync(12_000)

    expect(client.sendCommand).toHaveBeenCalledTimes(2)
    // Only the new captcha is polled from here
    const polledAfter = fetchMock.mock.calls.slice(1).map(([url]) => url)
    expect(polledAfter.length).toBeGreaterThanOrEqual(3)
    expect(new Set(polledAfter)).toEqual(new Set([buildCaptchaRelayResultUrl(NEXT_URL)]))
  })

  it.each(['cancelPasswordLogin', 'logout', 'stop'] as const)('%s ends the poll', async (action) => {
    const client = fakeClient()
    client.sendCommand.mockResolvedValueOnce({ payload: captchaResponse(VERIFY_URL) })
    await atCaptcha(client)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    if (action === 'stop') await protocol!['stop']()
    else await protocol![action]()

    await vi.advanceTimersByTimeAsync(30_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('polls for five minutes at most and leaves the WebUI slider in place', async () => {
    const client = fakeClient()
    client.sendCommand.mockResolvedValueOnce({ payload: captchaResponse(VERIFY_URL) })
    await atCaptcha(client)

    await vi.advanceTimersByTimeAsync(303_000)
    expect(fetchMock).toHaveBeenCalledTimes(99)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchMock).toHaveBeenCalledTimes(99)

    expect(protocol!.getPasswordLoginState()).toMatchObject({ phase: 'captcha' })
    expect(info).toHaveBeenCalledWith(expect.stringContaining('已停止查询'))
  })

  it('sends a relay ticket once when the server asks for the same captcha again', async () => {
    const client = fakeClient()
    client.sendCommand.mockResolvedValue({ payload: captchaResponse(VERIFY_URL) })
    // A record filed for an earlier round of this verify URL is still there
    fetchMock.mockResolvedValue(httpResponse(200, RELAY_TICKET))
    await atCaptcha(client)

    await vi.advanceTimersByTimeAsync(30_000)
    expect(client.sendCommand).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.length).toBeGreaterThan(5)
  })

  it('rides out relay errors, reporting an outage once, and still takes the result when it comes', async () => {
    const client = fakeClient()
    client.sendCommand
      .mockResolvedValueOnce({ payload: captchaResponse(VERIFY_URL) })
      .mockResolvedValueOnce({ payload: captchaResponse('https://ti.qq.com/safe/verify?uin=0&sid=2000000038&cap_cd=next') })
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed', {
        cause: Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }),
      }))
      .mockResolvedValueOnce(httpResponse(502, { error: 'bad gateway' }))
      .mockResolvedValueOnce(httpResponse(200, RELAY_TICKET))
    await atCaptcha(client)
    await vi.advanceTimersByTimeAsync(3_499)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(3_000)

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ECONNRESET（连续 1 次），0.5 秒后重试'))
    expect(client.sendCommand).toHaveBeenCalledTimes(2)
  })
})
