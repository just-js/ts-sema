// Makes the npm packages for a ts-sema release from its GitHub release assets, and optionally publishes them:
//   @beardsoft/ts-sema                      index.js, index.d.ts (bindings/napi), optionalDependencies on:
//   @beardsoft/ts-sema-<os>-<arch>[-musl]   one ts_sema.node each, selected by npm/bun through os/cpu/libc
//
//   node npm.js <version> [--lint] [--dry-run | --stage | --publish] [--tag <dist-tag>] [--from <dir>]
//   node npm.js <version> --approve                 approve the staged versions (2FA), platform packages first
//
// Downloads ts-sema-<target>.tar.gz of release <version> and checks it against the release's SHA256SUMS (--from:
// a directory with those files instead), unpacks ts_sema.node from each, and writes the packages to dist/npm/.
// --dry-run runs `npm pack --dry-run` in each. --stage runs `npm stage publish`: each version waits, private, until
// a maintainer approves it with 2FA (npmjs.com, or `npm stage list` / `npm stage approve <id>`; npm 11.15.0+); the
// release workflow stages, because direct publishing from CI is off for these packages. --publish runs
// `npm publish --access public` directly (by hand, with an npm login). In GitHub Actions both pass --provenance
// (`npm stage publish` doesn't add it by itself). Either way the platform packages go first and the main package
// last, so it never points at versions that aren't there. --lint first runs publint (--strict) on every package and
// attw (--profile esm-only: the main package is ESM only) on the main one, and stops on any finding; both are run
// from .github/npm/node_modules (`npm ci --prefix .github/npm`: npm, publint and attw pinned by hash in its
// package-lock.json, as release.yml does), else with npx at the same versions. Each package carries sbom.cdx.json:
// a platform package its target's SBOM from the release (ts-sema-<target>.cdx.json), the main package one of its
// platform packages and, as build-time only components, the release tools of .github/npm/package-lock.json.
// --approve lists the staged versions of <version> (npm stage list --json) and approves them in order; npm asks
// for the 2FA code. Needs Node 20+, tar and, to publish or approve, an npm login with rights on @beardsoft. Intel macOS
// has no addon build, so no package.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const root = dirname(fileURLToPath(import.meta.url))
const REPO = 'just-js/ts-sema'
const SCOPE = '@beardsoft'
// The release tools: .github/npm (npm ci) when installed, else npx at the versions its package.json pins.
const TOOLS_DIR = join(root, '.github/npm')
const toolVersions = JSON.parse(readFileSync(join(TOOLS_DIR, 'package.json'), 'utf8')).devDependencies
function tool (bin, pkg, argv) {
  const local = join(TOOLS_DIR, 'node_modules/.bin', bin)
  if (existsSync(local)) return [local, argv]
  if (bin === 'npm') return ['npm', argv]
  return ['npx', ['--yes', `${pkg}@${toolVersions[pkg]}`, ...argv]]
}
const npm = argv => tool('npm', 'npm', argv)
// Rust target -> npm package suffix and the os/cpu/libc npm selects it by. Must match bindings/napi/index.js.
const TARGETS = {
  'x86_64-unknown-linux-gnu': { suffix: 'linux-x64', os: 'linux', cpu: 'x64', libc: 'glibc' },
  'x86_64-unknown-linux-musl': { suffix: 'linux-x64-musl', os: 'linux', cpu: 'x64', libc: 'musl' },
  'aarch64-unknown-linux-gnu': { suffix: 'linux-arm64', os: 'linux', cpu: 'arm64', libc: 'glibc' },
  'aarch64-unknown-linux-musl': { suffix: 'linux-arm64-musl', os: 'linux', cpu: 'arm64', libc: 'musl' },
  'aarch64-apple-darwin': { suffix: 'darwin-arm64', os: 'darwin', cpu: 'arm64' }
}
// What ts_sema.node contains, besides our code (LICENSE): the licenses ship in every package.
const NOTICE = `ts_sema.node contains, besides ts-sema's own code (LICENSE, MIT):
- Bun's TypeScript checker and the crates it uses (https://github.com/oven-sh/bun, MIT; LICENSE-bun.md, which also
  lists the code Bun includes). The checker is a port of typescript-go (https://github.com/microsoft/typescript-go,
  Apache-2.0) and carries TypeScript's diagnostic messages and lib.*.d.ts files (Apache-2.0).
- Bun's mimalloc fork (https://github.com/oven-sh/mimalloc, MIT; LICENSE-mimalloc).
- zstd's libzstd, linked statically (https://github.com/facebook/zstd, BSD-3-Clause).
- On musl builds, LLVM's libunwind, linked statically (https://llvm.org, Apache-2.0 WITH LLVM-exception).
- The Rust standard library (https://github.com/rust-lang/rust, MIT OR Apache-2.0).
`

const args = process.argv.slice(2)
const opt = name => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}
const flag = name => args.includes(name)
const version = args.find((a, i) => !a.startsWith('--') && !['--tag', '--from'].includes(args[i - 1]))
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) {
  console.error('usage: node npm.js <version> [--lint] [--dry-run | --stage | --publish] [--tag <dist-tag>] [--from <dir>]')
  process.exit(2)
}
const log = s => console.log(`npm: ${s}`)
const run = (cmd, argv, cwd) => execFileSync(cmd, argv, { cwd, stdio: 'inherit' })

// --approve: npm stage list --json per package (items: id, packageName, version, status, shasum, ...), then
// npm stage approve <id> for each staged item of this version, platform packages first, the main one last.
if (flag('--approve')) {
  const names = [...Object.values(TARGETS).map(t => `${SCOPE}/ts-sema-${t.suffix}`), `${SCOPE}/ts-sema`]
  const pending = []
  for (const name of names) {
    const [cmd, argv] = npm(['stage', 'list', name, '--json'])
    const items = JSON.parse(execFileSync(cmd, argv, { encoding: 'utf8' }) || '[]')
    const item = items.find(i => i.packageName === name && i.version === version)
    if (!item) throw new Error(`${name}@${version} is not staged`)
    log(`${name}@${version}: stage ${item.id}, status ${item.status}, shasum ${item.shasum}`)
    pending.push(item)
  }
  for (const item of pending) {
    log(`approving ${item.packageName}@${version}`)
    run(...npm(['stage', 'approve', item.id]))
  }
  log(`approved ${pending.length} packages; check with: node verify.js ${version} --npm`)
  process.exit(0)
}

async function download (name) {
  const url = `https://github.com/${REPO}/releases/download/${version}/${name}`
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

// The release assets, checked against SHA256SUMS.
const from = opt('--from')
const read = async name => from ? readFileSync(join(from, name)) : download(name)
const sums = Object.fromEntries((await read('SHA256SUMS')).toString().trim().split('\n')
  .map(line => line.trim().split(/\s+/).reverse()))
const work = mkdtempSync(join(tmpdir(), 'ts-sema-npm-'))
const out = join(root, 'dist/npm')
rmSync(out, { recursive: true, force: true })
const licenses = { LICENSE: join(root, 'LICENSE'), 'LICENSE-bun.md': join(root, 'vendor/bun/LICENSE.md'),
  'LICENSE-mimalloc': join(root, 'vendor/mimalloc/LICENSE') }
// Shared metadata for all six packages.
const common = {
  version,
  author: 'Andrew Johnston',
  license: 'MIT',
  homepage: `https://github.com/${REPO}#readme`,
  bugs: { url: `https://github.com/${REPO}/issues` },
  repository: { type: 'git', url: `git+https://github.com/${REPO}.git`, directory: 'bindings/napi' },
  engines: { node: '>=18' },
  publishConfig: { access: 'public' }
}
// The main package's SBOM (CycloneDX 1.6): its platform packages (each carries its own SBOM of what ts_sema.node
// contains), and the tools that made and published it, from .github/npm/package-lock.json with the lock's integrity
// hashes, as scope "excluded" (build time only, not part of what is installed).
function mainSbom (name, platforms) {
  // purl: each segment of the name percent-encoded (@scope/name -> %40scope/name)
  const purl = (n, v) => `pkg:npm/${n.split('/').map(encodeURIComponent).join('/')}@${v}`
  const integrity = i => {
    const [alg, b64] = (i || '').split('-')
    return alg && b64 ? [{ alg: alg.toUpperCase().replace('SHA', 'SHA-'), content: Buffer.from(b64, 'base64').toString('hex') }] : []
  }
  const self = { type: 'library', 'bom-ref': purl(name, version), name, version, purl: purl(name, version),
    licenses: [{ expression: 'MIT' }], externalReferences: [{ type: 'vcs', url: `https://github.com/${REPO}` }] }
  const components = platforms.map(p => ({
    type: 'library', 'bom-ref': purl(p.name, version), name: p.name, version, purl: purl(p.name, version),
    scope: 'optional', licenses: [{ expression: 'MIT' }],
    description: `ts_sema.node for ${p.target}; its package's sbom.cdx.json lists what it contains`
  }))
  const lock = JSON.parse(readFileSync(join(TOOLS_DIR, 'package-lock.json'), 'utf8'))
  const seen = new Set()
  for (const [path, info] of Object.entries(lock.packages)) {
    if (!path) continue
    const toolName = info.name || path.slice(path.lastIndexOf('node_modules/') + 13)
    const ref = purl(toolName, info.version)
    if (seen.has(ref)) continue
    seen.add(ref)
    components.push({
      type: 'library', 'bom-ref': ref, name: toolName, version: info.version, purl: ref, scope: 'excluded',
      ...(info.license ? { licenses: [{ expression: info.license }] } : {}),
      hashes: integrity(info.integrity),
      properties: [{ name: 'ts-sema:role', value: 'release tool (.github/npm/package-lock.json)' },
        ...(info.inBundle ? [{ name: 'ts-sema:bundled-in', value: 'npm' }] : [])]
    })
  }
  const timestamp = process.env.SOURCE_DATE_EPOCH
    ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString()
    : (() => {
        try {
          return new Date(execFileSync('git', ['-C', root, 'log', '-1', '--format=%cI'], { encoding: 'utf8' }).trim()).toISOString()
        } catch { return new Date().toISOString() }
      })()
  const body = {
    metadata: { timestamp, tools: { components: [{ type: 'application', name: 'ts-sema npm.js' }] }, component: self },
    components,
    dependencies: [{ ref: self['bom-ref'], dependsOn: platforms.map(p => purl(p.name, version)) }]
  }
  const h = createHash('sha256').update(JSON.stringify(body)).digest('hex')
  return { bomFormat: 'CycloneDX', specVersion: '1.6',
    serialNumber: `urn:uuid:${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${(8 | (parseInt(h[16], 16) & 3)).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`,
    version: 1, ...body }
}
function writeExtras (dir, readme) {
  for (const [name, path] of Object.entries(licenses)) copyFileSync(path, join(dir, name))
  writeFileSync(join(dir, 'NOTICE'), NOTICE)
  writeFileSync(join(dir, 'README.md'), readme)
}

const packages = []
try {
  for (const [target, info] of Object.entries(TARGETS)) {
    const asset = `ts-sema-${target}.tar.gz`
    const bytes = await read(asset)
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (sums[asset] !== digest) throw new Error(`${asset}: SHA-256 ${digest} doesn't match SHA256SUMS (${sums[asset]})`)
    writeFileSync(join(work, asset), bytes)
    execFileSync('tar', ['xzf', asset], { cwd: work })
    const addon = join(work, `ts-sema-${target}`, 'ts_sema.node')
    if (!existsSync(addon)) throw new Error(`${asset} has no ts_sema.node`)
    const name = `${SCOPE}/ts-sema-${info.suffix}`
    const dir = join(out, info.suffix)
    mkdirSync(dir, { recursive: true })
    copyFileSync(addon, join(dir, 'ts_sema.node'))
    // The target's SBOM, as attested on the release (releases before 0.0.3 have none).
    const sbomAsset = `ts-sema-${target}.cdx.json`
    const hasSbom = sbomAsset in sums
    if (hasSbom) {
      const sbom = await read(sbomAsset)
      if (createHash('sha256').update(sbom).digest('hex') !== sums[sbomAsset]) {
        throw new Error(`${sbomAsset}: SHA-256 doesn't match SHA256SUMS`)
      }
      writeFileSync(join(dir, 'sbom.cdx.json'), sbom)
    }
    writeExtras(dir, `# ${name}\n\nThe ${target} build of [${SCOPE}/ts-sema](https://www.npmjs.com/package/${SCOPE}/ts-sema): ` +
      `\`ts_sema.node\`, an N-API addon that is also a plain shared library (bun_sema_* C ABI) for FFI. Install ` +
      `${SCOPE}/ts-sema, which picks this package for this platform. Built from release ${version} of ` +
      `https://github.com/${REPO}; see NOTICE for what it contains.\n`)
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name, ...common,
      description: `ts-sema (Bun's TypeScript checker) N-API addon for ${target}`,
      type: 'commonjs',
      main: 'ts_sema.node',
      keywords: ['typescript', 'type-checker', 'napi', 'prebuilt', target],
      files: ['ts_sema.node', 'README.md', 'NOTICE', ...(hasSbom ? ['sbom.cdx.json'] : []), ...Object.keys(licenses)],
      os: [info.os], cpu: [info.cpu], ...(info.libc ? { libc: [info.libc] } : {})
    }, null, 2) + '\n')
    packages.push({ name, dir, target })
    log(`${name}: ${asset} verified`)
  }

  const template = JSON.parse(readFileSync(join(root, 'bindings/napi/package.json'), 'utf8'))
  const main = join(out, 'ts-sema')
  mkdirSync(main, { recursive: true })
  for (const file of ['index.js', 'index.d.ts']) copyFileSync(join(root, 'bindings/napi', file), join(main, file))
  // The npm page: bindings/napi/README.md, its badges pointing at this version.
  writeExtras(main, readFileSync(join(root, 'bindings/napi/README.md'), 'utf8')
    .replace(/(@beardsoft\/ts-sema\/)\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?/g, `$1${version}`))
  writeFileSync(join(main, 'package.json'), JSON.stringify({
    ...template, ...common, version,
    files: [...(template.files || []), 'sbom.cdx.json'],
    optionalDependencies: Object.fromEntries(packages.map(p => [p.name, version]))
  }, null, 2) + '\n')
  writeFileSync(join(main, 'sbom.cdx.json'), JSON.stringify(mainSbom(template.name, packages), null, 2) + '\n')
  packages.push({ name: template.name, dir: main })
  log(`${template.name}: ${packages.length - 1} platform packages`)
} finally {
  rmSync(work, { recursive: true, force: true })
}

if (flag('--lint')) {
  for (const { name, dir } of packages) {
    log(`publint ${name}`)
    run(...tool('publint', 'publint', ['run', '.', '--strict', '--pack', 'npm']), dir)
  }
  const main = packages[packages.length - 1]
  log(`attw ${main.name}`)
  run(...tool('attw', '@arethetypeswrong/cli', ['--pack', '.', '--profile', 'esm-only', '--no-definitely-typed']), main.dir)
}

const tag = opt('--tag')
const publishArgs = ['--access', 'public', ...(tag ? ['--tag', tag] : []),
  ...(process.env.GITHUB_ACTIONS === 'true' ? ['--provenance'] : [])]
for (const { name, dir } of packages) {
  if (flag('--stage')) {
    log(`staging ${name}@${version}`)
    run(...npm(['stage', 'publish', ...publishArgs]), dir)
  } else if (flag('--publish')) {
    log(`publishing ${name}@${version}`)
    run(...npm(['publish', ...publishArgs]), dir)
  } else if (flag('--dry-run')) {
    run(...npm(['pack', '--dry-run']), dir)
  }
}
log(`packages in ${out}`)
if (flag('--stage')) {
  log(`staged ${packages.length} packages: approve each with 2FA on npmjs.com or \`npm stage list\` + \`npm stage approve <id>\`, ` +
    'the platform packages before the main one')
}
