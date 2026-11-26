import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Unmock globalVars so we test the real storage resolution and migration logic.
vi.unmock('../../src/support/globalVars')

const { getDbDir, getHostDataDir, getTempDir, initPluginStorage, migrateLegacyProtocolData } = await import('../../src/support/globalVars')

describe('plugin-nt-protocol storage', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'ntqq-storage-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('migrates legacy files from data/ root into the plugin host directory without overwriting existing files', () => {
    const legacy = path.join(root, 'data')
    const target = path.join(legacy, 'plugin-data', '@luckylillia-dev+plugin-nt-protocol')
    mkdirSync(path.join(legacy, 'database'), { recursive: true })
    mkdirSync(target, { recursive: true })

    writeFileSync(path.join(legacy, 'auth_token.txt'), 'legacy-token')
    writeFileSync(path.join(legacy, 'machine_guid.bin'), Buffer.alloc(16, 7))
    writeFileSync(path.join(legacy, 'qq-session-10001.json'), '{"uin":"10001"}')
    writeFileSync(path.join(legacy, 'qq-session-10002-macos.json'), '{"uin":"10002"}')
    writeFileSync(path.join(legacy, 'database', '10001.v3.db'), 'db-bytes')
    // Already present in target: must not be overwritten
    writeFileSync(path.join(target, 'auth_token.txt'), 'newer-token')

    const log = { info: vi.fn(), warn: vi.fn() }
    expect(migrateLegacyProtocolData(legacy, target, log)).toBe(true)

    expect(readFileSync(path.join(target, 'auth_token.txt'), 'utf8')).toBe('newer-token')
    expect(existsSync(path.join(legacy, 'auth_token.txt'))).toBe(true)
    expect(readFileSync(path.join(target, 'machine_guid.bin'))).toEqual(Buffer.alloc(16, 7))
    expect(readFileSync(path.join(target, 'qq-session-10001.json'), 'utf8')).toBe('{"uin":"10001"}')
    expect(readFileSync(path.join(target, 'qq-session-10002-macos.json'), 'utf8')).toBe('{"uin":"10002"}')
    expect(readFileSync(path.join(target, 'database', '10001.v3.db'), 'utf8')).toBe('db-bytes')
    expect(existsSync(path.join(legacy, 'machine_guid.bin'))).toBe(false)
    expect(existsSync(path.join(legacy, 'database', '10001.v3.db'))).toBe(false)
  })

  it('resolves host and per-instance temp directories from ctx.storage', async () => {
    const hostDir = path.join(root, 'host-data')
    const instanceDir = path.join(root, 'instance-data')
    const ctx = {
      storage: {
        dir: vi.fn(async (scope?: string) => (scope === 'host' ? hostDir : instanceDir)),
      },
    } as any

    await initPluginStorage(ctx)
    expect(getHostDataDir()).toBe(hostDir)
    expect(getDbDir()).toBe(path.join(hostDir, 'database'))
    expect(getTempDir()).toBe(path.join(instanceDir, 'temp'))
    expect(existsSync(getDbDir())).toBe(true)
    expect(existsSync(getTempDir())).toBe(true)
  })
})
