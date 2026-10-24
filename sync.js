// Refreshes vendor/ from upstream Bun: the Bun crates the C ABI (capi/) needs, Bun's root manifests, the files they
// read at compile time, Bun's mimalloc fork, and the generated files in codegen/.
//
//   node sync.js [<bun commit or tag>] [--no-fetch] [--offline]
//
// With no ref, the one in upstream.json. --no-fetch uses work/bun and work/mimalloc as they are (their HEAD must match
// the ref). --offline passes --offline to cargo. BUN_GIT / MIMALLOC_GIT override the clone URLs.
// Needs git, cargo and Node 22.18+ (Bun's codegen scripts are TypeScript, run with Node's type stripping). Only the
// maintainer runs this; building (build.js) needs none of work/.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const work = join(root, 'work')
const workBun = join(work, 'bun')
const workMimalloc = join(work, 'mimalloc')
const vendorBun = join(root, 'vendor', 'bun')
const vendorMimalloc = join(root, 'vendor', 'mimalloc')
const codegen = join(root, 'codegen')

// Files outside the crate directories that the build needs or that capi/ copies (capi/libs.rs is a copy of
// typescript_libs.rs, so a change there needs a look). Not Bun's Cargo.lock: capi/ is its own workspace with its own
// lock (step 2 seeds it from work/bun's), and vulnerability scanners (OSV, Scorecard) would report the ~300 crates of
// Bun's lock that we never build.
const BUN_FILES = ['Cargo.toml', 'rust-toolchain.toml', 'LICENSE.md', 'package.json',
  'src/runtime/cli/typescript_libs.bin', 'src/runtime/cli/typescript_libs.rs']
const MIMALLOC_PATHS = ['LICENSE', 'include', 'src']
// The parts of Bun that capi/ calls into: a change here means capi/ may need updating.
const WATCHED = ['vendor/bun/src/sema/driver', 'vendor/bun/src/sema/standalone',
  'vendor/bun/src/runtime/cli/typescript_libs.rs']
// lo's lib/untar.js reads ustar names (100 bytes) with the prefix field (155 bytes) but not pax 'x' records, and
// GitHub's tarballs put everything under "ts-sema-<ref>/".
const TARBALL_TOP = `ts-sema-${'x'.repeat(40)}/`

const args = process.argv.slice(2)
const flag = name => args.includes(name)
const upstreamFile = join(root, 'upstream.json')
const previous = existsSync(upstreamFile) ? JSON.parse(readFileSync(upstreamFile, 'utf8')) : null
const ref = args.find(a => !a.startsWith('--')) || previous?.bun.ref
if (!ref) throw new Error('usage: node sync.js <bun commit or tag> [--no-fetch] [--offline]')

const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { encoding: 'utf8', maxBuffer: 256 << 20, ...opts })
const git = (dir, ...argv) => run('git', ['-C', dir, ...argv]).trim()
const log = s => console.log(`sync: ${s}`)

// A shallow, optionally sparse fetch of one commit or tag.
function checkout (dir, url, ref, sparse) {
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(dir, { recursive: true })
    git(dir, 'init', '-q')
    git(dir, 'remote', 'add', 'origin', url)
  }
  if (sparse) git(dir, 'sparse-checkout', 'set', '--cone', ...sparse)
  const remoteRef = /^[0-9a-f]{40}$/.test(ref) ? ref : `refs/tags/${ref}`
  log(`fetching ${remoteRef} into ${relative(root, dir)}`)
  run('git', ['-C', dir, 'fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', remoteRef], { stdio: 'inherit' })
  git(dir, 'checkout', '-q', '--detach', 'FETCH_HEAD')
}

function headMatches (dir, ref) {
  const head = git(dir, 'rev-parse', 'HEAD')
  if (head.startsWith(ref)) return head
  let tagged = ''
  try {
    tagged = run('git', ['-C', dir, 'rev-parse', '-q', '--verify', `refs/tags/${ref}^{commit}`],
      { stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {}
  if (tagged === head) return head
  throw new Error(`${relative(root, dir)} is at ${head}, not ${ref}`)
}

// Tracked files only, so nothing a build or an editor left in work/ gets vendored. Symlinks are refused: lo's untar
// skips them.
function trackedFiles (dir, paths) {
  const out = run('git', ['-C', dir, 'ls-files', '-s', '-z', '--', ...paths]).split('\0').filter(Boolean)
  return out.map(line => {
    const [meta, path] = line.split('\t')
    if (meta.startsWith('120000')) throw new Error(`symlink in vendored set: ${path}`)
    return path
  })
}

function copyFiles (from, to, files) {
  rmSync(to, { recursive: true, force: true })
  for (const file of files) {
    mkdirSync(dirname(join(to, file)), { recursive: true })
    cpSync(join(from, file), join(to, file))
  }
}

function fitsUstar (path) {
  const full = TARBALL_TOP + path
  if (Buffer.byteLength(full) <= 100) return true
  for (let i = full.indexOf('/'); i !== -1; i = full.indexOf('/', i + 1)) {
    if (Buffer.byteLength(full.slice(0, i)) <= 155 && Buffer.byteLength(full.slice(i + 1)) <= 100) return true
  }
  return false
}

// 1. Sources
let commit
if (flag('--no-fetch')) {
  commit = headMatches(workBun, ref)
} else {
  checkout(workBun, process.env.BUN_GIT || 'https://github.com/oven-sh/bun.git', ref, ['src', 'scripts'])
  commit = git(workBun, 'rev-parse', 'HEAD')
}
const mimallocPin = readFileSync(join(workBun, 'scripts/build/deps/mimalloc.ts'), 'utf8')
const mimallocCommit = mimallocPin.match(/MIMALLOC_COMMIT = "([0-9a-f]{40})"/)?.[1]
if (!mimallocCommit) throw new Error('no MIMALLOC_COMMIT in scripts/build/deps/mimalloc.ts')
if (flag('--no-fetch')) headMatches(workMimalloc, mimallocCommit)
else checkout(workMimalloc, process.env.MIMALLOC_GIT || 'https://github.com/oven-sh/mimalloc.git', mimallocCommit)
log(`bun ${commit}, mimalloc ${mimallocCommit}`)

// 2. The crates capi/ depends on: cargo metadata on a copy of capi's manifest pointed at work/bun. Its Cargo.lock
// starts as Bun's, and cargo prunes it to what capi uses, so every version stays Bun's.
const meta = join(work, 'meta')
mkdirSync(meta, { recursive: true })
const manifest = readFileSync(join(root, 'capi/Cargo.toml'), 'utf8')
  .replaceAll('"../vendor/bun/', `"${workBun}/`)
  .replace('path = "lib.rs"', `path = "${join(root, 'capi/lib.rs')}"`)
if (manifest.includes('"../')) throw new Error('capi/Cargo.toml has a relative path outside ../vendor/bun/')
writeFileSync(join(meta, 'Cargo.toml'), manifest)
cpSync(join(workBun, 'Cargo.lock'), join(meta, 'Cargo.lock'))
log('cargo metadata')
const metadata = JSON.parse(run('cargo', ['metadata', '--format-version', '1', ...(flag('--offline') ? ['--offline'] : [])],
  { cwd: meta }))
const crates = metadata.packages
  .map(p => dirname(p.manifest_path))
  .filter(dir => dir.startsWith(workBun + '/'))
  .map(dir => relative(workBun, dir))
  .sort()
log(`${crates.length} Bun crates`)

// 3. vendor/
const bunFiles = trackedFiles(workBun, [...BUN_FILES, ...crates])
const missing = BUN_FILES.filter(f => !bunFiles.includes(f))
if (missing.length) throw new Error(`not in the Bun checkout: ${missing.join(' ')}`)
copyFiles(workBun, vendorBun, bunFiles)
const mimallocFiles = trackedFiles(workMimalloc, MIMALLOC_PATHS)
copyFiles(workMimalloc, vendorMimalloc, mimallocFiles)
cpSync(join(meta, 'Cargo.lock'), join(root, 'capi/Cargo.lock'))
log(`vendored ${bunFiles.length} Bun files, ${mimallocFiles.length} mimalloc files`)

// 4. Our patches, if any: patches/bun/*.patch and patches/mimalloc/*.patch, relative to the upstream repo root.
for (const [name, dir] of [['bun', 'vendor/bun'], ['mimalloc', 'vendor/mimalloc']]) {
  const patchDir = join(root, 'patches', name)
  if (!existsSync(patchDir)) continue
  const patches = readdirSync(patchDir).filter(f => f.endsWith('.patch')).sort()
  for (const patch of patches) {
    log(`applying patches/${name}/${patch}`)
    run('git', ['apply', `--directory=${dir}`, join(patchDir, patch)], { cwd: root, stdio: 'inherit' })
  }
}

// 5. codegen/, with Bun's own generators. BASE_PATH and CODEGEN_PATH are emptied: they hold the generating
// machine's paths and are only read by Bun's debug "load from disk instead of embedding" path.
const scripts = join(workBun, 'scripts/build')
const { generateBuildOptionsRs } = await import(join(scripts, 'buildOptionsRs.ts'))
const { generateJsonByteClass } = await import(join(scripts, 'jsonByteClass.ts'))
const { generateXmlByteClass } = await import(join(scripts, 'xmlByteClass.ts'))
const { NODEJS_VERSION } = await import(join(scripts, 'deps/nodejs-headers.ts'))
const version = JSON.parse(readFileSync(join(workBun, 'package.json'), 'utf8')).version
rmSync(codegen, { recursive: true, force: true })
const cfg = {
  codegenDir: codegen, cwd: workBun, version, revision: commit, nodejsVersion: NODEJS_VERSION,
  assertions: false, canary: false, canaryRevision: '0', fuzzilli: false
}
generateBuildOptionsRs(cfg)
generateJsonByteClass(cfg)
generateXmlByteClass(cfg)
const optionsFile = join(codegen, 'build_options.rs')
writeFileSync(optionsFile, readFileSync(optionsFile, 'utf8')
  .replace(/^(pub const (?:BASE|CODEGEN)_PATH: &\[u8\] = ).*;$/gm, '$1"".as_bytes();'))
log(`codegen for Bun ${version}, Node.js ${NODEJS_VERSION}`)

// 6. Checks
const vendored = [...bunFiles.map(f => `vendor/bun/${f}`), ...mimallocFiles.map(f => `vendor/mimalloc/${f}`)]
const tooLong = vendored.filter(f => !fitsUstar(f))
if (tooLong.length) throw new Error(`paths lo's untar can't extract from a GitHub tarball:\n${tooLong.join('\n')}`)
const typescript = readFileSync(join(vendorBun, 'src/sema/resolve.rs'), 'utf8').match(/VERSION_C: &core::ffi::CStr = c"([^"]+)"/)?.[1]
const toolchain = readFileSync(join(vendorBun, 'rust-toolchain.toml'), 'utf8').match(/channel = "([^"]+)"/)?.[1]

const upstream = {
  bun: { repo: 'oven-sh/bun', ref, commit, version, date: git(workBun, 'log', '-1', '--format=%cI') },
  typescript,
  mimalloc: { repo: 'oven-sh/mimalloc', commit: mimallocCommit },
  rust_toolchain: toolchain,
  nodejs_version: NODEJS_VERSION,
  crates
}
writeFileSync(upstreamFile, JSON.stringify(upstream, null, 2) + '\n')
log(`upstream.json: Bun ${version} (${commit.slice(0, 10)}), TypeScript ${typescript}, Rust ${toolchain}`)

// 7. What changed in the parts capi/ depends on, against the last commit of this repo.
const changed = run('git', ['status', '--porcelain', '--', ...WATCHED], { cwd: root }).trim()
if (!previous) log('first sync: review capi/ against vendor/bun/src/sema/driver and standalone')
else if (changed) log(`changed since the last commit, review capi/ against it (git diff -- ${WATCHED.join(' ')}):\n${changed}`)
else log('no changes in the parts capi/ calls into')
