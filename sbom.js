// Writes the CycloneDX 1.6 SBOM (JSON) of a build in dist/: what libts_sema.a, the shared library and ts_sema.node
// contain, for the target in dist/build.json.
//
//   node sbom.js [--dist <dir>] [--out <file>]       (default: dist/, <dist>/sbom.cdx.json)
//
// build.js runs it after a build. Components:
// - the crates compiled into the library: `cargo metadata --filter-platform <target>`, following normal
//   dependencies from capi/ (no build or dev dependencies, no proc-macros: those only run at compile time). crates.io
//   crates with their license and Cargo.lock's SHA-256; Bun's crates (vendor/bun, unmodified) as Bun's at its commit
// - Bun, typescript-go (the checker is its port: diagnostic messages, lib files), mimalloc (mimalloc variant), the Rust
//   standard library, and the static libraries build.js linked into ts_sema.node (build.json "static": libzstd, on
//   musl LLVM's libunwind) with the version of the package that installed them.
// Needs Node 20+ and cargo (with the toolchain build.js used: RUSTUP_TOOLCHAIN). No other dependencies.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const root = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  return i === -1 ? fallback : args[i + 1]
}
const dist = resolve(opt('--dist', join(root, 'dist')))
const out = resolve(opt('--out', join(dist, 'sbom.cdx.json')))
const build = JSON.parse(readFileSync(join(dist, 'build.json'), 'utf8'))
const upstream = JSON.parse(readFileSync(join(root, 'upstream.json'), 'utf8'))
const version = JSON.parse(readFileSync(join(root, 'bindings/napi/package.json'), 'utf8')).version
const bunRoot = join(root, 'vendor/bun')

// SPDX expressions: some crates still use the old "MIT/Apache-2.0".
const license = expr => [{ expression: expr.replaceAll('/', ' OR ') }]
const component = (type, name, version, purl, licenses, extra = {}) =>
  ({ type, 'bom-ref': purl, name, version, purl, ...(licenses ? { licenses: license(licenses) } : {}), ...extra })

// Cargo.lock's checksums (crates.io packages).
const checksums = new Map()
for (const block of readFileSync(join(root, 'capi/Cargo.lock'), 'utf8').split('[[package]]').slice(1)) {
  const field = name => block.match(new RegExp(`^${name} = "([^"]+)"`, 'm'))?.[1]
  if (field('checksum')) checksums.set(`${field('name')}@${field('version')}`, field('checksum'))
}

// The crates in the build: normal dependencies of capi's ts_sema for this target, without proc-macros.
const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--locked',
  '--manifest-path', join(root, 'capi/Cargo.toml'), '--filter-platform', build.target],
{ encoding: 'utf8', maxBuffer: 64 << 20 }))
const packages = new Map(metadata.packages.map(p => [p.id, p]))
const nodes = new Map(metadata.resolve.nodes.map(n => [n.id, n]))
const isProcMacro = p => p.targets.some(t => t.kind.includes('proc-macro'))
const included = new Set()
const stack = [metadata.resolve.root]
while (stack.length) {
  const id = stack.pop()
  if (included.has(id) || isProcMacro(packages.get(id))) continue
  included.add(id)
  for (const dep of nodes.get(id).deps) {
    if (dep.dep_kinds.some(k => k.kind === null)) stack.push(dep.pkg)
  }
}

const bun = upstream.bun
const bunPurl = `pkg:github/oven-sh/bun@${bun.commit}`
const self = {
  type: 'library',
  'bom-ref': `pkg:github/just-js/ts-sema@${version}`,
  name: 'ts-sema',
  version,
  purl: `pkg:github/just-js/ts-sema@${version}`,
  description: "Bun's TypeScript checker as a C-ABI library (libts_sema.a), shared library and N-API addon",
  licenses: license('MIT'),
  externalReferences: [{ type: 'vcs', url: 'https://github.com/just-js/ts-sema' }],
  properties: [
    { name: 'ts-sema:target', value: build.target },
    { name: 'ts-sema:variant', value: build.variant },
    { name: 'ts-sema:builtin-libs', value: String(build.builtin_libs) }
  ]
}
const refs = new Map([[metadata.resolve.root, self['bom-ref']]])
const components = []
for (const id of included) {
  if (id === metadata.resolve.root) continue
  const p = packages.get(id)
  let c
  if (p.source) {
    const sum = checksums.get(`${p.name}@${p.version}`)
    c = component('library', p.name, p.version, `pkg:cargo/${p.name}@${p.version}`, p.license || null,
      sum ? { hashes: [{ alg: 'SHA-256', content: sum }] } : {})
  } else {
    // Bun's own crates: Bun's license (LICENSE.md, MIT); the purl's subpath is the crate's directory in Bun's repo.
    const dir = relative(bunRoot, dirname(p.manifest_path))
    c = component('library', p.name, bun.version, `${bunPurl}#${dir}`, p.license || 'MIT',
      { group: 'oven-sh/bun', description: `Bun crate ${dir} (vendor/bun, unmodified)` })
  }
  refs.set(id, c['bom-ref'])
  components.push(c)
}

// The rest: not cargo packages.
const others = [
  component('library', 'bun', bun.version, bunPurl, 'MIT', {
    description: `Bun at ${bun.commit} (${bun.date}): the sources of the crates above, and the codegen files`,
    externalReferences: [{ type: 'vcs', url: 'https://github.com/oven-sh/bun' }]
  }),
  component('library', 'typescript-go', upstream.typescript, `pkg:github/microsoft/typescript-go@v${upstream.typescript}`,
    'Apache-2.0', {
      description: `Bun's checker is a port of typescript-go (TypeScript ${upstream.typescript}): its diagnostic ` +
        `messages${build.builtin_libs ? ' and lib.*.d.ts files' : ''} are built in`
    })
]
if (build.variant === 'mimalloc') {
  others.push(component('library', 'mimalloc', upstream.mimalloc.commit,
    `pkg:github/${upstream.mimalloc.repo}@${upstream.mimalloc.commit}`, 'MIT', { description: "Bun's mimalloc fork" }))
}
const rustVersion = build.rustc.match(/^rustc (\S+)/)?.[1] ?? 'unknown'
others.push(component('library', 'rust-std', rustVersion, `pkg:generic/rust-std@${rustVersion}`, 'MIT OR Apache-2.0',
  { description: `The Rust standard library of ${build.rustc}` }))
const staticLicenses = { zstd: 'BSD-3-Clause OR GPL-2.0-only', unwind: 'Apache-2.0 WITH LLVM-exception' }
for (const [lib, info] of Object.entries(build.static || {})) {
  const name = info.package || `lib${lib}`
  const v = info.version || 'unknown'
  const purl = info.manager === 'apk' ? `pkg:apk/alpine/${name}@${v}`
    : info.manager === 'dpkg' ? `pkg:deb/ubuntu/${name}@${v}`
      : `pkg:generic/${name}@${v}`
  others.push(component('library', name, v, purl, staticLicenses[lib] || null, {
    description: `lib${lib}.a, linked statically into ts_sema.node only (${info.path})`
  }))
}
components.push(...others)

const dependencies = [...included].map(id => ({
  ref: refs.get(id),
  dependsOn: nodes.get(id).deps.filter(d => included.has(d.pkg) && d.dep_kinds.some(k => k.kind === null))
    .map(d => refs.get(d.pkg))
}))
dependencies.find(d => d.ref === self['bom-ref']).dependsOn.push(...others.map(c => c['bom-ref']))

// Reproducible: the timestamp is the commit's (SOURCE_DATE_EPOCH, else git), the serial number a hash of the content.
let timestamp
if (process.env.SOURCE_DATE_EPOCH) timestamp = new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString()
else {
  try {
    timestamp = new Date(execFileSync('git', ['-C', root, 'log', '-1', '--format=%cI'], { encoding: 'utf8' }).trim())
      .toISOString()
  } catch {
    timestamp = new Date().toISOString()
  }
}
const body = { metadata: { timestamp, tools: { components: [{ type: 'application', name: 'ts-sema sbom.js' }] },
  component: self }, components, dependencies }
const h = createHash('sha256').update(JSON.stringify(body)).digest('hex')
const serial = `urn:uuid:${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${(8 | (parseInt(h[16], 16) & 3)).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`
writeFileSync(out, JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.6', serialNumber: serial, version: 1,
  ...body }, null, 2) + '\n')
console.log(`sbom: ${out} (${components.length} components)`)
