import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getHostDataDir } from '../../support/globalVars'
import { getNativeAddon } from '../../native'

// Each GUID retains its own registered QIMEI across account switches and restarts.
const registrations = new Map<string, Promise<string>>()

export function getWindowsQimei(guid: Buffer): Promise<string> {
  const guidHex = guid.toString('hex')
  const directory = join(getHostDataDir(), 'windows-devices')
  const file = join(directory, guidHex + '.json')
  const existing = registrations.get(file)
  if (existing) return existing
  const registration = loadOrRegister(directory, file, guidHex).catch(error => {
    registrations.delete(file)
    throw error
  })
  registrations.set(file, registration)
  return registration
}

async function loadOrRegister(directory: string, file: string, guidHex: string): Promise<string> {
  try {
    const saved = JSON.parse(await fs.readFile(file, 'utf8'))
    if (saved.guidHex === guidHex && typeof saved.qimei36 === 'string' && saved.qimei36.length === 36) {
      return saved.qimei36
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const native = getNativeAddon()
  if (typeof native.getWindowsQimei !== 'function') {
    throw new Error('原生模块缺少 getWindowsQimei，请更新 LuckyLillia.NTQQ.node')
  }
  const qimei36 = await native.getWindowsQimei({ guidHex })
  if (qimei36.length !== 36) throw new Error('Windows QIMEI 注册返回了无效的设备标识')
  await fs.mkdir(directory, { recursive: true })
  const temporary = file + '.' + randomUUID() + '.tmp'
  try {
    await fs.writeFile(temporary, JSON.stringify({ guidHex, qimei36 }) + '\n', { flag: 'wx' })
    await fs.rename(temporary, file)
  } finally {
    await fs.rm(temporary, { force: true })
  }
  return qimei36
}
