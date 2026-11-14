import { ActionName } from '../../types'
import { GetFlashFileInfoBase, GetFlashFilePayload } from './GetFlashFileInfo'


export class DownloadFlashFile extends GetFlashFileInfoBase<null> {
  actionName = ActionName.DownloadFlashFile

  async _handle(payload: GetFlashFilePayload) {
    const file_set_id = await this.get_file_set_id(payload)
    const res = await this.ctx.ntFileApi.downloadFlashFile(file_set_id)
    if (res.result !== 0) {
      throw new Error(res.errMsg)
    }
    return null
  }
}
