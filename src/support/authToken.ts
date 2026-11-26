import fs from 'node:fs'
import path from 'node:path'
import { getHostDataDir } from './globalVars'
import { isDevMode } from './utils/environment'

/** Stored under the plugin's cross-instance data directory (`ctx.storage.dir('host')`). */
export class AuthTokenUtil {
  private readonly resolvePath: () => string
  constructor(file: string | (() => string)) {
    this.resolvePath = typeof file === 'function' ? file : () => file
  }
  getPath() { return path.resolve(this.resolvePath()) }
  getToken() {
    try { return fs.readFileSync(this.resolvePath(), 'utf8').trim() }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error }
  }
  reload() { return this.getToken() }
  setToken(token: string) {
    const file = this.resolvePath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, token.trim(), { encoding: 'utf8', mode: 0o600 })
  }
}
export const authTokenUtil = new AuthTokenUtil(() => path.join(getHostDataDir(), isDevMode() ? 'auth_token.dev.txt' : 'auth_token.txt'))
