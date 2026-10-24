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

Built by `node build.js --napi` (with `--test` it also runs `napi/test.mjs`):
plain `cc` against the vendored `vendor/node-api-headers`, no node-gyp. Types
in `napi/index.d.ts`. `index.js` loads the addon from `TS_SEMA_NODE`, a
`ts_sema.node` next to it, or the platform package
`@beardsoft/ts-sema-<platform>-<arch>[-musl]` (npm publishing: to do). Checks
run one at a time within a process. Not on Windows yet.

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
