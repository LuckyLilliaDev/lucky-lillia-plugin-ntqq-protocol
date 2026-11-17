import { describe, expect, it, vi } from 'vitest'
import type { Context } from 'cordis'
import { GetFriendMsgHistory } from '../../../src/onebot/action/llbot/msg/GetFriendMsgHistory'
import { GetGroupMsgHistory } from '../../../src/onebot/action/go-cqhttp/GetGroupMsgHistory'
import { OB11Entities } from '../../../src/onebot/entities'

const config = { messageFormat: 'array' as const, debug: false }

describe.each([
  { label: 'private', Action: GetFriendMsgHistory, target: { user_id: '12345' } },
  { label: 'group', Action: GetGroupMsgHistory, target: { group_id: '555' } },
])('$label history', ({ Action, target }) => {
  function fixture(sequence = 0) {
    const ctx = {
      logger: { error: vi.fn() },
      ntUserApi: { getUidByUin: vi.fn(async () => 'u_peer') },
      ntFriendApi: { isFriend: vi.fn(async () => true) },
      ntGroupApi: { getGroup: vi.fn(async () => ({ groupName: 'Test group' })) },
      ntMsgApi: {
        getLatestMsgSeq: vi.fn(async () => sequence),
        getMsgsBySeqAndCount: vi.fn(async () => ({ msgList: [] as any[] })),
      },
    }
    return { ctx, action: new Action({ ctx: ctx as unknown as Context }) }
  }

  it('returns an empty list when the conversation has no latest message', async () => {
    const { ctx, action } = fixture(0)
    const result = await action.handle({ ...target, count: 20 } as any, config)
    expect(result).toMatchObject({ status: 'ok', retcode: 0, data: { messages: [] } })
    expect(ctx.ntMsgApi.getMsgsBySeqAndCount).not.toHaveBeenCalled()
  })

  it('does not query history for count zero', async () => {
    const { ctx, action } = fixture(20)
    expect(await action.handle({ ...target, count: 0 } as any, config)).toMatchObject({ status: 'ok', data: { messages: [] } })
    expect(ctx.ntMsgApi.getLatestMsgSeq).not.toHaveBeenCalled()
    expect(ctx.ntMsgApi.getMsgsBySeqAndCount).not.toHaveBeenCalled()
  })

  it('returns an empty list when the server has no messages in the requested range', async () => {
    const { ctx, action } = fixture(20)
    expect(await action.handle({ ...target, count: 10 } as any, config)).toMatchObject({ status: 'ok', data: { messages: [] } })
    expect(ctx.ntMsgApi.getMsgsBySeqAndCount).toHaveBeenCalledOnce()
  })

  it('respects an explicit sequence and reverse ordering when messages exist', async () => {
    const { ctx, action } = fixture(999)
    const raw = [{ message_id: 19 }, { message_id: 20 }]
    ctx.ntMsgApi.getMsgsBySeqAndCount.mockResolvedValue({ msgList: raw })
    const convert = vi.spyOn(OB11Entities, 'message').mockImplementation(async (_ctx, value) => ({ ...value }) as any)
    try {
      const result = await action.handle({ ...target, message_seq: '20', count: '2', reverseOrder: true } as any, config)
      expect(result).toMatchObject({ status: 'ok', data: { messages: [{ message_id: 20 }, { message_id: 19 }] } })
      expect(ctx.ntMsgApi.getLatestMsgSeq).not.toHaveBeenCalled()
      expect(ctx.ntMsgApi.getMsgsBySeqAndCount).toHaveBeenCalledWith(expect.any(Object), 20, 2, true)
    } finally { convert.mockRestore() }
  })
})
