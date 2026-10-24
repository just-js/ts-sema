// One property-test case, in its own process (properties.test.js runs it): a crash in ts-sema (an abort, a signal)
// then fails that case instead of the whole test run, and fast-check can shrink it.
//
//   node case.js <case.json>      prints {"result": ...} or {"threw": {"name", "message"}} on stdout
//
// A case is {"op", "args"}; args are encoded (encode() in properties.test.js) so that undefined, NaN, ±Infinity, -0
// and BigInt survive JSON. The addon comes from TS_SEMA_NODE, as for index.js.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import process from 'node:process'

const TAG = '$ts-sema-fuzz'
function decode (v) {
  if (Array.isArray(v)) return v.map(decode)
  if (v === null || typeof v !== 'object') return v
  if (TAG in v) {
    const t = v[TAG]
    if (t === 'undefined') return undefined
    if (t === 'NaN') return NaN
    if (t === 'Infinity') return Infinity
    if (t === '-Infinity') return -Infinity
    if (t === '-0') return -0
    if (t === 'bigint') return BigInt(v.value)
  }
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decode(x)]))
}

const { op, args } = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const a = decode(args)
const ts = await import(new URL('../../bindings/napi/index.js', import.meta.url))
const addon = createRequire(import.meta.url)(ts.libraryPath)

const ops = {
  checkSync: () => ts.checkSync(a[0], a[1]),
  check: () => ts.check(a[0], a[1]),
  // The same checks started at once: the addon runs them one at a time (its mutex); all must agree with checkSync.
  checkBoth: async () => {
    const sync = ts.checkSync(a[0])
    const all = await Promise.all(Array.from({ length: a[1] }, () => ts.check(a[0])))
    return { sync, all }
  },
  // The addon itself, below index.js's validation: the C ABI caps the thread count.
  addonCheckSync: () => JSON.parse(addon.checkSync(a[0], a[1], a[2])),
  builtinLib: () => ts.builtinLib(a[0]),
  builtinLibNames: () => ts.builtinLibNames(),
  // setLibs once per process: then a second call, then a check with whatever got registered.
  setLibs: () => {
    let first
    try {
      ts.setLibs(a[0])
      first = 'ok'
    } catch (e) {
      first = { name: e.name, message: e.message }
    }
    let second
    try {
      ts.setLibs({ 'lib.es5.d.ts': '' })
      second = 'ok'
    } catch (e) {
      second = { name: e.name, message: e.message }
    }
    return { first, second, report: ts.checkSync(a[1]) }
  }
}

try {
  const result = await ops[op]()
  process.stdout.write(JSON.stringify({ result: result === undefined ? null : result }))
} catch (e) {
  process.stdout.write(JSON.stringify({ threw: { name: e?.name, message: e?.message } }))
}
