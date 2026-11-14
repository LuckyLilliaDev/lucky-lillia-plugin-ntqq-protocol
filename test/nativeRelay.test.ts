import { describe, expect, it, vi } from 'vitest'
import { nativeRelay, nativeWasInitialized } from '../src/native/relay'
import type { NativeSign, RelayPacket } from '../src/native/sign-types'

describe('native callback across plugin replacement', () => {
  it('routes the original native callback to the replacement protocol client', async () => {
    const native = { init: vi.fn() } as unknown as NativeSign
    const oldClient = vi.fn(async () => Buffer.from('old'))
    const newClient = vi.fn(async () => Buffer.from('new'))
    const previousLogger = vi.fn()
    const logger = vi.fn()
    const first = nativeRelay(native, oldClient, previousLogger)
    const retainedByNative = (packet: RelayPacket) => first.sendPacket(packet)
    first.initialized = true
    // The loader returns a new JS wrapper around the same native exports on reload.
    nativeRelay({ ...native }, newClient, logger)
    const packet = { cmd: 'test', body: Buffer.from('payload') }
    expect(await retainedByNative(packet)).toEqual(Buffer.from('new'))
    expect(oldClient).not.toHaveBeenCalled()
    expect(newClient).toHaveBeenCalledExactlyOnceWith(packet)
    first.logger({ level: 'warn', message: 'notice' })
    expect(logger).toHaveBeenCalledOnce()
    expect(previousLogger).not.toHaveBeenCalled()
    expect(nativeWasInitialized(native)).toBe(true)
    expect(nativeWasInitialized({ init: vi.fn() } as unknown as NativeSign)).toBe(false)
  })
})
