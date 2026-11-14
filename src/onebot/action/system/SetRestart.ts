import { BaseAction } from '../BaseAction'
import { ActionName } from '../types'

export class SetRestart extends BaseAction<{}, null> {
  actionName = ActionName.SetRestart

  protected async _handle() {
    await this.ctx.ntSystemApi.restart()
    return null
  }
}
