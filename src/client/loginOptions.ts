import type { NTProtocolConfig } from '../support/types'

export type LoginMode = NTProtocolConfig['mode']
export type ProtocolId = NTProtocolConfig['protocol']

/** The official QQ client bridge as NativeQQ.health() has it: BridgeStatus of the protocol, in /api/login-info */
export interface BridgeStatus {
  /** stopped / starting / running / stopping / failed */
  session: string
  failure?: string
  authTokenSet: boolean
  /** QQ's process is up */
  qqRunning: boolean
  loggedIn: boolean
  qrcodeAvailable: boolean
}

export const LOGIN_MODES: { id: LoginMode; label: string; hint: string }[] = [
  { id: 'direct', label: '纯协议', hint: 'LLBot 自己模拟 QQ 客户端登录，不用安装 QQ' },
  { id: 'nativeqq', label: '官方 QQ 客户端桥接', hint: '需要安装官方 QQ 客户端，然后 LLBot 注入' },
]

export const PROTOCOLS: { id: ProtocolId; label: string; hint?: string }[] = [
  { id: 'linux', label: 'Linux' },
  { id: 'macos', label: 'macOS' },
  { id: 'windows', label: 'Windows' },
  { id: 'watch', label: '手表', hint: '手表 QQ 能调用的接口最少，比如拿不到群成员列表和历史消息' },
]

export const protocolLabel = (id: string) => PROTOCOLS.find(protocol => protocol.id === id)?.label ?? id

export function describeMethod(method: NTProtocolConfig): string {
  return method.mode === 'nativeqq'
    ? '官方 QQ 客户端桥接'
    : `纯协议 · ${protocolLabel(method.protocol)}`
}

/**
 * The protocol a saved choice waits for a restart to use: the pure protocol speaks one protocol per process,
 * the one it had when its client was created.
 */
export function pendingProtocol(method: NTProtocolConfig, locked?: ProtocolId): ProtocolId | undefined {
  return method.mode === 'direct' && locked && method.protocol !== locked ? method.protocol : undefined
}
