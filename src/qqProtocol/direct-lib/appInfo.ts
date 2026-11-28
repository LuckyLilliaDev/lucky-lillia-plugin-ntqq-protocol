import { getActiveProfile } from './profiles'
import { loadMachineGuidSync } from './machineGuid'

// The current protocol profile, flat. Read dynamically on access; branch on the family with getActiveProfile().
export const AppInfo = {
  get os() { return getActiveProfile().os },
  get kernel() { return getActiveProfile().kernel },
  get vendorOs() { return getActiveProfile().vendorOs },
  get currentVersion() { return getActiveProfile().currentVersion },
  get buildVer() { return getActiveProfile().buildVer },
  get miscBitmap() { return getActiveProfile().miscBitmap },
  get ptVersion() { return getActiveProfile().ptVersion },
  get ssoVersion() { return getActiveProfile().ssoVersion },
  get packageName() { return getActiveProfile().packageName },
  get wtLoginSdk() { return getActiveProfile().wtLoginSdk },
  get appId() { return getActiveProfile().appId },
  get subAppId() { return getActiveProfile().subAppId },
  get appIdQrCode() { return getActiveProfile().appIdQrCode },
  get mainSigMap() { return getActiveProfile().mainSigMap },
  get subSigMap() { return getActiveProfile().subSigMap },
  get ntLoginType() { return getActiveProfile().ntLoginType },
  get appClientVersion() { return getActiveProfile().appClientVersion },
  get qua() { return getActiveProfile().qua },
}

export const DeviceInfo = {
  get devType() { return getActiveProfile().devType },
  get devName(): string {
    return process.env.LLBOT_DEV_NAME?.trim() || `LuckyLillia-${loadMachineGuidSync().toString('hex').slice(0, 6)}`
  },
  get osVer() { return getActiveProfile().osVer },
  get vendorName() { return getActiveProfile().vendorName },
  get vendorOsName() { return getActiveProfile().vendorOsName },
  get systemKernel() { return getActiveProfile().systemKernel },
}
