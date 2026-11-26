import { describe, expect, it } from 'vitest'
import { NTProtocolSchema } from '../../src/settings'

describe('NT protocol settings', () => {
  it('keeps the signing CDN and the automatic login account out of the settings form', () => {
    const dict = (NTProtocolSchema as unknown as { dict: Record<string, { meta: { hidden?: boolean } }> }).dict
    expect(dict.signCDN.meta.hidden).toBe(true)
    expect(dict.autoLoginUin.meta.hidden).toBe(true)
    expect(NTProtocolSchema({}).signCDN).toBe('cf')
  })
})

describe('NT protocol login method', () => {
  it('is the pure protocol for any value it does not know', () => {
    expect(NTProtocolSchema({ mode: 'native' }).mode).toBe('native')
    expect(NTProtocolSchema({ mode: 'direct' }).mode).toBe('direct')
    expect(NTProtocolSchema({}).mode).toBe('native')
    for (const mode of ['nativeqq', 'pmhq', 'Native', 1]) expect(NTProtocolSchema({ mode } as never).mode).toBe('direct')
  })
})
