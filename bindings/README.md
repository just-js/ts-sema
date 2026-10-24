# bindings

Ways to call ts-sema from other languages and runtimes, all over the same C ABI
(`capi/include/ts_sema.h`).

## napi/

An N-API addon for **Node and Bun** (Deno loads N-API addons too, untested), `ts_sema.node`, with the static
library linked in (and libzstd, plus LLVM's libunwind on musl, when static
versions are available), so it needs nothing else installed.

```js
import { check, checkSync } from './bindings/napi/index.js'
const report = await check('path/to/tsconfig.json')      // on a worker thread
const again = checkSync('path/to/project', { threads: 2 })
// { ok, errors, files_loaded, files_checked, load_ms, check_ms, output }
```

Lib files: `setLibs({ 'lib.es2022.d.ts': text, ... })` (once, before the first
check; copied once and kept), `builtinLibSet(['es2022', 'dom'])` (built-in files
by tsconfig `lib` name plus everything they reference, ready for `setLibs`),
`builtinLib(name)`, `builtinLibNames()`. So `setLibs(builtinLibSet(['es2022']))`
limits a process to ES2022 with no DOM.

Built by `node build.js --napi` (with `--test` it also runs `napi/test.mjs`):
plain `cc` against the vendored `vendor/node-api-headers`, no node-gyp. Types
in `napi/index.d.ts`. `index.js` loads the addon from `TS_SEMA_NODE`, a
`ts_sema.node` next to it, or the platform package
`@beardsoft/ts-sema-<platform>-<arch>[-musl]` (npm publishing: to do). Checks
run one at a time within a process. Not on Windows yet.

The same `ts_sema.node` is also a plain shared library: it exports
`bun_sema_check`/`bun_sema_free`, and its N-API references are weak, so it
loads in any process (Python ctypes and C with `RTLD_NOW` were tested), not
only in Node or Bun. `index.js` exports its path as `libraryPath`, so an FFI
user can do `dlopen(libraryPath, ...)` with the examples below.

## ffi/

Examples of loading the shared library (`node build.js --shared`:
`libts_sema.so`, or `libts_sema.dylib` on macOS) through each runtime's own FFI:

| file | runtime | run |
| --- | --- | --- |
| `node.mjs` | Node 26.1+ `node:ffi` (experimental) | `node ffi/node.mjs dist/libts_sema.so test/fixture` |
| `bun.mjs` | Bun `bun:ffi` | `bun ffi/bun.mjs dist/libts_sema.so test/fixture` |
| `deno.ts` | Deno `Deno.dlopen` (untested) | `deno run --allow-ffi ffi/deno.ts dist/libts_sema.so test/fixture` |

The report string is freed with `bun_sema_free`, never `free`.

lo's binding lives in lo itself, `lib/sema` in just-js/lo.
