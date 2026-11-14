import { Context, Service } from 'cordis'
import { initActionMap } from './action'

declare module 'cordis' {
  interface Context { ntOnebot: OneBotActions }
}

/** OneBot-compatible account API. It never opens HTTP/WebSocket connections. */
export class OneBotActions extends Service {
  static inject = ['ntMsgApi', 'ntFileApi', 'ntFriendApi', 'ntGroupApi', 'ntUserApi',
    'ntWebApi', 'ntSystemApi', 'store', 'app', 'qqProtocol', 'timer', 'config']
  readonly actionMap: ReturnType<typeof initActionMap>

  constructor(ctx: Context) {
    super(ctx, 'ntOnebot')
    this.actionMap = initActionMap({ ctx })
  }
}
