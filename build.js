// Builds the C-ABI static library from capi/ and vendor/, into dist/:
//   libts_sema.a   the library (with mimalloc.o added for the mimalloc variant)
//   ts_sema.h      its header
//   build.json     what was built: variant, target, RUSTFLAGS, the Bun commit, rustc's version, link flags
//   libts_sema.so  with --shared (libts_sema.dylib on macOS): exports only the C ABI, for dlopen / any FFI
//   ts_sema.node   with --napi: the N-API addon (bindings/napi) for Node, Bun and Deno
//
//   node build.js [--variant mimalloc|plain] [--target <triple>] [--toolchain <rustup toolchain>] [--jobs <n>]
//                 [--nice <n>] [--cpus <taskset list>] [--mem-floor <MB>] [--native] [--lto off|thin|fat]
//                 [--pgo-gen <dir>] [--pgo-use <file.profdata>] [--no-builtin-libs] [--shared] [--napi] [--test]
//
// --test links test/check.c against the result with build.json's link flags and runs it on test/fixture.
// Needs a nightly Rust toolchain with cargo, and a C compiler (CC, default cc; CFLAGS are added) and ar (AR, default
// ar) for mimalloc, LDFLAGS for --shared and --test.
// rustc peaks at about 3 GB for the bun_sema crate. --jobs 1 keeps it to one rustc. --nice, --cpus (taskset) and
// --mem-floor (Linux: kill the build when MemAvailable drops below it, or on heavy major-fault thrash) are for small
// machines. Each variant/flag set is a full rebuild in target/.
import { execFileSync, spawn } from 'node:child_process'
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const target = join(root, 'target')
const dist = join(root, 'dist')
const work = join(target, 'ts-sema')

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  return i === -1 ? fallback : args[i + 1]
}
const flag = name => args.includes(name)
const variant = opt('--variant', 'mimalloc')
if (!['mimalloc', 'plain'].includes(variant)) throw new Error(`unknown --variant ${variant}`)
const jobs = opt('--jobs')
const niceness = opt('--nice')
const cpus = opt('--cpus')
const memFloor = Number(opt('--mem-floor', 0))
const pgoGen = opt('--pgo-gen')
const pgoUse = opt('--pgo-use')
const lto = opt('--lto', 'off')
// The C ABI (capi/include/ts_sema.h): the only symbols the shared library and the addon export.
const SYMBOLS = ['bun_sema_check', 'bun_sema_free', 'bun_sema_set_libs', 'bun_sema_builtin_lib']
const CC = process.env.CC || 'cc'
const AR = process.env.AR || 'ar'
// Extra C flags for mimalloc, e.g. "-arch x86_64" when building for Intel macOS on Apple silicon.
const CFLAGS = (process.env.CFLAGS || '').split(' ').filter(Boolean)
// Extra linker flags for --shared and --test, e.g. "-L/opt/homebrew/lib" for libzstd.
const LDFLAGS = (process.env.LDFLAGS || '').split(' ').filter(Boolean)

const env = { ...process.env }
if (opt('--toolchain')) env.RUSTUP_TOOLCHAIN = opt('--toolchain')
const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { encoding: 'utf8', env, ...opts })
const log = s => console.log(`build: ${s}`)
// The limits apply to every compiler this script starts.
const limited = (cmd, argv) => {
  let pre = []
  if (cpus) pre = ['taskset', '-c', cpus]
  if (niceness) pre = ['nice', '-n', niceness, ...pre]
  return pre.length ? [pre[0], [...pre.slice(1), cmd, ...argv]] : [cmd, argv]
}

const rustcInfo = run('rustc', ['-vV'])
const triple = opt('--target', rustcInfo.match(/^host: (.+)$/m)[1])
const musl = triple.includes('musl')
log(`${variant} for ${triple}, ${rustcInfo.split('\n')[0]}`)

// Newer nightlies split `allocator_api`, and Bun (pinned to an older nightly) only enables the old feature. A rustc
// that knows `allocator_ext` gets it enabled in every crate; one that doesn't never needed it.
// The probe's output goes to a scratch file, never /dev/null: rustc writes a temporary file and renames it over its
// output path, so as root `-o /dev/null` replaces the device with a regular file (found 2026-10-24).
function knowsFeature (name) {
  mkdirSync(work, { recursive: true })
  const out = join(work, 'probe.rmeta')
  try {
    run('rustc', [`-Zcrate-attr=feature(${name})`, '--crate-type=lib', '--emit=metadata', '-o', out, '-'],
      { input: '', stdio: ['pipe', 'ignore', 'ignore'] })
    return true
  } catch {
    return false
  } finally {
    rmSync(out, { force: true })
  }
}
// --print=native-static-libs: rustc lists the system libraries the staticlib needs (into the cargo log), for build.json.
const rustflags = ['--cap-lints=warn', '--print=native-static-libs']
// --no-builtin-libs: no TypeScript lib files in the library; embedders supply them (bun_sema_set_libs or a directory).
if (flag('--no-builtin-libs')) rustflags.push('--cfg', 'ts_sema_no_builtin_libs')
if (knowsFeature('allocator_ext')) rustflags.push('-Zcrate-attr=feature(allocator_ext)')
if (variant === 'mimalloc') rustflags.push('--cfg', 'bun_sema_mimalloc')
if (flag('--native')) rustflags.push('-C', 'target-cpu=native')
if (pgoGen) rustflags.push(`-Cprofile-generate=${resolve(pgoGen)}`)
if (pgoUse) rustflags.push(`-Cprofile-use=${resolve(pgoUse)}`)

mkdirSync(work, { recursive: true })
const extraObjects = []

// Bun's mimalloc fork, compiled as C with Bun's defines (Bun's scripts/build/deps/mimalloc.ts) but without the malloc
// override: the embedder keeps its own allocator, and only this library uses mimalloc. Bun compiles it as C++ for its
// C++ code, which would pull in libstdc++ (new handler, bad_alloc).
if (variant === 'mimalloc') {
  const object = join(work, 'mimalloc.o')
  const defines = ['MI_STATIC_LIB', 'MI_SKIP_COLLECT_ON_EXIT=1', 'MI_NO_PROCESS_DETACH=1', 'MI_FREE_USE_PAGEMAP=1',
    'MI_BUILD_RELEASE', 'MI_CMAKE_BUILD_TYPE=release']
  // musl: local-dynamic TLS, as Bun does.
  if (musl) defines.push('MI_LIBC_MUSL=1')
  const ccArgs = ['-x', 'c', '-O3', '-fPIC', '-fvisibility=hidden', ...(musl ? ['-ftls-model=local-dynamic'] : []),
    '-Wno-deprecated', ...CFLAGS, ...defines.map(d => `-D${d}`), `-I${join(root, 'vendor/mimalloc/include')}`,
    '-c', join(root, 'vendor/mimalloc/src/static.c'), '-o', object]
  run(...limited(CC, ccArgs), { stdio: 'inherit' })
  extraObjects.push(object)
  log('mimalloc.o built')
}

// cargo, logged to target/ts-sema/cargo.log, with a status line every 20 s.
const cargoArgs = ['build', '--release', '--locked', '-p', 'ts_sema', '--manifest-path', join(root, 'capi/Cargo.toml'),
  '--target-dir', target, '--target', triple, ...(jobs ? ['-j', jobs] : [])]
const cargoEnv = {
  ...env,
  RUSTFLAGS: rustflags.join(' '),
  BUN_CODEGEN_DIR: join(root, 'codegen'),
  CARGO_PROFILE_RELEASE_DEBUG: 'false',
  CARGO_PROFILE_RELEASE_LTO: lto
}
log(`RUSTFLAGS=${cargoEnv.RUSTFLAGS} LTO=${lto}`)
const logFile = join(work, 'cargo.log')
const status = await new Promise(done => {
  const [cmd, argv] = limited('cargo', cargoArgs)
  const child = spawn(cmd, argv, { env: cargoEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  const out = createWriteStream(logFile)
  let last = ''
  const onData = chunk => {
    out.write(chunk)
    const compiling = String(chunk).match(/Compiling (\S+)/g)
    if (compiling) last = compiling.at(-1).slice(10)
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)
  const started = Date.now()
  const meminfo = () => {
    try {
      const avail = readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+)/)
      const faults = readFileSync('/proc/vmstat', 'utf8').match(/pgmajfault (\d+)/)
      return { avail: avail ? Number(avail[1]) >> 10 : null, faults: faults ? Number(faults[1]) : null }
    } catch {
      return { avail: null, faults: null }
    }
  }
  let prevFaults = meminfo().faults
  const timer = setInterval(() => {
    const { avail, faults } = meminfo()
    const delta = faults === null || prevFaults === null ? 0 : faults - prevFaults
    prevFaults = faults
    const secs = Math.round((Date.now() - started) / 1000)
    log(`${secs}s ${last}${avail === null ? '' : `, ${avail} MB available, +${delta} major faults`}`)
    if (memFloor > 0 && avail !== null && (avail < memFloor || delta > 50000)) {
      log(`watchdog: stopping cargo (${avail} MB available, +${delta} major faults)`)
      process.kill(-child.pid, 'SIGKILL')
    }
  }, 20000)
  child.on('close', code => {
    clearInterval(timer)
    out.end()
    done(code)
  })
})
if (status !== 0) {
  const tail = readFileSync(logFile, 'utf8').split('\n').slice(-30).join('\n')
  console.error(tail)
  throw new Error(`cargo failed (${status}), full log: ${logFile}`)
}

// dist/
rmSync(dist, { recursive: true, force: true })
mkdirSync(dist)
const archive = join(dist, 'libts_sema.a')
copyFileSync(join(target, triple, 'release', 'libts_sema.a'), archive)
if (extraObjects.length) run(AR, ['rs', archive, ...extraObjects])
copyFileSync(join(root, 'capi/include/ts_sema.h'), join(dist, 'ts_sema.h'))
// What an embedder links besides the archive: dead-code elimination, which is required (the archive refers to ~760
// symbols of Bun's C/C++ side, uWebSockets, BoringSSL, ..., from code the checker never reaches; rustc itself always
// links with it), libzstd, which Bun's zstd crate binds, and rustc's native-static-libs.
const darwin = triple.includes('apple')
const nativeLibs = readFileSync(logFile, 'utf8').match(/native-static-libs: (.*)$/m)?.[1].trim().split(/\s+/) || []
const link = [darwin ? '-Wl,-dead_strip' : '-Wl,--gc-sections', '-lzstd', ...nativeLibs.filter(l => l !== '-lzstd')]

// --shared: a shared library from the whole archive (mimalloc included) that exports only the C ABI, for dlopen and
// any FFI. libts_sema.so on Linux, libts_sema.dylib (install name @rpath/libts_sema.dylib) on macOS.
const sharedName = darwin ? 'libts_sema.dylib' : 'libts_sema.so'
const shared = join(dist, sharedName)
if (flag('--shared') && darwin) {
  const list = join(work, 'ts_sema.exports')
  writeFileSync(list, SYMBOLS.map(name => `_${name}\n`).join(''))
  run(...limited(CC, [...CFLAGS, '-dynamiclib', '-o', shared, '-Wl,-all_load', archive,
    `-Wl,-exported_symbols_list,${list}`, '-Wl,-install_name,@rpath/libts_sema.dylib', ...LDFLAGS, ...link]),
  { stdio: 'inherit' })
  log(`${sharedName} linked`)
} else if (flag('--shared')) {
  const map = join(work, 'ts_sema.map')
  const exported = [...SYMBOLS]
  const extra = []
  if (pgoGen) {
    // A Rust staticlib doesn't carry the LLVM profiler runtime (rustc adds it only to final binaries): link the
    // sysroot's profiler_builtins rlib, and export __llvm_profile_write_file so a trainer can flush the profile.
    const sysroot = run('rustc', ['--print', 'sysroot']).trim()
    const libdir = join(sysroot, 'lib/rustlib', triple, 'lib')
    const rlib = run('ls', [libdir]).split('\n').find(f => f.startsWith('libprofiler_builtins-'))
    extra.push('-Wl,-u,__llvm_profile_runtime', '-Wl,-u,__llvm_profile_write_file', join(libdir, rlib))
    exported.push('__llvm_profile_write_file')
  }
  writeFileSync(map, `{ global: ${exported.join('; ')}; local: *; };\n`)
  // Instrumentation keeps every function alive, including Bun code that refers to Bun's runtime: no --no-undefined.
  run(...limited(CC, [...CFLAGS, '-shared', '-o', shared, '-Wl,-soname,libts_sema.so', '-Wl,--whole-archive',
    archive, ...extra, '-Wl,--no-whole-archive', `-Wl,--version-script=${map}`,
    ...(pgoGen ? [] : ['-Wl,--no-undefined']), ...LDFLAGS, ...link]), { stdio: 'inherit' })
  log(`${sharedName} linked`)
}

// --napi: bindings/napi/ts_sema_napi.c as dist/ts_sema.node, an N-API addon for Node, Bun and Deno, with the archive
// linked in. No node-gyp: plain cc against vendor/node-api-headers. The napi_* functions stay undefined and resolve
// from the host process at load time (macOS: -undefined dynamic_lookup). libzstd (and on musl
// LLVM's libunwind) go in statically when the .a can be found (ZSTD_STATIC / UNWIND_STATIC, the compiler's search
// path, or LDFLAGS' -L directories), so the addon needs nothing installed; else the -l flag, with a warning.
function findStatic (name, env) {
  if (process.env[env]) return process.env[env]
  try {
    const found = run(CC, [...CFLAGS, `-print-file-name=${name}`]).trim()
    if (found.startsWith('/') && existsSync(found)) return found
  } catch {}
  for (const flag of LDFLAGS) {
    if (flag.startsWith('-L') && existsSync(join(flag.slice(2), name))) return join(flag.slice(2), name)
  }
  return null
}
const addon = join(dist, 'ts_sema.node')
if (flag('--napi')) {
  const statics = { '-lzstd': findStatic('libzstd.a', 'ZSTD_STATIC'), '-lunwind': findStatic('libunwind.a', 'UNWIND_STATIC') }
  for (const [lib, path] of Object.entries(statics)) {
    if (!path && link.includes(lib)) log(`warning: no static ${lib.slice(2)} found, ts_sema.node will need the system's`)
  }
  const napiLink = link.map(l => statics[l] || l)
  // The N-API entry points, and the C ABI: the addon doubles as the shared library for FFI (its napi_* imports are weak).
  const exported = ['napi_register_module_v1', 'node_api_module_get_api_version_v1', ...SYMBOLS]
  const sources = [`-I${join(root, 'vendor/node-api-headers/include')}`, `-I${join(root, 'capi/include')}`,
    join(root, 'bindings/napi/ts_sema_napi.c'), archive]
  if (darwin) {
    const list = join(work, 'napi.exports')
    writeFileSync(list, exported.map(e => `_${e}`).join('\n') + '\n')
    run(...limited(CC, [...CFLAGS, '-O2', '-bundle', '-undefined', 'dynamic_lookup', '-o', addon, ...sources,
      `-Wl,-exported_symbols_list,${list}`, ...LDFLAGS, ...napiLink]), { stdio: 'inherit' })
  } else {
    const map = join(work, 'napi.map')
    writeFileSync(map, `{ global: ${exported.join('; ')}; local: *; };\n`)
    run(...limited(CC, [...CFLAGS, '-O2', '-fPIC', '-shared', '-o', addon, ...sources, `-Wl,--version-script=${map}`,
      ...LDFLAGS, ...napiLink]), { stdio: 'inherit' })
  }
  log(`ts_sema.node linked (static: ${Object.values(statics).filter(Boolean).join(' ') || 'none'})`)
}

const upstream = JSON.parse(readFileSync(join(root, 'upstream.json'), 'utf8'))
const info = {
  variant, target: triple, rustc: rustcInfo.split('\n')[0], rustflags: cargoEnv.RUSTFLAGS, lto,
  bun: upstream.bun.commit, bun_version: upstream.bun.version, typescript: upstream.typescript,
  builtin_libs: !flag('--no-builtin-libs'), symbols: SYMBOLS, link
}
writeFileSync(join(dist, 'build.json'), JSON.stringify(info, null, 2) + '\n')

// --test: link test/check.c against the archive the way an embedder would, and check test/fixture (one TS2322). With
// --shared, also a build of it that loads the shared library with dlopen + dlsym, the way an FFI does.
if (flag('--test')) {
  const exe = join(work, 'check')
  run(...limited(CC, [...CFLAGS, `-I${dist}`, join(root, 'test/check.c'), archive, ...LDFLAGS, ...link, '-o', exe]),
    { stdio: 'inherit' })
  run(exe, [join(root, 'test/fixture')], { stdio: 'inherit' })
  log('test passed (static)')
  if (existsSync(shared)) {
    const dl = join(work, 'check-dl')
    run(CC, [...CFLAGS, '-DTS_SEMA_DLOPEN', `-I${dist}`, join(root, 'test/check.c'), ...(darwin ? [] : ['-ldl']), '-o', dl],
      { stdio: 'inherit' })
    run(dl, [join(root, 'test/fixture'), shared], { stdio: 'inherit' })
    log(`test passed (${sharedName} through dlopen)`)
  }
  if (existsSync(addon)) {
    run(process.execPath, [join(root, 'bindings/napi/test.mjs'), addon], { stdio: 'inherit' })
    log('test passed (ts_sema.node)')
  }
}
log(`done: ${archive}${existsSync(shared) ? ` and ${sharedName}` : ''}`)
