import { describe, expect, it } from 'vitest'
import { describeMethod, isPasswordProtocol, protocolLoginMethods } from '../../src/client/loginOptions'
import type { NTProtocolConfig } from '../../src/support/types'

const saved: NTProtocolConfig = { mode: 'direct', protocol: 'macos', nativeQQ: { qqPath: '', hookMode: '' }, signCDN: 'cf', autoLoginUin: '' }

describe('login method', () => {
  it('reads as one line', () => {
    expect(describeMethod(saved)).toBe('纯协议 · macOS')
    expect(describeMethod({ ...saved, protocol: 'watch' })).toBe('纯协议 · Android 手表')
    expect(describeMethod({ ...saved, protocol: 'ipad' })).toBe('纯协议 · iPad')
    expect(describeMethod({ ...saved, protocol: 'iphone' })).toBe('纯协议 · iPhone')
    expect(describeMethod({ ...saved, protocol: 'harmonypad' })).toBe('纯协议 · 鸿蒙 Pad')
    expect(describeMethod({ ...saved, protocol: 'harmony' })).toBe('纯协议 · 鸿蒙手机')
    expect(describeMethod({ ...saved, mode: 'native' })).toBe('官方 QQ 客户端桥接')
  })

  it('distinguishes dual-mode desktop, QR-only watch, and password-only mobile protocols', () => {
    for (const id of ['linux', 'macos', 'windows'] as const) {
      expect(protocolLoginMethods(id)).toEqual(['qr', 'password'])
      expect(isPasswordProtocol(id)).toBe(false)
    }
    expect(protocolLoginMethods('watch')).toEqual(['qr'])
    expect(isPasswordProtocol('watch')).toBe(false)
    for (const id of ['ipad', 'iphone', 'harmonypad', 'harmony'] as const) {
      expect(protocolLoginMethods(id)).toEqual(['password'])
      expect(isPasswordProtocol(id)).toBe(true)
    }
  })
})
