#!/usr/bin/env node
// Releases ts-sema: sets the version in bindings/napi/package.json and commits that to main
// ("chore: release <version>"; push.yml ignores that file, so it starts no push build), tags the commit, pushes main
// and the tag together, and creates the GitHub release as a **draft**. The tag push starts the release build
// (.github/workflows/release.yml: build every target, SHA256SUMS, attestations, the assets attached to the draft,
// then it publishes the draft, verifies the published release and stages the npm packages with provenance). The
// release is published only with all its assets, so it can be an immutable release. Node 20+, no dependencies.
//
//   node release.js [--dry-run] <version>        e.g. node release.js 0.0.2
//
// The tag is the version as given, no "v" (like lo's); a version with a "-" suffix is a GitHub prerelease (npm tag
// "next"). Needs $GH_TOKEN or $GITHUB_TOKEN (Contents: Read and write). Local main must equal origin/main and be clean,
// and the push build of the commit being released must have passed. --dry-run does every check and prints what would
// happen. Re-running when the tag is already on origin at local main only creates the draft, if it is missing.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

function fail (msg) {
  console.error(`release: ${msg}`)
  process.exit(1)
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const [version] = args.filter(a => !a.startsWith('--'))
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version) || args.some(a => a.startsWith('--') && a !== '--dry-run')) {
  fail('usage: node release.js [--dry-run] <version>   (version like 0.0.1)')
}
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
if (!token) fail('needs $GH_TOKEN or $GITHUB_TOKEN')

const m = git('remote', 'get-url', 'origin').match(/github\.com[:/]([^/]+\/[^/]+?)(\.git)?$/)
if (!m) fail("can't get owner/repo from the origin remote")
const repo = m[1]
const api = `https://api.github.com/repos/${repo}`
const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: `Bearer ${token}` }

git('fetch', '-q', '--tags', 'origin')
if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') fail('not on main')
if (git('status', '--porcelain')) fail('the working tree has changes')
let sha = git('rev-parse', 'HEAD')
if (sha !== git('rev-parse', 'origin/main')) fail('local main is not origin/main; pull or push first')

const remote = git('ls-remote', '--tags', 'origin', `refs/tags/${version}^{}`).split('\t')[0] ||
  git('ls-remote', '--tags', 'origin', `refs/tags/${version}`).split('\t')[0]
if (remote && remote !== sha) fail(`tag ${version} already exists on origin at ${remote}`)

// The push build ("build on push") of the commit being released must have passed. A release commit
// ("chore: release ...", older ones with " [skip ci]") has none, so on a re-run its parent is the one that was checked.
const isReleaseCommit = /^chore: release \S+( \[skip ci\])?$/.test(git('log', '-1', '--format=%s', sha))
const built = isReleaseCommit ? git('rev-parse', `${sha}^`) : sha
const runs = await (await fetch(`${api}/actions/runs?head_sha=${built}&event=push&per_page=20`, { headers })).json()
const push = (runs.workflow_runs || []).find(r => r.name === 'build on push')
if (!push) fail(`no push build for ${built.slice(0, 7)}`)
if (push.conclusion !== 'success') fail(`the push build for ${built.slice(0, 7)} is ${push.status}/${push.conclusion}: ${push.html_url}`)

// The version in the main npm package's template (npm.js stamps every package with the release version anyway).
const pkgPath = new URL('./bindings/napi/package.json', import.meta.url)
const pkgText = readFileSync(pkgPath, 'utf8')
const bump = !remote && JSON.parse(pkgText).version !== version
if (!remote && git('tag', '--list', version)) fail(`tag ${version} exists locally but not on origin`)

// /releases/tags/<tag> doesn't return drafts: look through the list (drafts are visible with write access).
const listed = await fetch(`${api}/releases?per_page=100`, { headers })
if (!listed.ok) fail(`listing releases failed (HTTP ${listed.status})`)
const existing = (await listed.json()).find(r => r.tag_name === version)
if (existing && !existing.draft) fail(`release ${version} is already published: ${existing.html_url}`)
if (existing) {
  console.log(`draft release ${version} exists: ${existing.html_url}`)
  console.log(`release build: https://github.com/${repo}/actions/workflows/release.yml`)
  process.exit(0)
}

const up = JSON.parse(readFileSync(new URL('./upstream.json', import.meta.url), 'utf8'))
const body = [
  `- Bun ${up.bun.version} ([${up.bun.commit.slice(0, 10)}](https://github.com/oven-sh/bun/commit/${up.bun.commit})), TypeScript ${up.typescript}`,
  `- Built with Rust ${up.rust_toolchain}; assets: \`ts-sema-<target>.tar.gz\` (static + shared library, \`ts_sema.node\`, header, \`build.json\`, SBOM), \`ts-sema-<target>-debug.tar.gz\` (debug info), \`ts-sema-<target>.cdx.json\` (CycloneDX SBOM), \`SHA256SUMS\`, \`ts-sema-${version}.sigstore.json\` (the attestation bundle)`,
  `- Verify: \`gh release verify ${version} -R ${repo}\`, \`gh attestation verify ts-sema-<target>.tar.gz -R ${repo}\`, or \`node verify.js ${version}\` in a clone`
].join('\n')
const payload = { tag_name: version, name: version, body, draft: true, prerelease: version.includes('-') }

if (dryRun) {
  const steps = []
  if (bump) steps.push(`set bindings/napi/package.json to ${version} and commit "chore: release ${version}"`)
  if (!remote) steps.push(`tag ${bump ? 'that commit' : sha} as ${version}, push ${bump ? 'main and ' : ''}the tag`)
  steps.push(`create the draft ${payload.prerelease ? 'pre' : ''}release ${version} on ${repo}`)
  console.log(`would ${steps.join(', then ')}:`)
  console.log(JSON.stringify(payload, null, 2))
  process.exit(0)
}

if (bump) {
  writeFileSync(pkgPath, pkgText.replace(/("version":\s*")[^"]*(")/, `$1${version}$2`))
  git('add', 'bindings/napi/package.json')
  git('commit', '-q', '-m', `chore: release ${version}`)
  sha = git('rev-parse', 'HEAD')
  console.log(`committed ${sha.slice(0, 7)}: chore: release ${version}`)
}
if (!remote) {
  git('tag', '-a', version, '-m', `ts-sema ${version}`, sha)
  // main and the tag together: either both land on origin, or neither.
  git('push', '-q', '--atomic', 'origin', ...(bump ? ['main'] : []), `refs/tags/${version}`)
  console.log(`tagged ${sha.slice(0, 7)} as ${version} and pushed ${bump ? 'main + ' : ''}the tag`)
}
const res = await fetch(`${api}/releases`, { method: 'POST', headers, body: JSON.stringify(payload) })
if (res.status !== 201) fail(`creating release ${version} failed (HTTP ${res.status}): ${await res.text()}`)
console.log(`draft release ${version}: ${(await res.json()).html_url} (the release build attaches the assets and publishes it)`)
console.log(`release build: https://github.com/${repo}/actions/workflows/release.yml`)
