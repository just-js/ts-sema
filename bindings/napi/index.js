// Bun's TypeScript checker for Node, Bun and Deno, through the ts-sema N-API addon (ts_sema_napi.c).
//
//   import { check, checkSync } from '@beardsoft/ts-sema'
//   const report = await check('path/to/tsconfig.json')            // on a worker thread
//   const report = checkSync('path/to/project', { threads: 2 })
//   // { ok, errors, files_loaded, files_checked, load_ms, check_ms, output }
//   setLibs(builtinLibSet(['es2022']))   // before the first check: only ES2022 (and what it references), no DOM
//
// The addon comes from, in order: TS_SEMA_NODE (a path), ./ts_sema.node next to this file (a local build), or the
// package for this platform, @beardsoft/ts-sema-<platform>-<arch>[-musl]. libraryPath is that file, which FFI can load
// too (bindings/ffi).
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

function locate () {
  if (process.env.TS_SEMA_NODE) return process.env.TS_SEMA_NODE
  const local = join(here, 'ts_sema.node')
  if (existsSync(local)) return local
  return require.resolve(platformPackage())
}

/** The path of the addon. It is also a plain shared library exporting bun_sema_check/bun_sema_free, for any FFI. */
export const libraryPath = locate()
const addon = require(libraryPath)

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

/**
 * Replaces the built-in TypeScript lib files for the rest of the process: `{ 'lib.es2022.d.ts': text, ... }`. Only
 * these then exist for the checker. Call it once, before the first check. The set must include what its files
 * reference (`/// <reference lib="..." />`); builtinLibSet() makes such a set.
 */
export function setLibs (libs) {
  const names = Object.keys(libs)
  addon.setLibs(names, names.map(name => libs[name]))
}

/** The names of the built-in lib files (`lib.es5.d.ts`, ...). */
export function builtinLibNames () {
  return JSON.parse(addon.builtinLib())
}

/** A built-in lib file's text (`'lib.es2022.d.ts'` or `'es2022'`), or null. */
export function builtinLib (name) {
  return addon.builtinLib(libFile(name))
}

function libFile (name) {
  return name.startsWith('lib.') ? name : `lib.${name.toLowerCase()}.d.ts`
}

/**
 * Built-in lib files by tsconfig "lib" name (`'es2022'`, `'dom'`, ...) or file name, with every file they reference
 * (`/// <reference lib="..." />`), as `{ name: text }` for setLibs().
 */
export function builtinLibSet (names) {
  const set = {}
  const todo = names.map(libFile)
  while (todo.length) {
    const name = todo.pop()
    if (set[name] !== undefined) continue
    const text = addon.builtinLib(name)
    if (text === null) throw new Error(`ts-sema: no built-in lib ${name}`)
    set[name] = text
    for (const match of text.matchAll(/^\/\/\/\s*<reference\s+lib="([^"]+)"\s*\/>/gm)) todo.push(libFile(match[1]))
  }
  return set
}
