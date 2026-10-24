# ts-sema

[![CI](https://github.com/just-js/ts-sema/actions/workflows/push.yml/badge.svg)](https://github.com/just-js/ts-sema/actions/workflows/push.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/just-js/ts-sema/badge)](https://scorecard.dev/viewer/?uri=github.com/just-js/ts-sema)

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
| `vendor/bun/` | the Bun sources the build needs, unmodified: the crates `capi` depends on (`upstream.json` `crates`), Bun's root `Cargo.toml`/`rust-toolchain.toml` (not its `Cargo.lock`: `capi/Cargo.lock` is ours, pruned from it), `LICENSE.md`, and the TypeScript `lib.*.d.ts` bundle (`src/runtime/cli/typescript_libs.bin`) |
| `vendor/mimalloc/` | `src/`, `include/` and `LICENSE` of Bun's mimalloc fork (oven-sh/mimalloc), at the commit Bun pins |
| `codegen/` | the three files the crates `include!` (`BUN_CODEGEN_DIR`), made by Bun's own generators |
| `patches/` | our patches to the vendored sources, applied by `sync.js` (none yet) |
| `build.js` | builds `dist/` |
| `sync.js` | refreshes `vendor/`, `codegen/`, `capi/Cargo.lock` and `upstream.json` from a Bun commit or tag |
| `bindings/` | `napi/` (N-API addon for Node, Bun and Deno) and `ffi/` (examples for each runtime's FFI); see [`bindings/README.md`](bindings/README.md) |
| `vendor/node-api-headers/` | the N-API C headers (npm `node-api-headers`, MIT), for `bindings/napi` |
| `npm.js` | makes (and with `--publish` publishes) the npm packages for a release from its assets; see npm |
| `release.js` | bumps the version, tags `main`, pushes the tag and creates the draft GitHub release (`node release.js <version>`) |
| `verify.js` | verifies a published release: checksums, immutability, attestations, and with `--npm` the npm packages |
| `sbom.js` | writes `dist/sbom.cdx.json`, the CycloneDX SBOM of a build (`build.js` runs it) |
| `SECURITY.md` | reporting vulnerabilities, verifying releases |
| `libs.js` | writes a set of built-in lib files (plus what they reference) to a directory; `--list` |
| `test/` | `check.c` and `fixture/`, the smoke test (`node build.js --test`); `fuzz/`, property-based tests of our layer (see Testing) |
| `.github/workflows/` | CI builds and the release assets (see Releases), CodeQL, OpenSSF Scorecard; `.github/codeql/` is CodeQL's config, `.github/dependabot.yml` keeps the actions current |
| `.github/npm/` | the release tools (npm, publint, attw) pinned by hash in `package-lock.json`; `release.yml` installs them with `npm ci --prefix .github/npm`, `npm.js` uses them when installed |
| `capi/osv-scanner.toml` | advisories in `capi/Cargo.lock` reviewed as not affecting the build, with reasons (OSV-Scanner, Scorecard) |
| `.github/rulesets/` | the repository's rulesets as GitHub exports them (`default.json`: `main`, `tags.json`: all tags); Settings → Rules → Rulesets → New ruleset → Import a ruleset. Keep them in sync with the live ones |

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

## Testing

- `node build.js --test`: the smoke test. `test/check.c` links the static library and checks `test/fixture` (one
  TS2322); with `--shared` also through `dlopen`, with `--napi` also the addon (`bindings/napi/test.mjs`).
- `test/fuzz/`: property-based tests ([fast-check](https://fast-check.dev), pinned by hash in its lockfile) of
  ts-sema's own layer, not of Bun's checker: argument validation in `index.js` and the addon, the report JSON
  (escaping of any diagnostic text and file name, error counts), the C ABI's thread cap, `check` and `checkSync`
  agreeing (also concurrently), `builtinLib` and `setLibs`. Each case runs in a child process, so an abort in native
  code fails that case and fast-check shrinks it to a minimal input. CI runs it after every build with an addon.

```sh
npm ci --prefix test/fuzz
TS_SEMA_NODE=dist/ts_sema.node node --test test/fuzz/properties.test.js
FUZZ_RUNS=200 FUZZ_SEED=<seed> ...    # more runs; replay a failure with the seed fast-check printed
```

## Building

```sh
node build.js                       # mimalloc variant, host target, cargo's default parallelism
node build.js --jobs 1 --nice 19    # on a small machine
```

Outputs in `dist/`: `libts_sema.a`, `ts_sema.h`, `build.json` (variant, target,
RUSTFLAGS, Bun commit, link flags), and with `--shared` also a shared library,
`libts_sema.so` (Linux) or `libts_sema.dylib` (macOS, install name
`@rpath/libts_sema.dylib`), which exports only the two C functions, for `dlopen`
and any FFI (Node/Bun/Deno FFI, Python ctypes, lo's `lib/ffi.js`, ...). `--test`
links [`test/check.c`](test/check.c) against the archive with those link flags
and checks `test/fixture` (one expected TS2322); with `--shared` it also loads the
shared library through `dlopen` + `dlsym` and checks again. `CC`, `CFLAGS`
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
- `--no-builtin-libs`: no TypeScript lib files built in (see the C ABI).
- `--pgo-gen <dir>` / `--pgo-use <file>`: profile-guided optimization. Train an
  instrumented `--shared` build on some projects, merge with `llvm-profdata merge`,
  rebuild with `--pgo-use`. Worth 8-9% on top of mimalloc. A profile is only valid
  for the source and LLVM version it came from.

Each set of flags is a full rebuild: cargo keeps its artifacts per RUSTFLAGS in
`target/`.

## Releases

[`.github/workflows`](.github/workflows): `push.yml` builds and tests every
push to `main` and every PR; `release.yml` runs on a release tag (see Releasing) and
attaches to the release, for `x86_64`/`aarch64` Linux (gnu and musl) and macOS:

- `ts-sema-<target>.tar.gz`: one directory, `ts-sema-<target>/`, with `dist/`'s files: the static library, the
  shared library and `ts_sema.node` (all three without debug info, symbols kept), the header, `build.json`, `sbom.cdx.json`
- `ts-sema-<target>-debug.tar.gz`: the debug info (line tables) split off them: `libts_sema.a` as built, to link
  with line tables in your own binary, and for the shared library and the addon `<file>.debug` (Linux) or
  `<file>.dSYM` (macOS; Intel macOS has only the archive)
- `ts-sema-<target>.cdx.json`: the SBOM (CycloneDX 1.6, `sbom.js`): the crates compiled in, with licenses and
  checksums, Bun, typescript-go, mimalloc, the Rust standard library, and the static libzstd/libunwind in the addon

plus `SHA256SUMS` and `ts-sema-<version>.sigstore.json` (the attestation bundle). Each asset has a signed build
provenance attestation (Sigstore, the release run's identity), and the release itself is immutable, with GitHub's
release attestation (from 0.0.3):

```sh
gh attestation verify ts-sema-x86_64-unknown-linux-musl.tar.gz -R just-js/ts-sema
```

To debug a crash in a release build, unpack its `-debug` asset and put `<file>.debug` next to the binary (gdb and
lldb follow the binary's gnu-debuglink), or install it by build-id as
`/usr/lib/debug/.build-id/<first 2 hex digits>/<the rest>.debug`; `build.json` `debug_ids` lists each build-id
(macOS: the UUID, which matches the `.dSYM`).

Every build uses Bun's pinned nightly (`upstream.json` `rust_toolchain`). The
musl builds run natively in Alpine 3.23 (`docker run` on the Ubuntu runners), Intel macOS is cross-built on Apple
silicon; the tests run on every build except Intel macOS.

## Releasing

From an up-to-date `main` whose push build passed:

```sh
node release.js 0.0.3              # bump bindings/napi/package.json, commit, tag, push main + tag, create a draft release
```

The tag push starts [release.yml](.github/workflows/release.yml):

1. **build** every target (`build.yml`)
2. **publish**: `SHA256SUMS`, build provenance attestations for every asset, the assets and the attestation bundle
   (`ts-sema-<version>.sigstore.json`) attached to the draft, then the draft published. The release is complete
   when it is published, so it is an **immutable release**: its tag and assets can't change any more, and GitHub
   adds a release attestation.
3. **verify** the published release from outside: `sha256sum -c`, `gh release verify`, and for every asset
   `gh release verify-asset` and `gh attestation verify` (this repository, `release.yml`, the tag, a
   GitHub-hosted runner)
4. **npm**: lint the packages (`npm.js --lint`: publint, attw) and **stage** the six npm packages with npm trusted
   publishing and provenance

Nothing is public on npm until you approve each staged version with 2FA, platform packages first, the main one last:

```sh
npm ci --prefix .github/npm        # once: the pinned release tools (npm 11.21.1, for npm stage)
node npm.js 0.0.3 --approve        # npm stage list + npm stage approve for each, in order; npm asks for the 2FA code
```

(or one by one: `npm stage list <package> --json`, `npm stage approve <stage-id>`, or on npmjs.com).

Then check it all from outside, as a user would:

```sh
node verify.js 0.0.3 --npm
```

By hand instead of CI, as for 0.0.1 (no provenance; needs `npm login`):

```sh
node npm.js 0.0.3 --publish        # once the release run is green
```

- **Immutable releases** must be on (repository Settings → General → Releases, "Enable release immutability"):
  the verify job's `gh release verify` fails on a release that isn't immutable, and then nothing is staged on npm.
- **Versions** are independent semver, no `v` prefix; the tag, the GitHub release and all six npm packages share it.
- **`release.js`** sets `bindings/napi/package.json`'s version and commits it to `main` as
  `chore: release <version>` (`push.yml` ignores that file, so no push build), tags that commit and pushes `main`
  and the tag together (`--atomic`), then creates the draft release with the notes. A version with a `-` suffix
  (`0.1.0-beta.1`) becomes a prerelease, published to npm's `next` tag. It refuses unless `main` is clean, equal
  to `origin/main`, and its push build ("build on push") passed; it needs `$GH_TOKEN` (Contents: Read and write).
  `--dry-run` does every check and shows the release. Re-run, it creates a missing draft; a release run that
  failed can be re-run from the Actions page (the draft stays a draft until the publish job succeeds).
- **`verify.js <version>`** downloads the release, checks `SHA256SUMS`, immutability and every asset's
  attestation (with `gh` installed, cryptographically: Sigstore signature, repository, workflow; without, only
  that GitHub has one), and with `--npm` installs the package, runs `npm audit signatures` and a check.
- **Trusted publishing** needs, once per package on npmjs.com: Settings → Trusted publisher → GitHub Actions, user
  `just-js`, repository `ts-sema`, workflow `release.yml`, with "allow npm publish" **off** (CI can only stage,
  so a human approves every version).
- **`npm.js`** needs an npm login with publish rights on `@beardsoft` (`npm login`). `--dry-run` first shows each
  package's contents (`npm pack --dry-run`); `--lint` runs publint and attw on them first (as the release job
  does); `--tag next` publishes a prerelease without moving `latest`. By hand, wait for the release build first:
  it downloads the release's assets and checks them against `SHA256SUMS`.
- **Update** the version table in `bindings/napi/README.md` (the npm page) when the Bun or TypeScript version
  changes.

## npm

`@beardsoft/ts-sema` (the N-API addon's JS API, `bindings/napi`) and one package per platform,
`@beardsoft/ts-sema-{linux-x64,linux-x64-musl,linux-arm64,linux-arm64-musl,darwin-arm64}`, each a single
`ts_sema.node`, which npm and Bun pick by `os`/`cpu`/`libc`. All six share the release's version.

```sh
node npm.js 0.0.1 --dry-run     # download + verify the release's assets, write dist/npm/, npm pack --dry-run
node npm.js 0.0.1 --publish     # same, then npm publish (platform packages first); needs npm login
```

`npm.js` checks every asset against the release's `SHA256SUMS`; each package carries `LICENSE`, Bun's and mimalloc's
licenses and a `NOTICE` of what the addon contains. Intel macOS has no package (no addon build).

## The C ABI

```c
char *bun_sema_check(const char *project, const char *ts_lib_dir, uint32_t threads, size_t *len);
void bun_sema_free(char *report);
int bun_sema_set_libs(const char *const *names, const char *const *texts, const size_t *lens, size_t count);
char *bun_sema_builtin_lib(const char *name, size_t *len);
```

`project` is a tsconfig.json or its directory. `ts_lib_dir` NULL or "" uses the
built-in `lib.*.d.ts` files. `threads` 0 means one per core. The result is a
JSON report, `{"ok", "errors", "files_loaded", "files_checked", "load_ms",
"check_ms", "output"}`, where `output` is what `bun check --no-pretty` prints.
Free it with `bun_sema_free`, never `free`. The library is built with
`panic = "abort"`, so a panic in the checker ends the process.

**Lib files.** By default the checker uses the built-in TypeScript `lib.*.d.ts`
files (all 108 of its own TypeScript version, 339 KB compressed).
`bun_sema_set_libs` replaces them, for the rest of the process and before the
first check, with files the embedder passes in memory (`"lib.es2022.d.ts"` →
text). Only those then exist, so a tsconfig asking for another lib gets
TypeScript's own "cannot find lib" error: that's how an embedder limits the
standards it supports. The texts are borrowed, not copied, so they must live as
long as the process (embedded data is ideal). A set must include what its files
reference (`/// <reference lib="..." />`). `bun_sema_builtin_lib` returns a
built-in file's text (or, with a NULL name, a JSON array of names), and
[`libs.js`](libs.js) (`node libs.js <out dir> es2022 dom`) writes such a set
to a directory. `build.js --no-builtin-libs` leaves the built-in files out;
then `bun_sema_set_libs` or a lib directory is needed.

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

## Security

How releases are made and how to check them. Reporting a vulnerability: [SECURITY.md](SECURITY.md) (GitHub private
vulnerability reporting).

**Build and release**
- Every release asset is built by GitHub Actions from the tagged commit (`release.yml`), never on a developer machine,
  and carries a signed **SLSA build provenance attestation** (Sigstore, the run's OIDC identity), recorded in the
  public Sigstore transparency log and attached as `ts-sema-<version>.sigstore.json`. `SHA256SUMS` lists every asset.
- **Immutable releases** (from 0.0.3): the release is published only once all its assets are attached, and after
  that its tag and assets can't be changed or replaced; GitHub signs a release attestation over the tag, commit and
  assets. The release workflow then **verifies the published release** as a user would (checksums, `gh release
  verify`, `gh release verify-asset` and `gh attestation verify` for every asset) before anything goes to npm.
- Each target has a **CycloneDX 1.6 SBOM** (`ts-sema-<target>.cdx.json`, also `sbom.cdx.json` in the package):
  the crates compiled in with their licenses and `Cargo.lock` checksums, Bun at its commit, typescript-go,
  mimalloc, the Rust standard library and the static libraries in the addon, with versions.
- The **debug info** is split off the static archive, the shared library and the addon into its own attested asset, so the shipped
  binaries are smaller and a crash in a release build can still be debugged offline (see Releases).
- **Pinned inputs**: Bun's sources are vendored unmodified at a recorded commit (`upstream.json`), crates.io
  dependencies are locked with checksums (`capi/Cargo.lock`, `cargo build --locked`), the Rust toolchain is Bun's
  pinned nightly, every GitHub Action is pinned by commit SHA, and the release tools (npm, publint, attw) are pinned
  by hash (`.github/npm/package-lock.json`, `npm ci`). Dependabot proposes updates for actions and tools weekly.
  Advisories that don't affect the build are recorded with their reasons in `capi/osv-scanner.toml`.
- **Least privilege in CI**: workflows default to read-only tokens; only the release jobs that need it get
  `contents: write`, `id-token: write` or `attestations: write`; checkouts don't keep the token
  (`persist-credentials: false`).

**npm**
- The six `@beardsoft/ts-sema*` packages are made from the attested release assets (each checked against
  `SHA256SUMS`), linted (publint, attw), and **staged** from `release.yml` with **npm trusted publishing**: no npm
  token exists anywhere, and npm checks the workflow's OIDC identity. Direct publishing from CI is disabled; a
  maintainer approves every version with **2FA** before it becomes public.
- Each package version has an **npm provenance attestation** linking it to this repository, the commit and the
  workflow run, and an **SBOM** (`sbom.cdx.json`): a platform package its target's release SBOM, the main package
  its platform packages and the release tools that made it (from the tools' lockfile, marked build-time only). The packages have **no install scripts** and no dependencies besides their own platform packages.

**Analysis**
- **CodeQL** scans the Node scripts, the C, the Rust in `capi/` and the workflows on every push, pull request and
  weekly (`.github/workflows/codeql.yml`; vendored code excluded). Results are in the Security tab.
- **Property-based tests** (fast-check, `test/fuzz/`) of our layer run after every CI build: argument validation, the
  report JSON, the thread cap, sync/async agreement, lib registration (see Testing).
- **OpenSSF Scorecard** runs weekly and on every push to `main` (`.github/workflows/scorecard.yml`) and publishes
  its results.

**Checking a release yourself**

```sh
node verify.js 0.0.3 --npm                                           # all of the below, in a clone of this repo
gh release verify 0.0.3 -R just-js/ts-sema                           # immutable release + GitHub's release attestation
gh release verify-asset 0.0.3 ts-sema-<target>.tar.gz -R just-js/ts-sema
gh attestation verify ts-sema-<target>.tar.gz -R just-js/ts-sema     # build provenance of a downloaded asset
sha256sum -c --ignore-missing SHA256SUMS                             # checksums
npm audit signatures                                                 # in a project that installed @beardsoft/ts-sema
```

**Scores and public records**

| where | what |
| --- | --- |
| [OpenSSF Scorecard](https://scorecard.dev/viewer/?uri=github.com/just-js/ts-sema) | the repository's security practices, scored 0-10 per check |
| [deps.dev](https://deps.dev/npm/%40beardsoft%2Fts-sema) | Google's Open Source Insights: the npm package's dependencies, advisories, provenance and Scorecard |
| [Socket](https://socket.dev/npm/package/@beardsoft/ts-sema) | supply-chain analysis of the npm package (install scripts, network/filesystem access, ...) |
| [npm](https://www.npmjs.com/package/@beardsoft/ts-sema) | the package page shows the provenance of each version |
| [GitHub attestations](https://github.com/just-js/ts-sema/attestations) | every build provenance attestation of the release assets |
| [GitHub releases](https://github.com/just-js/ts-sema/releases) | immutable releases are marked as such |
| [Sigstore search](https://search.sigstore.dev/) | the transparency log entries (search by asset SHA-256 or by the repository) |

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
