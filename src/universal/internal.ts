import { Context } from 'cordis'
import { decodeMessageId } from './utils'
import { internalMethodName } from './internalNames'

// The account's own API, bot.internal, is OneBot 11's with the go-cqhttp and LLOneBot extensions: the actions the
// OneBot adapter serves, run here without its connections, so they work with that adapter switched off. Only ctx is
// what an action takes from the adapter (BaseAction).

export type Internal = Record<string, (params?: Record<string, unknown>) => Promise<any>>

export function createInternal(ctx: Context): Internal {
  const internal: Internal = {}
  for (const [name, action] of ctx.ntOnebot.actionMap) {
    const method = internalMethodName(name)
    if (method) internal[method] = params => call(ctx, action, params)
  }
  return internal
}

async function call(ctx: Context, action: { handle(params: any, options: { messageFormat: 'array'; debug: boolean }): Promise<{ retcode: number; wording?: string; message?: string; data?: unknown }> }, params: Record<string, unknown> = {}) {
  const result = await action.handle(await withOneBotIds(ctx, params), { messageFormat: 'array', debug: false })
  if (result.retcode !== 0) throw new Error(result.wording || result.message || `retcode ${result.retcode}`)
  return result.data
}

/** A plugin's `session.messageId` where OneBot wants its own number. */
async function withOneBotIds(ctx: Context, params: Record<string, unknown>) {
  const id = params.message_id
  if (typeof id !== 'string' || !id.includes('|')) return params
  const info = decodeMessageId(id)
  const msg = ctx.store.getMsgBySeq(info.peerUid, info.msgSeq) ?? (await ctx.ntMsgApi.getSingleMsg(info, info.msgSeq)).msgList[0]
  if (!msg) throw new Error('获取不到消息')
  return { ...params, message_id: ctx.store.createMsgShortId(msg) }
}
