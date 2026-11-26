import { describe, expect, it } from 'vitest'
import { describeMethod, pendingProtocol } from '../../src/client/loginOptions'
import type { NTProtocolConfig } from '../../src/support/types'

const saved: NTProtocolConfig = { mode: 'direct', protocol: 'macos', nativeQQ: { qqPath: '', hookMode: '' }, signCDN: 'cf', autoLoginUin: '' }

describe('login method', () => {
  it('reads as one line', () => {
    expect(describeMethod(saved)).toBe('纯协议 · macOS')
    expect(describeMethod({ ...saved, protocol: 'watch' })).toBe('纯协议 · 手表')
    expect(describeMethod({ ...saved, mode: 'native' })).toBe('官方 QQ 客户端桥接')
  })

  it('waits for a restart only for another protocol of the pure protocol', () => {
    expect(pendingProtocol(saved, undefined)).toBeUndefined()
    expect(pendingProtocol(saved, 'macos')).toBeUndefined()
    expect(pendingProtocol(saved, 'linux')).toBe('macos')
    expect(pendingProtocol({ ...saved, mode: 'native' }, 'linux')).toBeUndefined()
  })
})
