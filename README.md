# ts-sema

Bun's TypeScript type checker (`bun check`, the Rust crate `bun_sema` in
[oven-sh/bun](https://github.com/oven-sh/bun) `src/sema`, a port of
typescript-go's checker) as a static library with a small C ABI. It is built
outside Bun's build system, for embedding: the
[lo](https://github.com/just-js/lo) `sema` binding (`lib/sema`) and the
`sema-tsc` runtime use it.

The Bun commit, its TypeScript version and the rest of the pins are in
[`upstream.json`](upstream.json).

## Layout

| path | what |
| --- | --- |
| `capi/` | our crate `ts_sema` (`staticlib`): its own cargo workspace, with path deps into `vendor/bun`. `include/ts_sema.h` is the header |
| `vendor/bun/` | the Bun sources the build needs, unmodified: the crates `capi` depends on (`upstream.json` `crates`), Bun's root `Cargo.toml`/`Cargo.lock`/`rust-toolchain.toml`, `LICENSE.md`, and the TypeScript `lib.*.d.ts` bundle (`src/runtime/cli/typescript_libs.bin`) |
| `vendor/mimalloc/` | `src/`, `include/` and `LICENSE` of Bun's mimalloc fork (oven-sh/mimalloc), at the commit Bun pins |
| `codegen/` | the three files the crates `include!` (`BUN_CODEGEN_DIR`), made by Bun's own generators |
| `patches/` | our patches to the vendored sources, applied by `sync.js` (none yet) |
| `build.js` | builds `dist/` |
| `sync.js` | refreshes `vendor/`, `codegen/`, `capi/Cargo.lock` and `upstream.json` from a Bun commit or tag |
| `test/` | `check.c` and `fixture/`, the smoke test (`node build.js --test`) |
| `.github/workflows/` | CI builds and the release assets (see Releases) |

`work/`, `target/` and `dist/` are not tracked.

## Requirements

- A nightly Rust toolchain with cargo. Bun pins one in
  `vendor/bun/rust-toolchain.toml`; newer nightlies work too (`build.js`
  enables `allocator_ext` when rustc knows it).
- A C compiler and `ar`, for mimalloc (`CC`, `AR`; default `cc`, `ar`).
- About 3 GB of free memory for rustc: the `bun_sema` crate alone peaks there.
  A full build is about 7 minutes on one core here.
- Network access for cargo to fetch the crates.io dependencies (54 crates,
  pinned by `capi/Cargo.lock`).
- To link the result: dead-code elimination (`-Wl,--gc-sections`, or
  `-Wl,-dead_strip` on macOS), libzstd, and rustc's native libraries;
  `dist/build.json` `link` lists them. Dead-code elimination is required: the
  archive refers to ~760 symbols of Bun's C/C++ side (uWebSockets, BoringSSL, …)
  from code the checker never reaches. Rust links its own binaries that way.

No git or Bun is needed to build. `sync.js` needs git, cargo and Node 22.18+.

## Building

```sh
node build.js                       # mimalloc variant, host target, cargo's default parallelism
node build.js --jobs 1 --nice 19    # on a small machine
```

Outputs in `dist/`: `libts_sema.a`, `ts_sema.h`, `build.json` (variant, target,
RUSTFLAGS, Bun commit, link flags), and with `--shared` also `libts_sema.so`
(Linux). `--test` links [`test/check.c`](test/check.c) against the archive with
those link flags and checks `test/fixture` (one expected TS2322). `CC`, `CFLAGS`
(e.g. `-arch x86_64`), `AR` and `LDFLAGS` are honoured.

Options:

- `--variant mimalloc` (default): Bun's mimalloc fork backs the checker's heaps
  and is the library's Rust global allocator, as in `bun check`. It's compiled
  without the malloc override, so the embedder's own `malloc`/`free` stay as they
  are; the library just carries its own allocator. `mimalloc.o` is added to
  `libts_sema.a`.
- `--variant plain`: Bun's stand-in heaps (a bump allocator over `malloc`, meant
  for Bun's tests) and the system allocator. 15-20% slower, less peak memory.
- `--target <triple>`, `--toolchain <name>` (`RUSTUP_TOOLCHAIN`), `--jobs <n>`,
  `--native` (`-C target-cpu=native`), `--lto off|thin|fat`.
- `--nice <n>`, `--cpus <list>` (taskset), `--mem-floor <MB>`: limits for small
  machines. With `--mem-floor`, the build is killed when available memory drops
  below it or major faults spike (Linux).
- `--pgo-gen <dir>` / `--pgo-use <file>`: profile-guided optimization. Train an
  instrumented `--shared` build on some projects, merge with `llvm-profdata merge`,
  rebuild with `--pgo-use`. Worth 8-9% on top of mimalloc. A profile is only valid
  for the source and LLVM version it came from.

Each set of flags is a full rebuild: cargo keeps its artifacts per RUSTFLAGS in
`target/`.

## Releases

[`.github/workflows`](.github/workflows): `push.yml` builds and tests every
push to `main` and every PR; `release.yml` runs on a published release and
uploads `ts-sema-<target>.tar.gz` (one directory, `ts-sema-<target>/`, with
`dist/`'s files) for `x86_64`/`aarch64` Linux (gnu and musl) and macOS, plus
`SHA256SUMS`. Each asset has a signed build provenance attestation (Sigstore,
the release run's identity):

```sh
gh attestation verify ts-sema-x86_64-unknown-linux-musl.tar.gz -R just-js/ts-sema
```

Every build uses Bun's pinned nightly (`upstream.json` `rust_toolchain`). The
musl builds are cross-built on Ubuntu with `musl-gcc`, Intel macOS on Apple
silicon; the test runs on the gnu and Apple-silicon builds.

## The C ABI

```c
char *bun_sema_check(const char *project, const char *ts_lib_dir, uint32_t threads, size_t *len);
void bun_sema_free(char *report);
```

`project` is a tsconfig.json or its directory. `ts_lib_dir` NULL or "" uses the
built-in `lib.*.d.ts` files. `threads` 0 means one per core. The result is a
JSON report, `{"ok", "errors", "files_loaded", "files_checked", "load_ms",
"check_ms", "output"}`, where `output` is what `bun check --no-pretty` prints.
Free it with `bun_sema_free`, never `free`. The library is built with
`panic = "abort"`, so a panic in the checker ends the process.

To keep the library's own symbols (Rust's std, mimalloc's `mi_*`, Bun's
stand-ins for its C/C++ side) from clashing with the embedder's, link it into
one relocatable object and keep only the two C symbols global, as lo's
`lib/sema/build.js` does:

```sh
ld -r -o ts_sema.all.o --whole-archive libts_sema.a
objcopy --keep-global-symbol=bun_sema_check --keep-global-symbol=bun_sema_free ts_sema.all.o ts_sema.o
```

## Syncing with Bun

```sh
node sync.js <bun commit or tag>    # e.g. bun-v1.4.5; no argument: the ref in upstream.json
```

It fetches that commit (shallow, sparse: `src/` and `scripts/`) into
`work/bun`, and the mimalloc commit Bun pins into `work/mimalloc`. Then it:

1. asks cargo which Bun crates `capi` depends on;
2. copies their tracked files, plus the root files listed in `sync.js`, into
   `vendor/` (refusing symlinks and paths that lo's tar reader can't extract
   from a GitHub tarball);
3. applies `patches/`;
4. regenerates `codegen/` with Bun's generators (machine paths emptied);
5. writes `capi/Cargo.lock` (Bun's, pruned to what `capi` uses) and
   `upstream.json`;
6. reports changes to the parts `capi` calls into (`sema/driver`,
   `sema/standalone`, `typescript_libs.rs`, which `capi/libs.rs` copies).

Review `git diff`, build, and compare with `bun check` on a project before
committing. `--no-fetch` uses `work/` as it is; `--offline` passes `--offline`
to cargo; `BUN_GIT`/`MIMALLOC_GIT` override the clone URLs (e.g. SSH).

## Licenses

Our code (`capi/` except `libs.rs`, the scripts) is MIT, see [`LICENSE`](LICENSE).
Everything that came from Bun keeps Bun's license and notices,
[`vendor/bun/LICENSE.md`](vendor/bun/LICENSE.md) (MIT, with the licenses of the
code Bun includes): the sources in `vendor/bun/`, `capi/libs.rs` (a copy of
Bun's `typescript_libs.rs`) and `codegen/` (written by Bun's generators). Bun's
mimalloc fork is MIT, [`vendor/mimalloc/LICENSE`](vendor/mimalloc/LICENSE).
As Bun's `LICENSE.md` notes, the checker is a port of Microsoft's
[typescript-go](https://github.com/microsoft/typescript-go) and uses
TypeScript's diagnostic messages and `lib.*.d.ts` files (in
`typescript_libs.bin`), which are Apache-2.0.
