import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import { NativeQQProtocol } from '../src/qqProtocol/nativeQQ'
function observe(ctx: Context, protocol: NativeQQProtocol) {
  const send = vi.fn()
  ctx.on('qq/session-expired', reason => { send({ ...protocol.selfInfo }, reason) })
  return send
}

describe('NativeQQ session failure notifications', () => {
  const endings = [
    { name: 'error callback', reason: 'QQ process crashed', trigger: (protocol: NativeQQProtocol) => {
      protocol['onNativeEvent']({ type: 'error', message: 'QQ process crashed' }, 0)
    } },
    { name: 'stopped callback', reason: 'NativeQQ 会话已结束', trigger: (protocol: NativeQQProtocol) => {
      protocol['onNativeEvent']({ type: 'status', data: { status: 'stopped' } }, 0)
    } },
    { name: 'failed health', reason: 'native session failed', trigger: async (protocol: NativeQQProtocol) => {
      Object.assign(protocol, { native: { health: async () => ({ sessionStatus: 'failed', failure: 'native session failed' }) } })
      await protocol['probe'](0)
    } },
  ]

  it.each(endings)('reports $name with the old identity before clearing it', async ({ trigger, reason }) => {
    const ctx = new Context()
    const protocol = new NativeQQProtocol(ctx)
    Object.assign(protocol.selfInfo, { uin: '123456', uid: 'test-uid', nick: 'TestBot', online: true })
    const send = observe(ctx, protocol)
    await trigger(protocol)
    expect(send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ uin: '123456', uid: 'test-uid', nick: 'TestBot' }), reason,
    )
    expect(protocol.selfInfo).toEqual({ uin: '', uid: '', nick: '', online: false })
    await trigger(protocol)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it.each(endings)('does not report $name before the first login', async ({ trigger }) => {
    const ctx = new Context()
    const protocol = new NativeQQProtocol(ctx)
    const send = observe(ctx, protocol)
    await trigger(protocol)
    expect(send).not.toHaveBeenCalled()
  })

  it('keeps a requested protocol stop silent, including late native callbacks', async () => {
    const ctx = new Context()
    const protocol = new NativeQQProtocol(ctx)
    Object.assign(protocol.selfInfo, { uin: '123456', uid: 'test-uid', nick: 'TestBot', online: true })
    const send = observe(ctx, protocol)
    await protocol['stop']()
    protocol['onNativeEvent']({ type: 'status', data: { status: 'stopped' } }, 0)
    expect(send).not.toHaveBeenCalled()
  })
})
