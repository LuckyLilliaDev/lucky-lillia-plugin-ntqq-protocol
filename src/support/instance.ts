import path from 'node:path'
import { DATA_DIR } from './globalVars'
import { getInstanceArg } from './utils/environment'

export const DEFAULT_INSTANCE = 'default'

// Also a directory name and part of a lock name: nothing Windows or a pipe name would trip over
const INSTANCE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export function isValidInstanceName(name: string): boolean {
  return INSTANCE_NAME.test(name)
}

export function instancesDir(): string {
  return path.join(DATA_DIR, 'instances')
}

export interface InstanceChoice {
  name: string
  /** Why this one, for the startup log. */
  reason: string
}

/** --instance, else LLBOT_INSTANCE, else default, as LLBot picks it (src/common/instance.ts there). */
export function resolveInstance(argv: string[] = process.argv, env: NodeJS.ProcessEnv = process.env): InstanceChoice {
  const fromArgv = getInstanceArg(argv, {})
  const requested = fromArgv ?? getInstanceArg([], env)
  if (requested !== undefined) {
    if (!isValidInstanceName(requested)) {
      throw new Error(`实例名 "${requested}" 不合法：只能用字母、数字、_ 和 -，以字母或数字开头，最长 64 个字符`)
    }
    return { name: requested, reason: fromArgv !== undefined ? '--instance' : 'LLBOT_INSTANCE' }
  }
  return { name: DEFAULT_INSTANCE, reason: '默认实例' }
}

let current: InstanceChoice | undefined

/** The instance this process runs, fixed on first use. */
export function currentInstance(): InstanceChoice {
  return current ??= resolveInstance()
}
