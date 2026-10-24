# @beardsoft/ts-sema

[![npm version](https://img.shields.io/npm/v/@beardsoft/ts-sema)](https://www.npmjs.com/package/@beardsoft/ts-sema)
[![CI](https://github.com/just-js/ts-sema/actions/workflows/push.yml/badge.svg)](https://github.com/just-js/ts-sema/actions/workflows/push.yml)
[![Socket Badge](https://badge.socket.dev/npm/package/@beardsoft/ts-sema/0.0.1)](https://badge.socket.dev/npm/package/@beardsoft/ts-sema/0.0.1)
[![types](https://img.shields.io/npm/types/@beardsoft/ts-sema)](https://www.npmjs.com/package/@beardsoft/ts-sema)
[![node](https://img.shields.io/node/v/@beardsoft/ts-sema)](https://www.npmjs.com/package/@beardsoft/ts-sema)
[![license](https://img.shields.io/npm/l/@beardsoft/ts-sema)](https://github.com/just-js/ts-sema/blob/main/LICENSE)

A fast TypeScript type checker for Node and Bun: Bun's checker (the engine of `bun check`, a native port of
Microsoft's typescript-go) as a native addon. Check a project from JavaScript, in-process, without `tsc`, without a
TypeScript install, and without node-gyp or any install script: npm downloads one prebuilt binary for your platform.

- **TypeScript 7.0.2** semantics and diagnostics, with all of its `lib.*.d.ts` files built in
- **Async or sync**: `check()` runs on a worker thread; `checkSync()` on the calling one
- **Your own lib files**: limit a process to the standards you support (say ES2022 without DOM), from memory
- **Also a C library**: the same binary works with `node:ffi`, `bun:ffi`, Python ctypes or C (`bun_sema_*`)
- **Verifiable**: every release asset has a signed GitHub build attestation and a published SHA-256

## Install

```sh
npm install @beardsoft/ts-sema        # or: bun add @beardsoft/ts-sema
```

npm (and Bun) install only the package for your machine, chosen by `os`/`cpu`/`libc`:

| platform | package |
| --- | --- |
| Linux x64, glibc | `@beardsoft/ts-sema-linux-x64` |
| Linux x64, musl (Alpine) | `@beardsoft/ts-sema-linux-x64-musl` |
| Linux arm64, glibc | `@beardsoft/ts-sema-linux-arm64` |
| Linux arm64, musl (Alpine) | `@beardsoft/ts-sema-linux-arm64-musl` |
| macOS arm64 (Apple silicon) | `@beardsoft/ts-sema-darwin-arm64` |

Not yet: Windows, Intel macOS. Requires Node 18+ or Bun. Each platform package is one ~15 MB file
(`ts_sema.node`, ~6 MB to download), with no dependencies and no install scripts. Don't install with
`--omit=optional` (`--no-optional`): the binary comes as an optional dependency.

## Usage

```js
import { check, checkSync } from '@beardsoft/ts-sema'

// A tsconfig.json, or a directory that has one. On a worker thread: the event loop keeps running.
const report = await check('./tsconfig.json')
if (!report.ok) {
  console.error(report.output)          // the diagnostics, as `tsc --pretty false` would print them
  process.exitCode = 1
}

// The same on the calling thread, here with 2 checker threads (default: one per core).
const again = checkSync('./my-project', { threads: 2 })
console.log(`${again.errors} errors, ${again.files_checked} files checked in ${again.check_ms} ms`)
```

The report:

```ts
interface Report {
  ok: boolean           // no errors
  errors: number
  files_loaded: number  // files read: sources, declaration files, lib files
  files_checked: number
  load_ms: number       // reading and parsing
  check_ms: number      // binding and checking
  output: string        // the diagnostics and a summary line
}
```

`check(project, options?)` and `checkSync(project, options?)` take `options.libDir` (a directory of `lib.*.d.ts` files
to use instead of the built-in ones) and `options.threads`. Checks run one at a time within a process.

### Choosing the standards a project may use

The built-in lib files are TypeScript 7.0.2's. `setLibs()` replaces them for the whole process, once, before the
first check. Only the files you register then exist, so a tsconfig that asks for another lib fails the check:

```js
import { checkSync, setLibs, builtinLibSet } from '@beardsoft/ts-sema'

// ES2022 and everything it references (es2021, ..., es5): no DOM, so `document`, `fetch` and even `console` are
// errors unless the project declares them itself.
setLibs(builtinLibSet(['es2022']))
console.log(checkSync('./server').output)
```

- `builtinLibSet(names)`: built-in lib files by tsconfig `lib` name (`'es2022'`, `'dom'`, `'webworker'`, ...) plus
  every file they reference, as `{ 'lib.es2022.d.ts': text, ... }`.
- `setLibs(files)`: any `{ name: text }` set, including your own versions of the files.
- `builtinLib(name)` (`'es2022'` or `'lib.es2022.d.ts'`) returns one file's text, `builtinLibNames()` all 108 names.

### As a shared library, through FFI

`libraryPath` is the path of the installed binary. It is also a plain shared library exporting the C API, so any
FFI can call it (this one needs Node 26.1+'s `node:ffi`):

```js
import { libraryPath } from '@beardsoft/ts-sema'
import { dlopen, toString } from 'node:ffi'

const { functions: ts } = dlopen(libraryPath, {
  bun_sema_check: { arguments: ['string', 'pointer', 'uint32', 'buffer'], return: 'pointer' },
  bun_sema_free: { arguments: ['pointer'], return: 'void' }
})
const report = ts.bun_sema_check('./tsconfig.json', null, 0, new BigUint64Array(1))
console.log(JSON.parse(toString(report)).output)
ts.bun_sema_free(report)
```

The C API (`ts_sema.h`) and examples for `bun:ffi` and Deno are in the
[repository](https://github.com/just-js/ts-sema/tree/main/bindings).

### ESM and CommonJS

The package is ESM. From CommonJS, use `await import('@beardsoft/ts-sema')`, or `require()` it on Node 20.19+/22.12+,
which can load ES modules. TypeScript types are included.

## Versions

| @beardsoft/ts-sema | TypeScript | Bun's checker |
| --- | --- | --- |
| 0.0.1 | 7.0.2 | Bun 1.4.4 (`1917b1a`) |

Diagnostics are those of `bun check` at that Bun version (a port of typescript-go at that TypeScript version).

## Verifying what you installed

- **The release assets** the npm packages are made from carry signed build provenance (Sigstore, GitHub Actions):
  `gh attestation verify ts-sema-<target>.tar.gz -R just-js/ts-sema`, and are listed in the release's `SHA256SUMS`.
  The packaging script checks every asset against `SHA256SUMS` before publishing.
- **The npm packages** come from that same GitHub Actions release run, staged with npm trusted publishing (no
  npm tokens) and made public only after a maintainer approves each version with 2FA. Each has an npm provenance
  attestation linking it to the commit and workflow that built it (shown on its npm page; check with
  `npm audit signatures`). 0.0.1 was published by hand and has registry signatures only.

## License

MIT for ts-sema's own code. The binary contains Bun's checker (MIT), which is a port of typescript-go and carries
TypeScript's messages and lib files (Apache-2.0), plus mimalloc (MIT), zstd (BSD-3-Clause) and, on musl, LLVM's
libunwind; `NOTICE` and the `LICENSE*` files in each package list them. Source, build and issues:
[github.com/just-js/ts-sema](https://github.com/just-js/ts-sema).
