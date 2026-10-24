// Bun's TypeScript checker for Node, Bun and Deno, through the ts-sema N-API addon (ts_sema_napi.c).
//
//   import { check, checkSync } from '@beardsoft/ts-sema'
//   const report = await check('path/to/tsconfig.json')            // on a worker thread
//   const report = checkSync('path/to/project', { threads: 2 })
//   // { ok, errors, files_loaded, files_checked, load_ms, check_ms, output }
//
// The addon comes from, in order: TS_SEMA_NODE (a path), ./ts_sema.node next to this file (a local build), or the
// package for this platform, @beardsoft/ts-sema-<platform>-<arch>[-musl].
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import process from 'node:process'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))

function isMusl () {
  if (process.platform !== 'linux') return false
  const report = process.report?.getReport?.()
  return !report?.header?.glibcVersionRuntime
}

function platformPackage () {
  const arch = { x64: 'x64', arm64: 'arm64' }[process.arch]
  const os = { linux: 'linux', darwin: 'darwin' }[process.platform]
  if (!arch || !os) throw new Error(`ts-sema: no build for ${process.platform}-${process.arch}`)
  return `@beardsoft/ts-sema-${os}-${arch}${isMusl() ? '-musl' : ''}`
}

function load () {
  if (process.env.TS_SEMA_NODE) return require(process.env.TS_SEMA_NODE)
  const local = join(here, 'ts_sema.node')
  if (existsSync(local)) return require(local)
  return require(platformPackage())
}

const addon = load()

function args (project, options = {}) {
  if (typeof project !== 'string') throw new TypeError('ts-sema: project must be a string')
  return [project, options.libDir || '', options.threads >>> 0]
}

/** Checks a project on a worker thread. */
export async function check (project, options) {
  return JSON.parse(await addon.check(...args(project, options)))
}

/** Checks a project on the calling thread. */
export function checkSync (project, options) {
  return JSON.parse(addon.checkSync(...args(project, options)))
}
