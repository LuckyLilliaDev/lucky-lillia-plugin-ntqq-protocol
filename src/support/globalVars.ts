import path from 'node:path'
import * as os from 'node:os'
import fs, { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from 'node:fs'
import type { Context } from 'cordis'

export const PLUGIN_DATA_KEY = '@luckylillia-dev+plugin-nt-protocol'
export const DATA_DIR: string = path.resolve('data')
export const LOG_DIR = path.join(DATA_DIR, 'logs')
/** The bot's private files: locks. Not for hand edits. */
export const STATE_DIR = path.join(DATA_DIR, 'state')

// Cross-instance plugin data dir (`ctx.storage.dir('host')` -> `data/plugin-data/@luckylillia-dev+plugin-nt-protocol/`)
let hostDataDir: string = path.join(DATA_DIR, 'plugin-data', PLUGIN_DATA_KEY)
// Per-instance plugin temp dir (`ctx.storage.dir('global')/temp` -> `data/instances/<instance>/plugin-data/@luckylillia-dev+plugin-nt-protocol/shared/temp/`)
let tempDir: string = path.join(hostDataDir, 'temp')

export function getHostDataDir(): string {
  return hostDataDir
}

export function getDbDir(): string {
  return path.join(hostDataDir, 'database')
}

export function getTempDir(): string {
  return tempDir
}

/** Importing the public API must not create instance files. The running protocol owns initialization. */
export function ensureRuntimeDirectories() {
  for (const dir of [hostDataDir, getDbDir(), tempDir]) mkdirSync(dir, { recursive: true })
}

function moveIfAbsent(src: string, dest: string): boolean {
  if (!existsSync(src) || existsSync(dest)) return false
  mkdirSync(path.dirname(dest), { recursive: true })
  try {
    renameSync(src, dest)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    copyFileSync(src, dest)
    unlinkSync(src)
  }
  return true
}

/**
 * One-time move of pre-storage NTQQ protocol files from `data/` into the plugin's own host data directory
 * (`data/plugin-data/@luckylillia-dev+plugin-nt-protocol/`). Never overwrites existing files in the target.
 */
export function migrateLegacyProtocolData(
  legacyRoot: string = DATA_DIR,
  targetHostDir: string = hostDataDir,
  log?: { info(message: string): void; warn(message: string): void },
): boolean {
  if (path.resolve(legacyRoot) === path.resolve(targetHostDir)) return false
  let moved = 0
  try {
    for (const file of ['auth_token.txt', 'auth_token.dev.txt', 'machine_guid.bin']) {
      if (moveIfAbsent(path.join(legacyRoot, file), path.join(targetHostDir, file))) moved++
    }
    if (existsSync(legacyRoot)) {
      for (const name of readdirSync(legacyRoot)) {
        if (!/^qq-session-\d+(?:-(?:linux|windows|macos|watch))?\.json$/.test(name)) continue
        if (moveIfAbsent(path.join(legacyRoot, name), path.join(targetHostDir, name))) moved++
      }
    }
    const legacyDbDir = path.join(legacyRoot, 'database')
    const targetDbDir = path.join(targetHostDir, 'database')
    if (existsSync(legacyDbDir)) {
      for (const name of readdirSync(legacyDbDir)) {
        if (!/\.v3\.db(?:-wal|-shm)?$/.test(name)) continue
        if (moveIfAbsent(path.join(legacyDbDir, name), path.join(targetDbDir, name))) moved++
      }
    }
  } catch (error) {
    log?.warn(`迁移旧 NTQQ 协议数据时发生错误：${error instanceof Error ? error.message : String(error)}`)
  }
  if (moved > 0) {
    log?.info(`已将 ${moved} 个旧 NTQQ 协议数据文件迁移至插件专属目录 ${targetHostDir}`)
  }
  return moved > 0
}

/** Resolves plugin-owned storage directories from the host (`ctx.storage`), falling back gracefully on older hosts. */
export async function initPluginStorage(
  ctx: Context,
  log?: { info(message: string): void; warn(message: string): void },
): Promise<void> {
  const storage = (ctx as unknown as { storage?: { dir(scope?: string): Promise<string> } }).storage
  if (storage) {
    try {
      hostDataDir = await storage.dir('host')
    } catch {
      hostDataDir = path.join(DATA_DIR, 'plugin-data', PLUGIN_DATA_KEY)
    }
    try {
      tempDir = path.join(await storage.dir('global'), 'temp')
    } catch {
      tempDir = path.join(hostDataDir, 'temp')
    }
  } else {
    hostDataDir = path.join(DATA_DIR, 'plugin-data', PLUGIN_DATA_KEY)
    tempDir = path.join(hostDataDir, 'temp')
  }
  ensureRuntimeDirectories()
  migrateLegacyProtocolData(DATA_DIR, hostDataDir, log)
}

export function getFixedDataDir() {
  let dataDir: string = ''
  if (process.platform === 'win32') {
    dataDir = path.join(process.env['LOCALAPPDATA']!, 'llonebot')
  }
  else {
    dataDir = path.join(os.homedir(), '.llonebot')
  }
  if (!fs.existsSync(dataDir)) {
    try {
      fs.mkdirSync(dataDir)
    }catch (e) {

    }
  }
  return dataDir
}
