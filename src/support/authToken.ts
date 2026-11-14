import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './globalVars'
import { isDevMode } from './utils/environment'

/** Retains the existing token location when upgrading from the bundled protocol. */
export class AuthTokenUtil {
  constructor(private readonly file: string) {}
  getPath() { return path.resolve(this.file) }
  getToken() {
    try { return fs.readFileSync(this.file, 'utf8').trim() }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error }
  }
  reload() { return this.getToken() }
  setToken(token: string) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, token.trim(), { encoding: 'utf8', mode: 0o600 })
  }
}
export const authTokenUtil = new AuthTokenUtil(path.join(DATA_DIR, isDevMode() ? 'auth_token.dev.txt' : 'auth_token.txt'))
