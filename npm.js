// Makes the npm packages for a ts-sema release from its GitHub release assets, and optionally publishes them:
//   @beardsoft/ts-sema                      index.js, index.d.ts (bindings/napi), optionalDependencies on:
//   @beardsoft/ts-sema-<os>-<arch>[-musl]   one ts_sema.node each, selected by npm/bun through os/cpu/libc
//
//   node npm.js <version> [--dry-run] [--publish] [--tag <dist-tag>] [--from <dir>]
//
// Downloads ts-sema-<target>.tar.gz of release <version> and checks it against the release's SHA256SUMS (--from:
// a directory with those files instead), unpacks ts_sema.node from each, and writes the packages to dist/npm/.
// --dry-run runs `npm pack --dry-run` in each; --publish runs `npm publish --access public` (platform packages
// first, the main package last, so it never points at versions that aren't there). Needs Node 20+, tar and, to
// publish, an npm login with rights on @beardsoft. Intel macOS has no addon build, so no package.
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

const MAIN_README = `# @beardsoft/ts-sema

Bun's TypeScript type checker (\`bun check\`, a port of typescript-go) for Node and Bun, as an N-API addon: no
node-gyp, no \`tsc\`. The TypeScript lib files of its own version are built in. From https://github.com/${REPO}.

\`\`\`js
import { check, checkSync, setLibs, builtinLibSet, libraryPath } from '@beardsoft/ts-sema'

const report = await check('path/to/tsconfig.json')       // on a worker thread
const again = checkSync('path/to/project', { threads: 2 })
// { ok, errors, files_loaded, files_checked, load_ms, check_ms, output }

// Once per process, before the first check: only these lib files exist (here ES2022, no DOM).
setLibs(builtinLibSet(['es2022']))
\`\`\`

\`libraryPath\` is the addon's path; it is also a plain shared library with the C ABI (\`bun_sema_check\`, ...), for
\`node:ffi\`, \`bun:ffi\` or any other FFI. Platforms: Linux x64/arm64 (glibc and musl), macOS arm64. Checks run one at
a time in a process. See NOTICE for what the addon contains and the licenses.
`

const args = process.argv.slice(2)
const opt = name => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}
const flag = name => args.includes(name)
const version = args.find((a, i) => !a.startsWith('--') && !['--tag', '--from'].includes(args[i - 1]))
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) {
  console.error('usage: node npm.js <version> [--dry-run] [--publish] [--tag <dist-tag>] [--from <dir>]')
  process.exit(2)
}
const log = s => console.log(`npm: ${s}`)
const run = (cmd, argv, cwd) => execFileSync(cmd, argv, { cwd, stdio: 'inherit' })

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
const common = {
  version,
  license: 'MIT',
  repository: { type: 'git', url: `git+https://github.com/${REPO}.git` },
  homepage: `https://github.com/${REPO}`
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
    writeExtras(dir, `# ${name}\n\nThe ${target} build of [${SCOPE}/ts-sema](https://www.npmjs.com/package/${SCOPE}/ts-sema): ` +
      `\`ts_sema.node\`, an N-API addon that is also a plain shared library (bun_sema_* C ABI) for FFI. Install ` +
      `${SCOPE}/ts-sema, which picks this package for this platform. Built from release ${version} of ` +
      `https://github.com/${REPO}; see NOTICE for what it contains.\n`)
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name, ...common,
      description: `ts-sema (Bun's TypeScript checker) N-API addon for ${target}`,
      main: 'ts_sema.node',
      files: ['ts_sema.node', 'README.md', 'NOTICE', ...Object.keys(licenses)],
      os: [info.os], cpu: [info.cpu], ...(info.libc ? { libc: [info.libc] } : {})
    }, null, 2) + '\n')
    packages.push({ name, dir })
    log(`${name}: ${asset} verified`)
  }

  const template = JSON.parse(readFileSync(join(root, 'bindings/napi/package.json'), 'utf8'))
  const main = join(out, 'ts-sema')
  mkdirSync(main, { recursive: true })
  for (const file of ['index.js', 'index.d.ts']) copyFileSync(join(root, 'bindings/napi', file), join(main, file))
  writeExtras(main, MAIN_README)
  writeFileSync(join(main, 'package.json'), JSON.stringify({
    ...template, ...common, version,
    optionalDependencies: Object.fromEntries(packages.map(p => [p.name, version]))
  }, null, 2) + '\n')
  packages.push({ name: template.name, dir: main })
  log(`${template.name}: ${packages.length - 1} platform packages`)
} finally {
  rmSync(work, { recursive: true, force: true })
}

const tag = opt('--tag')
for (const { name, dir } of packages) {
  if (flag('--publish')) {
    log(`publishing ${name}@${version}`)
    run('npm', ['publish', '--access', 'public', ...(tag ? ['--tag', tag] : [])], dir)
  } else if (flag('--dry-run')) {
    run('npm', ['pack', '--dry-run'], dir)
  }
}
log(`packages in ${out}`)
