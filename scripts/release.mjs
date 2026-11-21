import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repository = 'LuckyLilliaDev/lucky-lillia-plugin-ntqq-protocol'
const name = '@luckylillia-dev/plugin-nt-protocol'
const registry = 'https://registry.npmjs.org'
const targets = ['win-x64', 'darwin-x64', 'darwin-arm64', 'linux-x64-glibc',
  'linux-arm64-glibc', 'linux-x64-musl', 'linux-arm64-musl']
const json = file => JSON.parse(readFileSync(file, 'utf8'))
const checksum = file => 'sha512-' + createHash('sha512').update(readFileSync(file)).digest('base64')

export function validatePackage(pkg) {
  assert.equal(pkg.name, name)
  assert.match(pkg.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?$/, 'Use an npm release version without build metadata')
  assert.equal(pkg.repository?.type, 'git')
  assert.equal(pkg.repository?.url, 'git+https://github.com/' + repository + '.git')
  assert.equal(pkg.publishConfig?.registry, registry)
  assert.equal(pkg.publishConfig?.access, 'public')
  assert.notEqual(pkg.private, true)
  return pkg.version.includes('-') ? 'next' : 'latest'
}

export function validateMetadata(pkg, lock, versionSource, env) {
  const tag = validatePackage(pkg)
  assert.equal(lock.name, pkg.name)
  assert.equal(lock.version, pkg.version)
  assert.equal(lock.packages?.['']?.name, pkg.name)
  assert.equal(lock.packages?.['']?.version, pkg.version)
  assert.equal(versionSource.match(/export const version = ['"]([^'"]+)['"]/u)?.[1], pkg.version,
    'src/version.ts must match package.json')
  assert.equal(env.GITHUB_REPOSITORY, repository)
  if (env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
    assert.equal(env.GITHUB_REF, 'refs/heads/main', 'Manual runs are only allowed from main')
  } else {
    assert.equal(env.GITHUB_EVENT_NAME, 'push')
    assert.equal(env.GITHUB_REF, 'refs/tags/v' + pkg.version, 'Tag must match package.json')
  }
  return tag
}

function inspectTarball(file, pkg, pack) {
  assert.equal(checksum(file), pack.integrity, 'Package archive integrity mismatch')
  const files = execFileSync('tar', ['-tzf', file], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    .trim().split(/\r?\n/).filter(Boolean)
  for (const entry of files) {
    assert.ok(entry.startsWith('package/') && !entry.includes('\\')
      && !entry.split('/').includes('..'), 'Unsafe archive path: ' + entry)
  }
  assert.deepEqual(files.filter(file => !file.endsWith('/')).map(file => file.slice(8)).sort(),
    pack.files.map(file => file.path).sort(), 'Archive files differ from npm pack manifest')
  const directory = mkdtempSync(path.join(tmpdir(), 'ntqq-release-'))
  try {
    execFileSync('tar', ['-xzf', file, '-C', directory])
    const packedRoot = path.join(directory, 'package')
    const packedPackage = json(path.join(packedRoot, 'package.json'))
    assert.deepEqual(packedPackage, pkg, 'Packed package metadata differs from source')
    const required = new Set(['package.json', 'README.md', 'LICENSE', 'lib/onebot-actions.json',
      'lib/client/module.js', 'lib/client/style.css', pkg.main, pkg.llbot.webui])
    const addExports = entry => {
      if (typeof entry === 'string') required.add(entry)
      else for (const value of Object.values(entry)) addExports(value)
    }
    addExports(pkg.exports)
    for (const relative of required) {
      const normalized = relative.replace(/^\.\//, '')
      assert.ok(pack.files.some(file => file.path === normalized && file.size > 0), 'Missing package file: ' + normalized)
    }
    for (const entry of pack.files) {
      assert.ok(['package.json', 'README.md', 'LICENSE'].includes(entry.path)
        || entry.path.startsWith('lib/') || entry.path.startsWith('native/production/'),
      'Unexpected published file: ' + entry.path)
    }
    const nativeRoot = path.join(packedRoot, 'native/production')
    const manifest = json(path.join(nativeRoot, 'manifest.json'))
    assert.equal(manifest.variant, 'production')
    assert.deepEqual(Object.keys(manifest.targets).sort(), [...targets].sort(), 'All production platforms must be included')
    const nativeFiles = ['manifest.json', ...Object.keys(manifest.files)].map(file => 'native/production/' + file).sort()
    assert.deepEqual(pack.files.filter(file => file.path.startsWith('native/production/')).map(file => file.path).sort(),
      nativeFiles, 'Native bundle files differ from its manifest')
    // inspectBundle only hashes/validates files; it never loads a .node or launches QQ.
    const require = createRequire(import.meta.url)
    require(path.join(nativeRoot, 'loader.cjs')).inspectBundle(nativeRoot, { allTargets: true })
    console.log('Verified backend, WebUI, declarations and all seven production native targets')
  } finally {
    // mkdtemp guarantees a new child of this known temporary root.
    assert.equal(path.dirname(directory), path.resolve(tmpdir()))
    assert.ok(path.basename(directory).startsWith('ntqq-release-'))
    rmSync(directory, { recursive: true, force: true })
  }
}

async function registryVersion(pkg) {
  return fetch(registry + '/' + encodeURIComponent(pkg.name) + '/' + encodeURIComponent(pkg.version),
    { signal: AbortSignal.timeout(30_000), headers: { 'cache-control': 'no-cache' } })
}

async function main() {
  const [command, output] = process.argv.slice(2)
  const pkg = json(path.join(root, 'package.json'))
  const npmTag = validatePackage(pkg)
  if (command === 'metadata') {
    validateMetadata(pkg, json(path.join(root, 'package-lock.json')), readFileSync(path.join(root, 'src/version.ts'), 'utf8'), process.env)
    console.log('Validated ' + pkg.name + '@' + pkg.version + ' (npm tag: ' + npmTag + ')')
    return
  }
  if (command === 'available') {
    const response = await registryVersion(pkg)
    assert.equal(response.status, 404, response.ok
      ? pkg.name + '@' + pkg.version + ' is already published; increment the version before releasing'
      : 'npm registry availability check failed: HTTP ' + response.status)
    console.log(pkg.name + '@' + pkg.version + ' has not been published')
    return
  }
  assert.ok(['pack', 'verify', 'published'].includes(command) && output,
    'Usage: node scripts/release.mjs metadata|available|pack <directory>|verify <directory>|published <directory>')
  const directory = path.resolve(output)
  const [pack] = json(path.join(directory, 'pack.json'))
  assert.equal(pack.name, pkg.name)
  assert.equal(pack.version, pkg.version)
  assert.equal(pack.filename, 'luckylillia-dev-plugin-nt-protocol-' + pkg.version + '.tgz')
  const tarball = path.join(directory, pack.filename)
  const release = { name: pkg.name, version: pkg.version, filename: pack.filename, npmTag, integrity: pack.integrity }
  if (command === 'pack') {
    inspectTarball(tarball, pkg, pack)
    writeFileSync(path.join(directory, 'release.json'), JSON.stringify(release, null, 2) + '\n')
  } else {
    assert.deepEqual(json(path.join(directory, 'release.json')), release)
    assert.equal(checksum(tarball), release.integrity, 'Downloaded artifact differs from the checked archive')
  }
  if (command === 'verify') {
    inspectTarball(tarball, pkg, pack)
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tarball=${tarball}\nnpm_tag=${npmTag}\n`)
  }
  if (command === 'published') {
    for (let attempt = 0; attempt < 6; attempt++) {
      const response = await registryVersion(pkg)
      if (response.ok) {
        const published = await response.json()
        assert.equal(published.name, pkg.name)
        assert.equal(published.version, pkg.version)
        assert.equal(published.dist?.integrity, release.integrity, 'Public package differs from the checked archive')
        const taggedResponse = await fetch(registry + '/' + encodeURIComponent(pkg.name) + '/' + npmTag,
          { signal: AbortSignal.timeout(30_000), headers: { 'cache-control': 'no-cache' } })
        if (taggedResponse.ok && (await taggedResponse.json()).version === pkg.version) {
          console.log('Published and verified ' + pkg.name + '@' + pkg.version + ' (' + npmTag + ')')
          return
        }
      } else if (response.status !== 404) throw new Error('Public version verification failed: HTTP ' + response.status)
      if (attempt < 5) await new Promise(resolve => setTimeout(resolve, 15_000))
    }
    throw new Error('npm accepted the publish command, but the version/tag is not public yet. Check npm Staged Packages/automated review before retrying; do not republish this version.')
  }
  console.log('Checked ' + pack.filename + ': ' + release.integrity)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
