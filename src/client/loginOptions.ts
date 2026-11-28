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
  { id: 'direct', label: '纯协议', hint: '自己实现协议，不需要安装 QQ' },
  { id: 'native', label: '官方 QQ 客户端桥接', hint: '需要安装官方 QQ 客户端，然后 LLBot 注入' },
]

export type InteractiveLoginMethod = 'qr' | 'password'

export const PROTOCOLS: { id: ProtocolId; label: string; hint?: string; loginMethods: InteractiveLoginMethod[] }[] = [
  { id: 'linux', label: 'Linux', loginMethods: ['qr', 'password'] },
  { id: 'macos', label: 'macOS', loginMethods: ['qr', 'password'] },
  { id: 'windows', label: 'Windows', loginMethods: ['qr', 'password'] },
  { id: 'watch', label: 'Android 手表', loginMethods: ['qr'], hint: 'Android 手表 QQ 能调用的接口最少，比如拿不到群成员列表和历史消息' },
  { id: 'ipad', label: 'iPad', loginMethods: ['password'] },
  { id: 'iphone', label: 'iPhone', loginMethods: ['password'], hint: '会与手机 QQ 互踢' },
  { id: 'harmonypad', label: '鸿蒙 Pad', loginMethods: ['password'] },
  { id: 'harmony', label: '鸿蒙手机', loginMethods: ['password'], hint: '会与手机 QQ 互踢' },
]

export const protocolLoginMethods = (id?: string): InteractiveLoginMethod[] =>
  PROTOCOLS.find(protocol => protocol.id === id)?.loginMethods ?? ['qr']

export const isPasswordProtocol = (id?: string) => {
  const methods = protocolLoginMethods(id)
  return methods.includes('password') && !methods.includes('qr')
}

export const protocolLabel = (id: string) => PROTOCOLS.find(protocol => protocol.id === id)?.label ?? id

export function describeMethod(method: NTProtocolConfig): string {
  return method.mode === 'native'
    ? '官方 QQ 客户端桥接'
    : `纯协议 · ${protocolLabel(method.protocol)}`
}
