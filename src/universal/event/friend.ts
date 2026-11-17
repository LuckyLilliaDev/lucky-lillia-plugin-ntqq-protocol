import * as NT from '../../api'
import type { NormalizeHost } from '../types'

export async function parseFriendRequest(
  bot: NormalizeHost,
  data: NT.FriendRequestEvent
) {
  return bot.event('friend-request', {
    user: {
      id: data.initiatorUin.toString()
    },
    message: {
      id: data.initiatorUid,
      content: data.comment
    }
  })
}
