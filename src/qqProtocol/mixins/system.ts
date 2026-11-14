import { Oidb } from '../../ntqqapi/proto'
import { Cmd } from '../direct-lib/cmd'
import type { QQProtocolBase } from '../base'

export function SystemMixin<T extends abstract new (...args: any[]) => QQProtocolBase>(Base: T): T & (abstract new (...args: any[]) => SystemMixinMethods)  {
  abstract class Mixed extends Base {
    async fetchPins() {
      const data = Oidb.Base.encode({
        command: 0x12b3,
        subCommand: 0,
        body: Buffer.alloc(0),
      })
      const res = await this.sendPB(Cmd.Misc.FetchPins, data)
      const oidbRespBody = Oidb.Base.decode(Buffer.from(res.pb, 'hex')).body
      return Oidb.FetchPinsResp.decode(oidbRespBody)
    }
  }
  return Mixed
}

/** Public methods contributed by this protocol mixin. */
export interface SystemMixinMethods {
  fetchPins(): Promise<{ readonly friends: { uid: string; }[]; readonly groups: { groupCode: number; }[]; }>;
}
