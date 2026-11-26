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
  let hostDataDir = fixture.dir
  let tempDir = path.join(fixture.dir, 'temp')
  const getHostDataDir = () => hostDataDir
  const getDbDir = () => path.join(hostDataDir, 'database')
  const getTempDir = () => tempDir
  const ensureRuntimeDirectories = () => {
    for (const dir of [hostDataDir, getDbDir(), tempDir]) fs.mkdirSync(dir, { recursive: true })
  }
  const initPluginStorage = async (ctx: { storage?: { dir(scope?: string): Promise<string> } }) => {
    if (ctx?.storage) {
      hostDataDir = await ctx.storage.dir('host').catch(() => fixture.dir)
      tempDir = path.join(await ctx.storage.dir('global').catch(() => fixture.dir), 'temp')
    }
    ensureRuntimeDirectories()
  }
  ensureRuntimeDirectories()
  return {
    DATA_DIR: fixture.dir,
    LOG_DIR: path.join(fixture.dir, 'logs'),
    STATE_DIR: path.join(fixture.dir, 'state'),
    getHostDataDir,
    getDbDir,
    getTempDir,
    getFixedDataDir: () => fixture.dir,
    ensureRuntimeDirectories,
    initPluginStorage,
    migrateLegacyProtocolData: () => false,
  }
})
vi.mock('../src/support/utils/environment', async original => ({
  ...await original<object>(),
  isDockerEnvironment: vi.fn(() => false),
  isNativeQQMode: vi.fn(() => false),
  currentNativeQQ: vi.fn(() => ({ qqPath: '', hookMode: '' })),
  getProtocol: vi.fn(() => 'linux'),
  getCdn: vi.fn(() => 'cf'),
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
