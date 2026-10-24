// node bindings/napi/test.mjs [addon.node]: checks test/fixture (one TS2322) with checkSync and check, then, in child
// processes (one lib set per process), with registered lib sets: es2022 via builtinLibSet (same result as the
// built-in set) and es5 only (the fixture's "lib": ["es2022"] is then missing).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const [addonPath, mode, ...libNames] = process.argv.slice(2)
if (addonPath) process.env.TS_SEMA_NODE = addonPath
const ts = await import('./index.js')
const fixture = fileURLToPath(new URL('../../test/fixture', import.meta.url))

if (mode === '--libs') {
  const set = ts.builtinLibSet(libNames)
  ts.setLibs(set)
  const report = ts.checkSync(fixture)
  console.log(JSON.stringify({ files: Object.keys(set).length, errors: report.errors, output: report.output }))
  process.exit(0)
}

const sync = ts.checkSync(fixture)
assert.equal(sync.errors, 1, sync.output)
assert.match(sync.output, /TS2322/)
const async = await ts.check(fixture, { threads: 1 })
assert.equal(async.errors, 1, async.output)
assert.match(async.output, /TS2322/)
assert.throws(() => ts.setLibs({ 'lib.es5.d.ts': '' }), /already set, or a check already ran/)

const names = ts.builtinLibNames()
assert.ok(names.length > 100 && names.includes('lib.es2022.d.ts'), `built-in names: ${names.length}`)
assert.match(ts.builtinLib('es5'), /interface Array<T>/)
assert.equal(ts.builtinLib('no-such-lib'), null)

const child = (...libs) => JSON.parse(execFileSync(process.execPath,
  [fileURLToPath(import.meta.url), ts.libraryPath, '--libs', ...libs], { encoding: 'utf8' }))
const es2022 = child('es2022')
assert.equal(es2022.errors, 1, es2022.output)
assert.match(es2022.output, /TS2322/)
const es5 = child('es5')
// Only es5 registered: TypeScript reports the fixture's "es2022" lib as missing.
assert.ok(es5.errors >= 1, es5.output)
assert.match(es5.output, /es2022/)

console.log(`napi: ok (sync ${sync.check_ms} ms, async ${async.check_ms} ms check; ${names.length} built-in libs; ` +
  `es2022 set: ${es2022.files} files, 1 error; es5 set: ${es5.errors} errors)`)
