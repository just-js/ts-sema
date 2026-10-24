#!/usr/bin/env node
// Verifies a published ts-sema release the way a user would, from outside CI:
//
//   node verify.js <version> [--npm] [--keep <dir>]
//
// - downloads every asset and checks it against the release's SHA256SUMS
// - the release: immutable (GitHub's release flag), and with `gh`: `gh release verify` (GitHub's release attestation)
// - each asset's build provenance: with `gh` (https://cli.github.com), `gh release verify-asset` and
//   `gh attestation verify` (Sigstore signature, this repository, release.yml at refs/tags/<version>, GitHub-hosted
//   runner); without it, only that GitHub has an attestation for the asset's SHA-256 (no signature check)
// - --npm: installs @beardsoft/ts-sema@<version> into a scratch project, runs `npm audit signatures` (registry
//   signatures and provenance attestations) and type-checks test/fixture with it (one TS2322)
// $GH_TOKEN/$GITHUB_TOKEN is used when set (higher API rate limit). --keep keeps the downloads in <dir>.
// Node 20+, no dependencies. Exits 1 on the first failed check.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const root = dirname(fileURLToPath(import.meta.url))
const REPO = 'just-js/ts-sema'
const args = process.argv.slice(2)
const opt = name => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}
const version = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--keep')
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) {
  console.error('usage: node verify.js <version> [--npm] [--keep <dir>]')
  process.exit(2)
}
const ok = s => console.log(`verify: ok    ${s}`)
const note = s => console.log(`verify: note  ${s}`)
function fail (s) {
  console.error(`verify: FAIL  ${s}`)
  process.exit(1)
}
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
  ...(token ? { Authorization: `Bearer ${token}` } : {}) }
const api = async path => {
  const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, { headers })
  return { status: res.status, body: res.ok ? await res.json() : null }
}
const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })
const hasGh = (() => { try { run('gh', ['--version']); return true } catch { return false } })()

// The release and its assets.
const { status, body: release } = await api(`/releases/tags/${version}`)
if (!release) fail(`release ${version}: HTTP ${status} (not published?)`)
ok(`release ${version} published ${release.published_at}${release.prerelease ? ' (prerelease)' : ''}`)
if (release.immutable === true) ok('release is immutable')
else note('release is not immutable (made before immutable releases, or the setting is off)')

const keep = opt('--keep')
const dir = keep ? resolve(keep) : mkdtempSync(join(tmpdir(), 'ts-sema-verify-'))
mkdirSync(dir, { recursive: true })
try {
  for (const asset of release.assets) {
    const res = await fetch(asset.browser_download_url, { redirect: 'follow' })
    if (!res.ok) fail(`${asset.name}: download HTTP ${res.status}`)
    writeFileSync(join(dir, asset.name), Buffer.from(await res.arrayBuffer()))
  }
  ok(`${release.assets.length} assets downloaded to ${dir}`)

  // SHA256SUMS: every listed file present and matching; every asset listed except the signature bundle.
  const names = release.assets.map(a => a.name)
  if (!names.includes('SHA256SUMS')) fail('no SHA256SUMS asset')
  const sums = readFileSync(join(dir, 'SHA256SUMS'), 'utf8').trim().split('\n').map(l => l.trim().split(/\s+/))
  const digests = {}
  for (const [sum, name] of sums) {
    if (!names.includes(name)) fail(`${name}: in SHA256SUMS but not a release asset`)
    const digest = createHash('sha256').update(readFileSync(join(dir, name))).digest('hex')
    if (digest !== sum) fail(`${name}: SHA-256 ${digest} doesn't match SHA256SUMS (${sum})`)
    digests[name] = digest
  }
  const unlisted = names.filter(n => n !== 'SHA256SUMS' && !n.endsWith('.sigstore.json') && !(n in digests))
  if (unlisted.length) fail(`not in SHA256SUMS: ${unlisted.join(', ')}`)
  ok(`${sums.length} assets match SHA256SUMS`)
  digests.SHA256SUMS = createHash('sha256').update(readFileSync(join(dir, 'SHA256SUMS'))).digest('hex')

  if (hasGh) {
    const gh = argv => run('gh', [...argv, '--repo', REPO], { cwd: dir })
    if (release.immutable === true) {
      gh(['release', 'verify', version])
      ok('gh release verify: release attestation verified')
    }
    for (const name of Object.keys(digests)) {
      if (release.immutable === true) gh(['release', 'verify-asset', version, name])
      // release.yml since 0.0.3 runs on the tag push; earlier releases ran on the release event (ref refs/heads/main).
      gh(['attestation', 'verify', name, '--signer-workflow', `${REPO}/.github/workflows/release.yml`,
        '--deny-self-hosted-runners'])
    }
    ok(`gh attestation verify: build provenance of ${Object.keys(digests).length} assets verified (Sigstore, ${REPO} release.yml)`)
  } else {
    for (const [name, digest] of Object.entries(digests)) {
      const { body } = await api(`/attestations/sha256:${digest}`)
      if (!body?.attestations?.length) fail(`${name}: GitHub has no attestation for sha256:${digest}`)
    }
    ok(`GitHub has an attestation for each of the ${Object.keys(digests).length} assets`)
    note('gh not found: attestation signatures not checked; install gh (https://cli.github.com) for that')
  }
} finally {
  if (!keep) rmSync(dir, { recursive: true, force: true })
}

// npm: what a user installs.
if (args.includes('--npm')) {
  const project = mkdtempSync(join(tmpdir(), 'ts-sema-verify-npm-'))
  try {
    writeFileSync(join(project, 'package.json'), '{ "name": "verify", "private": true, "type": "module" }\n')
    run('npm', ['install', '--no-fund', '--no-audit', `@beardsoft/ts-sema@${version}`], { cwd: project })
    ok(`npm install @beardsoft/ts-sema@${version}`)
    const audit = run('npm', ['audit', 'signatures'], { cwd: project })
    const signatures = audit.match(/(\d+) packages? ha(?:s|ve) (?:a )?verified registry signatures?/)?.[1]
    const attestations = audit.match(/(\d+) packages? ha(?:s|ve) (?:a )?verified attestations?/)?.[1]
    if (!signatures) fail(`npm audit signatures:\n${audit}`)
    ok(`npm audit signatures: ${signatures} verified registry signatures, ${attestations || 0} verified attestations`)
    if (!attestations) note('no provenance attestations (0.0.1 was published by hand)')
    const script = `import { checkSync } from '@beardsoft/ts-sema'
const r = checkSync(${JSON.stringify(join(root, 'test/fixture'))})
const text = typeof r === 'string' ? r : JSON.stringify(r)
if (!text.includes('TS2322')) { console.error(text); process.exit(1) }`
    writeFileSync(join(project, 'check.mjs'), script)
    run(process.execPath, ['check.mjs'], { cwd: project })
    ok('checkSync(test/fixture) reports the TS2322')
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
}
console.log(`verify: ${version} verified`)
