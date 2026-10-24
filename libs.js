// Writes a set of built-in TypeScript lib files, for bun_sema_set_libs / setLibs or a lib directory: the files for the
// given tsconfig "lib" names (es2022, dom, ...) plus every file they reference (/// <reference lib="..." />), taken
// from the library's built-in set, so they match the checker's TypeScript version.
//
//   node libs.js <out dir> <lib> [lib ...]      e.g. node libs.js my-libs es2022 dom
//   node libs.js --list                          the built-in file names
//
// Uses the N-API addon: TS_SEMA_NODE, else dist/ts_sema.node (node build.js --napi).
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const root = dirname(fileURLToPath(import.meta.url))
if (!process.env.TS_SEMA_NODE && existsSync(join(root, 'dist/ts_sema.node'))) {
  process.env.TS_SEMA_NODE = join(root, 'dist/ts_sema.node')
}
const { builtinLibNames, builtinLibSet } = await import('./bindings/napi/index.js')

const [out, ...libs] = process.argv.slice(2)
if (out === '--list') {
  console.log(builtinLibNames().join('\n'))
} else if (!out || !libs.length) {
  console.error('usage: node libs.js <out dir> <lib> [lib ...] | node libs.js --list')
  process.exit(2)
} else {
  const set = builtinLibSet(libs)
  mkdirSync(out, { recursive: true })
  for (const [name, text] of Object.entries(set)) writeFileSync(join(out, name), text)
  console.log(`${Object.keys(set).length} files in ${out}: ${Object.keys(set).sort().join(' ')}`)
}
