import { afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const fixture = vi.hoisted(() => ({ dir: '' }))
vi.mock('../src/support/globalVars', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  fixture.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntqq-test-'))
  const ensureRuntimeDirectories = () => {
    for (const name of ['temp', 'database']) fs.mkdirSync(path.join(fixture.dir, name), { recursive: true })
  }
  ensureRuntimeDirectories()
  return { DATA_DIR: fixture.dir, TEMP_DIR: path.join(fixture.dir, 'temp'), LOG_DIR: path.join(fixture.dir, 'logs'),
    dbDir: path.join(fixture.dir, 'database'), getFixedDataDir: () => fixture.dir, ensureRuntimeDirectories }
})
vi.mock('../src/support/utils/environment', async original => ({
  ...await original<object>(),
  isDockerEnvironment: vi.fn(() => false),
  isNativeQQMode: vi.fn(() => false),
  currentNativeQQTarget: vi.fn(() => ({ configPath: '', qqPath: '' })),
  getProtocol: vi.fn(() => 'linux'),
  getCdn: vi.fn(() => 'cf'),
  getSpecifiedUin: vi.fn(() => undefined),
  launchPins: vi.fn(() => ({})),
  lockedProtocol: vi.fn(() => undefined),
  isDevMode: vi.fn(() => false),
}))
afterAll(() => {
  if (!fixture.dir) return
  const resolved = path.resolve(fixture.dir)
  if (!resolved.startsWith(path.resolve(tmpdir()) + path.sep) || !path.basename(resolved).startsWith('ntqq-test-')) {
    throw new Error('Invalid test cleanup directory')
  }
  rmSync(resolved, { recursive: true, force: true })
})
