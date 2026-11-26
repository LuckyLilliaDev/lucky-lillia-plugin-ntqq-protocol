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
