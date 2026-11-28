import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const state = vi.hoisted(() => ({ directory: '', register: vi.fn() }))
vi.mock('../../../src/support/globalVars', () => ({ getHostDataDir: () => state.directory }))
vi.mock('../../../src/native', () => ({ getNativeAddon: () => ({ getWindowsQimei: state.register }) }))
import { getWindowsQimei } from '../../../src/qqProtocol/direct-lib/windowsDevice'

beforeEach(async () => {
  state.directory = await fs.mkdtemp(join(tmpdir(), 'llbot-windows-device-'))
  state.register.mockReset().mockResolvedValue('a'.repeat(36))
})
afterEach(async () => { await fs.rm(state.directory, { recursive: true, force: true }) })

it('shares registration between concurrent calls and saves the registered GUID', async () => {
  const guid = Buffer.alloc(16, 1)
  await Promise.all([getWindowsQimei(guid), getWindowsQimei(guid)])
  expect(state.register).toHaveBeenCalledTimes(1)
  const saved = JSON.parse(await fs.readFile(join(state.directory, 'windows-devices', guid.toString('hex') + '.json'), 'utf8'))
  expect(saved).toEqual({ guidHex: guid.toString('hex'), qimei36: 'a'.repeat(36) })
  await getWindowsQimei(Buffer.alloc(16, 2))
  expect(state.register).toHaveBeenCalledTimes(2)
})

it('reuses a persisted registration after restart', async () => {
  const guidHex = '03'.repeat(16)
  await fs.mkdir(join(state.directory, 'windows-devices'))
  await fs.writeFile(join(state.directory, 'windows-devices', guidHex + '.json'), JSON.stringify({ guidHex, qimei36: 'b'.repeat(36) }))
  await expect(getWindowsQimei(Buffer.from(guidHex, 'hex'))).resolves.toBe('b'.repeat(36))
  expect(state.register).not.toHaveBeenCalled()
})

it('allows retry after a registration fails', async () => {
  state.register.mockRejectedValueOnce(new Error('network'))
  await expect(getWindowsQimei(Buffer.alloc(16, 4))).rejects.toThrow('network')
  await expect(getWindowsQimei(Buffer.alloc(16, 4))).resolves.toBe('a'.repeat(36))
  expect(state.register).toHaveBeenCalledTimes(2)
})
