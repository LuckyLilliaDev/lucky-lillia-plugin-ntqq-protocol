// Persistent synthetic mobile device identity (iPad / iPhone / HarmonyPad / HarmonyPhone).
// Stored per protocol inside plugin host data dir (`<protocol>_device.json`).
// QIMEI registration/synthesis and `device_pb` assembly run strictly inside the native .node addon
// (mirroring macosDevice.ts) so QIMEI/O3 secrets never live in open-source TypeScript.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { getHostDataDir } from '../../../support/globalVars'
import { getLogger } from '../../../support/logger'
import { getNativeAddon } from '../../../native'
import type { ProtocolProfile } from '../profiles/types'

const logger = getLogger('mobile-device')

export interface MobileDevice {
  guid: Buffer
  guidHex: string
  qimei36: string
  xwid: string
  devicePbHex: string
  deviceName: string
  osVer: string
  model: string
}

interface MobileDeviceFile {
  guid: string
  qua: string
  qimei36: string
  xwid: string
  devicePbHex: string
  deviceName: string
  osVer: string
  model: string
}

const cache = new Map<string, MobileDevice>()
const inflight = new Map<string, Promise<MobileDevice>>()

function defaultDeviceName(guid: Buffer): string {
  const env = process.env.LLBOT_DEV_NAME?.trim()
  if (env) return env
  return `LuckyLillia-${guid.subarray(0, 3).toString('hex')}`
}

function deviceFilePath(protocolName: string): string {
  return join(getHostDataDir(), `${protocolName}_device.json`)
}

/** Synchronously return the last loaded mobile device for `protocolName` (for reserve f12 lookup). */
export function getCachedMobileDevice(protocolName: string, guidHex?: string): MobileDevice | null {
  if (guidHex) {
    const exact = cache.get(`${protocolName}:${guidHex}`)
    if (exact) return exact
  }
  for (const [k, v] of cache) {
    if (k.startsWith(`${protocolName}:`)) return v
  }
  return null
}

export async function getMobileDevice(
  profile: ProtocolProfile,
  guid: Buffer,
  opts: { registerOnline?: boolean; filePath?: string } = {},
): Promise<MobileDevice> {
  const guidHex = guid.toString('hex')
  const cacheKey = `${profile.name}:${guidHex}`
  const hit = cache.get(cacheKey)
  if (hit) return hit
  const pending = inflight.get(cacheKey)
  if (pending) return pending

  const job = loadOrInitMobileDevice(profile, guid, opts)
    .then((dev) => {
      cache.set(cacheKey, dev)
      return dev
    })
    .finally(() => {
      inflight.delete(cacheKey)
    })
  inflight.set(cacheKey, job)
  return job
}

async function loadOrInitMobileDevice(
  profile: ProtocolProfile,
  guid: Buffer,
  opts: { registerOnline?: boolean; filePath?: string },
): Promise<MobileDevice> {
  const guidHex = guid.toString('hex')
  const file = opts.filePath ?? deviceFilePath(profile.name)
  const registerOnline = opts.registerOnline ?? true
  const mobile = profile.mobile
  if (!mobile || (profile.family !== 'ios' && profile.family !== 'harmony')) {
    throw new Error(`getMobileDevice called for non-mobile profile ${profile.name}`)
  }

  let parsed: Partial<MobileDeviceFile> = {}
  try {
    const raw = await fs.readFile(file, 'utf-8')
    parsed = JSON.parse(raw) as Partial<MobileDeviceFile>
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn(`[MobileDevice] failed to read ${file}, regenerating: ${(e as Error).message}`)
    }
  }

  let dirty = false
  if (parsed.guid && parsed.guid !== guidHex) {
    parsed.qimei36 = ''
    parsed.devicePbHex = ''
    parsed.guid = guidHex
    dirty = true
  } else if (!parsed.guid) {
    parsed.guid = guidHex
    dirty = true
  }

  if (!parsed.model) {
    parsed.model = mobile.defaultModel
    dirty = true
  }
  if (!parsed.osVer) {
    parsed.osVer = mobile.defaultOsVer
    dirty = true
  }
  if (!parsed.deviceName) {
    parsed.deviceName = defaultDeviceName(guid)
    dirty = true
  }
  if (parsed.xwid === undefined) {
    parsed.xwid = ''
    dirty = true
  }

  const proxy = getNativeAddon()

  if (profile.family === 'harmony' && parsed.qimei36) {
    proxy.setHarmonyQimei?.({
      seedHex: guidHex,
      isPhone: mobile.isPhone,
      qimei36: parsed.qimei36,
    })
  }

  const needHarmonyQimei = profile.family === 'harmony' && !parsed.qimei36 && registerOnline
  const needRebuildPb = !parsed.devicePbHex || parsed.qua !== profile.qua || (profile.family === 'ios' && !parsed.qimei36)

  if (needHarmonyQimei) {
    if (typeof proxy.getHarmonyQimei !== 'function') {
      throw new Error('LuckyLillia.NTQQ.node 过旧 (缺 getHarmonyQimei), 请重新 build 并 sync:plugin')
    }
    try {
      const res = await proxy.getHarmonyQimei({
        seedHex: guidHex,
        isPhone: mobile.isPhone,
        qua: profile.qua,
        model: parsed.model,
        osVer: parsed.osVer,
      })
      parsed.qimei36 = res.qimei36
      parsed.devicePbHex = ''
      dirty = true
      logger.info(`[MobileDevice] HarmonyOS qimei36 registered: ${res.qimei36}`)
    } catch (e) {
      logger.warn(`[MobileDevice] HarmonyOS qimei36 registration failed (leaving empty, will retry): ${(e as Error).message}`)
      parsed.qimei36 = ''
    }
  }

  if (needRebuildPb || !parsed.devicePbHex) {
    if (typeof proxy.buildMobileDevicePb !== 'function') {
      throw new Error('LuckyLillia.NTQQ.node 过旧 (缺 buildMobileDevicePb), 请重新 build 并 sync:plugin')
    }
    const built = proxy.buildMobileDevicePb({
      platform: profile.family,
      isPhone: mobile.isPhone,
      seedHex: guidHex,
      qua: profile.qua,
      packageName: profile.packageName,
      ptVersion: profile.ptVersion,
      buildVer: profile.buildVer,
      deviceName: parsed.deviceName,
      model: parsed.model,
      osVer: parsed.osVer,
      q36: parsed.qimei36 || undefined,
      xwid: parsed.xwid || undefined,
      vendorName: profile.vendorName || undefined,
      screenMetrics: [...mobile.screenMetrics],
    })
    parsed.qimei36 = built.qimei36
    parsed.devicePbHex = built.devicePbHex
    parsed.qua = profile.qua
    dirty = true
  }

  const out: MobileDeviceFile = {
    guid: guidHex,
    qua: parsed.qua || profile.qua,
    qimei36: parsed.qimei36 ?? '',
    xwid: parsed.xwid ?? '',
    devicePbHex: parsed.devicePbHex ?? '',
    deviceName: parsed.deviceName,
    osVer: parsed.osVer,
    model: parsed.model,
  }

  if (dirty) {
    try {
      await fs.mkdir(getHostDataDir(), { recursive: true })
      await fs.writeFile(file, JSON.stringify(out, null, 2))
    } catch (e) {
      logger.warn(`[MobileDevice] persist ${file} failed: ${(e as Error).message}`)
    }
  }

  return {
    guid: Buffer.from(guid),
    guidHex,
    qimei36: out.qimei36,
    xwid: out.xwid,
    devicePbHex: out.devicePbHex,
    deviceName: out.deviceName,
    osVer: out.osVer,
    model: out.model,
  }
}

export function _resetMobileDeviceCacheForTest(): void {
  cache.clear()
  inflight.clear()
}
