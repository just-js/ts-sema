// node bindings/napi/test.mjs [addon.node]: checks test/fixture (one TS2322) with checkSync and check.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

if (process.argv[2]) process.env.TS_SEMA_NODE = process.argv[2]
const { check, checkSync } = await import('./index.js')
const fixture = fileURLToPath(new URL('../../test/fixture', import.meta.url))

const sync = checkSync(fixture)
assert.equal(sync.errors, 1, sync.output)
assert.match(sync.output, /TS2322/)
const async = await check(fixture, { threads: 1 })
assert.equal(async.errors, 1, async.output)
assert.match(async.output, /TS2322/)
console.log(`napi: ok (sync ${sync.check_ms} ms, async ${async.check_ms} ms check)`)
