// Property-based tests (fast-check) of ts-sema's own layer: bindings/napi/index.js (argument validation, lib sets),
// the N-API addon (ts_sema_napi.c: strings, threads, the async path and its mutex) and the capi C ABI (the report
// JSON, the thread cap, lib registration), with their hand-off to Bun's checker. Bun's checker itself is not the
// subject: the programs are small and only there to make the checker report known diagnostics.
//
//   npm ci --prefix test/fuzz
//   TS_SEMA_NODE=dist/ts_sema.node node --test test/fuzz/properties.test.js
//
// Every case runs in a child process (case.js), so an abort in native code fails that case and fast-check shrinks
// it to a minimal input. FUZZ_RUNS sets the runs per property (default 20); FUZZ_SEED replays a failure (fast-check
// prints the seed and path). On Linux the children run with a 4 GB address-space limit, so a runaway allocation fails
// fast instead of pressuring the machine.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import fc from 'fast-check'

const caseJs = fileURLToPath(new URL('./case.js', import.meta.url))
const params = {
  numRuns: Number(process.env.FUZZ_RUNS || 20),
  ...(process.env.FUZZ_SEED ? { seed: Number(process.env.FUZZ_SEED) } : {})
}

// JSON can't carry undefined, NaN, ±Infinity, -0 or BigInt: tag them (case.js decodes).
const TAG = '$ts-sema-fuzz'
function encode (v) {
  if (v === undefined) return { [TAG]: 'undefined' }
  if (typeof v === 'bigint') return { [TAG]: 'bigint', value: String(v) }
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return { [TAG]: 'NaN' }
    if (v === Infinity) return { [TAG]: 'Infinity' }
    if (v === -Infinity) return { [TAG]: '-Infinity' }
    if (Object.is(v, -0)) return { [TAG]: '-0' }
    return v
  }
  if (Array.isArray(v)) return v.map(encode)
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encode(x)]))
  return v
}

// Runs one case in a child; returns { result } / { threw } from case.js, or { crashed } for an abort or signal.
function run (op, args, cwd, timeout = 120000) {
  const dir = mkdtempSync(join(tmpdir(), 'ts-sema-fuzz-case-'))
  const file = join(dir, 'case.json')
  writeFileSync(file, JSON.stringify({ op, args: encode(args) }))
  const argv = process.platform === 'linux'
    ? ['sh', ['-c', 'ulimit -v 4000000; exec "$0" "$@"', process.execPath, caseJs, file]]
    : [process.execPath, [caseJs, file]]
  // maxBuffer: spawnSync's default (1 MB) kills a child whose output is larger, and builtinLib('lib.dom.d.ts') is
  // 2.4 MB of JSON; that showed up as a crash on CI (aarch64 gnu, 2026-10-24).
  const child = spawnSync(argv[0], argv[1], { cwd: cwd || dir, encoding: 'utf8', timeout, maxBuffer: 256 << 20 })
  rmSync(dir, { recursive: true, force: true })
  if (child.status !== 0 || child.signal) {
    return {
      crashed: { status: child.status, signal: child.signal, error: child.error?.code, stderr: (child.stderr || '').slice(-2000) }
    }
  }
  return JSON.parse(child.stdout)
}

// A project in a fresh temporary directory: { 'name.ts': text }, strict, ES2022 only, nothing from node_modules.
function withProject (files, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ts-sema-fuzz-project-'))
  try {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(join(dir, name, '..'), { recursive: true })
      writeFileSync(join(dir, name), text)
    }
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, lib: ['es2022'], types: [] },
      files: Object.keys(files)
    }))
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
const fixtureFiles = { 'index.ts': 'const x: string = 1\n' }

function assertReport (r) {
  assert.equal(typeof r, 'object')
  assert.equal(typeof r.ok, 'boolean')
  for (const k of ['errors', 'files_loaded', 'files_checked']) assert.ok(Number.isSafeInteger(r[k]) && r[k] >= 0, k)
  for (const k of ['load_ms', 'check_ms']) assert.ok(typeof r[k] === 'number' && r[k] >= 0, k)
  assert.equal(typeof r.output, 'string')
  assert.equal(r.ok, r.errors === 0)
}
function assertNoCrash (out) {
  assert.ok(!out.crashed, `crashed: ${JSON.stringify(out.crashed)}`)
}
const errorLines = output => (output.match(/: error TS\d+:/g) || []).length
// Bun's summary line ends with the elapsed time ("... in 58 files [28.53ms]"): drop it to compare outputs.
const untimed = output => output.replace(/ \[\d+(\.\d+)?m?s\]$/gm, '')

// Arbitrary JS values, as a caller might pass anything.
const anyValue = fc.anything({
  maxDepth: 2,
  withBigInt: true,
  withBoxedValues: false,
  withDate: false,
  withMap: false,
  withNullPrototype: false,
  withObjectString: false,
  withSet: false,
  withSparseArray: false,
  withTypedArray: false
})
// Strings that stress escaping: JSON's special characters, controls, separators, astral characters.
const nastyString = fc.string({
  unit: fc.oneof(fc.constantFrom('"', '\\', '\n', '\r', '\t', '\b', '\f', '\u0000', '\u001f', '\u007f', '\u2028',
    '\u2029', '\ufeff', '/', '\'', '`', '$', '{', '}'), fc.string({ unit: 'binary', minLength: 1, maxLength: 1 })),
  maxLength: 40
})
// File names that are fine on Linux and macOS but awkward for escaping: quotes, spaces, '#', Unicode.
const fileName = fc.string({
  unit: fc.constantFrom(...[...'abcXYZ019 _-.\'"#$%&()+,;=@[]^`{}~éñ漢字😀']),
  minLength: 1,
  maxLength: 16
}).filter(n => n.trim() === n && !n.startsWith('.') && !n.startsWith('-'))

test('arguments: any project and options give a report or a TypeError/RangeError, never a crash', () => {
  withProject(fixtureFiles, fixture => {
    const project = fc.oneof(fc.constant(fixture), fc.string({ maxLength: 20 }), anyValue)
    const threads = fc.oneof(fc.integer({ min: -5, max: 64 }), fc.double(), anyValue,
      fc.constantFrom(2 ** 31, 2 ** 32 - 1, 2 ** 32, 2 ** 53))
    const options = fc.oneof(fc.constant(undefined), fc.constant(null), anyValue,
      fc.record({ libDir: fc.oneof(fc.constant(''), fc.string({ maxLength: 12 }), anyValue), threads },
        { requiredKeys: [] }))
    fc.assert(fc.property(fc.constantFrom('checkSync', 'check'), project, options, (op, p, o) => {
      const out = run(op, [p, o])
      assertNoCrash(out)
      if (out.threw) assert.match(out.threw.name, /^(TypeError|RangeError)$/, out.threw.message)
      else assertReport(out.result)
    }), params)
  })
})

test('the C ABI caps the thread count: any uint32 (or a negative number) to the addon itself checks normally', () => {
  withProject(fixtureFiles, fixture => {
    const threads = fc.oneof(fc.integer({ min: 0, max: 2 ** 32 - 1 }), fc.constantFrom(2 ** 32 - 1, 2 ** 31),
      fc.integer({ min: -10, max: -1 }))
    fc.assert(fc.property(threads, t => {
      // 30 s: without the cap, a million threads doesn't abort but takes minutes.
      const out = run('addonCheckSync', [fixture, '', t], undefined, 30000)
      assertNoCrash(out)
      assertReport(out.result)
      assert.equal(out.result.errors, 1, out.result.output)
    }), params)
  })
})

test('report JSON: diagnostics quoting any text, in files with awkward names, parse and count right', () => {
  fc.assert(fc.property(nastyString, fileName, (text, name) => {
    withProject({ [`${name}.ts`]: `const x: ${JSON.stringify(text)} = 1\n` }, dir => {
      const out = run('checkSync', [dir], dir)
      assertNoCrash(out)
      assert.ok(out.result, `threw: ${JSON.stringify(out.threw)}`)
      assertReport(out.result)
      assert.equal(out.result.errors, 1, out.result.output)
      assert.match(out.result.output, /error TS2322:/)
      assert.ok(out.result.output.includes(`${name}.ts`), out.result.output)
    })
  }), params)
})

test('report: errors and ok match the diagnostics in output, across files', () => {
  fc.assert(fc.property(fc.array(fc.nat(5), { minLength: 1, maxLength: 4 }), perFile => {
    const files = Object.fromEntries(perFile.map((n, f) => [`f${f}.ts`,
      `export {}\n${Array.from({ length: n }, (_, i) => `const v${i}: string = ${i}\n`).join('')}`]))
    const total = perFile.reduce((a, b) => a + b, 0)
    withProject(files, dir => {
      const out = run('checkSync', [dir], dir)
      assertNoCrash(out)
      assertReport(out.result)
      assert.equal(out.result.errors, total, out.result.output)
      assert.equal(errorLines(out.result.output), total, out.result.output)
    })
  }), params)
})

test('check and checkSync agree, also with several checks at once', () => {
  fc.assert(fc.property(fc.nat(6), fc.integer({ min: 1, max: 4 }), (n, k) => {
    const files = { 'a.ts': Array.from({ length: n }, (_, i) => `const v${i}: number = '${i}'\n`).join('') || 'export {}\n' }
    withProject(files, dir => {
      const out = run('checkBoth', [dir, k], dir)
      assertNoCrash(out)
      const { sync, all } = out.result
      assertReport(sync)
      assert.equal(all.length, k)
      for (const r of all) {
        assertReport(r)
        for (const key of ['ok', 'errors', 'files_loaded', 'files_checked']) assert.equal(r[key], sync[key], key)
        assert.equal(untimed(r.output), untimed(sync.output))
      }
    })
  }), params)
})

test('builtinLib: any name gives the text, null, or a TypeError; the name list is consistent', () => {
  const names = run('builtinLibNames', [])
  assertNoCrash(names)
  const list = names.result
  assert.ok(Array.isArray(list) && list.length > 50, 'names')
  assert.equal(new Set(list).size, list.length, 'unique names')
  for (const n of list) assert.match(n, /^lib(\.[\w.-]+)?\.d\.ts$/i)
  fc.assert(fc.property(fc.oneof(fc.constantFrom(...list), fc.string({ maxLength: 20 }), anyValue), name => {
    const out = run('builtinLib', [name])
    assertNoCrash(out)
    if (out.threw) assert.equal(out.threw.name, 'TypeError', out.threw.message)
    else assert.ok(out.result === null || typeof out.result === 'string')
    if (typeof name === 'string' && list.includes(name)) assert.equal(typeof out.result, 'string', name)
  }), params)
})

test('setLibs: any lib map registers or throws; a second call always throws once one worked; checks still run', () => {
  withProject(fixtureFiles, fixture => {
    const libs = fc.oneof(fc.dictionary(fc.string({ maxLength: 12 }), nastyString, { maxKeys: 5 }), anyValue,
      fc.constant({ 'lib.es5.d.ts': 'interface Array<T> {}\n' }))
    fc.assert(fc.property(libs, map => {
      const out = run('setLibs', [map, fixture])
      assertNoCrash(out)
      const { first, second, report } = out.result
      if (first !== 'ok') assert.match(first.name, /^(TypeError|Error)$/, first.message)
      if (first === 'ok') assert.match(second.message, /already set/, JSON.stringify(second))
      assertReport(report)
    }), params)
  })
})
