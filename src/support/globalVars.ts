import path from 'node:path'
import * as os from 'node:os'
import fs from 'fs'
import { existsSync, mkdirSync } from 'node:fs'

export const DATA_DIR: string = path.resolve('data')
export const TEMP_DIR: string = path.join(DATA_DIR, 'temp')
export const LOG_DIR = path.join(DATA_DIR, 'logs')

export const dbDir = path.join(DATA_DIR, 'database')
/** Importing the public API must not create instance files. The running protocol owns initialization. */
export function ensureRuntimeDirectories() {
  for (const dir of [DATA_DIR, TEMP_DIR, dbDir]) mkdirSync(dir, { recursive: true })
}

// Config, plugin data and the WebUI password are per instance, see common/configPaths.ts
/** The bot's private files: locks. Not for hand edits. */
export const STATE_DIR = path.join(DATA_DIR, 'state')

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
