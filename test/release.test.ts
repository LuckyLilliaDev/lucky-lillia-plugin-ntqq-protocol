import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { validateMetadata, validatePackage } from '../scripts/release.mjs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'))
const versionSource = readFileSync(new URL('../src/version.ts', import.meta.url), 'utf8')
const env = { GITHUB_REPOSITORY: 'LuckyLilliaDev/lucky-lillia-plugin-ntqq-protocol',
  GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/v' + pkg.version }

describe('release validation', () => {
  it('accepts the matching release and selects latest', () => {
    expect(validateMetadata(pkg, lock, versionSource, env)).toBe('latest')
  })

  it('keeps prereleases off latest and rejects malformed versions', () => {
    expect(validatePackage({ ...pkg, version: '1.1.0-beta.1' })).toBe('next')
    for (const version of ['v1.1.0', '01.1.0', '1.1.0-beta.01', '1.1.0+build']) {
      expect(() => validatePackage({ ...pkg, version })).toThrow()
    }
  })

  it('requires the intended repository and matching tag', () => {
    expect(() => validateMetadata(pkg, lock, versionSource, { ...env, GITHUB_REPOSITORY: 'another/repo' })).toThrow()
    expect(() => validateMetadata(pkg, lock, versionSource, { ...env, GITHUB_REF: 'refs/tags/v0.0.1' })).toThrow()
  })

  it('allows manual runs only from main', () => {
    expect(validateMetadata(pkg, lock, versionSource, { ...env, GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF: 'refs/heads/main' })).toBe('latest')
    expect(() => validateMetadata(pkg, lock, versionSource, { ...env, GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF: 'refs/heads/feature' })).toThrow()
  })

  it('rejects stale lockfiles and runtime version metadata', () => {
    expect(() => validateMetadata(pkg, { ...lock, version: '0.0.1' }, versionSource, env)).toThrow()
    expect(() => validateMetadata(pkg, { ...lock, packages: { ...lock.packages, '': { ...lock.packages[''], version: '0.0.1' } } }, versionSource, env)).toThrow()
    expect(() => validateMetadata(pkg, lock, "export const version = '0.0.1'", env)).toThrow()
  })

  it('rejects the wrong package, repository URL, registry or private publication', () => {
    for (const replacement of [
      { name: '@luckylillia/plugin-onebot11' },
      { repository: { type: 'git', url: 'git+https://github.com/another/repo.git' } },
      { publishConfig: { access: 'public', registry: 'https://registry.npmmirror.com' } },
      { private: true },
    ]) expect(() => validatePackage({ ...pkg, ...replacement })).toThrow()
  })
})
