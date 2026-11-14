import { BaseAction } from '../BaseAction'
import { OB11Version } from '../../types'
import { ActionName } from '../types'
import { hostVersion } from '../../host'

export default class GetVersionInfo extends BaseAction<{}, OB11Version> {
  actionName = ActionName.GetVersionInfo

  protected async _handle(): Promise<OB11Version> {
    return {
      app_name: 'LLOneBot',
      protocol_version: 'v11',
      app_version: hostVersion(this.ctx),
    }
  }
}
